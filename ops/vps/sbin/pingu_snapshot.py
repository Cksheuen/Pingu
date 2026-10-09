#!/usr/bin/env python3
"""Complete, verifiable application snapshots for Pingu VPS migration.

A snapshot is a gzip tarball holding ``manifest.json`` plus a ``rootfs/``
tree of every fixed-allowlist asset required to rebuild the Pingu proxy
stack on a fresh VPS.  Every file is SHA256-hashed in the manifest, the
whole archive is SHA256-bound, and verification/restore reject unsafe
tar members (traversal, devices, hardlinks, escaping symlinks, parent
symlink attacks) before anything touches disk.

Python 3.9 stdlib only.  No file contents are ever emitted into the
manifest or logs.
"""

import datetime as dt
import hashlib
import ipaddress
import json
import os
import platform
import posixpath
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import zlib
from pathlib import Path

MANIFEST_SCHEMA = "pingu-vps-snapshot/v1"  # Immutable legacy Xray contract.
MIHOMO_MANIFEST_SCHEMA = "pingu-vps-snapshot/v2"


class SnapshotError(Exception):
    """Raised for any snapshot creation, verification or restore failure."""


# --- Fixed allowlist of required assets (paths relative to source_root) ----

REQUIRED_FILES = [
    "usr/local/sbin/pingu-gate",
    "usr/local/sbin/pingu_device_access.py",
    "usr/local/sbin/pingu-traffic-guard",
    "usr/local/sbin/pingu-traffic-report",
    "usr/local/bin/xray",
    "usr/local/etc/xray/config.json",
    "etc/pingu-gate.subscription.txt",
    "etc/pingu-traffic-guard.conf",
    "etc/nftables.d/pingu-guard.nft",
    "var/lib/pingu-gate/devices.json",
    "etc/systemd/system/pingu-gate.service",
    "etc/systemd/system/cksheuen-portal.service",
    "etc/systemd/system/pingu-traffic-guard.service",
    "etc/systemd/system/pingu-traffic-guard.timer",
    "etc/systemd/system/pingu-traffic-report.service",
    "etc/systemd/system/pingu-traffic-report.timer",
    "etc/systemd/system/xray.service",
]

# At least one path from each inner group must exist.
REQUIRED_ANY = [
    ["etc/pingu-gate.token", "etc/pingu-gate.tokens"],
]

REQUIRED_DIRS = [
    "usr/local/share/xray",
    "usr/local/etc/xray/certs",
]

# Symlinks that must exist in every snapshot (checked at create and verify).
REQUIRED_SYMLINKS = [
    "var/www/cksheuen-portal/current",
]

# Optional assets: staged when present, reported when missing.
OPTIONAL_PATHS = [
    "etc/pingu-gate.env",
    "root/pingu-secrets",
    "etc/pingu-backup.conf",
    "usr/local/sbin/pingu-backup",
    "usr/local/sbin/pingu_snapshot.py",
    "etc/systemd/system/pingu-backup.service",
    "etc/systemd/system/pingu-backup.timer",
    "etc/systemd/system/pingu-backup.path",
]

OPTIONAL_DROPIN_DIRS = [
    "etc/systemd/system/pingu-gate.service.d",
    "etc/systemd/system/xray.service.d",
    "etc/systemd/system/cksheuen-portal.service.d",
]

# Defence-in-depth allowlist enforced at verify time: even a manifest with
# matching SHA256 entries can never restore paths outside this set.  SSH
# host keys, machine-id, network/cloud-init config and rclone.conf are
# permanently excluded, and host sysctl files are metadata-only (never
# restored onto a fresh host).
ALLOWED_RESTORE_PREFIXES = [
    "usr/local/sbin/pingu-gate",
    "usr/local/sbin/pingu_device_access.py",
    "usr/local/sbin/pingu-traffic-guard",
    "usr/local/sbin/pingu-traffic-report",
    "usr/local/sbin/pingu-backup",
    "usr/local/sbin/pingu_snapshot.py",
    "usr/local/bin/xray",
    "usr/local/etc/xray/config.json",
    "usr/local/etc/xray/certs",
    "usr/local/share/xray",
    "etc/pingu-gate.subscription.txt",
    "etc/pingu-gate.token",
    "etc/pingu-gate.tokens",
    "etc/pingu-gate.env",
    "etc/pingu-traffic-guard.conf",
    "etc/pingu-backup.conf",
    "etc/nftables.d/pingu-guard.nft",
    "var/lib/pingu-gate/devices.json",
    "etc/systemd/system/pingu-gate.service",
    "etc/systemd/system/cksheuen-portal.service",
    "etc/systemd/system/xray.service",
    "etc/systemd/system/pingu-traffic-guard.service",
    "etc/systemd/system/pingu-traffic-guard.timer",
    "etc/systemd/system/pingu-traffic-report.service",
    "etc/systemd/system/pingu-traffic-report.timer",
    "etc/systemd/system/pingu-backup.service",
    "etc/systemd/system/pingu-backup.timer",
    "etc/systemd/system/pingu-backup.path",
    "etc/systemd/system/pingu-gate.service.d",
    "etc/systemd/system/xray.service.d",
    "etc/systemd/system/cksheuen-portal.service.d",
    "root/pingu-secrets",
    "var/lib/pingu-traffic-guard",
    "var/www/cksheuen-portal",
]

# Profiles are deliberately disjoint: a Mihomo backup neither requires nor
# restores a stale Xray binary/config left on a migrated host.
_XRAY_PREFIXES = (
    "usr/local/bin/xray", "usr/local/etc/xray", "usr/local/share/xray",
    "etc/systemd/system/xray.service",
)
MIHOMO_FILES = [
    path for path in REQUIRED_FILES
    if not any(path.startswith(prefix) for prefix in _XRAY_PREFIXES)
] + [
    "usr/local/bin/mihomo",
    "usr/local/sbin/pingu_mihomo.py",
    "usr/local/sbin/pingu_connections.py",
    "etc/mihomo/config.json",
    "etc/mihomo/GeoIP.dat",
    "etc/mihomo/GeoSite.dat",
    "etc/pingu-gate/certs/cksheuen.site.crt",
    "etc/pingu-gate/certs/cksheuen.site.key",
    "etc/systemd/system/mihomo.service",
]
RUNTIME_CONTROL_PATHS = [
    "usr/local/sbin/pingu-runtime-controls",
    "etc/systemd/system/pingu-runtime-controls.service",
]
MIHOMO_DIRS = ["etc/pingu-gate/certs"]
MIHOMO_DROPIN_DIRS = [
    path for path in OPTIONAL_DROPIN_DIRS if "xray.service" not in path
] + ["etc/systemd/system/mihomo.service.d"]
MIHOMO_ALLOWED_PREFIXES = [
    path for path in ALLOWED_RESTORE_PREFIXES
    if not any(path.startswith(prefix) for prefix in _XRAY_PREFIXES)
] + MIHOMO_FILES + MIHOMO_DIRS + RUNTIME_CONTROL_PATHS + ["etc/systemd/system/mihomo.service.d"]


def runtime_controls(config):
    """Saved optional-policy state, without importing an executable controller."""
    state = config.get("pingu-runtime-controls")
    if state is None:
        return None
    fields = {"warp", "source_guard", "destination_filter", "traffic_guard"}
    if not isinstance(state, dict) or set(state) != fields or any(type(value) is not bool for value in state.values()):
        raise SnapshotError("invalid saved runtime controls")
    return state


def snapshot_profile(manifest):
    """Select a strict versioned contract, including old untagged archives."""
    if not isinstance(manifest, dict):
        raise SnapshotError("invalid manifest schema")
    if manifest.get("schema") == MANIFEST_SCHEMA:
        if manifest.get("runtime_profile", "xray") != "xray":
            raise SnapshotError("legacy snapshot schema requires xray profile")
        return "xray"
    if (manifest.get("schema") == MIHOMO_MANIFEST_SCHEMA
            and manifest.get("runtime_profile") == "mihomo"):
        return "mihomo"
    raise SnapshotError("invalid manifest schema or runtime profile")


def _profile_assets(profile):
    if profile == "mihomo":
        return MIHOMO_FILES, MIHOMO_DIRS, MIHOMO_DROPIN_DIRS, MIHOMO_ALLOWED_PREFIXES
    if profile == "xray":
        return REQUIRED_FILES, REQUIRED_DIRS, OPTIONAL_DROPIN_DIRS, ALLOWED_RESTORE_PREFIXES
    raise SnapshotError("unsupported runtime profile: {!r}".format(profile))


# Safe fq/bbr tunables captured as metadata only; never restored wholesale.
NETWORK_TUNING_KEYS = frozenset({
    "net.core.default_qdisc",
    "net.ipv4.tcp_congestion_control",
    "net.core.rmem_max",
    "net.core.wmem_max",
    "net.core.rmem_default",
    "net.core.wmem_default",
    "net.ipv4.tcp_rmem",
    "net.ipv4.tcp_wmem",
    "net.ipv4.tcp_fastopen",
    "net.ipv4.tcp_mtu_probing",
    "net.core.netdev_max_backlog",
    "net.ipv4.tcp_slow_start_after_idle",
    "net.ipv4.tcp_no_metrics_save",
})

# Defence-in-depth exclusions applied inside every recursively copied
# directory.  The allowlist above already keeps SSH keys, host keys,
# machine-id, network/cloud-init config, logs, journals, proc/tmp and
# rclone.conf out of the archive.
EXCLUDE_RE = re.compile(
    r"(^|/)(\.ssh|journal|logs?|tmp|proc|sys|dev|run)(/|$)"
    r"|ssh_host_|machine-id|rclone\.conf$|cloud-init|(^|/)network(/|$)",
    re.IGNORECASE,
)

_SNAPSHOT_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")


# --- helpers ---------------------------------------------------------------

def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _new_snapshot_id():
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return "{}-{}".format(stamp, secrets.token_hex(4))


def _validate_snapshot_id(snapshot_id):
    if not _SNAPSHOT_ID_RE.match(snapshot_id):
        raise SnapshotError("unsafe snapshot id: {!r}".format(snapshot_id))


def _excluded(rel_posix):
    return EXCLUDE_RE.search(rel_posix) is not None


def _copy_path(src, dst, rel):
    """Copy one allowlisted path, preserving mode and symlinks."""
    if _excluded(rel):
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
    elif src.is_dir():
        _copy_tree(src, dst, rel)
    elif src.is_file():
        shutil.copy2(src, dst)
    else:
        raise SnapshotError("unsupported file type for {}".format(rel))


def _copy_tree(src_dir, dst_dir, rel_prefix):
    dst_dir.mkdir(parents=True, exist_ok=True)
    for entry in sorted(os.scandir(src_dir), key=lambda e: e.name):
        rel = "{}/{}".format(rel_prefix, entry.name)
        if _excluded(rel):
            continue
        target = dst_dir / entry.name
        if entry.is_symlink():
            os.symlink(os.readlink(entry.path), target)
        elif entry.is_dir(follow_symlinks=False):
            _copy_tree(Path(entry.path), target, rel)
        elif entry.is_file(follow_symlinks=False):
            shutil.copy2(entry.path, target)
        else:
            raise SnapshotError("unsupported file type for {}".format(rel))


def _stage_portal(source_root, rootfs, missing):
    """Stage portal ``current`` symlink (normalized relative) + its release."""
    portal = source_root / "var/www/cksheuen-portal"
    current = portal / "current"
    if not current.is_symlink():
        missing.append("var/www/cksheuen-portal/current")
        return
    raw_target = os.readlink(current)
    releases_prefix = "/var/www/cksheuen-portal/releases/"
    if os.path.isabs(raw_target):
        norm = os.path.normpath(raw_target)
        if not norm.startswith(releases_prefix) or norm == releases_prefix.rstrip("/"):
            raise SnapshotError(
                "portal current symlink escapes releases: {}".format(raw_target)
            )
        rel = "releases/" + norm[len(releases_prefix):].strip("/")
    else:
        resolved = os.path.normpath(os.path.join(str(portal), raw_target))
        if not resolved.startswith(str(portal) + "/releases/"):
            raise SnapshotError(
                "portal current symlink escapes releases: {}".format(raw_target)
            )
        rel = os.path.relpath(resolved, str(portal))
    release_src = portal / rel
    if not release_src.is_dir():
        missing.append("var/www/cksheuen-portal/" + rel)
        return
    _copy_tree(release_src, rootfs / "var/www/cksheuen-portal" / rel,
               "var/www/cksheuen-portal/" + rel)
    link_parent = rootfs / "var/www/cksheuen-portal"
    link_parent.mkdir(parents=True, exist_ok=True)
    os.symlink(rel, link_parent / "current")


def _stage_optional(source_root, rootfs, present, missing, profile="xray"):
    for rel in OPTIONAL_PATHS + (RUNTIME_CONTROL_PATHS if profile == "mihomo" else []):
        src = source_root / rel
        if src.exists():
            _copy_path(src, rootfs / rel, rel)
            present.append(rel)
        else:
            missing.append(rel)
    for rel in _profile_assets(profile)[2]:
        src = source_root / rel
        if src.is_dir():
            _copy_tree(src, rootfs / rel, rel)
            present.append(rel)
        else:
            missing.append(rel)
    tg = source_root / "var/lib/pingu-traffic-guard"
    if tg.is_dir():
        found = False
        for entry in sorted(tg.glob("*.json")):
            rel = "var/lib/pingu-traffic-guard/" + entry.name
            _copy_path(entry, rootfs / rel, rel)
            present.append(rel)
            found = True
        if not found:
            missing.append("var/lib/pingu-traffic-guard/*.json")
    else:
        missing.append("var/lib/pingu-traffic-guard/*.json")


def _collect_network_tuning(source_root):
    """Capture allowlisted fq/bbr tunables as metadata (never restored).

    Host sysctl files are not staged: restoring them wholesale onto a fresh
    host would clobber its kernel defaults.  Only the safe, allowlisted
    tunable values are recorded, together with their source file names.
    """
    values = {}
    files = []
    paths = []
    sysctl_d = source_root / "etc/sysctl.d"
    if sysctl_d.is_dir():
        paths.extend(sorted(sysctl_d.glob("*.conf")))
    main_conf = source_root / "etc/sysctl.conf"
    if main_conf.is_file():
        paths.append(main_conf)
    for path in paths:
        file_had_value = False
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith(("#", ";")) or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            if key in NETWORK_TUNING_KEYS:
                values.setdefault(key, value.strip())
                file_had_value = True
        if file_had_value:
            files.append(path.relative_to(source_root).as_posix())
    return {"files": sorted(files), "values": values}


def _build_manifest_entries(rootfs):
    """Walk the staged rootfs and produce sorted, validated entries."""
    entries = []
    for base, dirs, files in os.walk(rootfs, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            full = Path(base) / name
            rel = full.relative_to(rootfs).as_posix()
            lst = full.lstat()
            mode = stat.S_IMODE(lst.st_mode)
            if stat.S_ISLNK(lst.st_mode):
                target = os.readlink(full)
                if os.path.isabs(target) or "\\" in target:
                    raise SnapshotError(
                        "absolute or unsafe symlink in staging: {}".format(rel)
                    )
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))
                if resolved.startswith("..") or resolved.startswith("/"):
                    raise SnapshotError(
                        "symlink escapes rootfs: {} -> {}".format(rel, target)
                    )
                entries.append({
                    "path": rel, "type": "symlink", "mode": mode,
                    "size": len(target), "link_target": target,
                })
            elif stat.S_ISDIR(lst.st_mode):
                entries.append({"path": rel, "type": "dir", "mode": mode, "size": 0})
            elif stat.S_ISREG(lst.st_mode):
                entries.append({
                    "path": rel, "type": "file", "mode": mode,
                    "size": lst.st_size, "sha256": sha256_file(full),
                })
            else:
                raise SnapshotError("unsupported staged entry type: {}".format(rel))
    entries.sort(key=lambda e: e["path"])
    return entries


def _read_os_release(source_root):
    data = {}
    path = source_root / "etc/os-release"
    if path.is_file():
        for line in path.read_text(errors="replace").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                data[key.strip()] = value.strip().strip('"')
    return data.get("ID", "unknown"), data.get("VERSION_ID", "unknown")


def _valid_public_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except (ValueError, TypeError):
        return False
    return not (
        address.is_loopback
        or address.is_unspecified
        or address.is_multicast
        or address.is_link_local
    )


def _is_literal_ipv6(value):
    try:
        ipaddress.IPv6Address(value)
    except (ValueError, TypeError):
        return False
    return True


def _load_mihomo_config(source_root):
    path = source_root / "etc/mihomo/config.json"
    return json.loads(path.read_text()) if path.is_file() else None


def _validate_mihomo_identity(config, source_ip):
    """A published backup must have sufficient identity for fresh-host remap."""
    if not isinstance(config, dict):
        raise SnapshotError("Mihomo config must be a JSON object")
    if (not isinstance(source_ip, str) or not _valid_public_ipv4(source_ip)
            or config.get("pingu-public-ipv4") != source_ip):
        raise SnapshotError("Mihomo public IPv4 metadata does not match manifest")
    proxies = config.get("proxies", [])
    if not isinstance(proxies, list) or not isinstance(config.get("listeners", []), list):
        raise SnapshotError("Mihomo proxies/listeners must be lists")
    direct = [proxy for proxy in proxies if isinstance(proxy, dict)
              and proxy.get("name") == "direct" and proxy.get("type") == "direct"]
    if len(direct) != 1:
        raise SnapshotError("Mihomo config must have one owned direct proxy")
    return direct[0]


def _load_xray_config(source_root):
    """Parse usr/local/etc/xray/config.json; returns None if absent."""
    cfg = source_root / "usr/local/etc/xray/config.json"
    if not cfg.is_file():
        return None
    return json.loads(cfg.read_text())


def _public_ipv4_from_xray(source_root):
    """The direct outbound sendThrough is the authoritative bound address."""
    config = _load_xray_config(source_root)
    if not isinstance(config, dict):
        return None
    for outbound in config.get("outbounds", []):
        if isinstance(outbound, dict) and outbound.get("tag") == "direct":
            value = outbound.get("sendThrough")
            if isinstance(value, str) and _valid_public_ipv4(value):
                return value
    return None


def detect_public_ipv4(source_root=None):
    """Best-effort source public IPv4 detection; never raises.

    Returns (address_or_None, origin_label). Mihomo's owned public-IP
    metadata or the legacy Xray direct outbound ``sendThrough`` identifies
    the source address. Local-machine probes are only
    used for a live ``/`` root, never for a mounted/fixture root where they
    would report the worker's own address.
    """
    if source_root is not None:
        try:
            root = Path(source_root)
            if (root / "etc/mihomo/config.json").is_file():
                config = _load_mihomo_config(root)
                address = config.get("pingu-public-ipv4") if isinstance(config, dict) else None
                if isinstance(address, str) and _valid_public_ipv4(address):
                    return address, "mihomo-config:pingu-public-ipv4"
                return None, "unknown"
            address = _public_ipv4_from_xray(root)
            if address:
                return address, "xray-config:sendThrough"
        except Exception:
            pass
        if str(source_root) != "/":
            return None, "unknown"
    try:
        proc = subprocess.run(
            ["ip", "-4", "route", "get", "1.1.1.1"],
            capture_output=True, text=True, timeout=5,
        )
        if proc.returncode == 0:
            match = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", proc.stdout)
            if match:
                return match.group(1), "ip-route"
    except Exception:
        pass
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("1.1.1.1", 53))
        address = sock.getsockname()[0]
        sock.close()
        return address, "udp-connect"
    except Exception:
        return None, "unknown"


def detect_public_origin(source_root=None):
    """HTTPS origin from the WS subscription node; never raises.

    Returns the VLESS WebSocket server origin (no UUID/userinfo, path, or
    query), falling back to the first non-IP VLESS hostname in the file.
    """
    if source_root is None:
        return None
    try:
        sub = Path(source_root) / "etc/pingu-gate.subscription.txt"
        if not sub.is_file():
            return None
        fallback = None
        for raw in sub.read_text(errors="replace").splitlines():
            line = raw.strip()
            if not line or "://" not in line:
                continue
            try:
                parsed = urllib.parse.urlsplit(line)
            except ValueError:
                continue
            if parsed.scheme != "vless" or not parsed.hostname:
                continue
            host = parsed.hostname
            if _valid_public_ipv4(host):
                continue
            port = parsed.port
            origin = "https://{}".format(host)
            if port not in (None, 443):
                origin += ":{}".format(port)
            try:
                values = dict(urllib.parse.parse_qsl(
                    parsed.query, keep_blank_values=True))
            except ValueError:
                values = {}
            if values.get("type") == "ws":
                return origin
            if fallback is None:
                fallback = origin
        return fallback
    except Exception:
        return None


def _validate_critical_json(source_root, profile="xray"):
    """Malformed critical JSON must abort before any archive is published."""
    for rel, kind in (
        ("etc/mihomo/config.json" if profile == "mihomo" else "usr/local/etc/xray/config.json",
         profile + " config"),
        ("var/lib/pingu-gate/devices.json", "device registry"),
    ):
        path = source_root / rel
        if not path.is_file():
            continue  # absence is handled by the required-asset check
        try:
            json.loads(path.read_text())
        except ValueError as exc:
            raise SnapshotError(
                "malformed {} {}: {}".format(kind, rel, exc)
            )


def _xray_referenced_files(config):
    """Asset paths referenced by an Xray config (relative to source_root)."""
    refs = set()
    if not isinstance(config, dict):
        return refs
    text = json.dumps(config)
    for match in re.finditer(r'"(?:geoip|geosite):ext-file:([^",]+)"', text):
        refs.add("usr/local/share/xray/" + match.group(1))

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ("certificateFile", "keyFile") and isinstance(value, str):
                    refs.add("usr/local/etc/xray/" + value.lstrip("/"))
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(config)
    return refs


def _check_xray_assets(source_root, missing):
    """GeoIP/Geosite and cert/key files must exist, not empty dirs."""
    share = source_root / "usr/local/share/xray"
    certs = source_root / "usr/local/etc/xray/certs"
    share_files = (
        [p for p in share.iterdir() if p.is_file()] if share.is_dir() else []
    )
    if not share_files:
        missing.append("usr/local/share/xray/ (GeoIP/Geosite data files)")
    for name in ("geoip.dat", "geosite.dat"):
        if not (share / name).is_file():
            missing.append("usr/local/share/xray/" + name)
    if not certs.is_dir() or not any(p.is_file() for p in certs.iterdir()):
        missing.append("usr/local/etc/xray/certs/ (certificate/key files)")
    try:
        config = _load_xray_config(source_root)
    except ValueError:
        config = None  # malformed config is reported by _validate_critical_json
    for rel in sorted(_xray_referenced_files(config)):
        if not (source_root / rel).is_file():
            missing.append(rel)


# --- create ----------------------------------------------------------------

def create_snapshot(output_dir, source_root="/", snapshot_id=None, runtime_profile=None):
    """Create a complete snapshot archive under ``output_dir/<id>/``.

    Returns a dict with snapshot_id, created_at, archive_path, sha256 and
    manifest.  Raises SnapshotError if any required asset is missing.
    """
    source_root = Path(source_root)
    profile = runtime_profile or ("mihomo" if any(
        (source_root / path).exists() for path in (
            "etc/mihomo/config.json", "usr/local/bin/mihomo",
            "etc/systemd/system/mihomo.service"
        )
    ) else "xray")
    required_files, required_dirs, _, _ = _profile_assets(profile)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(output_dir, 0o700)

    snapshot_id = snapshot_id or _new_snapshot_id()
    _validate_snapshot_id(snapshot_id)

    staging = Path(tempfile.mkdtemp(prefix="pingu-snapshot-"))
    try:
        rootfs = staging / "rootfs"
        rootfs.mkdir()
        missing = []
        optional_present = []
        optional_missing = []

        _validate_critical_json(source_root, profile)

        for rel in required_files:
            src = source_root / rel
            if ((src.is_file() and not src.is_symlink())
                    or (profile == "xray" and src.is_symlink())):
                _copy_path(src, rootfs / rel, rel)
            else:
                missing.append(rel)
        for group in REQUIRED_ANY:
            candidates = [g for g in group if (source_root / g).exists()]
            if not candidates:
                missing.append(" or ".join(group))
            else:
                for rel in candidates:
                    _copy_path(source_root / rel, rootfs / rel, rel)
        for rel in required_dirs:
            if (source_root / rel).is_dir():
                _copy_tree(source_root / rel, rootfs / rel, rel)
            else:
                missing.append(rel + "/")
        if profile == "xray":
            _check_xray_assets(source_root, missing)
        _stage_portal(source_root, rootfs, missing)
        _stage_optional(source_root, rootfs, optional_present, optional_missing, profile)
        if profile == "mihomo" and runtime_controls(_load_mihomo_config(source_root)) is not None:
            for rel in RUNTIME_CONTROL_PATHS:
                if not (rootfs / rel).is_file() or (rootfs / rel).is_symlink():
                    missing.append(rel)

        if missing:
            raise SnapshotError(
                "missing required assets: {}".format(", ".join(sorted(set(missing))))
            )

        entries = _build_manifest_entries(rootfs)
        if profile == "xray" and (source_root / "etc/mihomo/config.json").exists():
            # An explicitly requested rollback snapshot must use its own
            # config identity even on a host with both runtimes installed.
            public_ipv4 = _public_ipv4_from_xray(source_root)
            origin = "xray-config:sendThrough" if public_ipv4 else "unknown"
        else:
            public_ipv4, origin = detect_public_ipv4(source_root)
        if profile == "mihomo":
            _validate_mihomo_identity(_load_mihomo_config(source_root), public_ipv4)
        public_origin = detect_public_origin(source_root)
        os_id, os_version = _read_os_release(source_root)
        manifest = {
            "schema": MIHOMO_MANIFEST_SCHEMA if profile == "mihomo" else MANIFEST_SCHEMA,
            "runtime_profile": profile,
            "snapshot_id": snapshot_id,
            "created_at": now_iso(),
            "network_tuning": _collect_network_tuning(source_root),
            "source": {
                "os_id": os_id,
                "os_version": os_version,
                "architecture": platform.machine(),
                "kernel": platform.release(),
                "hostname": socket.gethostname(),
                "public_ipv4": public_ipv4,
                "public_ipv4_origin": origin,
                "public_origin": public_origin,
            },
            "entries": entries,
            "optional_present": sorted(optional_present),
            "optional_missing": sorted(optional_missing),
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        )

        snap_dir = output_dir / snapshot_id
        snap_dir.mkdir(mode=0o700)
        os.chmod(snap_dir, 0o700)
        archive_path = snap_dir / "snapshot.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(staging / "manifest.json", arcname="manifest.json")
            for child in sorted(rootfs.iterdir()):
                tar.add(child, arcname="rootfs/" + child.name)
        os.chmod(archive_path, 0o600)

        digest = sha256_file(archive_path)
        sums = snap_dir / "SHA256SUMS"
        sums.write_text("{}  snapshot.tar.gz\n".format(digest))
        os.chmod(sums, 0o600)

        return {
            "snapshot_id": snapshot_id,
            "created_at": manifest["created_at"],
            "archive_path": str(archive_path),
            "sha256": digest,
            "manifest": manifest,
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)


# --- verify ----------------------------------------------------------------

def _validate_member(member):
    """Reject any tar member that could be unsafe to extract."""
    name = member.name.rstrip("/")
    if name != "manifest.json" and not name.startswith("rootfs/"):
        raise SnapshotError("unexpected archive member: {}".format(member.name))
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts) or "\\" in name:
        raise SnapshotError("unsafe member path: {}".format(member.name))
    if member.islnk():
        raise SnapshotError("hardlink members are forbidden: {}".format(member.name))
    if not (member.isfile() or member.isdir() or member.issym()):
        raise SnapshotError("device/fifo members are forbidden: {}".format(member.name))
    if member.issym():
        target = member.linkname
        if not target or os.path.isabs(target) or "\\" in target:
            raise SnapshotError(
                "unsafe symlink target for {}: {!r}".format(member.name, target)
            )
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(name), target)
        )
        if resolved != "rootfs" and not resolved.startswith("rootfs/"):
            raise SnapshotError(
                "symlink escapes rootfs: {} -> {}".format(member.name, target)
            )


def _allowed_restore_path(rel, entry_type=None, profile="xray"):
    """Whether a rootfs-relative path is inside the fixed restore allowlist."""
    for allowed in _profile_assets(profile)[3]:
        if rel == allowed or rel.startswith(allowed + "/"):
            return True
    # Intermediate parent directories of allowed paths are permitted as
    # directories only (e.g. "etc", "usr/local") and can never carry files.
    if entry_type == "dir":
        for allowed in _profile_assets(profile)[3]:
            if allowed.startswith(rel + "/"):
                return True
    return False


def verify_snapshot(archive_path, expected_sha256=None):
    """Validate archive hash, tar safety, manifest completeness and per-file
    SHA256.  Returns the manifest dict.  No extraction side effects."""
    archive_path = Path(archive_path)
    if not archive_path.is_file():
        raise SnapshotError("archive not found: {}".format(archive_path))
    if expected_sha256:
        actual = sha256_file(archive_path)
        if actual.lower() != expected_sha256.lower():
            raise SnapshotError("archive SHA256 mismatch")
    try:
        tar = tarfile.open(archive_path, "r:gz")
    except Exception as exc:
        raise SnapshotError("unreadable archive: {}".format(exc))
    try:
        with tar:
            members = tar.getmembers()
            manifest = None
            payload = {}
            for member in members:
                _validate_member(member)
                if member.name.rstrip("/") == "manifest.json":
                    if manifest is not None or not member.isfile():
                        raise SnapshotError("manifest.json must be a single file")
                    handle = tar.extractfile(member)
                    if handle is None:
                        raise SnapshotError("manifest.json cannot be read")
                    manifest = json.loads(handle.read().decode("utf-8"))
                else:
                    if member.name in payload:
                        raise SnapshotError("duplicate member: {}".format(member.name))
                    payload[member.name.rstrip("/")] = member

            profile = snapshot_profile(manifest)
            required_files, required_dirs, _, _ = _profile_assets(profile)
            config_rel = ("etc/mihomo/config.json" if profile == "mihomo"
                          else "usr/local/etc/xray/config.json")
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                raise SnapshotError("manifest has no entries")

            entry_paths = []
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(
                    entry.get("path"), str
                ):
                    raise SnapshotError("invalid manifest entry shape")
                entry_paths.append(entry["path"])
            if len(set(entry_paths)) != len(entry_paths):
                raise SnapshotError("duplicate manifest entries")

            # Fixed allowlist: a crafted manifest with matching SHA256
            # entries can never restore SSH/network/machine-id/sysctl paths.
            entry_types = {e["path"]: e.get("type") for e in entries}
            for rel in entry_paths:
                if not _allowed_restore_path(rel, entry_types.get(rel), profile):
                    raise SnapshotError(
                        "path outside restore allowlist: {}".format(rel)
                    )

            # The required asset set must be complete in the archive itself,
            # not only at creation time.
            entry_set = set(entry_paths)
            for rel in required_files:
                if (rel not in entry_set
                        or (profile == "mihomo" and entry_types.get(rel) != "file")):
                    raise SnapshotError(
                        "missing required asset in archive: {}".format(rel)
                    )
            for group in REQUIRED_ANY:
                if not any(candidate in entry_set for candidate in group):
                    raise SnapshotError(
                        "missing required asset: {}".format(" or ".join(group))
                    )
            for rel in required_dirs:
                entry = next((e for e in entries if e["path"] == rel), None)
                if entry is None or entry.get("type") != "dir":
                    raise SnapshotError(
                        "missing required directory: {}".format(rel)
                    )
            for rel in REQUIRED_SYMLINKS:
                entry = next((e for e in entries if e["path"] == rel), None)
                if entry is None or entry.get("type") != "symlink":
                    raise SnapshotError(
                        "missing required symlink: {}".format(rel)
                    )

            expected_names = {"rootfs/" + rel for rel in entry_paths}
            if set(payload) != expected_names:
                raise SnapshotError("manifest does not match archive payload")

            # Reject members beneath any archive symlink before extraction.
            symlink_names = {
                name for name, member in payload.items() if member.issym()
            }
            for name in payload:
                parts = name.split("/")
                for i in range(1, len(parts)):
                    if "/".join(parts[:i]) in symlink_names:
                        raise SnapshotError(
                            "member beneath archive symlink: {}".format(name)
                        )

            for entry in entries:
                member = payload["rootfs/" + entry["path"]]
                etype = entry.get("type")
                if stat.S_IMODE(member.mode) != entry.get("mode"):
                    raise SnapshotError(
                        "mode mismatch for {}".format(entry["path"])
                    )
                if etype == "file":
                    if not member.isfile() or member.size != entry.get("size"):
                        raise SnapshotError("size mismatch for {}".format(entry["path"]))
                    handle = tar.extractfile(member)
                    digest = hashlib.sha256()
                    buffered = []
                    with handle:
                        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                            digest.update(chunk)
                            if entry["path"] in (
                                config_rel,
                                "var/lib/pingu-gate/devices.json",
                            ):
                                buffered.append(chunk)
                    if digest.hexdigest() != entry.get("sha256"):
                        raise SnapshotError("SHA256 mismatch for {}".format(entry["path"]))
                    # Critical JSON must parse even when the SHA256 matches.
                    if entry["path"] in (
                        config_rel,
                        "var/lib/pingu-gate/devices.json",
                    ):
                        try:
                            json.loads(b"".join(buffered).decode("utf-8"))
                        except ValueError as exc:
                            raise SnapshotError(
                                "malformed critical JSON {}: {}".format(
                                    entry["path"], exc
                                )
                            )
                elif etype == "dir":
                    if not member.isdir():
                        raise SnapshotError("expected dir: {}".format(entry["path"]))
                elif etype == "symlink":
                    if not member.issym() or member.linkname != entry.get("link_target"):
                        raise SnapshotError("symlink mismatch for {}".format(entry["path"]))
                else:
                    raise SnapshotError("unknown entry type for {}".format(entry["path"]))

            if profile == "mihomo":
                with tar.extractfile(payload["rootfs/" + config_rel]) as handle:
                    config = json.loads(handle.read().decode("utf-8"))
                source_ip = manifest.get("source", {}).get("public_ipv4")
                _validate_mihomo_identity(config, source_ip)
                if runtime_controls(config) is not None:
                    for rel in RUNTIME_CONTROL_PATHS:
                        if entry_types.get(rel) != "file":
                            raise SnapshotError("missing runtime controls asset: " + rel)

            # Legacy Xray data/cert completeness: referenced files must be present.
            cfg_entry = next(
                (e for e in entries
                 if e["path"] == "usr/local/etc/xray/config.json"),
                None,
            )
            if cfg_entry is not None:
                cfg_member = payload["rootfs/usr/local/etc/xray/config.json"]
                handle = tar.extractfile(cfg_member)
                with handle:
                    config = json.loads(handle.read().decode("utf-8"))
                required_xray = set(_xray_referenced_files(config))
                # Xray's standard geo assets must be present, not empty dirs.
                required_xray.update({
                    "usr/local/share/xray/geoip.dat",
                    "usr/local/share/xray/geosite.dat",
                })
                for rel in sorted(required_xray):
                    if rel not in entry_set:
                        raise SnapshotError(
                            "missing xray-referenced asset: {}".format(rel)
                        )
    except (tarfile.TarError, OSError, EOFError, ValueError, zlib.error) as exc:
        raise SnapshotError("unreadable archive or invalid manifest: {}".format(exc))
    return manifest


# --- restore ---------------------------------------------------------------
def _ensure_parents_real(rootfs, target):
    """Reject extraction if target or any ancestor is a pre-existing symlink."""
    rootfs_resolved = rootfs.resolve()
    current = target
    while True:
        if current.is_symlink():
            raise SnapshotError(
                "symlink in extraction path at {}".format(current)
            )
        if current.resolve() == rootfs_resolved or current == current.parent:
            break
        current = current.parent
    target.parent.mkdir(parents=True, exist_ok=True)


def _check_destination_safe(destination):
    """Refuse symlink/nonempty destinations and any symlink ancestor.

    An empty real directory is accepted (the controller pre-creates it);
    anything else is refused before a single byte is written.
    """
    current = destination
    while True:
        if current.is_symlink():
            raise SnapshotError(
                "destination path contains a symlink: {}".format(current)
            )
        if current == current.parent:
            break
        current = current.parent
    if destination.exists():
        if not destination.is_dir():
            raise SnapshotError(
                "destination is not a directory: {}".format(destination)
            )
        if any(destination.iterdir()):
            raise SnapshotError(
                "destination is not empty: {}".format(destination)
            )
    else:
        destination.mkdir(parents=True)


def _safe_extract(archive_path, rootfs):
    with tarfile.open(archive_path, "r:gz") as tar:
        for member in tar.getmembers():
            if member.name.rstrip("/") == "manifest.json":
                continue
            _validate_member(member)
            rel = member.name.rstrip("/")[len("rootfs/"):]
            target = rootfs / rel
            _ensure_parents_real(rootfs, target)
            if member.isdir():
                if target.is_symlink():
                    raise SnapshotError(
                        "refusing to merge directory over symlink: {}".format(rel)
                    )
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                if target.is_symlink() or target.exists():
                    target.unlink()
                os.symlink(member.linkname, target)
            else:
                if target.is_symlink() or (target.exists() and not target.is_dir()):
                    target.unlink()
                source = tar.extractfile(member)
                with source, open(target, "wb") as out:
                    shutil.copyfileobj(source, out)
                os.chmod(target, stat.S_IMODE(member.mode))


def _remap_xray_config(rootfs, old_ip, new_ip):
    """Remap only IP-bearing Xray fields equal to the old source IPv4.

    Touches exclusively usr/local/etc/xray/config.json: the direct
    outbound sendThrough and explicit inbound listen bindings.  Reality
    decoy dest/serverNames, UUIDs, private keys, short IDs and every other
    field are preserved byte-for-byte apart from the rewritten values.
    Returns the list of changed field descriptions (empty if nothing).
    """
    cfg_path = rootfs / "usr/local/etc/xray/config.json"
    if not cfg_path.is_file():
        return []
    config = json.loads(cfg_path.read_text())
    changes = []
    for outbound in config.get("outbounds", []):
        if isinstance(outbound, dict) and outbound.get("tag") == "direct" \
                and outbound.get("sendThrough") == old_ip:
            outbound["sendThrough"] = new_ip
            changes.append("outbounds[tag=direct].sendThrough")
    for index, inbound in enumerate(config.get("inbounds", [])):
        if isinstance(inbound, dict) and inbound.get("listen") == old_ip:
            inbound["listen"] = new_ip
            changes.append("inbounds[{}].listen".format(index))
    if changes:
        cfg_path.write_text(json.dumps(config, indent=2) + "\n")
    return changes


def _remap_mihomo_config(rootfs, old_ip, new_ip, target_interface):
    """Change owned bind identity while preserving Reality credentials/decoys."""
    path = rootfs / "etc/mihomo/config.json"
    config = json.loads(path.read_text())
    direct = _validate_mihomo_identity(config, old_ip)
    changes = []
    if old_ip != new_ip:
        config["pingu-public-ipv4"] = new_ip
        changes.append("pingu-public-ipv4")
        for index, listener in enumerate(config.get("listeners", [])):
            if isinstance(listener, dict) and listener.get("listen") == old_ip:
                listener["listen"] = new_ip
                changes.append("listeners[{}].listen".format(index))
    if direct.get("interface-name") != target_interface:
        direct["interface-name"] = target_interface
        changes.append("proxies[name=direct].interface-name")
    if changes:
        path.write_text(json.dumps(config, indent=2) + "\n")
    return changes


def _owned_mihomo_reality_clients(rootfs):
    config = _load_mihomo_config(rootfs)
    uuids, ipv6_listens = set(), set()
    for listener in config.get("listeners", []):
        if (not isinstance(listener, dict) or listener.get("type") != "vless"
                or not isinstance(listener.get("reality-config"), dict)):
            continue
        for user in listener.get("users", []):
            if isinstance(user, dict) and isinstance(user.get("uuid"), str):
                uuids.add(user["uuid"])
        listen = listener.get("listen")
        if isinstance(listen, str) and _is_literal_ipv6(listen):
            ipv6_listens.add(listen)
    return uuids, ipv6_listens


def _owned_reality_clients(rootfs):
    """Owned Reality client UUIDs and explicit IPv6 listen bindings.

    Built from the staged Xray config's VLESS inbounds whose
    ``streamSettings.security`` is ``reality``.  The client IDs are the
    authoritative ownership signal for subscription nodes: a Reality URI
    carrying one of them belongs to this server, even when its host is a
    literal IPv6 with no IPv4 record.  Explicit IPv6 ``listen`` bindings,
    when present, mark the same owned addresses.
    """
    uuids = set()
    ipv6_listens = set()
    cfg_path = rootfs / "usr/local/etc/xray/config.json"
    if not cfg_path.is_file():
        return uuids, ipv6_listens
    try:
        config = json.loads(cfg_path.read_text())
    except ValueError:
        return uuids, ipv6_listens
    if not isinstance(config, dict):
        return uuids, ipv6_listens
    for inbound in config.get("inbounds", []):
        if not isinstance(inbound, dict) or inbound.get("protocol") != "vless":
            continue
        stream = inbound.get("streamSettings")
        if not isinstance(stream, dict) or stream.get("security") != "reality":
            continue
        settings = inbound.get("settings")
        if isinstance(settings, dict):
            for client in settings.get("clients", []):
                if isinstance(client, dict) and isinstance(client.get("id"), str):
                    uuids.add(client["id"])
        listen = inbound.get("listen")
        if isinstance(listen, str) and _is_literal_ipv6(listen):
            ipv6_listens.add(listen)
    return uuids, ipv6_listens


def _remap_subscription(rootfs, old_ip, new_ip, owned_uuids=None,
                        owned_ipv6=None):
    """Rewrite owned direct VLESS Reality node hosts in the subscription.

    Only VLESS Reality lines whose UUID is an owned Reality client ID are
    touched, and only when the server host is the old source IPv4 or a
    literal IPv6 (owned Reality nodes that have no IPv4 record).  The
    userinfo UUID, port, query (SNI, Reality public key, short ID, flow)
    and fragment are preserved exactly.  WS nodes, DNS names and foreign
    Reality URIs are never rewritten.
    Returns the list of changed node descriptions (empty if nothing).
    """
    owned_uuids = owned_uuids or set()
    owned_ipv6 = owned_ipv6 or set()
    sub_path = rootfs / "etc/pingu-gate.subscription.txt"
    if not sub_path.is_file():
        return []
    changes = []
    output = []
    for line_index, raw in enumerate(
            sub_path.read_text(errors="replace").splitlines(keepends=True)):
        line = raw.strip()
        if "://" not in line:
            output.append(raw)
            continue
        try:
            parsed = urllib.parse.urlsplit(line)
        except ValueError:
            output.append(raw)
            continue
        if parsed.scheme != "vless" or parsed.username not in owned_uuids:
            output.append(raw)
            continue
        try:
            values = dict(urllib.parse.parse_qsl(
                parsed.query, keep_blank_values=True))
        except ValueError:
            values = {}
        host = parsed.hostname
        if (values.get("security") != "reality"
                or values.get("type") == "ws"
                or not host
                or (host != old_ip
                    and host not in owned_ipv6
                    and not _is_literal_ipv6(host))):
            output.append(raw)
            continue
        userinfo, sep, hostport = parsed.netloc.rpartition("@")
        if hostport.startswith("["):
            bracket = hostport.find("]")
            port_part = hostport[bracket + 1:] if bracket != -1 else ""
        else:
            colon = hostport.find(":")
            port_part = hostport[colon:] if colon != -1 else ""
        netloc = (userinfo + "@" if sep else "") + new_ip + port_part
        rebuilt = urllib.parse.urlunsplit(
            (parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment)
        )
        if raw.endswith("\n"):
            rebuilt += "\n"
        output.append(rebuilt)
        changes.append("subscription.lines[{}].host".format(line_index))
    if changes:
        sub_path.write_text("".join(output))
    return changes


def restore_snapshot(archive_path, destination, expected_sha256=None,
                     public_ip=None, target_interface=None):
    """Verify first, then extract into ``destination/rootfs`` and write
    ``destination/manifest.json``.  With ``public_ip``, additionally remap
    the runtime source IPv4 and write ``destination/deployment.json``.
    Mihomo remaps also require an explicitly resolved target interface.
    Returns the manifest dict."""
    manifest = verify_snapshot(archive_path, expected_sha256)
    profile = snapshot_profile(manifest)
    if target_interface is not None and (not isinstance(target_interface, str)
            or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", target_interface)):
        raise SnapshotError("invalid target interface")
    if profile == "mihomo" and public_ip is not None and not target_interface:
        raise SnapshotError("Mihomo public IP remap requires target_interface")
    if public_ip is not None and not _valid_public_ipv4(public_ip):
        raise SnapshotError("invalid public IPv4: {!r}".format(public_ip))
    if public_ip is not None and not manifest.get("source", {}).get("public_ipv4"):
        raise SnapshotError(
            "snapshot has no source public IPv4; cannot remap identity"
        )
    destination = Path(destination)
    _check_destination_safe(destination)
    os.chmod(destination, 0o700)
    rootfs = destination / "rootfs"
    rootfs.mkdir(exist_ok=True)
    _safe_extract(archive_path, rootfs)
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )

    if public_ip is not None:
        old_ip = manifest.get("source", {}).get("public_ipv4")
        changed_paths = []
        changes = []
        if old_ip != public_ip or profile == "mihomo":
            if profile == "mihomo":
                cfg_changes = _remap_mihomo_config(rootfs, old_ip, public_ip, target_interface)
                config_rel = "etc/mihomo/config.json"
                owned_uuids, owned_ipv6 = _owned_mihomo_reality_clients(rootfs)
            else:
                cfg_changes = _remap_xray_config(rootfs, old_ip, public_ip)
                config_rel = "usr/local/etc/xray/config.json"
                owned_uuids, owned_ipv6 = _owned_reality_clients(rootfs)
            if cfg_changes:
                changed_paths.append(config_rel)
            sub_changes = _remap_subscription(
                rootfs, old_ip, public_ip, owned_uuids, owned_ipv6
            )
            if sub_changes:
                changed_paths.append("etc/pingu-gate.subscription.txt")
            changes = cfg_changes + sub_changes
        deployment = {
            "schema": "pingu-vps-deployment/v1",
            "snapshot_id": manifest.get("snapshot_id"),
            "source_ipv4": old_ip,
            "target_ipv4": public_ip,
            "runtime_profile": profile,
            "target_interface": target_interface,
            "changed_paths": changed_paths,
            "changed_fields": changes,
        }
        (destination / "deployment.json").write_text(
            json.dumps(deployment, indent=2, sort_keys=True) + "\n"
        )
    return manifest


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Pingu VPS snapshot tool")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="create a snapshot")
    create.add_argument("--output-dir", required=True)
    create.add_argument("--source-root", default="/")
    create.add_argument("--snapshot-id", default=None)
    create.add_argument("--runtime-profile", choices=("mihomo", "xray"), default=None)
    verify = sub.add_parser("verify", help="verify a snapshot archive")
    verify.add_argument("archive")
    verify.add_argument("--expected-sha256", default=None)
    restore = sub.add_parser("restore", help="verify and restore a snapshot")
    restore.add_argument("archive")
    restore.add_argument("destination")
    restore.add_argument("--expected-sha256", default=None)
    restore.add_argument("--public-ip", default=None)
    restore.add_argument("--target-interface", default=None)
    args = parser.parse_args(argv)

    if args.command == "create":
        result = create_snapshot(args.output_dir, args.source_root,
                                 args.snapshot_id, args.runtime_profile)
        print(json.dumps({k: v for k, v in result.items() if k != "manifest"},
                         indent=2, sort_keys=True))
        return 0
    if args.command == "verify":
        verify_snapshot(args.archive, args.expected_sha256)
        print(json.dumps({"ok": True, "archive": args.archive}))
        return 0
    restore_snapshot(args.archive, args.destination, args.expected_sha256,
                     args.public_ip, args.target_interface)
    print(json.dumps({"ok": True, "archive": args.archive,
                      "destination": args.destination}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
