import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).resolve().parent.parent / "sbin" / "pingu_device_access.py"
SPEC = importlib.util.spec_from_file_location("pingu_device_access", MODULE_PATH)
access = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(access)


class DeviceAccessTests(unittest.TestCase):
    def test_managed_provision_retries_and_revocation_tombstone(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "devices.json"
            registry = access.DeviceRegistry(path)
            ident, token = "cloud-" + "a" * 32, "b" * 43
            first = registry.provision_managed(ident, token, "alice", "phone")
            self.assertEqual(first, registry.provision_managed(ident, token, "alice", "phone"))
            self.assertEqual(len(registry.list()), 1)
            self.assertEqual(registry.authenticate(token)["id"], ident)
            self.assertNotIn(token, path.read_text())
            registry.revoke_managed(ident)
            with self.assertRaises(ValueError):
                registry.provision_managed(ident, token, "alice", "phone")
            self.assertIsNone(registry.authenticate(token))
            before_create = "cloud-" + "c" * 32
            registry.revoke_managed(before_create)
            registry = access.DeviceRegistry(path)
            with self.assertRaises(ValueError):
                registry.provision_managed(before_create, "d" * 43, "alice", "phone")

    def test_managed_identity_and_token_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            for ident, token in [("legacy", "a" * 43), ("cloud-" + "b" * 32, "short")]:
                with self.assertRaises(ValueError):
                    registry.provision_managed(ident, token, "owner", "device")
            self.assertEqual(registry.list(), [])

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
            "vless://00000000-0000-0000-0000-000000000000@vpn.example.test:443?type=ws&security=tls&path=%2F#shared\n"
            "vless://00000000-0000-0000-0000-000000000000@vpn.example.test:8443?type=tcp&security=reality#reality\n"
        )
        rendered = access.build_device_subscription(template, "token", "alice", "phone")
        self.assertEqual(len(rendered.splitlines()), 1)
        self.assertIn("type=ws", rendered)
        self.assertIn("__pingu_device__%2Fv1%2Ftoken", rendered)
        self.assertIn("Pingu%20alice%20%2F%20phone", rendered)
        self.assertNotIn("8443", rendered)

    def test_raw_path_is_encoded_exactly_once(self):
        template = (
            "vless://00000000-0000-0000-0000-000000000000@vpn.example.test:443"
            "?type=ws&security=tls&path=%2Fws#shared"
        )
        rendered = access.build_device_subscription(template, "tok", "alice", "phone")
        self.assertIn("path=%2F__pingu_device__%2Fv1%2Ftok", rendered)
        self.assertNotIn("%252F", rendered)

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


class TemplateValidationTests(unittest.TestCase):
    VALID = (
        "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
        "?encryption=none&security=tls&sni=vpn.example.test&type=ws"
        "&host=vpn.example.test&path=%2Fws#shared"
    )

    def test_missing_ws_node_rejected(self):
        template = (
            "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
            "?type=tcp&security=reality#reality\n"
        )
        with self.assertRaises(ValueError):
            access.validate_device_template(template)

    def test_invalid_uuid_rejected(self):
        with self.assertRaises(ValueError):
            access.validate_device_template(
                "vless://not-a-uuid@vpn.example.test:443?type=ws&security=tls#x"
            )

    def test_missing_port_rejected(self):
        with self.assertRaises(ValueError):
            access.validate_device_template(
                "vless://11111111-1111-1111-1111-111111111111@vpn.example.test"
                "?type=ws&security=tls#x"
            )

    def test_tls_is_required(self):
        with self.assertRaises(ValueError):
            access.validate_device_template(
                "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
                "?type=ws&security=none#x"
            )

    def test_flow_rejected_on_ws(self):
        with self.assertRaises(ValueError):
            access.validate_device_template(
                "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
                "?type=ws&security=tls&flow=xtls-rprx-vision#x"
            )

    def test_reality_rejected_on_ws(self):
        with self.assertRaises(ValueError):
            access.validate_device_template(
                "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
                "?type=ws&security=tls&pbk=xxxx&sid=yyyy#x"
            )


class ClashSubscriptionTests(unittest.TestCase):
    TEMPLATE = (
        "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
        "?encryption=none&security=tls&sni=vpn.example.test&type=ws"
        "&host=vpn.example.test&path=%2Fws#shared"
    )

    def test_yaml_has_required_fields_and_exact_device_path(self):
        rendered = access.build_clash_subscription(self.TEMPLATE, "tok_ABC-_.~", "alice", "phone")
        for snippet in (
            "type: vless",
            'server: "vpn.example.test"',
            "port: 443",
            'uuid: "11111111-1111-1111-1111-111111111111"',
            "udp: true",
            "tls: true",
            'servername: "vpn.example.test"',
            'client-fingerprint: "chrome"',
            "network: ws",
            "ws-opts:",
            'path: "/__pingu_device__/v1/tok_ABC-_.~"',
            "headers:",
            'Host: "vpn.example.test"',
            "proxy-groups:",
            "- name: PROXY",
            "rules:",
            "- MATCH,PROXY",
            'name: "Pingu alice / phone"',
        ):
            self.assertIn(snippet, rendered)
        self.assertNotIn("flow", rendered)
        self.assertNotIn("reality", rendered.lower())
        self.assertNotIn("%2F", rendered)

    @unittest.skipUnless(
        importlib.util.find_spec("yaml"), "PyYAML not installed"
    )
    def test_yaml_is_parseable_complete_config(self):
        import yaml

        rendered = access.build_clash_subscription(self.TEMPLATE, "tok", "alice", "phone")
        config = yaml.safe_load(rendered)
        proxy = config["proxies"][0]
        self.assertEqual(proxy["type"], "vless")
        self.assertEqual(proxy["network"], "ws")
        self.assertEqual(proxy["ws-opts"]["path"], "/__pingu_device__/v1/tok")
        self.assertEqual(proxy["ws-opts"]["headers"]["Host"], "vpn.example.test")
        self.assertEqual(config["proxy-groups"][0]["proxies"], ["Pingu alice / phone"])
        self.assertEqual(config["rules"], ["MATCH,PROXY"])


if __name__ == "__main__":
    unittest.main()
