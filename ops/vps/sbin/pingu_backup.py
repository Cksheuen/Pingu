#!/usr/bin/env python3
"""Immutable encrypted snapshot backup for Pingu VPS assets.

Each run creates a complete :mod:`pingu_snapshot` archive, uploads it to
an rclone **crypt** remote with ``--immutable`` (old snapshots are
append-only, never synced or purged), validates the upload with
``rclone cryptcheck``, and only then publishes ``LATEST.json``.  Any
failure (missing critical asset, auth, upload, verify) aborts before
LATEST is touched.  Errors are redacted; no credential material is ever
printed or persisted.

Python 3.9 stdlib only.
"""

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pingu_snapshot

LATEST_SCHEMA = "pingu-backup-index/v1"

CONFIG = {
    "RCLONE_BIN": "/usr/bin/rclone",
    "RCLONE_REMOTE": "",
    "STATE_DIR": "/var/lib/pingu-backup",
    "OUTPUT_DIR": "/var/lib/pingu-backup/snapshots",
    "LOCK_FILE": "/run/pingu-backup.lock",
    "SNAPSHOT_SOURCE_ROOT": "/",
    "CONFIG_FILE": "/etc/pingu-backup.conf",
}

_REDACT_RE = re.compile(
    r"(?i)(password|passwd|token|secret|client_secret|api_key|apikey|"
    r"credential|bearer)\s*[=:]\s*\S+"
)


def load_shell_config(path=None):
    path = path or CONFIG["CONFIG_FILE"]
    if not os.path.exists(path):
        return
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        CONFIG[key.strip()] = value.strip().strip('"').strip("'")


def run(cmd, timeout=None):
    return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def write_json(path, data):
    tmp = "{}.tmp".format(path)
    Path(tmp).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def redact(text):
    """Strip credential-looking values from rclone output before logging."""
    if not text:
        return ""
    return _REDACT_RE.sub(lambda m: m.group(1) + "=<redacted>", text).strip()


def _remote_root(remote):
    return remote.rstrip("/")


def validate_crypt_remote(remote):
    """Confirm the rclone remote is a crypt remote without exposing secrets.

    ``rclone config show`` output contains crypt passwords, so it is
    parsed in-process and never printed or included in errors.
    """
    name = remote.split(":", 1)[0]
    if not name or "/" in name:
        return False, "invalid rclone remote: {!r}".format(remote)
    proc = run([CONFIG["RCLONE_BIN"], "config", "show", name], timeout=30)
    if proc.returncode != 0:
        return False, "rclone config show failed for remote {}".format(name)
    match = re.search(r"^\s*type\s*=\s*(\S+)", proc.stdout or "", re.MULTILINE)
    if not match:
        return False, "remote {} has no type in rclone config".format(name)
    if match.group(1) != "crypt":
        return False, "remote {} is type {}, must be crypt".format(
            name, match.group(1)
        )
    return True, ""


def upload_snapshot(remote, snap_dir, snapshot_id):
    """Immutable upload of snapshot.tar.gz + SHA256SUMS."""
    dest = "{}/snapshots/{}".format(_remote_root(remote), snapshot_id)
    return run(
        [
            CONFIG["RCLONE_BIN"], "copy", str(snap_dir), dest,
            "--immutable", "--no-traverse",
        ],
        timeout=3600,
    )


def cryptcheck_snapshot(remote, snap_dir, snapshot_id):
    dest = "{}/snapshots/{}".format(_remote_root(remote), snapshot_id)
    return run(
        [CONFIG["RCLONE_BIN"], "cryptcheck", str(snap_dir), dest, "--one-way"],
        timeout=600,
    )


def publish_latest(remote, index):
    """Publish (overwrite) LATEST.json.  Deliberately not --immutable."""
    with tempfile.TemporaryDirectory(prefix="pingu-latest-") as tmp:
        latest = Path(tmp) / "LATEST.json"
        latest.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
        return run(
            [
                CONFIG["RCLONE_BIN"], "copyto", str(latest),
                "{}/LATEST.json".format(_remote_root(remote)),
            ],
            timeout=120,
        )


def _fail(state, state_dir, stage, error):
    state.update({"ok": False, "stage": stage, "error": redact(str(error))})
    write_json(Path(state_dir) / "last-run.json", state)
    print(json.dumps(state, sort_keys=True))
    return 1


def _prune_local_snapshots(output_dir, keep=1):
    """Bound the local plaintext snapshot cache to the newest ``keep`` dirs.

    Called only after a verified cloud publish.  Failed snapshots are kept
    for retry; nothing is ever deleted remotely.
    """
    output_dir = Path(output_dir)
    if not output_dir.is_dir():
        return
    snapshots = [
        path for path in output_dir.iterdir()
        if path.is_dir() and (path / "snapshot.tar.gz").is_file()
    ]
    snapshots.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for stale in snapshots[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def run_backup(state_dir, remote=None, source_root=None, output_dir=None):
    state = {"time": now_iso(), "ok": False}
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    remote = remote if remote is not None else CONFIG["RCLONE_REMOTE"]
    if not remote:
        return _fail(state, state_dir, "config", "RCLONE_REMOTE is not configured")
    if not Path(CONFIG["RCLONE_BIN"]).exists():
        return _fail(
            state, state_dir, "config",
            "rclone not found at {}".format(CONFIG["RCLONE_BIN"]),
        )
    state["remote"] = remote

    try:
        result = pingu_snapshot.create_snapshot(
            output_dir or CONFIG["OUTPUT_DIR"],
            source_root or CONFIG["SNAPSHOT_SOURCE_ROOT"],
        )
    except pingu_snapshot.SnapshotError as exc:
        return _fail(state, state_dir, "snapshot", exc)
    except Exception as exc:  # never leak unexpected internals verbatim
        return _fail(state, state_dir, "snapshot", exc)

    manifest = result["manifest"]
    state.update({
        "snapshot_id": result["snapshot_id"],
        "created_at": result["created_at"],
        "sha256": result["sha256"],
        "archive_bytes": os.path.getsize(result["archive_path"]),
        "files_count": sum(
            1 for e in manifest["entries"] if e.get("type") == "file"
        ),
    })
    snap_dir = Path(result["archive_path"]).parent

    try:
        ok, error = validate_crypt_remote(remote)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _fail(state, state_dir, "remote-validation", exc)
    if not ok:
        return _fail(state, state_dir, "remote-validation", error)

    try:
        uploaded = upload_snapshot(remote, snap_dir, result["snapshot_id"])
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _fail(state, state_dir, "upload", exc)
    if uploaded.returncode != 0:
        return _fail(
            state, state_dir, "upload",
            (uploaded.stderr or "rclone copy failed").strip(),
        )

    try:
        checked = cryptcheck_snapshot(remote, snap_dir, result["snapshot_id"])
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _fail(state, state_dir, "verify", exc)
    if checked.returncode != 0:
        return _fail(
            state, state_dir, "verify",
            (checked.stderr or "rclone cryptcheck failed").strip(),
        )

    index = {
        "schema": LATEST_SCHEMA,
        "snapshot_id": state["snapshot_id"],
        "sha256": state["sha256"],
        "created_at": state["created_at"],
        "archive_bytes": state["archive_bytes"],
        "files_count": state["files_count"],
        "verified": True,
    }
    try:
        published = publish_latest(remote, index)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return _fail(state, state_dir, "publish", exc)
    if published.returncode != 0:
        return _fail(
            state, state_dir, "publish",
            (published.stderr or "rclone copyto LATEST.json failed").strip(),
        )

    # Verified cloud copy exists: bound the local plaintext cache.  The
    # just-uploaded snapshot is the newest, so keep=1 retains it and drops
    # older local copies; failed runs never reach here and are preserved.
    _prune_local_snapshots(snap_dir.parent, keep=1)

    state.update(index)
    state["ok"] = True
    state["stage"] = "done"
    state["cloudpath"] = "{}/snapshots/{}".format(
        _remote_root(remote), result["snapshot_id"]
    )
    write_json(Path(state_dir) / "last-run.json", state)
    print(json.dumps(state, indent=2, sort_keys=True))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pingu immutable encrypted backup")
    parser.add_argument("--status", action="store_true",
                        help="print the last-run state and exit")
    parser.add_argument("--remote", default=None,
                        help="rclone crypt remote (default: RCLONE_REMOTE)")
    parser.add_argument("--config", default=None,
                        help="shell-style config file (default: /etc/pingu-backup.conf)")
    args = parser.parse_args(argv)

    load_shell_config(args.config)
    state_dir = Path(CONFIG["STATE_DIR"])
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)

    if args.status:
        print(json.dumps(read_json(state_dir / "last-run.json", {}),
                         indent=2, sort_keys=True))
        return 0

    lock_path = Path(CONFIG["LOCK_FILE"])
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps(
                {"time": now_iso(), "skipped": "another run in progress"}
            ))
            return 0
        return run_backup(state_dir, remote=args.remote)


if __name__ == "__main__":
    sys.exit(main())
