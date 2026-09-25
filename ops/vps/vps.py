#!/usr/bin/env python3
"""Pingu VPS migration controller (contract.md v1, local side).

Subcommands:
  backup    trigger the installed pingu-backup on the VPS over SSH, parse JSON
  status    print the verified LATEST.json from the crypt remote
  list      list immutable snapshot IDs on the crypt remote
  recover   download + verify + restore a snapshot into a local directory
  deploy    verify a snapshot locally, stage it on a fresh host, run bootstrap

Safety rules encoded here:
  * --target is mandatory; the current source host is refused as deploy target
  * nothing mutates without an explicit --apply (no interactive prompts)
  * snapshot IDs are strict single-component identifiers
  * archive checksums are verified BEFORE any destination write
  * restore destinations must resolve outside this repository
  * the rclone remote must be a crypt remote; secrets are never printed
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]
_SBIN_DIR = _HERE / "sbin"
_SNAPSHOT_HELPER = _SBIN_DIR / "pingu_snapshot.py"
_BOOTSTRAP = _HERE / "bootstrap.sh"

sys.path.insert(0, str(_SBIN_DIR))
try:
    import pingu_snapshot  # Module A: frozen API, see contract.md
except ImportError:  # pragma: no cover - tests inject a fake module
    pingu_snapshot = None

SOURCE_IPV4 = os.environ.get("PINGU_SOURCE_IPV4", "154.26.187.44")
DEFAULT_REMOTE = os.environ.get("PINGU_RCLONE_REMOTE", "drive-crypt:")
BACKUP_INDEX_SCHEMA = "pingu-backup-index/v1"
LATEST_KEY = "LATEST.json"
SNAPSHOT_PREFIX = "snapshots/"
ARCHIVE_NAME = "snapshot.tar.gz"
SSH_CONNECT_TIMEOUT = 10
REMOTE_BACKUP_TIMEOUT_SECONDS = 4500
REMOTE_BOOTSTRAP_TIMEOUT_SECONDS = 1800

_SNAPSHOT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SHA_LINE_RE = re.compile(r"^([0-9a-f]{64})\s+[* ]?(.+?)\s*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class VpsError(Exception):
    """User-facing controller error; message must stay free of secrets."""


def run(cmd, *, check=True, timeout=None, timeout_note=None):
    """Run a command (list argv only, never a shell string)."""
    printable = " ".join(str(part) for part in cmd)
    print(f"$ {printable}", file=sys.stderr)
    try:
        proc = subprocess.run(
            [str(part) for part in cmd], capture_output=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        message = f"command timed out after {timeout}s: {cmd[0]}"
        if timeout_note:
            message += f"\n{timeout_note}"
        raise VpsError(message)
    if check and proc.returncode != 0:
        raise VpsError(
            f"command failed ({proc.returncode}): {cmd[0]}\n"
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    return proc


def snapshot_id_valid(value):
    return isinstance(value, str) and bool(_SNAPSHOT_ID_RE.match(value)) and ".." not in value


def require_snapshot_id(value):
    if not snapshot_id_valid(value):
        raise VpsError(f"invalid snapshot id: {value!r}")
    return value


def _remote_path(remote, key):
    if not isinstance(key, str) or not key or key.startswith("/") or ".." in key.split("/"):
        raise VpsError(f"unsafe remote key: {key!r}")
    name, sep, sub = remote.partition(":")
    if not sep or not name:
        raise VpsError(f"invalid rclone remote: {remote!r}")
    sub = sub.strip("/")
    return f"{name}:{sub + '/' if sub else ''}{key}"


def crypt_remote_check(remote):
    """Validate that the rclone remote exists and is a crypt remote."""
    name = remote.split(":", 1)[0]
    proc = run(["rclone", "listremotes", "--long"])
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == name + ":":
            if parts[1] != "crypt":
                raise VpsError(f"rclone remote {name}: is {parts[1]}, must be crypt")
            return name
    raise VpsError(f"rclone remote {name}: not found in local rclone config")


def fetch_latest(remote):
    proc = run(["rclone", "cat", _remote_path(remote, LATEST_KEY)])
    try:
        data = json.loads(proc.stdout.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise VpsError(f"{LATEST_KEY} is not valid JSON: {exc}")
    if not isinstance(data, dict) or data.get("schema") != BACKUP_INDEX_SCHEMA:
        raise VpsError(f"{LATEST_KEY} has unexpected schema")
    if data.get("verified") is not True:
        raise VpsError(f"{LATEST_KEY} is not marked verified; refusing")
    require_snapshot_id(data.get("snapshot_id"))
    if not isinstance(data.get("sha256"), str) or not _SHA256_RE.match(data["sha256"]):
        raise VpsError(f"{LATEST_KEY} has invalid sha256")
    return data


def parse_sha256sums(text, filename):
    for line in text.splitlines():
        match = _SHA_LINE_RE.match(line.strip())
        if match and match.group(2) == filename:
            return match.group(1)
    raise VpsError(f"sha256 for {filename} not found in SHA256SUMS")


def resolve_snapshot(remote, ref):
    """Return (snapshot_id, expected_sha256) for 'latest' or an explicit ID."""
    if ref == "latest":
        latest = fetch_latest(remote)
        return latest["snapshot_id"], latest["sha256"]
    require_snapshot_id(ref)
    proc = run(
        ["rclone", "cat", _remote_path(remote, SNAPSHOT_PREFIX + ref + "/SHA256SUMS")]
    )
    return ref, parse_sha256sums(proc.stdout.decode("utf-8"), ARCHIVE_NAME)


def download_snapshot(remote, snapshot_id, dest_dir):
    dest_dir = Path(dest_dir)
    for name in (ARCHIVE_NAME, "SHA256SUMS"):
        run(
            [
                "rclone",
                "copyto",
                _remote_path(remote, SNAPSHOT_PREFIX + snapshot_id + "/" + name),
                str(dest_dir / name),
            ]
        )
    return dest_dir / ARCHIVE_NAME, dest_dir / "SHA256SUMS"


def verify_archive_file(archive, sha_sums_file, expected_sha256):
    """Verify the archive against SHA256SUMS and the published index. BEFORE writes."""
    digest = hashlib.sha256()
    with open(archive, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    listed = parse_sha256sums(Path(sha_sums_file).read_text("utf-8"), ARCHIVE_NAME)
    if actual != listed:
        raise VpsError("checksum mismatch: archive vs SHA256SUMS (tampered or corrupt)")
    if expected_sha256 and actual != expected_sha256:
        raise VpsError("checksum mismatch: archive vs LATEST.json")
    return actual


def assert_dest_outside_repo(dest):
    resolved = Path(dest).expanduser().resolve()
    repo = _REPO_ROOT.resolve()
    if resolved == repo or repo in resolved.parents:
        raise VpsError(f"restore destination {resolved} is inside the repository; refusing")
    return resolved


def _snapshot_module():
    if pingu_snapshot is None:
        raise VpsError("snapshot helper ops/vps/sbin/pingu_snapshot.py is unavailable")
    return pingu_snapshot


def _require_identity(identity):
    path = Path(identity).expanduser()
    if not path.is_file():
        raise VpsError(f"SSH identity file not found: {path}")
    return str(path)


def _ssh_base(identity):
    return [
        "ssh",
        "-i",
        identity,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
    ]


def _parse_safe_json(blob, *, limit=1024 * 1024):
    raw = blob if isinstance(blob, bytes) else blob.encode("utf-8")
    if len(raw) > limit:
        raise VpsError("remote JSON output exceeds safe size limit")
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise VpsError(f"remote output is not valid JSON: {exc}")


def backup(target, identity, remote, apply=False):
    crypt_remote_check(remote)
    identity = _require_identity(identity)
    command = shlex.join(["pingu-backup", "--remote", remote])
    print(f"plan: run installed pingu-backup on {target} with remote {remote}")
    if not apply:
        print("plan only; pass --apply to execute")
        return None
    proc = run(
        _ssh_base(identity) + [target, command],
        timeout=REMOTE_BACKUP_TIMEOUT_SECONDS,
        timeout_note=(
            "remote backup state is uncertain; the backup may still be running. "
            "Inspect the host before retrying or changing DNS."
        ),
    )
    report = _parse_safe_json(proc.stdout)
    if not isinstance(report, dict) or report.get("ok") is not True:
        raise VpsError("pingu-backup reported failure; inspect remote last-run.json errorsstage")
    allowed = (
        "snapshot_id",
        "sha256",
        "created_at",
        "archive_bytes",
        "files_count",
        "verified",
        "ok",
        "cloudpath",
        "errorsstage",
    )
    print(json.dumps({k: report[k] for k in allowed if k in report}, indent=2))
    return report


def status(remote):
    crypt_remote_check(remote)
    print(json.dumps(fetch_latest(remote), indent=2))


def list_snapshots(remote):
    crypt_remote_check(remote)
    proc = run(["rclone", "lsf", _remote_path(remote, SNAPSHOT_PREFIX)])
    ids = sorted(
        {
            line.strip().rstrip("/")
            for line in proc.stdout.decode("utf-8", "replace").splitlines()
            if line.strip()
        }
    )
    for snapshot_id in ids:
        if snapshot_id_valid(snapshot_id):
            print(snapshot_id)


def recover(remote, ref, dest, public_ip=None, apply=False, target_interface=None):
    crypt_remote_check(remote)
    dest = assert_dest_outside_repo(dest)
    snapshot_id, expected_sha = resolve_snapshot(remote, ref)
    print(f"plan: recover snapshot {snapshot_id} from {remote} into {dest}")
    if public_ip:
        print(f"plan: remap proxy source IPv4 to {public_ip} during restore")
    if not apply:
        print("plan only; pass --apply to execute")
        return None
    with tempfile.TemporaryDirectory(prefix="pingu-recover-") as raw:
        tmp = Path(raw)
        os.chmod(tmp, 0o700)
        archive, sha_file = download_snapshot(remote, snapshot_id, tmp)
        sha = verify_archive_file(archive, sha_file, expected_sha)
        module = _snapshot_module()
        module.verify_snapshot(str(archive), expected_sha256=sha)
        dest.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(dest, 0o700)
        kwargs = {"target_interface": target_interface} if target_interface else {}
        return module.restore_snapshot(
            str(archive), str(dest), expected_sha256=sha, public_ip=public_ip, **kwargs
        )


def deploy(
    target,
    identity,
    public_ip,
    ref,
    remote,
    apply=False,
    rclone_conf=None,
    enable_backup=False,
):
    if not target:
        raise VpsError("--target is required")
    host = target.rsplit("@", 1)[-1]
    if host == SOURCE_IPV4:
        raise VpsError(
            f"refusing to deploy onto the current source host {SOURCE_IPV4}; "
            "a fresh target is required"
        )
    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            resolved = socket.gethostbyname(host)
        except OSError:
            resolved = ""
        if resolved == SOURCE_IPV4:
            raise VpsError(
                f"refusing to deploy: {host} resolves to the current source "
                f"host {SOURCE_IPV4}; a fresh target is required"
            )
    identity = _require_identity(identity)
    try:
        ip = str(ipaddress.IPv4Address(public_ip))
    except ValueError:
        raise VpsError(f"invalid --public-ip: {public_ip!r}")
    if ip == SOURCE_IPV4:
        raise VpsError(
            f"refusing to deploy: --public-ip is the current source host {SOURCE_IPV4}"
        )
    crypt_remote_check(remote)
    snapshot_id, expected_sha = resolve_snapshot(remote, ref)
    if not _SNAPSHOT_HELPER.is_file():
        raise VpsError(f"snapshot helper missing: {_SNAPSHOT_HELPER}")
    if not _BOOTSTRAP.is_file():
        raise VpsError(f"bootstrap script missing: {_BOOTSTRAP}")
    staging = f"/root/.pingu-migration/staging/{snapshot_id}"
    bootstrap_command = (
        f"bash {staging}/bootstrap.sh"
        f" --archive {staging}/{ARCHIVE_NAME}"
        f" --sha256sums {staging}/SHA256SUMS"
        f" --helper {staging}/pingu_snapshot.py"
        f" --snapshot {snapshot_id}"
        f" --public-ip {ip}"
    )
    if enable_backup:
        bootstrap_command += " --enable-backup"
    if rclone_conf:
        bootstrap_command += f" --rclone-conf {staging}/rclone.conf"
    print(f"plan: deploy snapshot {snapshot_id} to {target} (public IPv4 {ip})")
    print(f"plan: local verify, then stage archive+helper+bootstrap into {staging} (0700)")
    print(f"plan: remote command: {bootstrap_command}")
    if not apply:
        print("plan only; pass --apply to execute")
        return None
    with tempfile.TemporaryDirectory(prefix="pingu-deploy-") as raw:
        tmp = Path(raw)
        os.chmod(tmp, 0o700)
        archive, sha_file = download_snapshot(remote, snapshot_id, tmp)
        sha = verify_archive_file(archive, sha_file, expected_sha)
        _snapshot_module().verify_snapshot(str(archive), expected_sha256=sha)
        ssh = _ssh_base(identity)
        run(ssh + [target, f"install -d -m 0700 {staging}"], timeout=60)
        uploads = [
            (archive, f"{staging}/{ARCHIVE_NAME}"),
            (sha_file, f"{staging}/SHA256SUMS"),
            (_SNAPSHOT_HELPER, f"{staging}/pingu_snapshot.py"),
            (_BOOTSTRAP, f"{staging}/bootstrap.sh"),
        ]
        if rclone_conf:
            conf_path = Path(rclone_conf).expanduser()
            if not conf_path.is_file():
                raise VpsError(f"rclone.conf not found: {conf_path}")
            uploads.append((conf_path, f"{staging}/rclone.conf"))
        scp_opts = [
            "-i",
            identity,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=10",
        ]
        for local, remote_path in uploads:
            run(
                ["scp", *scp_opts, str(local), f"{target}:{remote_path}"],
                timeout=300,
            )
        run(
            ssh + [target, f"chmod 0700 {staging} && {bootstrap_command}"],
            timeout=REMOTE_BOOTSTRAP_TIMEOUT_SECONDS,
            timeout_note=(
                "remote bootstrap state is uncertain; bootstrap may still be running. "
                "Inspect the host before retrying or changing DNS."
            ),
        )
    print("deploy finished; external HTTPS/WS reachability still requires the future manual DNS cutover")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="vps",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--remote",
        default=DEFAULT_REMOTE,
        help=f"rclone crypt remote (default: {DEFAULT_REMOTE})",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    backup_p = sub.add_parser("backup", help="run pingu-backup on the VPS over SSH")
    backup_p.add_argument("--target", required=True, help="SSH target, e.g. root@HOST")
    backup_p.add_argument("--identity", required=True, help="SSH private key file")
    backup_p.add_argument("--apply", action="store_true", help="execute (default: plan only)")

    sub.add_parser("status", help="show verified LATEST.json from the crypt remote")
    sub.add_parser("list", help="list snapshot IDs on the crypt remote")

    recover_p = sub.add_parser("recover", help="download, verify and restore a snapshot locally")
    recover_p.add_argument("--snapshot", required=True, help="'latest' or a snapshot ID")
    recover_p.add_argument("--dest", required=True, help="restore directory (must be outside repo)")
    recover_p.add_argument("--public-ip", default=None, help="remap proxy source IPv4 during restore")
    recover_p.add_argument("--target-interface", default=None,
                           help="target public IPv4 interface (required for Mihomo IP remap)")
    recover_p.add_argument("--apply", action="store_true", help="execute (default: plan only)")

    deploy_p = sub.add_parser("deploy", help="deploy a snapshot onto a fresh Ubuntu 24.04 host")
    deploy_p.add_argument("--target", required=True, help="SSH target of the NEW host, e.g. root@NEW_IP")
    deploy_p.add_argument("--identity", required=True, help="SSH private key file")
    deploy_p.add_argument("--public-ip", required=True, help="public IPv4 of the new host")
    deploy_p.add_argument("--snapshot", required=True, help="'latest' or a snapshot ID")
    deploy_p.add_argument("--apply", action="store_true", help="execute (default: plan only)")
    deploy_p.add_argument(
        "--with-rclone-conf",
        default=None,
        help="explicitly provision local rclone.conf to the new host (0600)",
    )
    deploy_p.add_argument(
        "--enable-backup",
        action="store_true",
        help="install rclone and enable the backup timer on the new host",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "backup":
            backup(args.target, args.identity, args.remote, args.apply)
        elif args.cmd == "status":
            status(args.remote)
        elif args.cmd == "list":
            list_snapshots(args.remote)
        elif args.cmd == "recover":
            recover(args.remote, args.snapshot, args.dest, args.public_ip, args.apply,
                    args.target_interface)
        elif args.cmd == "deploy":
            deploy(
                args.target,
                args.identity,
                args.public_ip,
                args.snapshot,
                args.remote,
                args.apply,
                args.with_rclone_conf,
                args.enable_backup,
            )
    except VpsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
