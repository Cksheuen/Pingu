#!/usr/bin/env python3
"""Pingu's Mihomo configuration migration and bounded local controller client.

Runtime credentials stay in /etc/mihomo/config.json (0600). The migration
accepts only the deployed Pingu VLESS/Reality + loopback-WS contract; unknown
protocols or routing semantics fail instead of silently changing policy.
"""

import argparse
import ipaddress
import json
import os
import re
import secrets
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("PINGU_MIHOMO_CONFIG", "/etc/mihomo/config.json"))
CONTROLLER = "127.0.0.1:19090"
MAX_RESPONSE = 8 * 1024 * 1024


class MihomoError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def convert_xray(config, interface, controller_secret):
    """Return a Mihomo config preserving the known Pingu server contract."""
    if not isinstance(config, dict) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", interface):
        raise MihomoError("invalid source config or network interface")
    if len(controller_secret) < 32:
        raise MihomoError("controller secret must be at least 32 characters")
    outbounds = config.get("outbounds", [])
    direct = next((o for o in outbounds if o.get("tag") == "direct"), None)
    if not direct or direct.get("protocol") != "freedom":
        raise MihomoError("source must have a direct freedom outbound")
    for o in outbounds:
        if (o.get("tag"), o.get("protocol")) not in {
            ("direct", "freedom"), ("blocked", "blackhole")
        }:
            raise MihomoError("unsupported source outbound; migrate its policy explicitly")
    try:
        source_ip = str(ipaddress.IPv4Address(direct["sendThrough"]))
    except (KeyError, ValueError):
        raise MihomoError("source must have an explicit direct IPv4 binding") from None
    if direct.get("settings", {}).get("domainStrategy") != "UseIPv4":
        raise MihomoError("unsupported direct IP strategy")
    if config.get("dns") or config.get("reverse"):
        raise MihomoError("custom DNS/reverse configuration needs explicit migration")

    listeners = []
    ports = set()
    for inbound in config.get("inbounds", []):
        if inbound.get("protocol") != "vless":
            raise MihomoError("only Pingu VLESS inbounds are supported")
        stream = inbound.get("streamSettings", {})
        settings = inbound.get("settings", {})
        if settings.get("decryption", "none") != "none" or settings.get("fallbacks"):
            raise MihomoError("unsupported VLESS decryption or fallback")
        port = inbound.get("port")
        if not isinstance(port, int) or not 1 <= port <= 65535 or port in ports:
            raise MihomoError("invalid or duplicate inbound port")
        ports.add(port)
        listener = {
            "name": inbound.get("tag", "vless-{}".format(port)),
            "type": "vless", "listen": inbound.get("listen") or "0.0.0.0",
            "port": port, "users": [],
        }
        for index, client in enumerate(settings.get("clients", [])):
            if not isinstance(client.get("id"), str) or not client["id"]:
                raise MihomoError("inbound user has no UUID")
            user = {"username": client.get("email") or "{}-{}".format(listener["name"], index + 1),
                    "uuid": client["id"]}
            if client.get("flow"):
                if client["flow"] != "xtls-rprx-vision":
                    raise MihomoError("unsupported VLESS flow")
                user["flow"] = client["flow"]
            listener["users"].append(user)
        if not listener["users"]:
            raise MihomoError("inbound has no users")
        if stream.get("security") == "reality" and stream.get("network", "tcp") in ("tcp", "raw"):
            reality = stream.get("realitySettings", {})
            if reality.get("xver", 0) != 0:
                raise MihomoError("Reality PROXY protocol requires explicit migration")
            if not all(reality.get(k) for k in ("privateKey", "serverNames", "shortIds")):
                raise MihomoError("incomplete Reality settings")
            listener["reality-config"] = {
                "dest": reality.get("target") or reality.get("dest"),
                "private-key": reality["privateKey"],
                "short-id": reality["shortIds"],
                "server-names": reality["serverNames"],
            }
            if not listener["reality-config"]["dest"]:
                raise MihomoError("Reality handshake destination is missing")
        elif stream.get("network") == "ws" and stream.get("security", "none") == "none":
            try:
                loopback = ipaddress.ip_address(listener["listen"]).is_loopback
            except ValueError:
                loopback = False
            if not loopback:
                raise MihomoError("plaintext WS backend must remain loopback-only")
            if any(u.get("flow") for u in listener["users"]):
                raise MihomoError("Vision cannot be used on the WS backend")
            listener["ws-path"] = stream.get("wsSettings", {}).get("path", "/")
            listener["allow-insecure"] = True
        else:
            raise MihomoError("unsupported VLESS transport/security combination")
        listeners.append(listener)
    if not listeners:
        raise MihomoError("no VLESS listeners found")

    rules = []
    routing = config.get("routing", {})
    if routing.get("balancers"):
        raise MihomoError("source balancers require explicit migration")
    for rule in routing.get("rules", []):
        if set(rule) - {"type", "domain", "ip", "outboundTag"} or rule.get("type") != "field":
            raise MihomoError("unsupported source routing rule")
        target = {"blocked": "REJECT", "direct": "direct"}.get(rule.get("outboundTag"))
        if not target or (bool(rule.get("domain")) == bool(rule.get("ip"))):
            raise MihomoError("routing conditions cannot be converted without changing semantics")
        for domain in rule.get("domain", []):
            if domain.startswith("geosite:"):
                kind, value = "GEOSITE", domain[8:]
            elif domain.startswith("regexp:"):
                kind, value = "DOMAIN-REGEX", domain[7:]
            elif domain.startswith("domain:"):
                kind, value = "DOMAIN-SUFFIX", domain[7:]
            elif domain.startswith("full:"):
                kind, value = "DOMAIN", domain[5:]
            elif ":" not in domain:
                kind, value = "DOMAIN-KEYWORD", domain
            else:
                raise MihomoError("unsupported domain matcher")
            if "," in value or not value:
                raise MihomoError("invalid domain matcher")
            rules.append("{},{},{}".format(kind, value, target))
        for address in rule.get("ip", []):
            if address.startswith("geoip:") and not address.startswith("geoip:!"):
                rules.append("GEOIP,{},{}".format(address[6:], target))
            else:
                try:
                    net = ipaddress.ip_network(address, strict=False)
                except ValueError:
                    raise MihomoError("unsupported IP matcher") from None
                rules.append("{},{},{}".format("IP-CIDR6" if net.version == 6 else "IP-CIDR", net, target))
    rules.append("MATCH,direct")
    return {
        "mode": "rule", "ipv6": False, "allow-lan": False, "log-level": "info",
        "external-controller": CONTROLLER, "secret": controller_secret,
        "geodata-mode": True, "geodata-loader": "memconservative",
        "geo-auto-update": False,
        "pingu-public-ipv4": source_ip,
        "listeners": listeners,
        "proxies": [{"name": "direct", "type": "direct", "ip-version": "ipv4",
                     "interface-name": interface}],
        "rules": rules,
    }


def atomic_config(path, config):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix=".pingu-mihomo-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(config, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def controller_request(method, path, config_path=None):
    """Whitelist connection operations; never proxy arbitrary controller paths."""
    if not ((method == "GET" and path in ("/connections", "/version")) or
            (method == "DELETE" and (path == "/connections" or
             re.fullmatch(r"/connections/[A-Za-z0-9-]{1,128}", path)))):
        raise MihomoError("unsupported controller operation")
    try:
        cfg = json.loads(Path(config_path or CONFIG_PATH).read_text())
        address = cfg["external-controller"]
        host, port = address.rsplit(":", 1)
        if not ipaddress.ip_address(host.strip("[]")).is_loopback or not 1 <= int(port) <= 65535:
            raise ValueError()
        secret = cfg["secret"]
        if not isinstance(secret, str) or len(secret) < 32:
            raise ValueError()
    except (OSError, KeyError, ValueError, TypeError):
        raise MihomoError("local controller configuration is unavailable") from None
    request = urllib.request.Request("http://" + address + path, method=method,
                                     headers={"Authorization": "Bearer " + secret})
    # The controller is local; never send credentials through ambient proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=4) as response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise MihomoError("controller response exceeds limit")
            return json.loads(body) if body else {}
    except (OSError, ValueError):
        raise MihomoError("Mihomo controller is unavailable") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="/usr/local/etc/xray/config.json")
    parser.add_argument("--output", default=str(CONFIG_PATH))
    parser.add_argument("--interface", required=True)
    parser.add_argument("--apply", action="store_true", help="write a root-only Mihomo config")
    args = parser.parse_args()
    try:
        config = convert_xray(json.loads(Path(args.source).read_text()), args.interface, secrets.token_urlsafe(36))
        if args.apply:
            if Path(args.output).exists():
                raise MihomoError("output already exists; refusing to overwrite live credentials")
            atomic_config(args.output, config)
        print(json.dumps({"applied": args.apply, "output": args.output,
                          "listener_ports": [i["port"] for i in config["listeners"]],
                          "rule_count": len(config["rules"])}))
    except (MihomoError, OSError, ValueError) as exc:
        parser.exit(1, "migration failed: {}\n".format(exc))


if __name__ == "__main__":
    main()
