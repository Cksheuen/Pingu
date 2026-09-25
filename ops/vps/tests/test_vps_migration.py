"""Tests for the Pingu VPS migration controller and fresh-host bootstrap.

Controller tests mock ssh/scp/rclone. Bootstrap tests run the real bash script
against a fixture snapshot archive, a contract-faithful fake snapshot helper,
and stateful fake systemctl/nft/cp/apt commands under a PINGU_ROOT sandbox.
The fakes never touch the real host's systemd or nft state.
"""

import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

OPS_VPS = Path(__file__).resolve().parents[1]
BOOTSTRAP = OPS_VPS / "bootstrap.sh"


class FakeSnapshot:
    """Stand-in for Module A's pingu_snapshot (frozen API only)."""

    def __init__(self):
        self.verify_calls = []
        self.restore_calls = []

    def verify_snapshot(self, archive, expected_sha256=None):
        self.verify_calls.append(
            {"archive": archive, "expected_sha256": expected_sha256}
        )
        return {"schema": "pingu-vps-snapshot/v1", "entries": []}

    def restore_snapshot(self, archive, destination, expected_sha256=None, public_ip=None):
        self.restore_calls.append(
            {
                "archive": archive,
                "destination": destination,
                "expected_sha256": expected_sha256,
                "public_ip": public_ip,
            }
        )
        return {"schema": "pingu-vps-snapshot/v1", "destination": destination}


class ControllerTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_mod = sys.modules.get("pingu_snapshot")
        self.fake_snapshot = FakeSnapshot()
        sys.modules["pingu_snapshot"] = self.fake_snapshot
        self.vps = importlib.import_module("ops.vps.vps")
        importlib.reload(self.vps)
        self.tmp = Path(tempfile.mkdtemp(prefix="pingu-ctrl-test-"))
        self.identity = self.tmp / "id_rsa"
        self.identity.write_text("fixture-key")
        self.archive_bytes = b"fixture snapshot archive contents"
        self.archive_path = self.tmp / "snapshot.tar.gz"
        self.archive_path.write_bytes(self.archive_bytes)
        self.sha_hex = hashlib.sha256(self.archive_bytes).hexdigest()
        self.snapshot_id = "20260905-010101-abc123"
        self.latest_json = json.dumps(
            {
                "schema": "pingu-backup-index/v1",
                "snapshot_id": self.snapshot_id,
                "sha256": self.sha_hex,
                "created_at": "2026-09-05T01:01:01Z",
                "archive_bytes": len(self.archive_bytes),
                "files_count": 12,
                "verified": True,
            }
        ).encode()
        self.sha_text = f"{self.sha_hex}  snapshot.tar.gz\n"
        self.runner = mock.Mock(side_effect=self._fake_run)
        self.patcher = mock.patch.object(self.vps.subprocess, "run", self.runner)
        self.patcher.start()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        self.patcher.stop()
        if self._saved_mod is None:
            sys.modules.pop("pingu_snapshot", None)
        else:
            sys.modules["pingu_snapshot"] = self._saved_mod
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fake_run(self, argv, capture_output=False, timeout=None):
        argv = [str(part) for part in argv]
        if argv[0] == "rclone" and argv[1] == "listremotes":
            return mock.Mock(stdout=b"drive-crypt: crypt\n", returncode=0, stderr=b"")
        if argv[0] == "rclone" and argv[1] == "cat":
            if argv[2].endswith(":LATEST.json"):
                return mock.Mock(stdout=self.latest_json, returncode=0, stderr=b"")
            if argv[2].endswith("/SHA256SUMS"):
                return mock.Mock(stdout=self.sha_text.encode(), returncode=0, stderr=b"")
            return mock.Mock(stdout=b"", returncode=1, stderr=b"not found")
        if argv[0] == "rclone" and argv[1] == "copyto":
            source, dest = argv[2], argv[3]
            if source.endswith("/snapshot.tar.gz"):
                shutil.copyfile(self.archive_path, dest)
            elif source.endswith("/SHA256SUMS"):
                Path(dest).write_bytes(self.sha_text.encode())
            return mock.Mock(stdout=b"", returncode=0, stderr=b"")
        if argv[0] == "ssh":
            return mock.Mock(
                stdout=b'{"ok": true, "snapshot_id": "%s", "verified": true}'
                % self.snapshot_id.encode(),
                returncode=0,
                stderr=b"",
            )
        if argv[0] == "scp":
            return mock.Mock(stdout=b"", returncode=0, stderr=b"")
        raise AssertionError(f"unexpected command: {argv}")

    def commands(self):
        return [
            [str(part) for part in recorded.args[0]]
            for recorded in self.runner.call_args_list
        ]


class SnapshotIdValidationTest(ControllerTestBase):
    def test_rejects_traversal_and_absolute(self):
        for value in ("../etc", "/etc/passwd", "", "a" * 65, "has space", ".."):
            self.assertFalse(self.vps.snapshot_id_valid(value), value)


class RemotePathTest(ControllerTestBase):
    def test_root_remote_join(self):
        self.assertEqual(
            self.vps._remote_path("drive-crypt:", "LATEST.json"),
            "drive-crypt:LATEST.json",
        )

    def test_subdir_remote_join_uses_slash_not_colon(self):
        self.assertEqual(
            self.vps._remote_path("drive-crypt:subdir", "LATEST.json"),
            "drive-crypt:subdir/LATEST.json",
        )
        self.assertEqual(
            self.vps._remote_path("drive-crypt:sub/", "snapshots/x/f"),
            "drive-crypt:sub/snapshots/x/f",
        )

    def test_traversal_and_absolute_rejected(self):
        for bad in ("../etc/passwd", "/abs", "", "a/../../b"):
            with self.assertRaises(self.vps.VpsError):
                self.vps._remote_path("drive-crypt:", bad)


class CryptRemoteTest(ControllerTestBase):
    def test_non_crypt_remote_refused(self):
        self.runner.side_effect = lambda argv, capture_output=False, timeout=None: mock.Mock(
            stdout=b"drive-crypt: drive\n", returncode=0, stderr=b""
        )
        with self.assertRaises(self.vps.VpsError):
            self.vps.crypt_remote_check("drive-crypt:")

    def test_unknown_remote_refused(self):
        self.runner.side_effect = lambda argv, capture_output=False, timeout=None: mock.Mock(
            stdout=b"other: crypt\n", returncode=0, stderr=b""
        )
        with self.assertRaises(self.vps.VpsError):
            self.vps.crypt_remote_check("drive-crypt:")


class LatestIndexTest(ControllerTestBase):
    def test_unverified_latest_refused(self):
        self.latest_json = json.dumps(
            {"schema": "pingu-backup-index/v1", "snapshot_id": self.snapshot_id,
             "sha256": self.sha_hex, "verified": False}
        ).encode()
        with self.assertRaises(self.vps.VpsError):
            self.vps.status("drive-crypt:")

    def test_bad_schema_refused(self):
        self.latest_json = json.dumps({"schema": "other/v1"}).encode()
        with self.assertRaises(self.vps.VpsError):
            self.vps.status("drive-crypt:")


class RecoverTest(ControllerTestBase):
    def test_dest_inside_repo_refused(self):
        with self.assertRaises(self.vps.VpsError):
            self.vps.recover("drive-crypt:", "latest", str(self.vps._REPO_ROOT), apply=True)

    def test_tampered_archive_fails_before_target_write(self):
        self.sha_text = "0" * 64 + "  snapshot.tar.gz\n"
        dest = self.tmp / "restore-dest"
        with self.assertRaises(self.vps.VpsError):
            self.vps.recover("drive-crypt:", "latest", str(dest), apply=True)
        self.assertFalse(dest.exists(), "no destination write before checksum verification")
        self.assertEqual(self.fake_snapshot.restore_calls, [])

    def test_happy_recover_verifies_and_restores_with_ip_remap(self):
        dest = self.tmp / "restore-dest"
        manifest = self.vps.recover(
            "drive-crypt:", "latest", str(dest), public_ip="10.0.0.9", apply=True
        )
        self.assertEqual(manifest["schema"], "pingu-vps-snapshot/v1")
        self.assertEqual(len(self.fake_snapshot.verify_calls), 1)
        call = self.fake_snapshot.restore_calls[0]
        self.assertEqual(call["expected_sha256"], self.sha_hex)
        self.assertEqual(call["public_ip"], "10.0.0.9")
        self.assertTrue(dest.exists())
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)

    def test_plan_mode_does_not_download(self):
        dest = self.tmp / "restore-dest"
        self.vps.recover("drive-crypt:", "latest", str(dest), apply=False)
        for cmd in self.commands():
            self.assertNotIn("copyto", cmd)


class BackupTest(ControllerTestBase):
    def test_plan_makes_no_ssh_call(self):
        self.vps.backup("root@10.0.0.9", str(self.identity), "drive-crypt:", apply=False)
        for cmd in self.commands():
            self.assertNotIn("ssh", cmd)

    def test_apply_runs_remote_backup_with_remote_flag(self):
        self.vps.backup("root@10.0.0.9", str(self.identity), "drive-crypt:", apply=True)
        ssh_calls = [cmd for cmd in self.commands() if cmd[0] == "ssh"]
        self.assertTrue(ssh_calls)
        self.assertIn("pingu-backup --remote drive-crypt:", ssh_calls[0][-1])

    def test_remote_argument_is_shell_quoted(self):
        def fake(argv, capture_output=False, timeout=None):
            argv = [str(part) for part in argv]
            if argv[:2] == ["rclone", "listremotes"]:
                return mock.Mock(stdout=b"weird-crypt: crypt\n", returncode=0, stderr=b"")
            if argv[0] == "ssh":
                return mock.Mock(stdout=b'{"ok": true}', returncode=0, stderr=b"")
            raise AssertionError(f"unexpected command: {argv}")

        self.runner.side_effect = fake
        self.vps.backup("root@10.0.0.9", str(self.identity), "weird-crypt:odd dir", apply=True)
        ssh_calls = [cmd for cmd in self.commands() if cmd[0] == "ssh"]
        self.assertIn("pingu-backup --remote 'weird-crypt:odd dir'", ssh_calls[0][-1])

    def test_remote_failure_json_raises(self):
        self.runner.side_effect = lambda argv, capture_output=False, timeout=None: mock.Mock(
            stdout=b'{"ok": false, "errorsstage": "upload"}', returncode=0, stderr=b""
        )
        with self.assertRaises(self.vps.VpsError):
            self.vps.backup("root@10.0.0.9", str(self.identity), "drive-crypt:", apply=True)

    def test_remote_backup_timeout_budget_surfaces_uncertain_state(self):
        seen_timeouts = []

        def fake(argv, capture_output=False, timeout=None):
            argv = [str(part) for part in argv]
            if argv[:2] == ["rclone", "listremotes"]:
                return mock.Mock(stdout=b"drive-crypt: crypt\n", returncode=0, stderr=b"")
            if argv[0] == "ssh":
                seen_timeouts.append(timeout)
                raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)
            raise AssertionError(f"unexpected command: {argv}")

        self.runner.side_effect = fake
        with self.assertRaisesRegex(self.vps.VpsError, "remote backup state is uncertain.*DNS"):
            self.vps.backup("root@10.0.0.9", str(self.identity), "drive-crypt:", apply=True)
        self.assertEqual(seen_timeouts, [self.vps.REMOTE_BACKUP_TIMEOUT_SECONDS])


class SshHardeningTest(ControllerTestBase):
    def test_ssh_base_requires_known_host_key_and_connect_timeout(self):
        base = self.vps._ssh_base(str(self.identity))
        self.assertIn("StrictHostKeyChecking=yes", base)
        self.assertNotIn("accept-new", base)
        self.assertIn("ConnectTimeout=10", base)

    def test_deploy_ssh_calls_carry_process_timeout(self):
        with mock.patch.object(self.vps, "_SNAPSHOT_HELPER", self.archive_path):
            self.vps.deploy(
                "root@10.0.0.9", str(self.identity), "10.0.0.9", "latest", "drive-crypt:",
                apply=True,
            )
        ssh_timeouts = [
            call.kwargs.get("timeout")
            for call in self.runner.call_args_list
            if call.args[0][0] == "ssh"
        ]
        self.assertEqual(ssh_timeouts, [60, self.vps.REMOTE_BOOTSTRAP_TIMEOUT_SECONDS])
        self.assertEqual(ssh_timeouts, [60, 1800])

    def test_bootstrap_timeout_surfaces_uncertain_remote_state(self):
        seen_timeouts = []

        def fake(argv, capture_output=False, timeout=None):
            argv = [str(part) for part in argv]
            if argv[0] == "ssh" and "bootstrap.sh" in argv[-1]:
                seen_timeouts.append(timeout)
                raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)
            return self._fake_run(argv, capture_output=capture_output, timeout=timeout)

        self.runner.side_effect = fake
        with mock.patch.object(self.vps, "_SNAPSHOT_HELPER", self.archive_path):
            with self.assertRaisesRegex(
                self.vps.VpsError, "remote bootstrap state is uncertain.*DNS"
            ):
                self.vps.deploy(
                    "root@10.0.0.9", str(self.identity), "10.0.0.9", "latest",
                    "drive-crypt:", apply=True,
                )
        self.assertEqual(seen_timeouts, [self.vps.REMOTE_BOOTSTRAP_TIMEOUT_SECONDS])


class SourceHostRefusalTest(ControllerTestBase):
    def test_refuses_current_source_host(self):
        with self.assertRaises(self.vps.VpsError):
            self.vps.deploy(
                "root@154.26.187.44",
                str(self.identity),
                "10.0.0.9",
                "latest",
                "drive-crypt:",
                apply=True,
            )
        self.assertEqual(self.commands(), [])

    def test_refuses_public_ip_equal_to_source(self):
        with self.assertRaises(self.vps.VpsError):
            self.vps.deploy(
                "root@10.0.0.9",
                str(self.identity),
                self.vps.SOURCE_IPV4,
                "latest",
                "drive-crypt:",
                apply=True,
            )
        self.assertEqual(self.commands(), [])

    def test_refuses_hostname_resolving_to_source(self):
        with mock.patch.object(
            self.vps.socket, "gethostbyname", return_value=self.vps.SOURCE_IPV4
        ):
            with self.assertRaises(self.vps.VpsError):
                self.vps.deploy(
                    "root@old-host.example",
                    str(self.identity),
                    "10.0.0.9",
                    "latest",
                    "drive-crypt:",
                    apply=True,
                )
        self.assertEqual(self.commands(), [])

    def test_refuses_invalid_public_ip(self):
        with self.assertRaises(self.vps.VpsError):
            self.vps.deploy(
                "root@10.0.0.9", str(self.identity), "not-an-ip", "latest", "drive-crypt:",
                apply=True,
            )


class DeployTest(ControllerTestBase):
    def test_plan_makes_no_ssh_or_scp_call(self):
        with mock.patch.object(self.vps, "_SNAPSHOT_HELPER", self.archive_path):
            self.vps.deploy(
                "root@10.0.0.9", str(self.identity), "10.0.0.9", "latest", "drive-crypt:",
                apply=False,
            )
        for cmd in self.commands():
            self.assertNotIn(cmd[0], ("ssh", "scp"))

    def test_apply_stages_archive_helper_bootstrap_and_runs_bootstrap(self):
        with mock.patch.object(self.vps, "_SNAPSHOT_HELPER", self.archive_path):
            self.vps.deploy(
                "root@10.0.0.9", str(self.identity), "10.0.0.9", "latest", "drive-crypt:",
                apply=True,
            )
        cmds = self.commands()
        self.assertIn(
            ["ssh", "-i", str(self.identity), "-o", "BatchMode=yes", "-o",
             "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
             "root@10.0.0.9",
             "install -d -m 0700 /root/.pingu-migration/staging/" + self.snapshot_id],
            cmds,
        )
        scp_calls = [cmd for cmd in cmds if cmd[0] == "scp"]
        self.assertEqual(len(scp_calls), 4)
        for cmd in scp_calls:
            self.assertIn("StrictHostKeyChecking=yes", cmd)
            self.assertIn("ConnectTimeout=10", cmd)
        scp_targets = [cmd[-1] for cmd in scp_calls]
        self.assertTrue(any(t.endswith("/pingu_snapshot.py") for t in scp_targets))
        self.assertTrue(any(t.endswith("/bootstrap.sh") for t in scp_targets))
        bootstrap_call = [cmd for cmd in cmds if cmd[0] == "ssh"][-1][-1]
        self.assertIn("--public-ip 10.0.0.9", bootstrap_call)
        self.assertIn(f"--snapshot {self.snapshot_id}", bootstrap_call)
        self.assertIn("bootstrap.sh", bootstrap_call)


FAKE_HELPER = r'''
"""Minimal contract-faithful snapshot helper for bootstrap tests."""
import hashlib
import json
import os
import sys
import tarfile


def _sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot(archive_path, expected_sha256=None):
    if expected_sha256 and _sha(archive_path) != expected_sha256:
        raise ValueError("archive sha256 mismatch")
    with tarfile.open(archive_path) as tar:
        for member in tar.getmembers():
            parts = member.name.split("/")
            if member.name.startswith("/") or ".." in parts:
                raise ValueError("unsafe archive member: " + member.name)
        manifest = json.load(tar.extractfile("manifest.json"))
    return manifest


def restore_snapshot(archive_path, destination, expected_sha256=None, public_ip=None):
    manifest = verify_snapshot(archive_path, expected_sha256)
    log = os.environ.get("PINGU_FAKE_HELPER_LOG")
    if log:
        with open(log, "a") as handle:
            handle.write(destination + "\n")
    if os.path.isdir(destination) and os.listdir(destination):
        raise ValueError("restore destination is not empty: " + destination)
    os.makedirs(destination, exist_ok=True)
    changed = []
    with tarfile.open(archive_path) as tar:
        for member in tar.getmembers():
            if not member.name.startswith("rootfs/"):
                continue
            target = os.path.join(destination, member.name)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
            elif member.issym():
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if os.path.lexists(target):
                    os.remove(target)
                os.symlink(member.linkname, target)
            elif member.isfile():
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as out, tar.extractfile(member) as src:
                    out.write(src.read())
                os.chmod(target, member.mode)
    if public_ip:
        cfg = os.path.join(destination, "rootfs", "usr/local/etc/xray/config.json")
        with open(cfg) as handle:
            text = handle.read()
        remapped = text.replace("154.26.187.44", public_ip)
        if remapped != text:
            with open(cfg, "w") as handle:
                handle.write(remapped)
            changed.append("usr/local/etc/xray/config.json")
    with open(os.path.join(destination, "manifest.json"), "w") as handle:
        json.dump(manifest, handle)
    with open(os.path.join(destination, "deployment.json"), "w") as handle:
        json.dump({"changed_paths": changed, "target_ipv4": public_ip}, handle)
    return manifest
'''

FAKE_XRAY = """#!/usr/bin/env bash
# Fake xray for bootstrap tests: fails -test when config is marked FAIL_TEST.
if [[ "$1" == "run" && "$2" == "-test" ]]; then
  cfg=""
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "-c" ]] && cfg="$2"
    shift
  done
  if grep -q "FAIL_TEST" "$cfg" 2>/dev/null; then
    exit 1
  fi
fi
exit 0
"""

FAKE_SYSTEMCTL = r"""#!/usr/bin/env bash
# Stateful fake systemctl for bootstrap tests (never touches the real host).
STATE_DIR="${PINGU_FAKE_STATE:?}"
mkdir -p "$STATE_DIR/units"
printf '%s\n' "$*" >> "$STATE_DIR/systemctl.log"
cmd="${1:-}"
if [[ $# -gt 0 ]]; then shift; fi
case "$cmd" in
  daemon-reload)
    exit 0
    ;;
  is-active)
    unit="${1:-}"
    [[ "${PINGU_FAKE_HEALTH_FAIL_UNIT:-}" == "$unit" ]] && exit 3
    if [[ -f "$STATE_DIR/units/$unit" ]] \
      && [[ "$(cat "$STATE_DIR/units/$unit")" == "active" ]]; then
      exit 0
    fi
    exit 3
    ;;
  is-enabled)
    if [[ -f "$STATE_DIR/units/${1:-}" ]]; then exit 0; fi
    exit 1
    ;;
  enable)
    now=0
    if [[ "${1:-}" == "--now" ]]; then
      now=1
      shift
    fi
    rc=0
    for unit in "$@"; do
      if [[ "${PINGU_FAKE_FAIL_UNIT:-}" == "$unit" ]]; then
        echo "fake systemctl: simulated failure for $unit" >&2
        rc=1
        continue
      fi
      if [[ $now -eq 1 ]]; then
        printf 'active\n' > "$STATE_DIR/units/$unit"
      else
        printf 'enabled\n' > "$STATE_DIR/units/$unit"
      fi
    done
    exit $rc
    ;;
  start)
    for unit in "$@"; do printf 'active\n' > "$STATE_DIR/units/$unit"; done
    exit 0
    ;;
  stop)
    for unit in "$@"; do rm -f "$STATE_DIR/units/$unit"; done
    exit 0
    ;;
  disable)
    for unit in "$@"; do rm -f "$STATE_DIR/units/$unit"; done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
"""

FAKE_NFT = r"""#!/usr/bin/env bash
# Stateful fake nft for bootstrap tests (never touches the real host).
STATE_DIR="${PINGU_FAKE_STATE:?}"
mkdir -p "$STATE_DIR"
printf '%s\n' "$*" >> "$STATE_DIR/nft.log"
case "${1:-}" in
  -c)
    exit 0
    ;;
  -f)
    touch "$STATE_DIR/pingu_guard"
    exit 0
    ;;
  list)
    if [[ -f "$STATE_DIR/pingu_guard" ]]; then
      echo "table inet pingu_guard"
      exit 0
    fi
    exit 1
    ;;
  delete)
    rm -f "$STATE_DIR/pingu_guard"
    exit 0
    ;;
esac
exit 0
"""

FAKE_CP = r"""#!/usr/bin/env bash
# Fake cp: delegates to /bin/cp unless PINGU_FAKE_CP_FAIL_FILE matches an arg.
if [[ -n "${PINGU_FAKE_CP_FAIL_FILE:-}" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == *"$PINGU_FAKE_CP_FAIL_FILE"* ]]; then
      echo "fake cp: simulated failure copying $arg" >&2
      exit 1
    fi
  done
fi
exec /bin/cp "$@"
"""

FAKE_IP = r"""#!/usr/bin/env bash
# Fake ip for bootstrap tests (never touches the real host).
if [[ "$1" == "-j" && "$2" == "-4" && "$3" == "addr" ]]; then
  printf '[{"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP"],"addr_info":[{"family":"inet","local":"127.0.0.1"}]},{"ifindex":2,"ifname":"%s","flags":["UP"],"addr_info":[{"family":"inet","local":"%s"}]}]\n' \
    "${PINGU_FAKE_INTERFACE:-eth0}" "${PINGU_FAKE_PUBLIC_IP:-10.0.0.9}"
  exit 0
fi
echo "fake ip: unsupported arguments: $*" >&2
exit 1
"""


class BootstrapHarness:
    """Builds a fixture snapshot archive and a sandboxed host root."""

    SNAPSHOT_ID = "20260905-010101-abc123"
    OLD_IP = "154.26.187.44"
    NEW_IP = "10.0.0.9"

    def __init__(self, test, config_fail=False, source_arch="amd64"):
        self.test = test
        self.base = Path(tempfile.mkdtemp(prefix="pingu-bootstrap-test-")).resolve()
        self.staging = self.base / "staging"
        self.staging.mkdir()
        self.root = self.base / "host"
        self.fakes = self.base / "fakes"
        self.fakestate = self.base / "fakestate"
        self.fakes.mkdir()
        self.fakestate.mkdir()
        self.archive = self.staging / "snapshot.tar.gz"
        self.sha_sums = self.staging / "SHA256SUMS"
        self.helper = self.staging / "pingu_snapshot.py"
        self._build_archive(config_fail, source_arch)
        self.helper.write_text(FAKE_HELPER)
        sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.sha_sums.write_text(f"{sha}  snapshot.tar.gz\n")
        self._build_fakes()
        self._build_host_root()

    def cleanup(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def _build_archive(self, config_fail, source_arch):
        marker = "FAIL_TEST" if config_fail else ""
        files = {
            "rootfs/usr/local/bin/xray": FAKE_XRAY.encode(),
            "rootfs/usr/local/etc/xray/config.json": json.dumps(
                {
                    "outbounds": [{"protocol": "freedom", "sendThrough": self.OLD_IP}],
                    "inbounds": [
                        {"port": 8443, "streamSettings": {"realitySettings":
                            {"serverHost": self.OLD_IP, "note": marker}}}
                    ],
                }
            ).encode(),
            "rootfs/etc/systemd/system/pingu-gate.service": b"[Unit]\n",
            "rootfs/etc/systemd/system/xray.service": b"[Unit]\n",
            "rootfs/etc/systemd/system/cksheuen-portal.service": b"[Unit]\n",
            "rootfs/etc/systemd/system/pingu-traffic-guard.timer": b"[Unit]\n",
            "rootfs/etc/systemd/system/pingu-traffic-report.timer": b"[Unit]\n",
            "rootfs/etc/nftables.d/pingu-guard.nft": b"table inet pingu_guard {\n}\n",
            "rootfs/etc/pingu-gate.token": b"snapshot-token\n",
            "rootfs/var/lib/pingu-gate/devices.json": b'{"revocations": 1}\n',
            "rootfs/var/lib/pingu-traffic-guard/state.json": b'{"counter": 5}\n',
            "rootfs/var/www/cksheuen-portal/releases/20260811-032313/index.html": b"hello\n",
        }
        manifest = {
            "schema": "pingu-vps-snapshot/v1",
            "snapshot_id": self.SNAPSHOT_ID,
            "created_at": "2026-09-05T01:01:01Z",
            "source": {
                "os_id": "ubuntu",
                "os_version": "24.04",
                "architecture": source_arch,
                "public_ipv4": self.OLD_IP,
                "public_origin": "fixture",
            },
            "entries": [
                {"path": path[len("rootfs/"):], "type": "file", "mode": 0o644,
                 "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
                for path, data in files.items()
            ],
        }
        manifest_bytes = json.dumps(manifest).encode()
        with tarfile.open(self.archive, "w:gz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(manifest_bytes)
            tar.addfile(info, io.BytesIO(manifest_bytes))
            for path, data in files.items():
                info = tarfile.TarInfo(path)
                info.size = len(data)
                info.mode = 0o755 if path.endswith("/xray") else 0o644
                tar.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo("rootfs/var/www/cksheuen-portal/current")
            info.type = tarfile.SYMTYPE
            info.linkname = "releases/20260811-032313"
            tar.addfile(info)

    def _write_fake(self, name, content):
        script = self.fakes / name
        script.write_text(content)
        script.chmod(0o755)

    def _build_fakes(self):
        self._write_fake("systemctl", FAKE_SYSTEMCTL)
        self._write_fake("nft", FAKE_NFT)
        self._write_fake("cp", FAKE_CP)
        self._write_fake("ip", FAKE_IP)
        for name in ("apt-get", "systemd-analyze"):
            self._write_fake(
                name,
                "#!/usr/bin/env bash\n"
                f'printf "%s\\n" "$*" >> "${{PINGU_FAKE_STATE:?}}/{name}.log"\n'
                "exit 0\n",
            )

    def _build_host_root(self, os_id="ubuntu", os_version="24.04"):
        (self.root / "etc").mkdir(parents=True)
        (self.root / "etc/os-release").write_text(
            f'ID={os_id}\nVERSION_ID="{os_version}"\n'
        )
        (self.root / "etc/nftables.conf").write_text("#!/usr/sbin/nft -f\n")

    def seed_nft_table(self):
        (self.fakestate / "pingu_guard").touch()

    def run_bootstrap(self, *extra_args, expect_success=True, env_extra=None):
        env = os.environ.copy()
        env["PINGU_ROOT"] = str(self.root)
        env["PINGU_ARCH"] = "amd64"
        env["PINGU_FAKE_STATE"] = str(self.fakestate)
        env["PINGU_FAKE_PUBLIC_IP"] = self.NEW_IP
        env["PINGU_FAKE_HELPER_LOG"] = str(self.fakestate / "helper.log")
        env["PATH"] = str(self.fakes) + os.pathsep + env["PATH"]
        if env_extra:
            env.update(env_extra)
        args = [
            "bash", str(BOOTSTRAP),
            "--archive", str(self.archive),
            "--sha256sums", str(self.sha_sums),
            "--helper", str(self.helper),
            "--snapshot", self.SNAPSHOT_ID,
            "--public-ip", self.NEW_IP,
        ] + list(extra_args)
        proc = subprocess.run(args, env=env, capture_output=True, text=True)
        if expect_success:
            self.test.assertEqual(
                proc.returncode, 0,
                f"bootstrap failed:\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
            )
        return proc

    def _log(self, name):
        path = self.fakestate / f"{name}.log"
        return path.read_text() if path.exists() else ""

    def systemctl_log(self):
        return self._log("systemctl")

    def nft_log(self):
        return self._log("nft")

    def apt_log(self):
        return self._log("apt-get")

    def unit_state(self, unit):
        state_file = self.fakestate / "units" / unit
        return state_file.read_text().strip() if state_file.exists() else None

    def nft_table_loaded(self):
        return (self.fakestate / "pingu_guard").exists()

    def helper_restore_calls(self):
        log = self.fakestate / "helper.log"
        return log.read_text().splitlines() if log.exists() else []


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.harness = BootstrapHarness(self)
        self.addCleanup(self.harness.cleanup)

    def test_fresh_deploy_installs_remaps_ip_and_writes_marker(self):
        proc = self.harness.run_bootstrap()
        self.assertIn("public IPv4 10.0.0.9 directly assigned to eth0", proc.stdout)
        root = self.harness.root
        marker = json.loads((root / "etc/pingu-migration/deployment.json").read_text())
        self.assertEqual(marker["snapshot_id"], self.harness.SNAPSHOT_ID)
        self.assertEqual(marker["target_ip"], self.harness.NEW_IP)
        config = json.loads((root / "usr/local/etc/xray/config.json").read_text())
        self.assertEqual(config["outbounds"][0]["sendThrough"], self.harness.NEW_IP)
        self.assertEqual(
            config["inbounds"][0]["streamSettings"]["realitySettings"]["serverHost"],
            self.harness.NEW_IP,
        )
        self.assertEqual(
            os.readlink(root / "var/www/cksheuen-portal/current"),
            "releases/20260811-032313",
        )
        # global nftables.conf is preserved byte-for-byte
        self.assertEqual(
            (root / "etc/nftables.conf").read_text(), "#!/usr/sbin/nft -f\n"
        )
        # every mandatory unit is active
        for unit in (
            "pingu-gate.service",
            "xray.service",
            "cksheuen-portal.service",
            "pingu-traffic-guard.timer",
            "pingu-traffic-report.timer",
            "pingu-firewall.service",
        ):
            self.assertEqual(self.harness.unit_state(unit), "active", unit)
        self.assertTrue(self.harness.nft_table_loaded())

    def test_public_ip_preflight_refuses_nat_only_before_mutations(self):
        proc = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_PUBLIC_IP": "10.0.0.10"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not directly assigned", proc.stderr)
        self.assertIn("NAT-only", proc.stderr)
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())
        self.assertEqual(self.harness.systemctl_log(), "")
        self.assertEqual(self.harness.nft_log(), "")
        self.assertEqual(self.harness.apt_log(), "")
        self.assertEqual(self.harness.helper_restore_calls(), [])

    def test_os_guard_refuses_before_writes(self):
        shutil.rmtree(self.harness.root)
        self.harness._build_host_root(os_id="debian", os_version="12")
        proc = self.harness.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unsupported OS", proc.stderr)
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())
        self.assertEqual(self.harness.systemctl_log(), "")
        self.assertEqual(self.harness.nft_log(), "")

    def test_snapshot_arch_guard_refuses_before_writes(self):
        arm = BootstrapHarness(self, source_arch="arm64")
        self.addCleanup(arm.cleanup)
        proc = arm.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("architecture", proc.stderr)
        self.assertFalse((arm.root / "etc/pingu-migration").exists())
        self.assertEqual(arm.systemctl_log(), "")
        self.assertEqual(arm.nft_log(), "")

    def test_tampered_archive_refused_before_install(self):
        data = bytearray(self.harness.archive.read_bytes())
        data[10] ^= 0xFF
        self.harness.archive.write_bytes(bytes(data))
        proc = self.harness.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("checksum", proc.stderr)
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())
        self.assertNotIn("enable --now", self.harness.systemctl_log())

    def test_idempotent_rerun_is_read_only_and_preserves_state(self):
        self.harness.run_bootstrap()
        devices = self.harness.root / "var/lib/pingu-gate/devices.json"
        devices.write_text('{"revocations": 99}\n')
        # Even an older mtime than the archive must not matter: the re-run
        # must not extract or install anything at all.
        old = time.time() - 10 * 86400
        os.utime(devices, (old, old))
        marker_before = (
            self.harness.root / "etc/pingu-migration/deployment.json"
        ).read_bytes()
        sysctl_before = self.harness.systemctl_log()
        nft_before = self.harness.nft_log()
        apt_before = self.harness.apt_log()
        restore_paths_before = set(self.harness.staging.glob("restore.*"))
        helper_calls_before = len(self.harness.helper_restore_calls())
        proc = self.harness.run_bootstrap()
        self.assertEqual(proc.returncode, 0)
        self.assertIn("idempotent re-run", proc.stdout + proc.stderr)
        self.assertEqual(devices.read_text(), '{"revocations": 99}\n')
        self.assertEqual(
            set(self.harness.staging.glob("restore.*")),
            restore_paths_before,
            "no extraction on idempotent re-run",
        )
        self.assertEqual(
            len(self.harness.helper_restore_calls()),
            helper_calls_before,
            "no helper restore on idempotent re-run",
        )
        self.assertFalse((self.harness.staging / "restore").exists())
        self.assertEqual(
            (self.harness.root / "etc/pingu-migration/deployment.json").read_bytes(),
            marker_before,
        )
        # read-only is-active health queries are allowed; no mutating commands
        sysctl_delta = self.harness.systemctl_log()[len(sysctl_before):]
        for line in sysctl_delta.splitlines():
            self.assertTrue(
                line.startswith("is-active "),
                f"unexpected mutating systemctl call on idempotent re-run: {line}",
            )
        self.assertEqual(self.harness.nft_log(), nft_before)
        self.assertEqual(self.harness.apt_log(), apt_before)

    def test_idempotent_rerun_unhealthy_exits_nonzero_without_mutation(self):
        self.harness.run_bootstrap()
        devices = self.harness.root / "var/lib/pingu-gate/devices.json"
        devices.write_text('{"revocations": 99}\n')
        proc = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_HEALTH_FAIL_UNIT": "xray.service"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("health validation FAILED", proc.stderr)
        # no rollback and no mutation on the idempotent path
        self.assertEqual(devices.read_text(), '{"revocations": 99}\n')
        self.assertNotIn("rolling back", proc.stderr)
        self.assertTrue(self.harness.nft_table_loaded())

    def test_unmarked_existing_installation_refused(self):
        token = self.harness.root / "etc/pingu-gate.token"
        token.parent.mkdir(parents=True, exist_ok=True)
        token.write_text("manual-install-token\n")
        proc = self.harness.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("fresh-host guard", proc.stderr)
        self.assertEqual(token.read_text(), "manual-install-token\n")
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())
        self.assertEqual(self.harness.systemctl_log(), "")
        self.assertEqual(self.harness.nft_log(), "")

    def test_existing_managed_nft_table_refused(self):
        self.harness.seed_nft_table()
        proc = self.harness.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("fresh-host guard", proc.stderr)
        self.assertEqual(self.harness.systemctl_log(), "")
        # the pre-existing table must not have been deleted or reloaded
        self.assertTrue(self.harness.nft_table_loaded())

    def test_different_snapshot_marker_refused(self):
        self.harness.run_bootstrap()
        marker = self.harness.root / "etc/pingu-migration/deployment.json"
        data = json.loads(marker.read_text())
        data["snapshot_id"] = "20260906-020202-zzz999"
        marker.write_text(json.dumps(data))
        proc = self.harness.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("already present", proc.stderr)

    def test_failed_health_rolls_back_and_writes_no_marker(self):
        # pre-existing on-host state (not a fresh-host-guard artifact)
        state = self.harness.root / "var/lib/pingu-traffic-guard/state.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text('{"counter": 1}\n')
        proc = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_HEALTH_FAIL_UNIT": "xray.service"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("rolling back", proc.stderr)
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())
        # pre-existing state restored byte-for-byte
        self.assertEqual(state.read_text(), '{"counter": 1}\n')
        # table deleted, started units stopped+disabled, generated files removed
        self.assertFalse(self.harness.nft_table_loaded())
        for unit in (
            "pingu-gate.service",
            "xray.service",
            "pingu-firewall.service",
            "pingu-traffic-guard.timer",
        ):
            self.assertIsNone(self.harness.unit_state(unit), unit)
        self.assertIn("stop xray.service", self.harness.systemctl_log())
        self.assertIn("disable xray.service", self.harness.systemctl_log())
        self.assertIn("daemon-reload", self.harness.systemctl_log())
        self.assertFalse(
            (self.harness.root / "etc/systemd/system/pingu-firewall.service").exists()
        )
        self.assertFalse(
            (self.harness.root / "usr/local/sbin/pingu-firewall-loader.sh").exists()
        )

    def test_failed_enable_records_intent_and_rolls_back(self):
        proc = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_FAIL_UNIT": "pingu-gate.service"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("rolling back", proc.stderr)
        # intent recorded before the attempt: stop is attempted even though
        # `enable --now` itself failed
        self.assertIn("stop pingu-gate.service", self.harness.systemctl_log())
        self.assertFalse(self.harness.nft_table_loaded())
        self.assertFalse((self.harness.root / "etc/pingu-migration").exists())

    def test_failed_attempt_then_retry_uses_fresh_private_restore_dir(self):
        first = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_HEALTH_FAIL_UNIT": "xray.service"},
        )
        self.assertNotEqual(first.returncode, 0)
        first_calls = self.harness.helper_restore_calls()
        self.assertEqual(len(first_calls), 1)
        first_restore = Path(first_calls[0])
        self.assertEqual(first_restore.parent, self.harness.staging)
        self.assertTrue(first_restore.name.startswith("restore."))
        self.assertEqual(stat.S_IMODE(first_restore.stat().st_mode), 0o700)

        # Module A now rejects a non-empty destination. This legacy directory
        # would make the old fixed "$STAGING/restore" path fail on retry.
        legacy_restore = self.harness.staging / "restore"
        legacy_restore.mkdir()
        (legacy_restore / "leftover").write_text("failed attempt\n")

        second = self.harness.run_bootstrap()
        self.assertEqual(second.returncode, 0)
        calls = self.harness.helper_restore_calls()
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0], calls[1])
        for destination in calls:
            path = Path(destination)
            self.assertEqual(path.parent, self.harness.staging)
            self.assertTrue(path.name.startswith("restore."))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual((legacy_restore / "leftover").read_text(), "failed attempt\n")

    def test_failed_cp_after_mv_restores_original(self):
        state = self.harness.root / "var/lib/pingu-traffic-guard/state.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text('{"counter": 1}\n')
        index = (
            self.harness.root
            / "var/www/cksheuen-portal/releases/20260811-032313/index.html"
        )
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text("old homepage\n")
        proc = self.harness.run_bootstrap(
            expect_success=False,
            env_extra={"PINGU_FAKE_CP_FAIL_FILE": str(index)},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("rolling back", proc.stderr)
        # the file whose cp failed (touched but never installed) is restored
        self.assertEqual(index.read_text(), "old homepage\n")
        # the file installed earlier in the same run is also restored
        self.assertEqual(state.read_text(), '{"counter": 1}\n')

    def test_firewall_persistence_own_unit_global_nft_unchanged(self):
        global_nft = self.harness.root / "etc/nftables.conf"
        before = global_nft.read_bytes()
        self.harness.run_bootstrap()
        self.assertEqual(global_nft.read_bytes(), before)
        unit = (
            self.harness.root / "etc/systemd/system/pingu-firewall.service"
        ).read_text()
        self.assertIn(
            "Before=pingu-gate.service xray.service cksheuen-portal.service", unit
        )
        self.assertIn("WantedBy=multi-user.target", unit)
        loader = (
            self.harness.root / "usr/local/sbin/pingu-firewall-loader.sh"
        ).read_text()
        self.assertIn("nft -f /etc/nftables.d/pingu-guard.nft", loader)
        self.assertNotIn("flush", loader)
        self.assertEqual(self.harness.unit_state("pingu-firewall.service"), "active")
        # nft was never asked to flush or to touch unrelated tables
        self.assertNotIn("flush", self.harness.nft_log())

    def test_rclone_conf_provisioned_explicitly_at_0600(self):
        conf = self.harness.base / "rclone.conf"
        conf.write_text("[drive-crypt]\ntype = crypt\n")
        self.harness.run_bootstrap("--rclone-conf", str(conf))
        installed = self.harness.root / "root/.config/rclone/rclone.conf"
        self.assertTrue(installed.exists())
        self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o600)

    def test_preexisting_rclone_conf_refused(self):
        dst = self.harness.root / "root/.config/rclone/rclone.conf"
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text("[drive-crypt]\ntype = crypt\n")
        conf = self.harness.base / "rclone.conf"
        conf.write_text("[drive-crypt]\ntype = crypt\n")
        proc = self.harness.run_bootstrap(
            "--rclone-conf", str(conf), expect_success=False
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("rclone.conf", proc.stderr)
        self.assertEqual(dst.read_text(), "[drive-crypt]\ntype = crypt\n")


FAKE_MIHOMO = r"""#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "${PINGU_FAKE_STATE:?}/mihomo.log"
[[ "$#" == "5" && "$1" == "-t" && "$2" == "-d" && "$4" == "-f" ]] || exit 64
[[ -f "$3/GeoIP.dat" && -f "$3/GeoSite.dat" && -f "$5" ]] || exit 65
if grep -q FAIL_TEST "$5"; then exit 1; fi
"""


class MihomoBootstrapHarness(BootstrapHarness):
    """Exercise real verify/extract/remap rather than the legacy fake helper."""
    def __init__(self, test, config_fail=False):
        super().__init__(test, config_fail=config_fail)
        shutil.copyfile(OPS_VPS / "sbin/pingu_snapshot.py", self.helper)

    def _build_archive(self, config_fail, source_arch):
        from ops.vps.sbin import pingu_snapshot as snapshot
        from ops.vps.tests.test_pingu_snapshot import build_mihomo_source
        source = self.base / "source"
        source.mkdir()
        build_mihomo_source(source)
        binary = source / "usr/local/bin/mihomo"
        binary.write_text(FAKE_MIHOMO)
        binary.chmod(0o755)
        if config_fail:
            path = source / "etc/mihomo/config.json"
            config = json.loads(path.read_text())
            config["pingu-test-marker"] = "FAIL_TEST"
            path.write_text(json.dumps(config))
        with mock.patch.object(snapshot.platform, "machine", return_value=source_arch):
            result = snapshot.create_snapshot(self.base / "snapshots", source,
                                              snapshot_id=self.SNAPSHOT_ID)
        shutil.copyfile(result["archive_path"], self.archive)


class MihomoBootstrapTest(unittest.TestCase):
    def harness(self, config_fail=False):
        harness = MihomoBootstrapHarness(self, config_fail=config_fail)
        self.addCleanup(harness.cleanup)
        return harness

    def test_new_profile_bootstraps_without_xray_and_resolves_actual_interface(self):
        h = self.harness()
        proc = h.run_bootstrap(env_extra={"PINGU_FAKE_INTERFACE": "ens3"})
        self.assertIn("directly assigned to ens3", proc.stdout)
        self.assertFalse((h.root / "usr/local/bin/xray").exists())
        self.assertNotIn("xray.service", h.systemctl_log())
        self.assertEqual(h.unit_state("mihomo.service"), "active")
        self.assertIn("-t -d ", h._log("mihomo"))
        config = json.loads((h.root / "etc/mihomo/config.json").read_text())
        self.assertEqual(config["pingu-public-ipv4"], h.NEW_IP)
        self.assertEqual(config["proxies"][0]["interface-name"], "ens3")
        self.assertEqual(config["listeners"][0]["listen"], h.NEW_IP)
        self.assertEqual(config["listeners"][0]["reality-config"]["dest"], h.OLD_IP + ":443")
        marker = json.loads((h.root / "etc/pingu-migration/deployment.json").read_text())
        self.assertEqual(marker["runtime_profile"], "mihomo")
        self.assertEqual(marker["target_interface"], "ens3")
        self.assertIn("Before=pingu-gate.service mihomo.service cksheuen-portal.service",
                      (h.root / "etc/systemd/system/pingu-firewall.service").read_text())
        before = (h.root / "etc/mihomo/config.json").read_bytes()
        second = h.run_bootstrap(env_extra={"PINGU_FAKE_INTERFACE": "ens3"})
        self.assertIn("idempotent re-run", second.stdout)
        self.assertEqual((h.root / "etc/mihomo/config.json").read_bytes(), before)

    def test_failed_mihomo_validation_rolls_back_all_owned_files(self):
        h = self.harness(config_fail=True)
        proc = h.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("mihomo config test failed", proc.stderr)
        self.assertIn("rolling back", proc.stderr)
        for path in ("etc/mihomo/config.json", "usr/local/bin/mihomo",
                     "etc/pingu-gate/certs/cksheuen.site.key",
                     "etc/systemd/system/mihomo.service",
                     "etc/pingu-migration/deployment.json"):
            self.assertFalse((h.root / path).exists(), path)
        self.assertFalse(h.nft_table_loaded())
        self.assertNotIn("enable --now mihomo.service", h.systemctl_log())
        self.assertIsNone(h.unit_state("pingu-firewall.service"))

    def test_ambiguous_interface_refused_before_mutation(self):
        h = self.harness()
        payload = [{"ifname": name, "flags": ["UP"], "addr_info": [
            {"family": "inet", "local": h.NEW_IP}]} for name in ("ens3", "eth0")]
        h._write_fake("ip", "#!/bin/sh\ncat <<'JSON'\n" + json.dumps(payload) + "\nJSON\n")
        proc = h.run_bootstrap(expect_success=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("ambiguous", proc.stderr)
        self.assertEqual(h.systemctl_log(), "")
        self.assertEqual(h.nft_log(), "")
        self.assertFalse((h.root / "usr/local/bin/mihomo").exists())


if __name__ == "__main__":
    unittest.main()
