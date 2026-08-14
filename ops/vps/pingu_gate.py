#!/usr/bin/env python3
import datetime as dt
import hmac
import html
import http.server
import http.client
from http import cookies
import ipaddress
import json
import os
import re
import select
import socket
import ssl
import subprocess
import time
import urllib.parse
from http import HTTPStatus

try:
    import pingu_device_access as device_access
except ImportError:  # pragma: no cover - supports direct local imports in tests
    import importlib.util
    from pathlib import Path

    _DEVICE_SPEC = importlib.util.spec_from_file_location(
        "pingu_device_access", Path(__file__).with_name("pingu_device_access.py")
    )
    device_access = importlib.util.module_from_spec(_DEVICE_SPEC)
    _DEVICE_SPEC.loader.exec_module(device_access)


PATH_PREFIX = os.environ.get("PINGU_GATE_PATH_PREFIX", "/__pingu_gate__")
TOKEN_FILE = os.environ.get("PINGU_GATE_TOKEN_FILE", "/etc/pingu-gate.token")
TOKENS_FILE = os.environ.get("PINGU_GATE_TOKENS_FILE", "/etc/pingu-gate.tokens")
SUBSCRIPTION_FILE = os.environ.get(
    "PINGU_GATE_SUBSCRIPTION_FILE", "/etc/pingu-gate.subscription.txt"
)
ALLOW4_SET = os.environ.get("PINGU_GATE_ALLOW4_SET", "reality_allow4")
ALLOW6_SET = os.environ.get("PINGU_GATE_ALLOW6_SET", "reality_allow6")
NFT_TABLE = os.environ.get("PINGU_GATE_NFT_TABLE", "pingu_guard")
DEFAULT_TTL = os.environ.get("PINGU_GATE_DEFAULT_TTL", "7d")
LEASE_TTL = os.environ.get("PINGU_GATE_LEASE_TTL", "30m")
LISTEN_HOST = os.environ.get("PINGU_GATE_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PINGU_GATE_LISTEN_PORT", "443"))
CERT_FILE = os.environ.get(
    "PINGU_GATE_CERT_FILE", "/usr/local/etc/xray/certs/cksheuen.site.crt"
)
KEY_FILE = os.environ.get(
    "PINGU_GATE_KEY_FILE", "/usr/local/etc/xray/certs/cksheuen.site.key"
)
IPV6_PREFIX_BITS = int(os.environ.get("PINGU_GATE_IPV6_PREFIX_BITS", "128"))
WS_BACKEND_HOST = os.environ.get("PINGU_GATE_WS_BACKEND_HOST", "127.0.0.1")
WS_BACKEND_PORT = int(os.environ.get("PINGU_GATE_WS_BACKEND_PORT", "10000"))
WS_RELAY_TIMEOUT = int(os.environ.get("PINGU_GATE_WS_RELAY_TIMEOUT", "3600"))
TLS_HANDSHAKE_TIMEOUT = int(os.environ.get("PINGU_GATE_TLS_HANDSHAKE_TIMEOUT", "10"))
PORTAL_BACKEND_HOST = os.environ.get("PINGU_GATE_PORTAL_BACKEND_HOST", "127.0.0.1")
PORTAL_BACKEND_PORT = int(os.environ.get("PINGU_GATE_PORTAL_BACKEND_PORT", "10080"))
PORTAL_PROXY_TIMEOUT = int(os.environ.get("PINGU_GATE_PORTAL_PROXY_TIMEOUT", "8"))
PORTAL_MAX_RESPONSE_BYTES = int(
    os.environ.get("PINGU_GATE_PORTAL_MAX_RESPONSE_BYTES", str(16 * 1024 * 1024))
)
DEVICE_SESSION_COOKIE = os.environ.get(
    "PINGU_GATE_DEVICE_SESSION_COOKIE", "pingu_device_session"
)
DEVICE_SESSION_TTL = int(os.environ.get("PINGU_GATE_DEVICE_SESSION_TTL", "900"))
DEVICE_REGISTRY = device_access.DeviceRegistry(
    os.environ.get("PINGU_GATE_DEVICE_STATE_FILE", device_access.DEVICE_STATE_FILE)
)
DEVICE_SESSIONS = device_access.ManagementSessions(DEVICE_SESSION_TTL)
ALLOWED_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("PINGU_GATE_ALLOWED_EMAILS", "").split(",")
    if email.strip()
}

TTL_PATTERN = re.compile(r"^(?P<value>[1-9][0-9]*)(?P<unit>[smhd])$")
TTL_MULTIPLIER = {"s": 1, "m": 60, "h": 3600, "d": 86400}
PORTAL_RESPONSE_HEADERS = {
    "cache-control",
    "content-encoding",
    "content-language",
    "content-type",
    "etag",
    "expires",
    "last-modified",
}


def parse_duration_seconds(value):
    match = TTL_PATTERN.fullmatch((value or "").strip())
    if not match:
        raise ValueError("TTL must use s, m, h, or d, for example 30m")
    seconds = int(match.group("value")) * TTL_MULTIPLIER[match.group("unit")]
    if seconds < 60 or seconds > 31 * 86400:
        raise ValueError("TTL must be between 1m and 31d")
    return seconds


def parse_tokens(text):
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        data = json.loads(text)
        return [str(item).strip() for item in data if str(item).strip()]
    return [line.strip() for line in text.replace(",", "\n").splitlines() if line.strip()]


def read_tokens():
    tokens = parse_tokens(os.environ.get("PINGU_GATE_TOKENS", ""))
    for path in (TOKENS_FILE, TOKEN_FILE):
        try:
            with open(path, "r", encoding="utf-8") as token_file:
                tokens.extend(parse_tokens(token_file.read()))
        except OSError:
            pass
    result = []
    seen = set()
    for token in tokens:
        if token not in seen:
            seen.add(token)
            result.append(token)
    return result


def token_allowed(token):
    token = (token or "").strip()
    if not token:
        return False
    return any(hmac.compare_digest(token, stored) for stored in read_tokens())


def bearer_token(handler):
    authorization = handler.headers.get("Authorization", "").strip()
    scheme, separator, value = authorization.partition(" ")
    if separator and scheme.lower() == "bearer":
        return value.strip()
    return ""


def nft_contains(set_name, element):
    proc = subprocess.run(
        ["nft", "list", "set", "inet", NFT_TABLE, set_name],
        text=True,
        capture_output=True,
        timeout=8,
    )
    return proc.returncode == 0 and element in proc.stdout


def nft_refresh(set_name, element, ttl):
    parse_duration_seconds(ttl)
    add_line = (
        f"add element inet {NFT_TABLE} {set_name} "
        f"{{ {element} timeout {ttl} }}\n"
    )
    if nft_contains(set_name, element):
        batch = (
            f"delete element inet {NFT_TABLE} {set_name} {{ {element} }}\n"
            + add_line
        )
        return subprocess.run(
            ["nft", "-f", "-"],
            input=batch,
            text=True,
            capture_output=True,
            timeout=8,
        )
    return subprocess.run(
        ["nft", "-f", "-"],
        input=add_line,
        text=True,
        capture_output=True,
        timeout=8,
    )


def client_ip_from_headers(handler):
    for header in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
        value = handler.headers.get(header, "").split(",", 1)[0].strip()
        if not value:
            continue
        try:
            return ipaddress.ip_address(value)
        except ValueError:
            pass
    host = handler.client_address[0]
    if host.startswith("::ffff:"):
        host = host.rsplit(":", 1)[-1]
    return ipaddress.ip_address(host)


def access_email(handler):
    # Port 443 must remain restricted to Cloudflare source ranges before this
    # identity header can be trusted.
    return handler.headers.get("Cf-Access-Authenticated-User-Email", "").strip().lower()


def authorized_by_access(handler):
    email = access_email(handler)
    return bool(email and (not ALLOWED_EMAILS or email in ALLOWED_EMAILS))


def normalize_allow_element(ip):
    if isinstance(ip, ipaddress.IPv6Address) and IPV6_PREFIX_BITS < 128:
        return str(ipaddress.ip_network(f"{ip}/{IPV6_PREFIX_BITS}", strict=False))
    return str(ip)


def allow_set_for_ip(ip):
    return ALLOW6_SET if isinstance(ip, ipaddress.IPv6Address) else ALLOW4_SET


def is_allowlisted(handler):
    try:
        ip = client_ip_from_headers(handler)
    except ValueError:
        return False
    return nft_contains(allow_set_for_ip(ip), normalize_allow_element(ip))


def request_token(handler, params=None):
    header_token = bearer_token(handler)
    if header_token:
        return header_token
    params = params or {}
    return (params.get("token", [""])[0] or "").strip()


def request_authorized(handler, params=None):
    return authorized_by_access(handler) or token_allowed(request_token(handler, params))


def is_websocket_upgrade(headers):
    return (
        headers.get("Upgrade", "").strip().lower() == "websocket"
        and "upgrade"
        in {value.strip().lower() for value in headers.get("Connection", "").split(",")}
    )


def read_subscription():
    try:
        with open(SUBSCRIPTION_FILE, "r", encoding="utf-8") as subscription_file:
            return subscription_file.read().strip() + "\n"
    except OSError:
        return ""


def html_page(title, body):
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0f1420">
  <title>{html.escape(title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --surface-ice: #f7faff;
      --surface-frost: #eef4fc;
      --surface-silver: #dde6f3;
      --ink-graphite: #0f1420;
      --ink-deep: #161e30;
      --ink: #1a2233;
      --ink-muted: #5d6b85;
      --ink-soft: #93a1bb;
      --ink-on-dark: #cdd9ee;
      --ink-on-dark-soft: #7e8db0;
      --accent-cobalt: #2f6fe4;
      --accent-cobalt-strong: #1f57c4;
      --accent-cyan: #4fd6f5;
      --line: #c8d4e6;
      --line-arm: #aebfda;
      --line-dark: #2a3852;
      --success: #2faa78;
      --danger: #e2574e;
      --ease: cubic-bezier(.2,.7,.2,1);
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif;
    }}
    * {{ box-sizing: border-box; }}
    html {{ min-width: 320px; background: var(--ink-graphite); }}
    body {{ min-width: 320px; min-height: 100vh; margin: 0; overflow-x: hidden; background: var(--surface-ice); color: var(--ink); }}
    button, input, textarea {{ font: inherit; }}
    button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible {{ outline: 3px solid rgba(79,214,245,.55); outline-offset: 3px; }}
    a {{ color: inherit; text-decoration: none; }}
    p, h1, h2 {{ margin: 0; }}
    .shell {{ min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }}
    .topbar {{ min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 clamp(20px,5vw,64px); border-bottom: 1px solid var(--line-dark); background: var(--ink-graphite); color: var(--ink-on-dark); }}
    .brand {{ display: inline-flex; align-items: center; gap: 12px; }}
    .brand-mark {{ width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--accent-cyan); border-radius: 4px; color: var(--accent-cyan); font-weight: 800; box-shadow: inset 0 0 0 4px var(--ink-deep); }}
    .brand strong, .brand small {{ display: block; }}
    .brand strong {{ font-size: 15px; letter-spacing: -.03em; }}
    .brand small, .tick {{ font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; }}
    .brand small {{ margin-top: 3px; color: var(--ink-on-dark-soft); }}
    .back-link {{ color: var(--ink-on-dark-soft); font-size: 12px; transition: color 140ms ease; }}
    .back-link:hover {{ color: var(--accent-cyan); }}
    main {{ position: relative; display: grid; grid-template-columns: minmax(260px,.72fr) minmax(420px,1.28fr); min-height: 620px; overflow: hidden; }}
    main::before {{ position: absolute; width: 440px; height: 440px; right: -220px; bottom: -250px; border: 1px solid rgba(47,111,228,.16); border-radius: 50%; content: ""; pointer-events: none; }}
    .intro {{ min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 24px; padding: clamp(48px,8vw,110px) clamp(24px,6vw,86px); border-right: 1px solid var(--line); background: var(--surface-frost); }}
    .intro .tick {{ color: var(--accent-cobalt); }}
    .intro h1 {{ max-width: 8ch; overflow-wrap: anywhere; font-size: clamp(38px,5.6vw,72px); line-height: .98; letter-spacing: -.075em; }}
    .intro p {{ max-width: 34ch; color: var(--ink-muted); font-size: 15px; line-height: 1.75; }}
    .energy-rail {{ display: flex; align-items: center; gap: 10px; color: var(--ink-soft); }}
    .energy-rail::before {{ width: 54px; height: 2px; background: var(--accent-cobalt); content: ""; box-shadow: 22px 0 0 -1px var(--accent-cyan); }}
    .stage {{ position: relative; min-width: 0; display: grid; place-items: center; padding: clamp(28px,6vw,76px); }}
    .panel {{ position: relative; min-width: 0; width: min(100%,620px); overflow: hidden; border: 1px solid var(--line-arm); border-radius: 10px; padding: clamp(24px,4vw,42px); background: var(--surface-frost); box-shadow: 0 20px 56px rgba(15,20,32,.12); }}
    .panel::after {{ position: absolute; top: -1px; right: 24px; width: 72px; height: 2px; background: var(--accent-cobalt); content: ""; }}
    .panel-head {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }}
    .panel-head .tick {{ color: var(--ink-muted); }}
    .state-pill {{ display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-ice); color: var(--ink-muted); font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; letter-spacing: .08em; }}
    .state-pill::before {{ width: 6px; height: 6px; border-radius: 50%; background: var(--accent-cyan); content: ""; box-shadow: 0 0 7px rgba(79,214,245,.7); }}
    .panel h2 {{ font-size: clamp(27px,4vw,40px); line-height: 1.08; letter-spacing: -.055em; }}
    .lede {{ margin-top: 12px; color: var(--ink-muted); font-size: 14px; line-height: 1.65; }}
    .ip-readout {{ display: grid; gap: 7px; margin-top: 28px; padding: 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--ink-deep); color: var(--ink-on-dark); }}
    .ip-readout span {{ color: var(--ink-on-dark-soft); font-size: 10px; letter-spacing: .09em; text-transform: uppercase; }}
    .ip-readout code {{ overflow-wrap: anywhere; color: var(--accent-cyan); font-family: "SFMono-Regular", Consolas, monospace; font-size: 15px; }}
    .gate-form {{ display: grid; gap: 18px; margin-top: 24px; }}
    .field {{ display: grid; gap: 7px; }}
    .field label {{ color: var(--ink-muted); font-size: 11px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }}
    input, textarea {{ width: 100%; border: 1px solid var(--line-arm); border-radius: 5px; padding: 12px 13px; background: var(--surface-ice); color: var(--ink); }}
    input:hover, textarea:hover {{ border-color: var(--accent-cobalt); }}
    input:focus, textarea:focus {{ border-color: var(--accent-cobalt); outline: 3px solid rgba(79,214,245,.3); }}
    .field-note {{ color: var(--ink-soft); font-size: 11px; line-height: 1.5; }}
    .submit {{ min-height: 48px; display: inline-flex; align-items: center; justify-content: space-between; gap: 24px; border: 1px solid var(--accent-cobalt-strong); border-radius: 5px; padding: 11px 16px; background: var(--accent-cobalt); color: #f7faff; font-weight: 700; cursor: pointer; transition: transform 150ms var(--ease), background 150ms ease; }}
    .submit:hover {{ background: var(--accent-cobalt-strong); transform: translateY(-1px); }}
    .submit:active {{ transform: translateY(1px); }}
    .result {{ display: grid; gap: 16px; }}
    .result-mark {{ width: 58px; height: 58px; display: grid; place-items: center; border: 1px solid var(--success); border-radius: 50%; color: var(--success); font-size: 24px; }}
    .result-mark.error {{ border-color: var(--danger); color: var(--danger); }}
    .result-details {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }}
    .result-details div {{ min-width: 0; padding: 13px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-ice); }}
    .result-details span, .result-details code {{ display: block; }}
    .result-details span {{ color: var(--ink-muted); font-size: 10px; }}
    .result-details code {{ margin-top: 5px; overflow-wrap: anywhere; color: var(--accent-cobalt-strong); font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }}
    .subscription {{ display: grid; gap: 8px; margin-top: 8px; }}
    .subscription h3 {{ margin: 0; font-size: 14px; }}
    textarea {{ min-height: 132px; resize: vertical; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; line-height: 1.55; }}
    footer {{ display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px clamp(20px,5vw,64px); border-top: 1px solid var(--line-dark); background: var(--ink-graphite); color: var(--ink-on-dark-soft); font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }}
    @media (max-width: 760px) {{
      .topbar {{ min-height: 66px; }}
      .back-link {{ display: none; }}
      main {{ grid-template-columns: 1fr; }}
      .intro {{ gap: 16px; padding-block: 42px; border-right: 0; border-bottom: 1px solid var(--line); }}
      .intro h1 {{ max-width: 12ch; font-size: clamp(34px,11vw,54px); }}
      .stage {{ padding: 24px 18px 42px; }}
      .panel {{ padding: 24px 20px; }}
      .panel-head {{ align-items: flex-start; flex-direction: column; margin-bottom: 22px; }}
      .state-pill {{ max-width: 100%; white-space: normal; }}
      .result-details {{ grid-template-columns: 1fr; }}
      footer {{ align-items: flex-start; flex-direction: column; }}
    }}
    @media (prefers-reduced-motion: reduce) {{ *,*::before,*::after {{ animation-duration: .01ms !important; transition-duration: .01ms !important; }} }}
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="返回 cksheuen 首页">
        <span class="brand-mark" aria-hidden="true">P</span>
        <span><strong>Pingu Gate</strong><small>network authorization</small></span>
      </a>
      <a class="back-link" href="/">返回服务首页 ↗</a>
    </header>
    <main>
      <section class="intro">
        <span class="tick">PRIVATE NETWORK / GATE 01</span>
        <h1>短期授权，持续可达。</h1>
        <p>只把当前公网地址加入临时白名单。Pingu 桌面端会在连接前续租，不需要维护固定 IP。</p>
        <span class="energy-rail tick">LEASE CONTROL</span>
      </section>
      <section class="stage"><div class="panel">{body}</div></section>
    </main>
    <footer><span>CKSHEUEN / PRIVATE INFRASTRUCTURE</span><span>TLS · SHORT LEASE · NFTABLES</span></footer>
  </div>
</body>
</html>"""


def redact_sensitive_paths(value):
    result = str(value)
    for prefix in (
        device_access.DEVICE_WS_PREFIX,
        device_access.DEVICE_SUBSCRIPTION_PREFIX,
    ):
        pattern = rf"({re.escape(prefix.rstrip('/'))}/)[A-Za-z0-9_-]+"
        result = re.sub(pattern, r"\1<redacted>", result)
    return result


def parse_form_body(handler):
    try:
        length = min(int(handler.headers.get("Content-Length", "0") or "0"), 8192)
    except ValueError:
        length = 0
    raw = handler.rfile.read(length).decode("utf-8", errors="ignore")
    return urllib.parse.parse_qs(raw)


def resolve_device_websocket(path, registry=DEVICE_REGISTRY):
    parsed_path = urllib.parse.urlparse(path).path
    is_device_path = parsed_path.startswith(device_access.DEVICE_WS_PREFIX.rstrip("/") + "/")
    if not is_device_path:
        return False, "", None, path
    token = device_access.device_token_from_path(parsed_path)
    return True, token, registry.authenticate(token), "/"


class GateHandler(http.server.BaseHTTPRequestHandler):
    server_version = "pingu-gate/1.1"

    def log_message(self, fmt, *args):
        message = redact_sensitive_paths(fmt % args)
        print(
            "%s %s - %s"
            % (
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                self.address_string(),
                message,
            ),
            flush=True,
        )

    def send_bytes(self, status, data, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
            "base-uri 'none'; frame-ancestors 'none'",
        )
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, status, text, content_type="text/plain; charset=utf-8"):
        self.send_bytes(status, text.encode("utf-8"), content_type)

    def send_json(self, status, payload):
        self.send_bytes(
            status,
            (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def send_html(self, status, title, body, extra_headers=None):
        self.send_bytes(
            status,
            html_page(title, body).encode("utf-8"),
            "text/html; charset=utf-8",
            extra_headers,
        )

    def redirect(self, location, extra_headers=None):
        headers = {"Location": location}
        headers.update(extra_headers or {})
        self.send_bytes(HTTPStatus.SEE_OTHER, b"", "text/plain; charset=utf-8", headers)

    def device_session_id(self):
        jar = cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except cookies.CookieError:
            return ""
        morsel = jar.get(DEVICE_SESSION_COOKIE)
        return morsel.value if morsel else ""

    def require_device_session(self, params=None):
        session_id = self.device_session_id()
        csrf = None if params is None else ((params.get("csrf", [""])[0] or "").strip())
        if not DEVICE_SESSIONS.valid(session_id, csrf):
            self.send_text(HTTPStatus.FORBIDDEN, "device management authentication required\n")
            return ""
        return session_id

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith(PATH_PREFIX):
            if is_websocket_upgrade(self.headers):
                self.handle_ws_proxy()
            else:
                self.handle_portal_proxy()
            return
        if parsed.path in (PATH_PREFIX, PATH_PREFIX + "/"):
            self.show_form()
            return
        if parsed.path == PATH_PREFIX + "/devices":
            self.show_devices()
            return
        if parsed.path.startswith(device_access.DEVICE_SUBSCRIPTION_PREFIX.rstrip("/") + "/"):
            self.handle_device_subscription(parsed.path)
            return
        if parsed.path == PATH_PREFIX + "/allow":
            self.handle_allow(urllib.parse.parse_qs(parsed.query))
            return
        if parsed.path == PATH_PREFIX + "/status":
            try:
                ip = client_ip_from_headers(self)
            except ValueError:
                self.send_text(HTTPStatus.BAD_REQUEST, "invalid client ip\n")
                return
            self.send_text(
                HTTPStatus.OK,
                f"ok\nclient_ip={ip}\naccess_email={access_email(self) or '-'}\n",
            )
            return
        if parsed.path in (PATH_PREFIX + "/sub", PATH_PREFIX + "/subscription"):
            self.handle_subscription(urllib.parse.parse_qs(parsed.query))
            return
        self.send_text(HTTPStatus.NOT_FOUND, "not found\n")

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith(PATH_PREFIX):
            self.send_text(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed\n")
            return
        self.handle_portal_proxy(head_only=True)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == PATH_PREFIX + "/lease":
            self.handle_lease()
            return
        if parsed.path == PATH_PREFIX + "/devices/login":
            self.handle_device_login(parse_form_body(self))
            return
        if parsed.path == PATH_PREFIX + "/devices/create":
            self.handle_device_create(parse_form_body(self))
            return
        if parsed.path == PATH_PREFIX + "/devices/revoke":
            self.handle_device_revoke(parse_form_body(self))
            return
        if parsed.path != PATH_PREFIX + "/allow":
            self.send_text(HTTPStatus.NOT_FOUND, "not found\n")
            return
        self.handle_allow(parse_form_body(self))

    def show_form(self):
        ip = client_ip_from_headers(self)
        body = f"""
<div class="panel-head"><span class="tick">AUTHORIZATION / 01</span><span class="state-pill">NETWORK DETECTED</span></div>
<h2>授权当前网络</h2>
<p class="lede">验证访问凭证后，当前地址会获得一段可自动过期的 Reality 访问租约。</p>
<div class="ip-readout"><span>检测到的公网 IP</span><code>{html.escape(str(ip))}</code></div>
<form class="gate-form" method="post" action="{html.escape(PATH_PREFIX)}/allow">
  <div class="field">
    <label for="gate-token">一次性访问凭证</label>
    <input id="gate-token" name="token" type="password" autocomplete="one-time-code" placeholder="输入 Gate token" required>
    <span class="field-note">凭证只用于本次请求，页面不会在浏览器中保存。</span>
  </div>
  <div class="field">
    <label for="gate-ttl">授权时长</label>
    <input id="gate-ttl" name="ttl" value="{html.escape(DEFAULT_TTL)}" placeholder="例如 12h 或 7d" required>
    <span class="field-note">Pingu 桌面端使用更短的自动续租；这里适合临时手动授权。</span>
  </div>
  <button class="submit" type="submit"><span>授权当前设备</span><span aria-hidden="true">→</span></button>
</form>
<a class="submit" style="margin-top:12px" href="{html.escape(PATH_PREFIX)}/devices"><span>管理第三方订阅设备</span><span aria-hidden="true">↗</span></a>
"""
        self.send_html(HTTPStatus.OK, "Pingu Gate", body)

    def authorize_ip(self, ttl):
        try:
            ip = client_ip_from_headers(self)
            ttl_seconds = parse_duration_seconds(ttl)
        except ValueError as error:
            return None, None, None, str(error)
        element = normalize_allow_element(ip)
        set_name = allow_set_for_ip(ip)
        proc = nft_refresh(set_name, element, ttl)
        if proc.returncode != 0:
            return None, None, None, (proc.stderr or "nft refresh failed").strip()
        expires_at = (
            dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=ttl_seconds)
        ).isoformat(timespec="seconds")
        return element, ttl_seconds, expires_at, None

    def handle_lease(self):
        if not request_authorized(self):
            self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return
        element, ttl_seconds, expires_at, error = self.authorize_ip(LEASE_TTL)
        if error:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "lease_update_failed"},
            )
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "ip": element,
                "ttl_seconds": ttl_seconds,
                "expires_at": expires_at,
            },
        )

    def handle_allow(self, params):
        if not request_authorized(self, params):
            self.send_html(
                HTTPStatus.UNAUTHORIZED,
                "Unauthorized",
                """
<div class="panel-head"><span class="tick">AUTHORIZATION / ERROR</span><span class="state-pill">REQUEST DENIED</span></div>
<div class="result"><span class="result-mark error" aria-hidden="true">×</span><h2>凭证无效</h2><p class="lede">当前网络没有被加入白名单。请返回并检查一次性访问凭证。</p><a class="submit" href="./"><span>重新授权</span><span aria-hidden="true">←</span></a></div>
""",
            )
            return
        ttl = (params.get("ttl", [DEFAULT_TTL])[0] or DEFAULT_TTL).strip()
        element, _, _, error = self.authorize_ip(ttl)
        if error:
            self.send_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"authorization failed\n{error}\n")
            return
        subscription = read_subscription()
        subscription_block = ""
        if subscription:
            subscription_block = f"""
<div class="subscription"><h3>客户端订阅</h3><textarea readonly aria-label="客户端订阅">{html.escape(subscription)}</textarea></div>
"""
        body = f"""
<div class="panel-head"><span class="tick">AUTHORIZATION / COMPLETE</span><span class="state-pill">LEASE ACTIVE</span></div>
<div class="result">
  <span class="result-mark" aria-hidden="true">✓</span>
  <div><h2>当前网络已授权</h2><p class="lede">Reality 白名单已更新。Pingu 会在后续连接中自动续租。</p></div>
  <div class="result-details">
    <div><span>授权地址</span><code>{html.escape(element)}</code></div>
    <div><span>有效期</span><code>{html.escape(ttl)}</code></div>
  </div>
  {subscription_block}
</div>
"""
        self.send_html(HTTPStatus.OK, "Allowed", body)

    def show_devices(self, error=""):
        session_id = self.device_session_id()
        if error or not DEVICE_SESSIONS.valid(session_id):
            error_block = (
                f'<p class="lede" style="color:var(--danger)">{html.escape(error)}</p>'
                if error
                else ""
            )
            body = f"""
<div class="panel-head"><span class="tick">DEVICE ACCESS / LOGIN</span><span class="state-pill">KEY REQUIRED</span></div>
<h2>管理第三方设备</h2>
<p class="lede">输入一次 Gate 访问密钥后，才能创建或撤销专属订阅。密钥不会写入 URL、Cookie 或设备记录。</p>
{error_block}
<form class="gate-form" method="post" action="{html.escape(PATH_PREFIX)}/devices/login">
  <div class="field">
    <label for="device-access-key">Gate 访问密钥</label>
    <input id="device-access-key" name="token" type="password" autocomplete="one-time-code" required>
    <span class="field-note">认证会话默认持续 {DEVICE_SESSION_TTL // 60} 分钟。</span>
  </div>
  <button class="submit" type="submit"><span>进入设备管理</span><span aria-hidden="true">→</span></button>
</form>
"""
            self.send_html(
                HTTPStatus.UNAUTHORIZED if error else HTTPStatus.OK,
                "Device Access",
                body,
            )
            return

        csrf = DEVICE_SESSIONS.csrf(session_id)
        rows = []
        for device in sorted(DEVICE_REGISTRY.list(), key=lambda item: item["created_at"], reverse=True):
            state = "已撤销" if device.get("revoked_at") else "有效"
            revoke = ""
            if not device.get("revoked_at"):
                revoke = f"""
<form method="post" action="{html.escape(PATH_PREFIX)}/devices/revoke">
  <input type="hidden" name="csrf" value="{html.escape(csrf)}">
  <input type="hidden" name="device_id" value="{html.escape(device['id'])}">
  <button class="submit" type="submit"><span>撤销</span><span aria-hidden="true">×</span></button>
</form>"""
            rows.append(
                f"""<div class="result-details" style="margin-top:12px">
	  <div><span>用户 / 设备</span><code>{html.escape(device['owner'])} / {html.escape(device['name'])}</code></div>
	  <div><span>创建时间</span><code>{html.escape(str(device.get('created_at') or '—'))}</code></div>
	  <div><span>状态 / 连接次数</span><code>{state} / {device['connection_count']}</code></div>
  <div><span>最后连接</span><code>{html.escape(str(device.get('last_seen_at') or '—'))}</code></div>
  <div><span>最后 IP</span><code>{html.escape(str(device.get('last_ip') or '—'))}</code></div>
</div>{revoke}"""
            )
        body = f"""
<div class="panel-head"><span class="tick">DEVICE ACCESS / MANAGE</span><span class="state-pill">AUTHENTICATED</span></div>
<h2>专属订阅设备</h2>
<p class="lede">每台设备使用独立连接路径。创建后的订阅链接和二维码只显示一次；遗失时请撤销并重建。</p>
<form class="gate-form" method="post" action="{html.escape(PATH_PREFIX)}/devices/create">
  <input type="hidden" name="csrf" value="{html.escape(csrf)}">
  <div class="field"><label for="device-owner">用户</label><input id="device-owner" name="owner" maxlength="80" required></div>
  <div class="field"><label for="device-name">设备名称</label><input id="device-name" name="name" maxlength="80" required></div>
  <button class="submit" type="submit"><span>创建专属订阅</span><span aria-hidden="true">＋</span></button>
</form>
<div class="subscription"><h3>现有设备</h3>{''.join(rows) or '<p class="lede">尚未创建设备。</p>'}</div>
"""
        self.send_html(HTTPStatus.OK, "Device Access", body)

    def handle_device_login(self, params):
        token = (params.get("token", [""])[0] or "").strip()
        if not token_allowed(token):
            self.show_devices("访问密钥无效。")
            return
        session_id, _ = DEVICE_SESSIONS.issue()
        cookie = (
            f"{DEVICE_SESSION_COOKIE}={session_id}; Path={PATH_PREFIX}/devices; "
            f"Max-Age={DEVICE_SESSION_TTL}; Secure; HttpOnly; SameSite=Strict"
        )
        self.redirect(PATH_PREFIX + "/devices", {"Set-Cookie": cookie})

    def handle_device_create(self, params):
        session_id = self.require_device_session(params)
        if not session_id:
            return
        owner = (params.get("owner", [""])[0] or "").strip()
        name = (params.get("name", [""])[0] or "").strip()
        if not owner or not name:
            self.send_text(HTTPStatus.BAD_REQUEST, "owner and device name are required\n")
            return
        template = read_subscription()
        try:
            device_access.build_device_subscription(template, "validation", owner, name)
        except ValueError as error:
            self.send_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"{error}\n")
            return
        record, token = DEVICE_REGISTRY.create(owner, name)
        url = device_access.subscription_url(token)
        try:
            qr_svg = device_access.render_qr_svg(url)
        except RuntimeError as error:
            DEVICE_REGISTRY.revoke(record["id"])
            self.send_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"{error}\n")
            return
        body = f"""
<div class="panel-head"><span class="tick">DEVICE ACCESS / CREATED</span><span class="state-pill">SHOW ONCE</span></div>
<h2>专属订阅已创建</h2>
<p class="lede">用户：{html.escape(record['owner'])} · 设备：{html.escape(record['name'])}。导入后无需再按网络续签 IP。</p>
<div class="subscription">
  <h3>订阅链接（仅显示本次）</h3>
  <textarea readonly aria-label="专属订阅链接">{html.escape(url)}</textarea>
  <div style="max-width:280px;padding:16px;background:#fff;border:1px solid var(--line);border-radius:8px">{qr_svg}</div>
</div>
<form class="gate-form" method="get" action="{html.escape(PATH_PREFIX)}/devices">
  <button class="submit" type="submit"><span>返回设备管理</span><span aria-hidden="true">←</span></button>
</form>
"""
        self.send_html(HTTPStatus.CREATED, "Device Created", body)

    def handle_device_revoke(self, params):
        if not self.require_device_session(params):
            return
        device_id = (params.get("device_id", [""])[0] or "").strip()
        if not DEVICE_REGISTRY.revoke(device_id):
            self.send_text(HTTPStatus.NOT_FOUND, "device not found or already revoked\n")
            return
        self.redirect(PATH_PREFIX + "/devices")

    def handle_device_subscription(self, path):
        token = device_access.subscription_token_from_path(path)
        device = DEVICE_REGISTRY.authenticate(token)
        if not device:
            self.send_text(HTTPStatus.FORBIDDEN, "invalid or revoked device subscription\n")
            return
        try:
            subscription = device_access.build_device_subscription(
                read_subscription(), token, device["owner"], device["name"]
            )
        except ValueError as error:
            self.send_text(HTTPStatus.INTERNAL_SERVER_ERROR, f"{error}\n")
            return
        print(
            json.dumps(
                {
                    "event": "device_subscription_fetch",
                    "device_id": device["id"],
                    "owner": device["owner"],
                    "name": device["name"],
                    "source_ip": str(client_ip_from_headers(self)),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        self.send_text(HTTPStatus.OK, subscription)

    def handle_subscription(self, params):
        if not (request_authorized(self, params) or is_allowlisted(self)):
            self.send_html(
                HTTPStatus.UNAUTHORIZED,
                "Unauthorized",
                """
<div class="panel-head"><span class="tick">SUBSCRIPTION / ERROR</span><span class="state-pill">REQUEST DENIED</span></div>
<div class="result"><span class="result-mark error" aria-hidden="true">×</span><h2>尚未授权</h2><p class="lede">先为当前网络签发租约，再读取客户端订阅。</p><a class="submit" href="./"><span>前往授权</span><span aria-hidden="true">→</span></a></div>
""",
            )
            return
        subscription = read_subscription()
        if not subscription:
            self.send_text(HTTPStatus.NOT_FOUND, "subscription not configured\n")
            return
        self.send_text(HTTPStatus.OK, subscription)

    def handle_portal_proxy(self, head_only=False):
        backend = http.client.HTTPConnection(
            PORTAL_BACKEND_HOST,
            PORTAL_BACKEND_PORT,
            timeout=PORTAL_PROXY_TIMEOUT,
        )
        try:
            backend.request(
                "HEAD" if head_only else "GET",
                self.path,
                headers={
                    "Host": self.headers.get("Host", ""),
                    "Accept": self.headers.get("Accept", "*/*"),
                    "Accept-Encoding": self.headers.get("Accept-Encoding", "identity"),
                    "X-Forwarded-For": str(client_ip_from_headers(self)),
                    "X-Forwarded-Proto": "https",
                },
            )
            response = backend.getresponse()
            length_header = response.getheader("Content-Length")
            if length_header and int(length_header) > PORTAL_MAX_RESPONSE_BYTES:
                self.send_text(HTTPStatus.BAD_GATEWAY, "portal response too large\n")
                return
            payload = b"" if head_only else response.read(PORTAL_MAX_RESPONSE_BYTES + 1)
            if len(payload) > PORTAL_MAX_RESPONSE_BYTES:
                self.send_text(HTTPStatus.BAD_GATEWAY, "portal response too large\n")
                return

            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() in PORTAL_RESPONSE_HEADERS:
                    self.send_header(key, value)
            if not head_only:
                self.send_header("Content-Length", str(len(payload)))
            elif length_header:
                self.send_header("Content-Length", length_header)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if not head_only:
                self.wfile.write(payload)
        except (OSError, http.client.HTTPException, ValueError):
            self.send_text(HTTPStatus.SERVICE_UNAVAILABLE, "portal unavailable\n")
        finally:
            backend.close()

    def handle_ws_proxy(self):
        if not is_websocket_upgrade(self.headers):
            self.send_text(HTTPStatus.NOT_FOUND, "not found\n")
            return
        is_device_path, device_token, device, backend_path = resolve_device_websocket(
            self.path, DEVICE_REGISTRY
        )
        source_ip = ""
        if is_device_path:
            try:
                source_ip = str(client_ip_from_headers(self))
            except ValueError:
                self.send_text(HTTPStatus.BAD_REQUEST, "invalid client ip\n")
                return
            if not device:
                self.send_text(HTTPStatus.FORBIDDEN, "invalid or revoked device\n")
                return
            backend_path = "/"
        elif not is_allowlisted(self):
            self.send_text(HTTPStatus.FORBIDDEN, "forbidden\n")
            return
        try:
            backend = socket.create_connection((WS_BACKEND_HOST, WS_BACKEND_PORT), timeout=8)
        except OSError as error:
            self.send_text(HTTPStatus.BAD_GATEWAY, f"backend unavailable: {error}\n")
            return
        if device:
            device = DEVICE_REGISTRY.record_connection(device_token, source_ip)
            if not device:
                backend.close()
                self.send_text(HTTPStatus.FORBIDDEN, "revoked device\n")
                return
            print(
                json.dumps(
                    {
                        "event": "device_ws_connect",
                        "device_id": device["id"],
                        "owner": device["owner"],
                        "name": device["name"],
                        "source_ip": source_ip,
                        "connection_count": device["connection_count"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        try:
            lines = [f"{self.command} {backend_path} {self.request_version}\r\n"]
            for key, value in self.headers.items():
                if key.lower() in {"cf-connecting-ip", "x-forwarded-for", "x-real-ip"}:
                    continue
                lines.append(f"{key}: {value}\r\n")
            lines.append(f"X-Forwarded-For: {client_ip_from_headers(self)}\r\n\r\n")
            backend.sendall("".join(lines).encode("iso-8859-1"))
            self.connection.setblocking(False)
            backend.setblocking(False)
            deadline = time.time() + WS_RELAY_TIMEOUT
            while time.time() < deadline:
                readable, _, _ = select.select([self.connection, backend], [], [], 30)
                if not readable:
                    continue
                for source in readable:
                    try:
                        data = source.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    target = backend if source is self.connection else self.connection
                    target.sendall(data)
        finally:
            try:
                backend.close()
            except OSError:
                pass


class ThreadingTLSServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_class, ssl_context):
        self.ssl_context = ssl_context
        super().__init__(server_address, handler_class)

    def process_request_thread(self, request, client_address):
        tls_request = None
        try:
            request.settimeout(TLS_HANDSHAKE_TIMEOUT)
            tls_request = self.ssl_context.wrap_socket(request, server_side=True)
            tls_request.settimeout(None)
        except (OSError, ssl.SSLError):
            self.shutdown_request(request)
            return
        try:
            self.finish_request(tls_request, client_address)
        except Exception:
            self.handle_error(tls_request, client_address)
        finally:
            self.shutdown_request(tls_request)


def main():
    parse_duration_seconds(DEFAULT_TTL)
    parse_duration_seconds(LEASE_TTL)
    if not read_tokens() and not ALLOWED_EMAILS:
        raise SystemExit(
            "missing PINGU_GATE_TOKENS_FILE/PINGU_GATE_TOKEN_FILE/"
            "PINGU_GATE_TOKENS or PINGU_GATE_ALLOWED_EMAILS"
        )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    httpd = ThreadingTLSServer((LISTEN_HOST, LISTEN_PORT), GateHandler, context)
    print(
        f"pingu-gate listening on {LISTEN_HOST}:{LISTEN_PORT} lease_ttl={LEASE_TTL}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
