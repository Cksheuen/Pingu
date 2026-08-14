import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from ops.vps import pingu_traffic_guard as guard
from ops.vps import pingu_traffic_report as report


class TrafficGuardTests(unittest.TestCase):
    def setUp(self):
        self.original_config = guard.CONFIG.copy()

    def tearDown(self):
        guard.CONFIG.clear()
        guard.CONFIG.update(self.original_config)

    def test_load_shell_config_overrides_defaults(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "guard.conf"
            config_path.write_text(
                "# comment\nEMAIL_TO=operator@example.com\nWATCH_PORTS='8443'\n"
            )
            guard.load_shell_config(config_path)

        self.assertEqual(guard.CONFIG["EMAIL_TO"], "operator@example.com")
        self.assertEqual(guard.CONFIG["WATCH_PORTS"], "8443")

    def test_nft_set_bytes_parses_counters(self):
        output = """
          elements = { 192.0.2.10 counter packets 4 bytes 8192,
                       198.51.100.5 counter packets 2 bytes 1024 }
        """
        with mock.patch.object(
            guard,
            "run",
            return_value=SimpleNamespace(returncode=0, stdout=output, stderr=""),
        ):
            counters = guard.nft_set_bytes("acct4", "ipv4")

        self.assertEqual(counters, {"192.0.2.10": 8192, "198.51.100.5": 1024})

    def test_alert_without_email_is_log_only(self):
        guard.CONFIG["EMAIL_TO"] = ""
        with mock.patch.object(guard, "append_alert") as append_alert:
            with mock.patch.object(guard, "send_via_mail") as send_mail:
                sent = guard.alert("subject", "body")

        self.assertFalse(sent)
        self.assertEqual(append_alert.call_count, 2)
        send_mail.assert_not_called()


class TrafficReportTests(unittest.TestCase):
    def test_human_bytes(self):
        self.assertEqual(report.human_bytes(512), "512 B")
        self.assertEqual(report.human_bytes(1536), "1.50 KiB")
        self.assertEqual(report.human_bytes("bad"), "n/a")

    def test_xray_access_regex_supports_ipv4_and_ipv6(self):
        ipv4 = report.XRAY_RE.search(
            "2026/08/11 03:00:00 from 192.0.2.4:1234 accepted tcp:example.com:443 [proxy] email: user"
        )
        ipv6 = report.XRAY_RE.search(
            "2026/08/11 03:00:00 from [2001:db8::1]:1234 accepted tcp:[2001:db8::2]:443 [direct]"
        )

        self.assertEqual(ipv4.group("src"), "192.0.2.4")
        self.assertEqual(ipv4.group("email"), "user")
        self.assertEqual(ipv6.group("src"), "[2001:db8::1]")
        self.assertEqual(ipv6.group("route"), "direct")

    def test_cleanup_reports_respects_retention(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            old_report = output_dir / "traffic-report-old.txt"
            new_report = output_dir / "traffic-report-new.txt"
            old_report.write_text("old")
            new_report.write_text("new")
            old_time = report.dt.datetime.now().timestamp() - 60 * 86400
            os.utime(old_report, (old_time, old_time))

            report.cleanup_reports(output_dir, retention_days=45)

            self.assertFalse(old_report.exists())
            self.assertTrue(new_report.exists())


if __name__ == "__main__":
    unittest.main()
