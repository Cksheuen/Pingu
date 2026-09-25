import copy
import http.server
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from ops.vps.sbin import pingu_mihomo as mihomo


def source_config():
    return {
        "inbounds": [
            {"tag": "reality", "port": 8443, "protocol": "vless",
             "settings": {"decryption": "none", "clients": [{"id": "11111111-1111-1111-1111-111111111111", "flow": "xtls-rprx-vision"}]},
             "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {
                 "dest": "example.com:443", "privateKey": "private-key-fixture", "serverNames": ["example.com"], "shortIds": ["0011223344556677"]}}},
            {"tag": "ws", "listen": "127.0.0.1", "port": 10000, "protocol": "vless",
             "settings": {"decryption": "none", "clients": [{"id": "22222222-2222-2222-2222-222222222222"}]},
             "streamSettings": {"network": "ws", "security": "none", "wsSettings": {"path": "/"}}},
        ],
        "outbounds": [{"tag": "direct", "protocol": "freedom", "sendThrough": "203.0.113.10", "settings": {"domainStrategy": "UseIPv4"}},
                      {"tag": "blocked", "protocol": "blackhole"}],
        "routing": {"domainStrategy": "IPIfNonMatch", "rules": [
            {"type": "field", "ip": ["geoip:private"], "outboundTag": "blocked"},
            {"type": "field", "domain": ["geosite:cn", "regexp:.*\\.cn$"], "outboundTag": "blocked"},
            {"type": "field", "ip": ["geoip:cn"], "outboundTag": "blocked"},
        ]},
    }


class ConversionTests(unittest.TestCase):
    def test_preserves_credentials_transport_and_ordered_block_policy(self):
        source = source_config()
        untouched = copy.deepcopy(source)
        cfg = mihomo.convert_xray(source, "ens3", "x" * 40)
        self.assertEqual(source, untouched)
        reality, ws = cfg["listeners"]
        self.assertEqual(reality["users"][0]["uuid"], source["inbounds"][0]["settings"]["clients"][0]["id"])
        self.assertEqual(reality["reality-config"]["private-key"], "private-key-fixture")
        self.assertEqual(reality["reality-config"]["short-id"], ["0011223344556677"])
        self.assertEqual(ws["listen"], "127.0.0.1")
        self.assertTrue(ws["allow-insecure"])
        self.assertEqual(ws["ws-path"], "/")
        self.assertEqual(cfg["rules"], ["GEOIP,private,REJECT", "GEOSITE,cn,REJECT", "DOMAIN-REGEX,.*\\.cn$,REJECT", "GEOIP,cn,REJECT", "MATCH,direct"])
        self.assertEqual(cfg["proxies"][0]["interface-name"], "ens3")
        self.assertEqual(cfg["proxies"][0]["ip-version"], "ipv4")
        self.assertEqual(cfg["external-controller"], "127.0.0.1:19090")

    def test_refuses_exposed_plaintext_or_unknown_policy(self):
        variants = []
        exposed = source_config(); exposed["inbounds"][1]["listen"] = "0.0.0.0"; variants.append(exposed)
        rule = source_config(); rule["routing"]["rules"][0]["port"] = "443"; variants.append(rule)
        outbound = source_config(); outbound["outbounds"].append({"tag": "warp", "protocol": "socks"}); variants.append(outbound)
        for config in variants:
            with self.subTest(config=config), self.assertRaises(mihomo.MihomoError):
                mihomo.convert_xray(config, "eth0", "x" * 40)

    def test_config_is_atomic_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            mihomo.atomic_config(path, {"secret": "x" * 40})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"secret": "x" * 40})
            self.assertEqual([p.name for p in Path(directory).iterdir()], ["config.json"])


class ControllerTests(unittest.TestCase):
    def test_authenticated_local_api_and_close_paths(self):
        calls = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                self.send_response(200); self.end_headers()
                self.wfile.write(b'{"connections": [{"id":"connection-1"}]}')

            def do_DELETE(self):
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                self.send_response(204); self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.json"
                path.write_text(json.dumps({"external-controller": "127.0.0.1:{}".format(server.server_port), "secret": "s" * 40}))
                self.assertEqual(mihomo.controller_request("GET", "/connections", path)["connections"][0]["id"], "connection-1")
                self.assertEqual(mihomo.controller_request("DELETE", "/connections/connection-1", path), {})
                with self.assertRaises(mihomo.MihomoError):
                    mihomo.controller_request("GET", "/configs", path)
                path.write_text(json.dumps({"external-controller": "203.0.113.1:19090", "secret": "s" * 40}))
                with self.assertRaises(mihomo.MihomoError):
                    mihomo.controller_request("GET", "/connections", path)
            self.assertEqual(calls, [("GET", "/connections", "Bearer " + "s" * 40), ("DELETE", "/connections/connection-1", "Bearer " + "s" * 40)])
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
