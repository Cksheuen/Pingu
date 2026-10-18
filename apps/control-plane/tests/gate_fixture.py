"""Disposable real Gate HTTP service for the cross-runtime contract test."""
import importlib.util
import http.server
import pathlib
import tempfile

root = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("gate_contract", root / "ops/vps/sbin/pingu_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    token = root / "control-token"
    token.write_text("contract-test-dedicated-key-" + "a" * 32)
    gate.CONTROL_TOKEN_FILE = str(token)
    gate.DEVICE_REGISTRY = gate.device_access.DeviceRegistry(root / "devices.json")
    gate.read_subscription = lambda: "vless://11111111-1111-4111-8111-111111111111@contract.example.test:443?type=ws&security=tls&path=%2F"
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), gate.GateHandler) as server:
        print(server.server_address[1], flush=True)
        server.serve_forever()
