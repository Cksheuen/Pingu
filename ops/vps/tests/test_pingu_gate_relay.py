import concurrent.futures
import importlib.util
import pathlib
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock


PATH = pathlib.Path(__file__).resolve().parent.parent / "sbin" / "pingu_gate.py"
SPEC = importlib.util.spec_from_file_location("gate_relay", PATH)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class RetryRead:
    """Inject one transient TLS read while retaining a real socket transport."""
    def __init__(self, sock):
        self.sock = sock
        self.retry = True

    def __getattr__(self, name):
        return getattr(self.sock, name)

    def recv(self, size):
        if self.retry:
            self.retry = False
            raise ssl.SSLWantReadError(ssl.SSL_ERROR_WANT_READ, "retry read")
        return self.sock.recv(size)


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = pathlib.Path(cls.directory.name)
        cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "1",
                        "-subj", "/CN=localhost"], check=True, capture_output=True)
        cls.server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.server_context.load_cert_chain(cert, key)
        cls.client_context = ssl.create_default_context(cafile=str(cert))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def tls_pair(self):
        left, right = socket.socketpair()
        left.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        right.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        left.settimeout(5)
        right.settimeout(5)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            server = pool.submit(self.server_context.wrap_socket, left, server_side=True)
            client = self.client_context.wrap_socket(right, server_hostname="localhost")
            gate_socket = server.result(timeout=5)
        self.addCleanup(client.close)
        self.addCleanup(gate_socket.close)
        return gate_socket, client

    @staticmethod
    def receive(sock, size):
        chunks = []
        while size:
            data = sock.recv(min(size, 16384))
            if not data:
                break
            chunks.append(data)
            size -= len(data)
        return b"".join(chunks)

    def relay(self, client, backend):
        errors = []
        def run():
            try:
                gate.relay_ws_stream(client, backend)
            except Exception as error:
                errors.append(error)
            finally:
                client.close()
                backend.close()
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        return thread, errors

    def test_tls_backpressure_preserves_download_and_reverse_upload(self):
        gate_client, client = self.tls_pair()
        gate_backend, backend = socket.socketpair()
        backend.settimeout(5)
        self.addCleanup(backend.close)
        thread, errors = self.relay(gate_client, gate_backend)
        payload = bytes(range(256)) * 8192
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            sender = pool.submit(backend.sendall, payload)
            # A paused TLS receiver fills the small send buffer. The old
            # nonblocking sendall raises SSLWantWriteError and truncates here.
            time.sleep(0.1)
            self.assertEqual(self.receive(client, len(payload)), payload)
            sender.result(timeout=5)
            upload = b"reverse-upload\x00\xff" * 16384
            receiver = pool.submit(self.receive, backend, len(upload))
            client.sendall(upload)
            self.assertEqual(receiver.result(timeout=5), upload)
        backend.shutdown(socket.SHUT_WR)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_transient_tls_read_does_not_close_the_relay(self):
        gate_client, client = self.tls_pair()
        gate_backend, backend = socket.socketpair()
        backend.settimeout(5)
        self.addCleanup(backend.close)
        thread, errors = self.relay(RetryRead(gate_client), gate_backend)
        client.sendall(b"request after WANT_READ")
        self.assertEqual(self.receive(backend, 23), b"request after WANT_READ")
        backend.sendall(b"response")
        self.assertEqual(self.receive(client, 8), b"response")
        backend.shutdown(socket.SHUT_WR)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_idle_relay_obeys_lease_deadline(self):
        client, client_peer = socket.socketpair()
        backend, backend_peer = socket.socketpair()
        for sock in (client, client_peer, backend, backend_peer):
            self.addCleanup(sock.close)
        started = time.monotonic()
        with mock.patch.object(gate, "WS_RELAY_TIMEOUT", 0.1):
            thread, errors = self.relay(client, backend)
            thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
