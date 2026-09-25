import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from ops.vps.sbin import pingu_backup as backup
from ops.vps.sbin import pingu_snapshot as snap
from ops.vps.tests.test_pingu_snapshot import OLD_IP, build_source


SYSTEMD_DIR = Path(__file__).resolve().parents[1] / "systemd"


def _parse_unit(path):
    sections = {}
    current = None
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            sections.setdefault(current, {})
        elif "=" in line and current is not None:
            key, value = line.split("=", 1)
            sections[current][key.strip()] = value.strip()
    return sections


class BackupConfigTests(unittest.TestCase):
    def setUp(self):
        self.original_config = backup.CONFIG.copy()

    def tearDown(self):
        backup.CONFIG.clear()
        backup.CONFIG.update(self.original_config)

    def test_load_shell_config_overrides_defaults(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            conf = Path(temp_dir) / "backup.conf"
            conf.write_text(
                "# comment\nRCLONE_REMOTE='drive-crypt:'\nSTATE_DIR=/var/tmp/x\n"
            )
            backup.load_shell_config(str(conf))

        self.assertEqual(backup.CONFIG["RCLONE_REMOTE"], "drive-crypt:")
        self.assertEqual(backup.CONFIG["STATE_DIR"], "/var/tmp/x")

    def test_redact_strips_credential_values(self):
        text = "failed token=abc123 and password=hunter2 in config"
        redacted = backup.redact(text)
        self.assertNotIn("abc123", redacted)
        self.assertNotIn("hunter2", redacted)
        self.assertIn("token=<redacted>", redacted)


class CryptRemoteValidationTests(unittest.TestCase):
    def setUp(self):
        self.original_config = backup.CONFIG.copy()

    def tearDown(self):
        backup.CONFIG.clear()
        backup.CONFIG.update(self.original_config)

    def test_accepts_crypt_remote_without_leaking_secret(self):
        captured = {}

        def fake_run(cmd, timeout=None):
            captured["cmd"] = cmd
            return SimpleNamespace(
                returncode=0,
                stdout="[drive-crypt]\ntype = crypt\npassword = hX-secret-value\n",
                stderr="",
            )

        with mock.patch.object(backup, "run", side_effect=fake_run):
            ok, error = backup.validate_crypt_remote("drive-crypt:")

        self.assertTrue(ok)
        self.assertEqual(error, "")
        self.assertEqual(
            captured["cmd"], ["/usr/bin/rclone", "config", "show", "drive-crypt"]
        )

    def test_rejects_non_crypt_remote(self):
        def fake_run(cmd, timeout=None):
            return SimpleNamespace(
                returncode=0, stdout="[drive]\ntype = drive\n", stderr=""
            )

        with mock.patch.object(backup, "run", side_effect=fake_run):
            ok, error = backup.validate_crypt_remote("drive:")

        self.assertFalse(ok)
        self.assertIn("must be crypt", error)


class BackupFlowTests(unittest.TestCase):
    """End-to-end backup flow with a real snapshot and mocked rclone."""

    def setUp(self):
        self.original_config = backup.CONFIG.copy()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        build_source(self.source)
        self.state_dir = self.root / "state"
        self.output_dir = self.root / "output"
        backup.CONFIG.update({
            "RCLONE_BIN": sys.executable,  # exists; rclone itself is mocked
            "RCLONE_REMOTE": "drive-crypt:",
            "STATE_DIR": str(self.state_dir),
            "OUTPUT_DIR": str(self.output_dir),
            "LOCK_FILE": str(self.root / "backup.lock"),
            "SNAPSHOT_SOURCE_ROOT": str(self.source),
        })
        self.commands = []
        self.latest_payloads = []

    def tearDown(self):
        backup.CONFIG.clear()
        backup.CONFIG.update(self.original_config)
        self.tmp.cleanup()

    def _fake_run(self, fail_stage=None):
        def fake_run(cmd, timeout=None):
            self.commands.append(cmd)
            verb = cmd[1] if len(cmd) > 1 else ""
            if verb == "config":
                return SimpleNamespace(
                    returncode=0,
                    stdout="[drive-crypt]\ntype = crypt\npassword = secret\n",
                    stderr="",
                )
            if fail_stage == "upload" and verb == "copy":
                return SimpleNamespace(
                    returncode=1, stdout="", stderr="upload failed token=abc123"
                )
            if fail_stage == "verify" and verb == "cryptcheck":
                return SimpleNamespace(
                    returncode=1, stdout="", stderr="cryptcheck mismatch"
                )
            if fail_stage == "publish" and verb == "copyto":
                return SimpleNamespace(
                    returncode=1, stdout="", stderr="copyto failed"
                )
            if verb == "copyto":
                self.latest_payloads.append(Path(cmd[2]).read_text())
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return fake_run

    def _patch_ip(self):
        return mock.patch.object(
            snap, "detect_public_ipv4",
            side_effect=lambda source_root=None: (OLD_IP, "pinned"),
        )

    def test_happy_path_uploads_immutable_cryptchecks_and_publishes_latest(self):
        with mock.patch.object(backup, "run", side_effect=self._fake_run()), \
             self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 0)
        verbs = [cmd[1] for cmd in self.commands]
        self.assertEqual(verbs, ["config", "copy", "cryptcheck", "copyto"])
        copy_cmd = self.commands[1]
        self.assertIn("--immutable", copy_cmd)
        self.assertTrue(
            copy_cmd[3].startswith("drive-crypt:/snapshots/")
        )
        self.assertEqual(self.commands[2][1], "cryptcheck")
        self.assertTrue(
            self.commands[3][3].endswith("/LATEST.json")
        )

        self.assertEqual(len(self.latest_payloads), 1)
        index = json.loads(self.latest_payloads[0])
        self.assertEqual(index["schema"], backup.LATEST_SCHEMA)
        self.assertTrue(index["verified"])
        self.assertGreater(index["archive_bytes"], 0)
        self.assertGreater(index["files_count"], 0)

        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertTrue(state["ok"])
        self.assertEqual(state["stage"], "done")
        self.assertEqual(state["snapshot_id"], index["snapshot_id"])
        self.assertEqual(state["sha256"], index["sha256"])
        self.assertTrue(
            state["cloudpath"].startswith("drive-crypt:/snapshots/")
        )

    def test_upload_failure_never_promotes_latest(self):
        with mock.patch.object(
            backup, "run", side_effect=self._fake_run(fail_stage="upload")
        ), self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 1)
        self.assertEqual(
            [cmd[1] for cmd in self.commands], ["config", "copy"]
        )
        self.assertEqual(self.latest_payloads, [])
        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertFalse(state["ok"])
        self.assertEqual(state["stage"], "upload")
        self.assertNotIn("abc123", state["error"])

    def test_cryptcheck_failure_never_promotes_latest(self):
        with mock.patch.object(
            backup, "run", side_effect=self._fake_run(fail_stage="verify")
        ), self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 1)
        self.assertEqual(
            [cmd[1] for cmd in self.commands],
            ["config", "copy", "cryptcheck"],
        )
        self.assertEqual(self.latest_payloads, [])
        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertFalse(state["ok"])
        self.assertEqual(state["stage"], "verify")

    def test_publish_failure_is_reported_without_latest_promotion(self):
        with mock.patch.object(
            backup, "run", side_effect=self._fake_run(fail_stage="publish")
        ), self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 1)
        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertFalse(state["ok"])
        self.assertEqual(state["stage"], "publish")
        # The failed copyto must not be recorded as a verified promotion.
        self.assertNotIn("verified", state)

    def test_missing_critical_asset_aborts_before_any_rclone_call(self):
        (self.source / "var/lib/pingu-gate/devices.json").unlink()
        with mock.patch.object(backup, "run", side_effect=self._fake_run()), \
             self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 1)
        self.assertEqual(self.commands, [])
        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertFalse(state["ok"])
        self.assertEqual(state["stage"], "snapshot")
        self.assertIn("devices.json", state["error"])

    def test_timeout_is_recorded_and_never_promotes_latest(self):
        def fake_run(cmd, timeout=None):
            self.commands.append(cmd)
            verb = cmd[1] if len(cmd) > 1 else ""
            if verb == "config":
                return SimpleNamespace(
                    returncode=0,
                    stdout="[drive-crypt]\ntype = crypt\n",
                    stderr="",
                )
            if verb == "copy":
                raise subprocess.TimeoutExpired(cmd, timeout=3600)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with mock.patch.object(backup, "run", side_effect=fake_run), \
             self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 1)
        self.assertEqual([cmd[1] for cmd in self.commands], ["config", "copy"])
        self.assertEqual(self.latest_payloads, [])
        state = json.loads((self.state_dir / "last-run.json").read_text())
        self.assertFalse(state["ok"])
        self.assertEqual(state["stage"], "upload")
        self.assertIn("timed out", state["error"])
        # Failed snapshot is preserved locally for retry.
        snapshots = list(self.output_dir.glob("*/snapshot.tar.gz"))
        self.assertEqual(len(snapshots), 1)

    def test_success_prunes_local_snapshot_cache_to_one(self):
        stale = self.output_dir / "20200101T000000Z-stale"
        stale.mkdir(parents=True)
        (stale / "snapshot.tar.gz").write_text("old\n")
        (stale / "SHA256SUMS").write_text("old\n")

        with mock.patch.object(backup, "run", side_effect=self._fake_run()), \
             self._patch_ip():
            rc = backup.run_backup(self.state_dir)

        self.assertEqual(rc, 0)
        snapshots = sorted(
            p.name for p in self.output_dir.glob("*/snapshot.tar.gz")
        )
        self.assertEqual(len(snapshots), 1)
        self.assertNotIn("20200101T000000Z-stale", snapshots)


class SystemdUnitTests(unittest.TestCase):
    """Semantic structure of the backup unit (actual service tested later)."""

    def test_unit_uses_valid_sections_and_keys(self):
        unit = _parse_unit(SYSTEMD_DIR / "pingu-backup.service")
        self.assertIn("Unit", unit)
        self.assertIn("Service", unit)
        # RateLimit* are invalid unit-level keys for services.
        self.assertNotIn("RateLimitIntervalSec", unit.get("Unit", {}))
        self.assertNotIn("RateLimitBurst", unit.get("Unit", {}))
        # ConditionPathExists belongs in [Unit], not [Service].
        self.assertIn("ConditionPathExists", unit["Unit"])
        self.assertNotIn("ConditionPathExists", unit["Service"])
        # StartLimit* (if any) belongs in [Unit].
        for section, values in unit.items():
            if section != "Unit":
                self.assertNotIn("StartLimitIntervalSec", values)
                self.assertNotIn("StartLimitBurst", values)

    def test_unit_grants_required_data_access(self):
        unit = _parse_unit(SYSTEMD_DIR / "pingu-backup.service")
        service = unit["Service"]
        # /root must stay readable (pingu-secrets, rclone.conf) ...
        self.assertEqual(service["ProtectHome"], "read-only")
        # ... while rclone OAuth token refresh can write its config ...
        self.assertIn("/root/.config/rclone", service["ReadWritePaths"])
        # ... the state dir is a proper StateDirectory ...
        self.assertEqual(service["StateDirectory"], "pingu-backup")
        self.assertEqual(service["StateDirectoryMode"], "0700")
        # ... and the lock file under /run is writable.
        self.assertIn("/run", service["ReadWritePaths"])

    def test_path_watcher_stays_disabled_and_daily_timer_preserved(self):
        path_unit = _parse_unit(SYSTEMD_DIR / "pingu-backup.path")
        self.assertEqual(
            path_unit["Path"]["Unit"], "pingu-backup.service"
        )
        self.assertIn("PathChanged", path_unit["Path"])
        timer = (SYSTEMD_DIR / "pingu-backup.timer").read_text()
        self.assertIn("OnCalendar=*-*-* 00:30:00 UTC", timer)


class BackupMainTests(unittest.TestCase):
    def setUp(self):
        self.original_config = backup.CONFIG.copy()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        build_source(self.source)
        backup.CONFIG.update({
            "RCLONE_BIN": sys.executable,
            "RCLONE_REMOTE": "",
            "STATE_DIR": str(self.root / "state"),
            "OUTPUT_DIR": str(self.root / "output"),
            "LOCK_FILE": str(self.root / "backup.lock"),
            "SNAPSHOT_SOURCE_ROOT": str(self.source),
        })

    def tearDown(self):
        backup.CONFIG.clear()
        backup.CONFIG.update(self.original_config)
        self.tmp.cleanup()

    def test_status_prints_last_run_state(self):
        state_dir = Path(backup.CONFIG["STATE_DIR"])
        state_dir.mkdir(parents=True)
        (state_dir / "last-run.json").write_text(
            json.dumps({"ok": True, "stage": "done"})
        )
        with mock.patch("sys.stdout", new=io.StringIO()) as stdout:
            rc = backup.main(["--status"])
        self.assertEqual(rc, 0)
        self.assertIn('"ok": true', stdout.getvalue())

    def test_remote_flag_overrides_config(self):
        commands = []

        def fake_run(cmd, timeout=None):
            commands.append(cmd)
            if cmd[1] == "config":
                return SimpleNamespace(
                    returncode=0,
                    stdout="[other-crypt]\ntype = crypt\n",
                    stderr="",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with mock.patch.object(backup, "run", side_effect=fake_run), \
             mock.patch.object(
                 snap, "detect_public_ipv4",
                 side_effect=lambda source_root=None: (OLD_IP, "pinned")):
            rc = backup.main(["--remote", "other-crypt:"])

        self.assertEqual(rc, 0)
        self.assertEqual(commands[0][-1], "other-crypt")
        state = json.loads(
            (Path(backup.CONFIG["STATE_DIR"]) / "last-run.json").read_text()
        )
        self.assertTrue(state["ok"])
        self.assertEqual(state["remote"], "other-crypt:")


if __name__ == "__main__":
    unittest.main()
