"""Small Headscale adapter for Pingu's authenticated node-control endpoint.

One cloud permission generation owns one Headscale user. Revocation first
persists a tombstone, expires its keys, deletes its nodes and removes its user.
No auth key is ever passed in argv, logged, or written to the adapter journal.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

BINARY = os.environ.get("PINGU_HEADSCALE_BIN", "/usr/local/bin/headscale")
CONFIG = os.environ.get("PINGU_HEADSCALE_CONFIG", "/etc/pingu-mesh/config.yaml")
JOURNAL = os.environ.get("PINGU_MESH_JOURNAL", "/var/lib/pingu-gate/mesh-revoked.json")
CONTROL_URL = os.environ.get("PINGU_MESH_CONTROL_URL", "")
IPV4_CIDR = os.environ.get("PINGU_MESH_IPV4_CIDR", "100.117.234.0/24")


def _cli(*args):
    result = subprocess.run([BINARY, "-c", CONFIG, "-o", "json", *map(str, args)],
                            capture_output=True, text=True, timeout=8, check=False)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise RuntimeError("mesh control unavailable")
    try:
        return json.loads(result.stdout) if result.stdout.strip() else None
    except ValueError as exc:
        raise RuntimeError("invalid mesh control response") from exc


def _store(path, data):
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def control(data):
    identity = data.get("id", "")
    action = data.get("action")
    if not isinstance(identity, str) or not re.fullmatch(r"mesh-[a-f0-9]{32}-[a-f0-9]{32}", identity):
        raise ValueError("invalid mesh identity")
    if action not in ("enroll", "revoke"):
        raise ValueError("invalid mesh action")
    if not CONTROL_URL.startswith("https://"):
        raise RuntimeError("mesh control is not configured")
    path = Path(JOURNAL)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        revoked = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(revoked, dict):
            raise RuntimeError("invalid mesh journal")
        username = "pingu-" + hashlib.sha256(identity.encode()).hexdigest()[:40]
        if action == "enroll" and identity in revoked:
            raise ValueError("mesh identity revoked")
        if action == "revoke":
            revoked[identity] = int(time.time())
            _store(path, revoked)
        user = next((u for u in (_cli("users", "list") or []) if u["name"] == username), None)
        if action == "enroll":
            if user is None:
                user = _cli("users", "create", username)
            # Single-use, short-lived credentials; no reusable or ephemeral flags.
            key = _cli("preauthkeys", "create", "-u", user["id"], "-e", "10m")
            return {"id": identity, "state": "active", "control_url": CONTROL_URL,
                    "auth_key": key["key"], "hostname": "pingu-" + identity[5:17], "ipv4_cidr": IPV4_CIDR}
        if user is not None:
            for key in _cli("preauthkeys", "list") or []:
                if key.get("user", {}).get("id") == user["id"]:
                    _cli("preauthkeys", "expire", "-i", key["id"])
            for node in _cli("nodes", "list", "-u", username) or []:
                _cli("nodes", "delete", "-i", node["id"], "--force")
            # Removes issued key records and the user foreign key, preventing
            # an already-issued credential from rejoining after this returns.
            _cli("users", "destroy", "-i", user["id"], "--force")
        return {"id": identity, "state": "revoked"}
