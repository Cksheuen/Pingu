import importlib.util
import ipaddress
import pathlib
import tempfile
import unittest
from email.message import Message
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("pingu_gate.py")
SPEC = importlib.util.spec_from_file_location("pingu_gate", MODULE_PATH)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class HandlerStub:
    def __init__(self, headers=None, client_address=("203.0.113.10", 12345)):
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value
        self.client_address = client_address


class GateTests(unittest.TestCase):
    def test_duration_validation(self):
        self.assertEqual(gate.parse_duration_seconds("30m"), 1800)
        self.assertEqual(gate.parse_duration_seconds("7d"), 604800)
        with self.assertRaises(ValueError):
            gate.parse_duration_seconds("0m")
        with self.assertRaises(ValueError):
            gate.parse_duration_seconds("forever")

    def test_bearer_token_is_preferred_over_query_token(self):
        handler = HandlerStub({"Authorization": "Bearer header-secret"})
        self.assertEqual(
            gate.request_token(handler, {"token": ["query-secret"]}),
            "header-secret",
        )

    def test_cloudflare_header_drives_detected_ip(self):
        handler = HandlerStub({"CF-Connecting-IP": "198.51.100.27"})
        self.assertEqual(
            gate.client_ip_from_headers(handler),
            ipaddress.ip_address("198.51.100.27"),
        )

    def test_ipv6_prefix_normalization(self):
        with mock.patch.object(gate, "IPV6_PREFIX_BITS", 64):
            self.assertEqual(
                gate.normalize_allow_element(ipaddress.ip_address("2001:db8:1:2::1234")),
                "2001:db8:1:2::/64",
            )

    def test_websocket_upgrade_requires_both_headers(self):
        websocket_headers = Message()
        websocket_headers["Upgrade"] = "websocket"
        websocket_headers["Connection"] = "keep-alive, Upgrade"
        self.assertTrue(gate.is_websocket_upgrade(websocket_headers))

        ordinary_headers = Message()
        ordinary_headers["Upgrade"] = "websocket"
        self.assertFalse(gate.is_websocket_upgrade(ordinary_headers))

    def test_gate_page_uses_eva_theme_and_secure_form_contract(self):
        page = gate.html_page(
            "Pingu Gate",
            '<form><input type="password" autocomplete="one-time-code"></form>',
        )

        self.assertIn("--surface-ice: #f7faff", page)
        self.assertIn("--accent-cobalt: #2f6fe4", page)
        self.assertIn("--accent-cyan: #4fd6f5", page)
        self.assertIn('meta name="theme-color" content="#0f1420"', page)
        self.assertIn('autocomplete="one-time-code"', page)

    def test_device_tokens_are_redacted_from_access_logs(self):
        token = "secret_device_token_123456789"
        message = gate.redact_sensitive_paths(
            f'GET /__pingu_gate__/devices/subscription/{token} and /__pingu_device__/v1/{token}'
        )
        self.assertNotIn(token, message)
        self.assertEqual(message.count("<redacted>"), 2)

    def test_device_websocket_resolves_without_ip_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            device, token = registry.create("alice", "phone")
            is_device, resolved_token, resolved, backend_path = gate.resolve_device_websocket(
                f"/__pingu_device__/v1/{token}", registry
            )
            self.assertTrue(is_device)
            self.assertEqual(resolved_token, token)
            self.assertEqual(resolved["id"], device["id"])
            self.assertEqual(backend_path, "/")

            registry.revoke(device["id"])
            _, _, resolved, _ = gate.resolve_device_websocket(
                f"/__pingu_device__/v1/{token}", registry
            )
            self.assertIsNone(resolved)

    def test_legacy_websocket_path_is_not_classified_as_device(self):
        is_device, token, device, backend_path = gate.resolve_device_websocket("/legacy-ws")
        self.assertFalse(is_device)
        self.assertEqual(token, "")
        self.assertIsNone(device)
        self.assertEqual(backend_path, "/legacy-ws")

    def test_device_login_rejects_invalid_gate_key(self):
        handler = object.__new__(gate.GateHandler)
        handler.show_devices = mock.Mock()
        with mock.patch.object(gate, "token_allowed", return_value=False):
            handler.handle_device_login({"token": ["wrong"]})
        handler.show_devices.assert_called_once_with("访问密钥无效。")

    def test_device_login_issues_secure_short_lived_cookie(self):
        handler = object.__new__(gate.GateHandler)
        handler.redirect = mock.Mock()
        sessions = gate.device_access.ManagementSessions(900)
        with (
            mock.patch.object(gate, "token_allowed", return_value=True),
            mock.patch.object(gate, "DEVICE_SESSIONS", sessions),
        ):
            handler.handle_device_login({"token": ["valid-secret"]})
        _, headers = handler.redirect.call_args.args
        cookie = headers["Set-Cookie"]
        self.assertIn("Secure", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("valid-secret", cookie)

    def test_device_create_requires_authenticated_session(self):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_text = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            with mock.patch.object(gate, "DEVICE_REGISTRY", registry):
                handler.handle_device_create(
                    {"csrf": ["missing"], "owner": ["alice"], "name": ["phone"]}
                )
            self.assertEqual(registry.list(), [])
        self.assertEqual(handler.send_text.call_args.args[0], 403)

    def test_device_create_after_login_returns_local_qr_and_one_time_url(self):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_text = mock.Mock()
        handler.send_html = mock.Mock()
        sessions = gate.device_access.ManagementSessions(900)
        session_id, csrf = sessions.issue()
        handler.headers["Cookie"] = f"{gate.DEVICE_SESSION_COOKIE}={session_id}"
        template = "vless://uuid@cksheuen.site:443?type=ws&security=tls&path=%2F#shared\n"
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            with (
                mock.patch.object(gate, "DEVICE_SESSIONS", sessions),
                mock.patch.object(gate, "DEVICE_REGISTRY", registry),
                mock.patch.object(gate, "read_subscription", return_value=template),
                mock.patch.object(
                    gate.device_access, "render_qr_svg", return_value="<svg>local-qr</svg>"
                ),
            ):
                handler.handle_device_create(
                    {"csrf": [csrf], "owner": ["alice"], "name": ["phone"]}
                )
            self.assertEqual(len(registry.list()), 1)
        status, _, body = handler.send_html.call_args.args
        self.assertEqual(status, 201)
        self.assertIn("<svg>local-qr</svg>", body)
        self.assertIn("/__pingu_gate__/devices/subscription/", body)

    def test_authenticated_device_list_shows_creation_and_connection_audit_fields(self):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_html = mock.Mock()
        sessions = gate.device_access.ManagementSessions(900)
        session_id, _ = sessions.issue()
        handler.headers["Cookie"] = f"{gate.DEVICE_SESSION_COOKIE}={session_id}"
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            record, token = registry.create("alice", "phone")
            registry.record_connection(token, "198.51.100.27")
            with (
                mock.patch.object(gate, "DEVICE_SESSIONS", sessions),
                mock.patch.object(gate, "DEVICE_REGISTRY", registry),
            ):
                handler.show_devices()

        status, _, body = handler.send_html.call_args.args
        self.assertEqual(status, 200)
        self.assertIn(record["created_at"], body)
        self.assertIn("alice / phone", body)
        self.assertIn("198.51.100.27", body)
        self.assertIn("有效 / 1", body)

    @mock.patch.object(gate.subprocess, "run")
    @mock.patch.object(gate, "nft_contains", return_value=True)
    def test_existing_lease_is_refreshed_in_one_nft_transaction(self, _, run):
        run.return_value.returncode = 0
        gate.nft_refresh("reality_allow4", "198.51.100.27", "30m")

        command = run.call_args.args[0]
        batch = run.call_args.kwargs["input"]
        self.assertEqual(command, ["nft", "-f", "-"])
        self.assertIn("delete element", batch)
        self.assertIn("add element", batch)
        self.assertIn("timeout 30m", batch)


if __name__ == "__main__":
    unittest.main()
