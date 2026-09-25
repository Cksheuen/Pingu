import copy
import importlib.util
import ipaddress
import json
import pathlib
import tempfile
import unittest
import urllib.parse
from email.message import Message
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).resolve().parent.parent / "sbin" / "pingu_gate.py"
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
    def test_connection_management_requires_login_and_csrf(self):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_text = mock.Mock()
        handler.send_json = mock.Mock()
        handler.send_html = mock.Mock()
        handler.redirect = mock.Mock()
        sessions = gate.device_access.ManagementSessions(900)
        with mock.patch.object(gate, "DEVICE_SESSIONS", sessions), mock.patch.object(gate.mihomo, "controller_request") as request:
            handler.show_connections()
            handler.redirect.assert_called_once_with(gate.PATH_PREFIX + "/devices")
            request.assert_not_called()
            session, csrf = sessions.issue()
            handler.headers["Cookie"] = f"{gate.DEVICE_SESSION_COOKIE}={session}"
            handler.show_connections()
            body = handler.send_html.call_args.args[2]
            self.assertIn(csrf, body)
            self.assertIn("/devices/connections.js", body)
            self.assertNotIn("19090", body)
            self.assertFalse(handler.require_device_session({"csrf": ["wrong"]}))
            self.assertEqual(handler.require_device_session({"csrf": [csrf]}), session)

    def test_connection_endpoint_passes_only_authorized_controller_operations(self):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_json = mock.Mock()
        handler.send_text = mock.Mock()
        handler.path = gate.PATH_PREFIX + "/devices/connections/close"
        sessions = gate.device_access.ManagementSessions(900)
        session, csrf = sessions.issue()
        with mock.patch.object(gate, "DEVICE_SESSIONS", sessions), mock.patch.object(gate.mihomo, "controller_request", return_value={}) as request:
            with mock.patch.object(gate, "parse_form_body", return_value={"csrf": [csrf], "id": ["abc-123"]}):
                handler.do_POST()
                request.assert_not_called()
                handler.headers["Cookie"] = f"{gate.DEVICE_SESSION_COOKIE}={session}"
                handler.do_POST()
                request.assert_called_once_with("DELETE", "/connections/abc-123")
            request.reset_mock()
            with mock.patch.object(gate, "parse_form_body", return_value={"csrf": [csrf], "id": ["../configs"]}):
                handler.do_POST()
                request.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[0], 400)

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


class DeviceSubscriptionEndpointTests(unittest.TestCase):
    TEMPLATE = (
        "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
        "?encryption=none&security=tls&sni=vpn.example.test&type=ws"
        "&host=vpn.example.test&path=%2Fws#shared"
    )

    @staticmethod
    def _handler():
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.client_address = ("203.0.113.10", 12345)
        handler.send_text = mock.Mock()
        return handler

    def _fetch(self, handler, registry, token, query=""):
        url = f"/__pingu_gate__/devices/subscription/{token}{query}"
        with (
            mock.patch.object(gate, "DEVICE_REGISTRY", registry),
            mock.patch.object(gate, "read_subscription", return_value=self.TEMPLATE),
        ):
            handler.handle_device_subscription(urllib.parse.urlparse(url))

    def test_default_returns_raw_vless_text(self):
        handler = self._handler()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            _, token = registry.create("alice", "phone")
            self._fetch(handler, registry, token)
        status, body, content_type = handler.send_text.call_args.args
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/plain; charset=utf-8")
        self.assertTrue(body.startswith("vless://"))
        self.assertIn("type=ws", body)

    def test_clash_format_returns_yaml(self):
        handler = self._handler()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            _, token = registry.create("alice", "phone")
            self._fetch(handler, registry, token, "?format=clash")
        status, body, content_type = handler.send_text.call_args.args
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/yaml; charset=utf-8")
        self.assertIn("proxies:", body)
        self.assertIn("network: ws", body)
        self.assertIn(f'path: "/__pingu_device__/v1/{token}"', body)

    def test_unknown_format_returns_400(self):
        handler = self._handler()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            _, token = registry.create("alice", "phone")
            self._fetch(handler, registry, token, "?format=bogus")
        self.assertEqual(handler.send_text.call_args.args[0], 400)

    def test_invalid_token_returns_403_for_every_format(self):
        handler = self._handler()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            for query in ("", "?format=clash", "?format=bogus"):
                self._fetch(handler, registry, "unknown-token", query)
        statuses = [call.args[0] for call in handler.send_text.call_args_list]
        self.assertEqual(statuses, [403, 403, 403])

    def test_revoked_token_returns_403(self):
        handler = self._handler()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            record, token = registry.create("alice", "phone")
            registry.revoke(record["id"])
            self._fetch(handler, registry, token, "?format=clash")
        self.assertEqual(handler.send_text.call_args.args[0], 403)


class DeviceCreatePageTests(unittest.TestCase):
    TEMPLATE = (
        "vless://11111111-1111-1111-1111-111111111111@vpn.example.test:443"
        "?type=ws&security=tls&host=vpn.example.test&path=%2Fws#shared"
    )

    @staticmethod
    def _handler_with_session():
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.send_html = mock.Mock()
        sessions = gate.device_access.ManagementSessions(900)
        session_id, csrf = sessions.issue()
        handler.headers["Cookie"] = f"{gate.DEVICE_SESSION_COOKIE}={session_id}"
        return handler, sessions, csrf

    def test_page_shows_labeled_links_qrs_and_escaped_raw_node(self):
        handler, sessions, csrf = self._handler_with_session()
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            with (
                mock.patch.object(gate, "DEVICE_SESSIONS", sessions),
                mock.patch.object(gate, "DEVICE_REGISTRY", registry),
                mock.patch.object(gate, "read_subscription", return_value=self.TEMPLATE),
                mock.patch.object(
                    gate.device_access,
                    "render_qr_svg",
                    side_effect=["<svg>general-qr</svg>", "<svg>clash-qr</svg>"],
                ),
            ):
                handler.handle_device_create(
                    {"csrf": [csrf], "owner": ["alice"], "name": ["phone"]}
                )
            self.assertEqual(len(registry.list()), 1)
        status, _, body = handler.send_html.call_args.args
        self.assertEqual(status, 201)
        self.assertIn("Pingu / 通用客户端订阅链接", body)
        self.assertIn("Clash Verge / Mihomo 订阅链接", body)
        self.assertIn("?format=clash", body)
        self.assertIn("<svg>general-qr</svg>", body)
        self.assertIn("<svg>clash-qr</svg>", body)
        self.assertLess(
            body.index("Pingu / 通用客户端订阅链接"), body.index("<svg>general-qr</svg>")
        )
        self.assertLess(
            body.index("Clash Verge / Mihomo 订阅链接"), body.index("<svg>clash-qr</svg>")
        )
        self.assertIn("vless://", body)
        self.assertIn("&amp;", body)
        self.assertNotIn("<script>", body)

    def test_malformed_template_does_not_persist_device(self):
        handler, sessions, csrf = self._handler_with_session()
        handler.send_text = mock.Mock()
        template = "vless://not-a-uuid@vpn.example.test:443?type=ws&security=tls#x"
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(
                pathlib.Path(directory) / "devices.json"
            )
            with (
                mock.patch.object(gate, "DEVICE_SESSIONS", sessions),
                mock.patch.object(gate, "DEVICE_REGISTRY", registry),
                mock.patch.object(gate, "read_subscription", return_value=template),
            ):
                handler.handle_device_create(
                    {"csrf": [csrf], "owner": ["alice"], "name": ["phone"]}
                )
            self.assertEqual(registry.list(), [])
        status, message = handler.send_text.call_args.args
        self.assertEqual(status, 500)
        self.assertNotIn("not-a-uuid", message)


class WsSourceIdentityTests(unittest.TestCase):
    """Source attribution for Gate-relayed WS connections (fake sockets only)."""

    WS_NAME = "cf-ws-local"
    WS_PORT = 10000

    def setUp(self):
        gate.WS_SOURCE_IDENTITIES.clear()
        self.addCleanup(gate.WS_SOURCE_IDENTITIES.clear)

    @staticmethod
    def _config_path(directory):
        path = pathlib.Path(directory) / "config.json"
        path.write_text(
            json.dumps(
                {
                    "listeners": [
                        {"name": "cf-ws-local", "type": "vless", "listen": "127.0.0.1",
                         "port": 10000, "ws-path": "/", "allow-insecure": True},
                        {"name": "reality", "type": "vless", "listen": "0.0.0.0", "port": 8443,
                         "reality-config": {"dest": "example.com:443"}},
                    ]
                }
            ),
            encoding="utf-8",
        )
        return path

    def _enrich(self, payload, directory):
        with (
            mock.patch.object(gate, "WS_LISTENER_IDS", set()),
            mock.patch.object(gate.mihomo, "CONFIG_PATH", self._config_path(directory)),
        ):
            return gate.enrich_connections(payload, gate.ws_source_snapshot())

    @staticmethod
    def _ws_connection(connection_id, source_ip, source_port, inbound_port="10000"):
        return {
            "id": connection_id,
            "upload": 1, "download": 2, "start": "2026-09-24T00:00:00Z", "chains": ["DIRECT"],
            "metadata": {"host": "example.com", "destinationPort": 443, "network": "ws",
                         "type": "Vless", "inboundName": "cf-ws-local", "inboundPort": inbound_port,
                         "sourceIP": source_ip, "sourcePort": source_port},
        }

    @classmethod
    def _fake_backend(cls, port):
        sock = mock.Mock()
        sock.getsockname.return_value = ("127.0.0.1", port)
        return sock

    def test_converted_config_keeps_xray_tag_and_is_the_only_ws_listener_source(self):
        with tempfile.TemporaryDirectory() as directory:
            ids = gate.ws_listener_ids(self._config_path(directory))
        self.assertEqual(ids, {("cf-ws-local", 10000)})
        self.assertNotIn(("reality", 8443), ids)

    def test_two_devices_map_to_distinct_backend_ports(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            alice, _ = registry.create("alice", "phone")
            bob, _ = registry.create("bob", "laptop")
            first, second = self._fake_backend(40001), self._fake_backend(40002)
            gate.register_ws_source(gate.backend_endpoint(first), "198.51.100.11", alice)
            gate.register_ws_source(gate.backend_endpoint(second), "198.51.100.22", bob)
            payload = {
                "connections": [
                    self._ws_connection("c1", "127.0.0.1", 40001),
                    self._ws_connection("c2", "127.0.0.1", "40002"),
                ],
                "uploadTotal": 0, "downloadTotal": 0,
            }
            enriched = self._enrich(payload, directory)
        first_metadata = enriched["connections"][0]["metadata"]
        second_metadata = enriched["connections"][1]["metadata"]
        self.assertEqual(first_metadata["sourceIP"], "198.51.100.11")
        self.assertEqual(first_metadata["pinguDeviceOwner"], "alice")
        self.assertNotIn("sourcePort", first_metadata, "no fabricated client port")
        self.assertEqual(first_metadata["pinguBackendSourcePort"], 40001)
        self.assertEqual(second_metadata["sourceIP"], "198.51.100.22")
        self.assertEqual(second_metadata["pinguDeviceName"], "laptop")
        self.assertEqual(second_metadata["pinguBackendSourcePort"], "40002")

    def test_legacy_allowlisted_ws_gets_source_without_fabricated_device(self):
        with tempfile.TemporaryDirectory() as directory:
            identity_token = gate.register_ws_source(
                gate.backend_endpoint(self._fake_backend(40003)), "198.51.100.33"
            )
            self.assertTrue(identity_token)
            payload = {"connections": [self._ws_connection("c3", "127.0.0.1", 40003)]}
            enriched = self._enrich(payload, directory)
        metadata = enriched["connections"][0]["metadata"]
        self.assertEqual(metadata["sourceIP"], "198.51.100.33")
        self.assertNotIn("pinguDeviceOwner", metadata)
        self.assertNotIn("pinguDeviceName", metadata)

    def test_unmatched_and_reality_connections_are_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            gate.register_ws_source(
                gate.backend_endpoint(self._fake_backend(40004)), "198.51.100.44"
            )
            unmatched = self._ws_connection("c4", "127.0.0.1", 40099)
            reality = {
                "id": "c5",
                "metadata": {"host": "example.com", "destinationPort": 443,
                             "inboundName": "reality", "inboundPort": 8443,
                             "sourceIP": "127.0.0.1", "sourcePort": 40004},
            }
            # A Reality listener that reuses the registered backend endpoint must
            # stay untouched (loopback::1-style prefixes must not match either).
            loopback_lookalike = self._ws_connection("c6", "::1zz", 40004)
            payload = {"connections": [unmatched, reality, loopback_lookalike]}
            before = copy.deepcopy(payload)
            enriched = self._enrich(payload, directory)
        self.assertEqual(payload, before, "enrichment must not mutate the controller payload")
        self.assertEqual(enriched["connections"], before["connections"])

    def test_cleanup_is_identity_scoped_so_port_reuse_survives_stale_finally(self):
        endpoint = gate.backend_endpoint(self._fake_backend(40005))
        stale = gate.register_ws_source(endpoint, "198.51.100.55")
        gate.discard_ws_source(endpoint, stale)
        self.assertEqual(gate.ws_source_snapshot(), {})
        current = gate.register_ws_source(endpoint, "198.51.100.66")
        gate.discard_ws_source(endpoint, stale)          # late stale cleanup
        self.assertEqual(gate.ws_source_snapshot()[endpoint]["source_ip"], "198.51.100.66")
        gate.discard_ws_source(endpoint, current)
        self.assertEqual(gate.ws_source_snapshot(), {})

    def test_capacity_admission_skips_new_entries_without_evicting_active_ones(self):
        keep = gate.backend_endpoint(self._fake_backend(40006))
        gate.register_ws_source(keep, "198.51.100.77")
        with mock.patch.object(gate, "MAX_WS_IDENTITIES", 1):
            self.assertEqual(
                gate.register_ws_source(gate.backend_endpoint(self._fake_backend(40007)), "198.51.100.88"),
                "",
            )
        snapshot = gate.ws_source_snapshot()
        self.assertEqual(list(snapshot), [keep], "active identity must not be evicted")

    def test_identity_map_and_enriched_payload_never_contain_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            device, token = registry.create("alice", "phone")
            gate.register_ws_source(
                gate.backend_endpoint(self._fake_backend(40008)), "198.51.100.99", device
            )
            payload = {"connections": [self._ws_connection("c8", "127.0.0.1", "40008")]}
            enriched = self._enrich(payload, directory)
        serialized = json.dumps([[str(k), v] for k, v in gate.ws_source_snapshot().items()])
        serialized += json.dumps(enriched)
        self.assertNotIn(token, serialized)
        self.assertNotIn(device["token_digest"], serialized)
        self.assertNotIn("uuid", serialized.lower())

    def test_ports_are_normalized_or_rejected_without_coercion(self):
        self.assertEqual(gate.normalized_port("443"), 443)
        self.assertEqual(gate.normalized_port(443), 443)
        for value in (0, 65536, -1, True, "443.0", "443 ", " 443", None, "", "999999"):
            self.assertIsNone(gate.normalized_port(value), repr(value))
        self.assertIsNone(gate.connection_endpoint({"sourceIP": "127.0.0.1", "sourcePort": "abc"}))


class WsProxyCleanupTests(unittest.TestCase):
    """handle_ws_proxy registers/removes identity on normal and error exits."""

    def setUp(self):
        gate.WS_SOURCE_IDENTITIES.clear()
        self.addCleanup(gate.WS_SOURCE_IDENTITIES.clear)

    def _handler(self, path, registry):
        handler = object.__new__(gate.GateHandler)
        handler.headers = Message()
        handler.headers["Upgrade"] = "websocket"
        handler.headers["Connection"] = "Upgrade"
        handler.headers["CF-Connecting-IP"] = "198.51.100.27"
        handler.command = "GET"
        handler.request_version = "HTTP/1.1"
        handler.path = path
        handler.connection = mock.Mock()
        handler.send_text = mock.Mock()
        handler.send_bytes = mock.Mock()
        return handler

    def _run(self, handler, backend, registry, relay=None):
        # The relay is exercised through a fake loop, so the registration window
        # and the error path can both be observed without touching sockets.
        def fake_relay(*_args, **_kwargs):
            if callable(relay):
                return relay()
            if isinstance(relay, BaseException):
                raise relay
        with (
            mock.patch.object(gate, "DEVICE_REGISTRY", registry),
            mock.patch.object(gate, "relay_ws_stream", side_effect=fake_relay),
            mock.patch.object(gate.socket, "create_connection", return_value=backend),
        ):
            handler.handle_ws_proxy()

    def test_device_relay_registers_then_cleans_up_without_leaking_token(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            device, token = registry.create("alice", "phone")
            backend = mock.Mock()
            backend.getsockname.return_value = ("127.0.0.1", 41001)
            handler = self._handler(f"/__pingu_device__/v1/{token}", registry)
            during = []
            self._run(handler, backend, registry, relay=lambda: during.append(gate.ws_source_snapshot()))
            self.assertFalse(handler.send_text.called, "no error response for a valid device")
        self.assertEqual(
            during[0][("127.0.0.1", 41001)]["source_ip"], "198.51.100.27"
        )
        self.assertEqual(during[0][("127.0.0.1", 41001)]["device_name"], "phone")
        self.assertEqual(gate.ws_source_snapshot(), {}, "normal close must remove the identity")
        self.assertEqual(registry.list()[0]["connection_count"], 1)
        backend.close.assert_called()

    def test_relay_error_still_removes_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = gate.device_access.DeviceRegistry(pathlib.Path(directory) / "devices.json")
            _, token = registry.create("alice", "phone")
            backend = mock.Mock()
            backend.getsockname.return_value = ("127.0.0.1", 41002)
            handler = self._handler(f"/__pingu_device__/v1/{token}", registry)
            with self.assertRaises(OSError):
                self._run(handler, backend, registry, relay=OSError("relay failed"))
        self.assertEqual(gate.ws_source_snapshot(), {}, "error exit must remove the identity")
        backend.close.assert_called()

    def test_legacy_allowlisted_relay_is_registered_with_real_source(self):
        """An allowlisted legacy WS origin has no device, but its source is kept."""
        backend = mock.Mock()
        backend.getsockname.return_value = ("127.0.0.1", 41003)
        handler = self._handler("/legacy-ws", None)
        during = []
        with mock.patch.object(gate, "is_allowlisted", return_value=True):
            self._run(handler, backend, gate.DEVICE_REGISTRY,
                      relay=lambda: during.append(gate.ws_source_snapshot()))
        self.assertEqual(
            during[0][("127.0.0.1", 41003)]["source_ip"], "198.51.100.27"
        )
        self.assertEqual(during[0][("127.0.0.1", 41003)]["owner"], "",
                         "legacy origin must not fabricate a device")
        self.assertEqual(gate.ws_source_snapshot(), {})


if __name__ == "__main__":
    unittest.main()
