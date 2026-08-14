import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("pingu_device_access.py")
SPEC = importlib.util.spec_from_file_location("pingu_device_access", MODULE_PATH)
access = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(access)


class DeviceAccessTests(unittest.TestCase):
    def test_create_persists_digest_only_and_authenticates(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            record, token = registry.create("alice@example.com", "Alice iPhone")
            raw = pathlib.Path(directory, "devices.json").read_text()

            self.assertNotIn(token, raw)
            self.assertEqual(registry.authenticate(token)["id"], record["id"])
            self.assertIsNone(registry.authenticate("wrong-token"))

    def test_revoke_blocks_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            record, token = registry.create("alice", "phone")
            self.assertTrue(registry.revoke(record["id"]))
            self.assertIsNone(registry.authenticate(token))
            self.assertFalse(registry.revoke(record["id"]))

    def test_subscription_contains_only_ws_node_and_device_path(self):
        template = (
            "vless://uuid@cksheuen.site:443?type=ws&security=tls&path=%2F#shared\n"
            "vless://uuid@cksheuen.site:8443?type=tcp&security=reality#reality\n"
        )
        rendered = access.build_device_subscription(template, "token", "alice", "phone")
        self.assertEqual(len(rendered.splitlines()), 1)
        self.assertIn("type=ws", rendered)
        self.assertIn("__pingu_device__%2Fv1%2Ftoken", rendered)
        self.assertIn("Pingu%20alice%20%2F%20phone", rendered)
        self.assertNotIn("8443", rendered)

    @mock.patch.object(access.subprocess, "run")
    def test_qr_uses_stdin_and_returns_svg(self, run):
        run.return_value = mock.Mock(returncode=0, stdout="<svg viewBox='0 0 1 1'></svg>")
        self.assertIn("<svg", access.render_qr_svg("https://example.test/sub"))
        self.assertEqual(run.call_args.kwargs["input"], "https://example.test/sub")
        self.assertNotIn("https://example.test/sub", run.call_args.args[0])

    def test_path_extractors_reject_extra_segments(self):
        self.assertEqual(access.device_token_from_path("/__pingu_device__/v1/token"), "token")
        self.assertEqual(access.subscription_token_from_path("/__pingu_gate__/devices/subscription/token"), "token")
        self.assertEqual(access.device_token_from_path("/__pingu_device__/v1/token/extra"), "")

    def test_management_session_requires_csrf_for_mutations(self):
        sessions = access.ManagementSessions(ttl_seconds=900)
        session_id, csrf = sessions.issue()
        self.assertTrue(sessions.valid(session_id))
        self.assertTrue(sessions.valid(session_id, csrf))
        self.assertFalse(sessions.valid(session_id, ""))


if __name__ == "__main__":
    unittest.main()
