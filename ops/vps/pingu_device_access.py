"""Per-device access for generic subscription clients.

The module deliberately stores only a digest of the bearer token.  The token is
returned once at provisioning time and is then used as both the subscription
credential and the WebSocket path credential.  Xray remains localhost-only;
the Gate authenticates the device path before forwarding a WebSocket request.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import threading
import urllib.parse


DEVICE_WS_PREFIX = os.environ.get("PINGU_GATE_DEVICE_WS_PREFIX", "/__pingu_device__/v1")
DEVICE_SUBSCRIPTION_PREFIX = os.environ.get(
    "PINGU_GATE_DEVICE_SUBSCRIPTION_PREFIX", "/__pingu_gate__/devices/subscription"
)
DEVICE_STATE_FILE = os.environ.get(
    "PINGU_GATE_DEVICE_STATE_FILE", "/var/lib/pingu-gate/devices.json"
)
PUBLIC_ORIGIN = os.environ.get("PINGU_GATE_PUBLIC_ORIGIN", "https://cksheuen.site")
QR_ENCODE_BIN = os.environ.get("PINGU_GATE_QRENCODE_BIN", "/usr/bin/qrencode")

_LABEL_RE = re.compile(r"[^\w .@+:/-]+", re.UNICODE)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def token_digest(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def clean_label(value: str, fallback: str, limit: int = 80) -> str:
    cleaned = _LABEL_RE.sub("", (value or "").strip())[:limit].strip()
    return cleaned or fallback


def _atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class DeviceRegistry:
    """Small atomic registry suitable for a single Gate process."""

    def __init__(self, path: str | os.PathLike[str] = DEVICE_STATE_FILE):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._devices: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            return
        devices = payload.get("devices", []) if isinstance(payload, dict) else []
        if not isinstance(devices, list):
            return
        for device in devices:
            if not isinstance(device, dict):
                continue
            device_id = str(device.get("id", "")).strip()
            digest = str(device.get("token_digest", "")).strip()
            if device_id and re.fullmatch(r"[0-9a-f]{64}", digest):
                self._devices[device_id] = self._public_record(device)

    @staticmethod
    def _public_record(device: dict) -> dict:
        return {
            "id": str(device.get("id", "")),
            "owner": clean_label(str(device.get("owner", "")), "unassigned"),
            "name": clean_label(str(device.get("name", "")), "device"),
            "token_digest": str(device.get("token_digest", "")),
            "created_at": str(device.get("created_at", "")),
            "revoked_at": device.get("revoked_at"),
            "last_seen_at": device.get("last_seen_at"),
            "last_ip": device.get("last_ip"),
            "connection_count": int(device.get("connection_count", 0) or 0),
        }

    def _save_locked(self) -> None:
        _atomic_write(self.path, {"version": 1, "devices": list(self._devices.values())})

    def create(self, owner: str, name: str) -> tuple[dict, str]:
        owner_label = clean_label(owner, "unassigned")
        name_label = clean_label(name, "device")
        token = secrets.token_urlsafe(32)
        record = {
            "id": secrets.token_hex(8),
            "owner": owner_label,
            "name": name_label,
            "token_digest": token_digest(token),
            "created_at": utc_now(),
            "revoked_at": None,
            "last_seen_at": None,
            "last_ip": None,
            "connection_count": 0,
        }
        with self._lock:
            self._devices[record["id"]] = record
            self._save_locked()
        return dict(record), token

    def list(self) -> list[dict]:
        with self._lock:
            return [dict(device) for device in self._devices.values()]

    def authenticate(self, token: str) -> dict | None:
        digest = token_digest(token)
        if not token or len(token) > 200:
            return None
        with self._lock:
            for device in self._devices.values():
                if secrets.compare_digest(device["token_digest"], digest):
                    if device.get("revoked_at"):
                        return None
                    return dict(device)
        return None

    def revoke(self, device_id: str) -> bool:
        with self._lock:
            device = self._devices.get(device_id)
            if not device or device.get("revoked_at"):
                return False
            device["revoked_at"] = utc_now()
            self._save_locked()
            return True

    def record_connection(self, token: str, source_ip: str) -> dict | None:
        digest = token_digest(token)
        with self._lock:
            for device in self._devices.values():
                if not secrets.compare_digest(device["token_digest"], digest):
                    continue
                if device.get("revoked_at"):
                    return None
                device["last_seen_at"] = utc_now()
                device["last_ip"] = source_ip
                device["connection_count"] = int(device.get("connection_count", 0)) + 1
                self._save_locked()
                return dict(device)
        return None


class ManagementSessions:
    """Ephemeral operator sessions; access keys never leave the login body."""

    def __init__(self, ttl_seconds: int = 900):
        self.ttl_seconds = max(60, int(ttl_seconds))
        self._lock = threading.RLock()
        self._sessions: dict[str, tuple[str, float]] = {}

    def issue(self) -> tuple[str, str]:
        session_id = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        expires = dt.datetime.now(dt.timezone.utc).timestamp() + self.ttl_seconds
        with self._lock:
            self._sessions[session_id] = (csrf, expires)
        return session_id, csrf

    def valid(self, session_id: str, csrf: str | None = None) -> bool:
        now = dt.datetime.now(dt.timezone.utc).timestamp()
        with self._lock:
            session = self._sessions.get(session_id)
            if not session or session[1] < now:
                self._sessions.pop(session_id, None)
                return False
            if csrf is not None and not secrets.compare_digest(session[0], csrf):
                return False
            return True

    def csrf(self, session_id: str) -> str:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return ""
            return session[0]

def device_registry() -> DeviceRegistry:
    global _REGISTRY
    try:
        return _REGISTRY
    except NameError:
        _REGISTRY = DeviceRegistry()
        return _REGISTRY


def device_token_from_path(path: str) -> str:
    prefix = DEVICE_WS_PREFIX.rstrip("/") + "/"
    if not path.startswith(prefix):
        return ""
    token = path[len(prefix) :]
    if not token or "/" in token or token != urllib.parse.unquote(token) or len(token) > 200:
        return ""
    return token


def subscription_token_from_path(path: str) -> str:
    prefix = DEVICE_SUBSCRIPTION_PREFIX.rstrip("/") + "/"
    if not path.startswith(prefix):
        return ""
    token = path[len(prefix) :]
    if not token or "/" in token or token != urllib.parse.unquote(token) or len(token) > 200:
        return ""
    return token


def subscription_url(token: str, origin: str = PUBLIC_ORIGIN) -> str:
    return (
        origin.rstrip("/")
        + DEVICE_SUBSCRIPTION_PREFIX.rstrip("/")
        + "/"
        + urllib.parse.quote(token, safe="-_.~")
    )


def build_device_subscription(template: str, token: str, owner: str, name: str) -> str:
    """Extract the existing WS node and replace only its path/label."""

    for raw_line in template.splitlines():
        line = raw_line.strip()
        if not line or "://" not in line:
            continue
        try:
            parsed = urllib.parse.urlsplit(line)
            query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        except ValueError:
            continue
        values = dict(query)
        if parsed.scheme != "vless" or values.get("type") != "ws":
            continue
        values["path"] = f"{DEVICE_WS_PREFIX.rstrip('/')}/{token}"
        query_string = urllib.parse.urlencode(values)
        fragment = urllib.parse.quote(
            f"Pingu {clean_label(owner, 'unassigned')} / {clean_label(name, 'device')}",
            safe="-_.@",
        )
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path, query_string, fragment)
        ) + "\n"
    raise ValueError("subscription template has no VLESS WebSocket node")


def render_qr_svg(content: str, binary: str = QR_ENCODE_BIN) -> str:
    try:
        result = subprocess.run(
            [binary, "-t", "SVG", "-o", "-"],
            input=content,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("QR generator is unavailable") from error
    if result.returncode != 0 or "<svg" not in result.stdout[:512].lower():
        raise RuntimeError("QR generator failed")
    svg_index = result.stdout.lower().find("<svg")
    return result.stdout[svg_index:]
