import hashlib
import io
import json
import os
import shutil
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ops.vps.sbin import pingu_snapshot as snap


OLD_IP = "154.26.187.44"
NEW_IP = "198.51.100.20"

XRAY_CONFIG = {
    "log": {"loglevel": "warning"},
    "inbounds": [
        {
            "listen": OLD_IP,
            "port": 443,
            "protocol": "vless",
            "settings": {
                "clients": [
                    {"id": "b831381d-6324-4d53-ad4f-8cda48b30811",
                     "flow": "xtls-rprx-vision"}
                ],
                "decryption": "none",
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "dest": OLD_IP + ":443",
                    "serverNames": [OLD_IP],
                    "privateKey": "oMGgMh-secret-private-key",
                    "shortIds": ["0123abcd"],
                },
            },
        },
        {
            "listen": "127.0.0.1",
            "port": 10000,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"},
            "streamSettings": {
                "network": "tcp",
                "security": "tls",
                "tlsSettings": {
                    "certificates": [
                        {
                            "certificateFile": "certs/cksheuen.site.crt",
                            "keyFile": "certs/cksheuen.site.key",
                        }
                    ]
                },
            },
        }
    ],
    "routing": {
        "domainStrategy": "IPIfNonMatch",
        "rules": [
            {"type": "field", "outboundTag": "direct", "ip": ["geoip:cn"]},
            {"type": "field", "outboundTag": "direct",
             "domain": ["geosite:cn"]},
        ],
    },
    "outbounds": [
        {
            "tag": "direct",
            "protocol": "freedom",
            "sendThrough": OLD_IP,
            "settings": {"domainStrategy": "UseIPv4"},
        }
    ],
}


def build_source(root):
    """Create a fixture source_root with every required asset."""
    files = {
        "usr/local/sbin/pingu-gate": "#!/bin/sh\necho gate\n",
        "usr/local/sbin/pingu_device_access.py": "print('helper')\n",
        "usr/local/sbin/pingu-traffic-guard": "#!/bin/sh\necho guard\n",
        "usr/local/sbin/pingu-traffic-report": "#!/bin/sh\necho report\n",
        "usr/local/bin/xray": "XRAY-BINARY-BLOB\n",
        "usr/local/etc/xray/config.json": json.dumps(XRAY_CONFIG, indent=2),
        "usr/local/etc/xray/certs/cksheuen.site.crt": "TLS-CERT\n",
        "usr/local/etc/xray/certs/cksheuen.site.key": "TLS-KEY\n",
        "usr/local/share/xray/geoip.dat": "GEOIP\n",
        "usr/local/share/xray/geosite.dat": "GEOSITE\n",
        "etc/pingu-gate.subscription.txt": (
            "vless://b831381d-6324-4d53-ad4f-8cda48b30811@" + OLD_IP +
            ":443?security=reality&sni=cksheuen.site&pbk=reality-pubkey"
            "&sid=0123abcd&flow=xtls-rprx-vision&type=tcp#Direct-Reality\n"
            "vless://b831381d-6324-4d53-ad4f-8cda48b30811@cksheuen.site:443"
            "?type=ws&security=tls&sni=cksheuen.site&path=%2Fws%2Fpath#WS\n"
        ),
        "etc/pingu-gate.token": "gate-token\n",
        "etc/pingu-traffic-guard.conf": "DAILY_LIMIT=100\n",
        "etc/nftables.d/pingu-guard.nft": "table inet pingu_guard {}\n",
        "var/lib/pingu-gate/devices.json": json.dumps(
            {"devices": [{"token_hash": "deadbeef", "uuid": "u1"}]}
        ),
        "etc/systemd/system/pingu-gate.service": "[Unit]\n",
        "etc/systemd/system/cksheuen-portal.service": "[Unit]\n",
        "etc/systemd/system/xray.service": "[Unit]\n",
        "etc/systemd/system/pingu-traffic-guard.service": "[Unit]\n",
        "etc/systemd/system/pingu-traffic-guard.timer": "[Unit]\n",
        "etc/systemd/system/pingu-traffic-report.service": "[Unit]\n",
        "etc/systemd/system/pingu-traffic-report.timer": "[Unit]\n",
        "etc/systemd/system/pingu-gate.service.d/lease.conf": "[Service]\n",
        "etc/pingu-gate.env": "LEASE_SECRET=x\n",
        "root/pingu-secrets/reality_public_key": "pk\n",
        "root/pingu-secrets/reality_short_id": "sid\n",
        "var/lib/pingu-traffic-guard/daily-total.json": "{}\n",
        "etc/pingu-backup.conf": "RCLONE_REMOTE=drive-crypt:\n",
        "usr/local/sbin/pingu-backup": "#!/bin/sh\n",
        "usr/local/sbin/pingu_snapshot.py": "print(1)\n",
        "etc/systemd/system/pingu-backup.service": "[Unit]\n",
        "etc/systemd/system/pingu-backup.timer": "[Unit]\n",
        "etc/systemd/system/pingu-backup.path": "[Unit]\n",
        "etc/sysctl.d/10-bufferbloat.conf": (
            "net.core.default_qdisc=fq\n"
            "net.ipv4.tcp_congestion_control=bbr\n"
            "net.core.rmem_max=67108864\n"
            "net.core.wmem_max=67108864\n"
        ),
        "etc/sysctl.d/99-sysctl.conf": (
            "# general host tuning\nfs.file-max=65535\n"
            "net.ipv4.tcp_fastopen=3\n"
        ),
        "etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\n',
        "var/www/cksheuen-portal/releases/20260811-032313/index.html":
            "<html>portal</html>\n",
    }
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    current = root / "var/www/cksheuen-portal/current"
    current.symlink_to(
        "/var/www/cksheuen-portal/releases/20260811-032313"
    )
    # Must never be staged (outside the fixed allowlist / excluded).
    rclone_conf = root / "root/.config/rclone/rclone.conf"
    rclone_conf.parent.mkdir(parents=True, exist_ok=True)
    rclone_conf.write_text("[drive-crypt]\npassword = topsecret\n")


MIHOMO_CONFIG = {
    "pingu-public-ipv4": OLD_IP,
    "external-controller": "127.0.0.1:9090",
    "secret": "fixture-controller-secret",
    "geodata-mode": True,
    "listeners": [{
        "name": "reality", "type": "vless", "listen": OLD_IP, "port": 443,
        "users": [{"name": "owner", "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811"}],
        "reality-config": {
            "dest": OLD_IP + ":443", "private-key": "fixture-reality-private-key",
            "short-id": ["0123abcd"], "server-names": [OLD_IP],
        },
    }, {
        "name": "ws", "type": "vless", "listen": "127.0.0.1", "port": 10000,
        "users": [], "ws-path": "/ws/path", "allow-insecure": True,
    }],
    "proxies": [{"name": "direct", "type": "direct", "ip-version": "ipv4",
                 "interface-name": "eth0"}],
    "rules": ["MATCH,direct"],
}


def build_mihomo_source(root):
    """Build new production assets without retaining any Xray artifacts."""
    build_source(root)
    for path in ("usr/local/etc/xray", "usr/local/share/xray"):
        shutil.rmtree(root / path)
    for path in ("usr/local/bin/xray", "etc/systemd/system/xray.service"):
        (root / path).unlink()
    files = {
        "usr/local/bin/mihomo": "MIHOMO-BINARY-BLOB\n",
        "usr/local/sbin/pingu_mihomo.py": "# fixture API adapter\n",
        "usr/local/sbin/pingu_connections.py": "# fixture connections UI\n",
        "etc/mihomo/config.json": json.dumps(MIHOMO_CONFIG, indent=2),
        "etc/mihomo/GeoIP.dat": "GEOIP\n",
        "etc/mihomo/GeoSite.dat": "GEOSITE\n",
        "etc/pingu-gate/certs/cksheuen.site.crt": "TLS-CERT\n",
        "etc/pingu-gate/certs/cksheuen.site.key": "TLS-KEY\n",
        "etc/systemd/system/mihomo.service": "[Unit]\n",
        "etc/systemd/system/mihomo.service.d/limits.conf": "[Service]\n",
    }
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    (root / "etc/mihomo/config.json").chmod(0o600)
    (root / "etc/pingu-gate/certs/cksheuen.site.key").chmod(0o600)


def _craft_archive(path, files, symlinks, entries, modes=None,
                   manifest_extra=None):
    """Build an archive with a matching manifest (hashes computed for real)."""
    modes = modes or {}
    manifest = {"schema": snap.MANIFEST_SCHEMA, "entries": entries}
    if manifest_extra:
        manifest.update(manifest_extra)
    with tarfile.open(path, "w:gz") as tar:
        payload = json.dumps(manifest).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(payload)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(payload))
        for entry in entries:
            if entry["type"] != "dir":
                continue
            info = tarfile.TarInfo("rootfs/" + entry["path"])
            info.type = tarfile.DIRTYPE
            info.mode = entry.get("mode", 0o755)
            tar.addfile(info)
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = modes.get(name, 0o644)
            tar.addfile(info, io.BytesIO(data))
        for name, target in symlinks.items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            info.mode = modes.get(name, 0o777)
            tar.addfile(info)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Resolve symlinked ancestors (macOS /var -> /private/var) so the
        # strict restore destination checks see a real, symlink-free chain.
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        build_source(self.source)
        self.output = self.root / "output"

    def tearDown(self):
        self.tmp.cleanup()

    def _create(self):
        with mock.patch.object(
            snap, "detect_public_ipv4",
            side_effect=lambda source_root=None: (OLD_IP, "pinned"),
        ):
            return snap.create_snapshot(self.output, self.source)

    def test_legacy_untagged_archive_still_verifies_and_restores(self):
        result = self._create()
        legacy = self.root / "legacy-v1.tar.gz"
        with tarfile.open(result["archive_path"], "r:gz") as source:
            with tarfile.open(legacy, "w:gz") as target:
                for member in source.getmembers():
                    if member.name == "manifest.json":
                        manifest = json.load(source.extractfile(member))
                        manifest.pop("runtime_profile", None)
                        blob = json.dumps(manifest).encode()
                        member.size = len(blob)
                        target.addfile(member, io.BytesIO(blob))
                    else:
                        target.addfile(member, source.extractfile(member) if member.isfile() else None)
        manifest = snap.verify_snapshot(legacy)
        self.assertEqual(snap.snapshot_profile(manifest), "xray")
        destination = self.root / "legacy-restore"
        snap.restore_snapshot(legacy, destination, public_ip=NEW_IP)
        config = json.loads((destination / "rootfs/usr/local/etc/xray/config.json").read_text())
        self.assertEqual(config["outbounds"][0]["sendThrough"], NEW_IP)

    def test_create_verify_restore_roundtrip(self):
        result = self._create()
        self.assertEqual(
            result["archive_path"],
            str(self.output / result["snapshot_id"] / "snapshot.tar.gz"),
        )
        self.assertTrue(
            (self.output / result["snapshot_id"] / "SHA256SUMS").is_file()
        )
        self.assertEqual(
            (self.output / result["snapshot_id"]).stat().st_mode & 0o777, 0o700
        )

        manifest = snap.verify_snapshot(result["archive_path"], result["sha256"])
        self.assertEqual(manifest["schema"], snap.MANIFEST_SCHEMA)
        self.assertEqual(manifest["source"]["public_ipv4"], OLD_IP)
        paths = {e["path"] for e in manifest["entries"]}
        self.assertIn("usr/local/bin/xray", paths)
        self.assertIn("var/lib/pingu-gate/devices.json", paths)
        current = next(
            e for e in manifest["entries"]
            if e["path"] == "var/www/cksheuen-portal/current"
        )
        self.assertEqual(current["type"], "symlink")
        self.assertEqual(current["link_target"], "releases/20260811-032313")
        self.assertIn(
            "var/www/cksheuen-portal/releases/20260811-032313/index.html", paths
        )

        dest = self.root / "restore"
        restored = snap.restore_snapshot(
            result["archive_path"], dest, result["sha256"]
        )
        self.assertEqual(restored["snapshot_id"], result["snapshot_id"])
        self.assertTrue((dest / "manifest.json").is_file())
        self.assertEqual(
            (dest / "rootfs/usr/local/bin/xray").read_text(), "XRAY-BINARY-BLOB\n"
        )
        self.assertEqual(
            os.readlink(dest / "rootfs/var/www/cksheuen-portal/current"),
            "releases/20260811-032313",
        )
        self.assertEqual(
            (dest / "rootfs/var/www/cksheuen-portal/releases/20260811-032313/"
             "index.html").read_text(),
            "<html>portal</html>\n",
        )

    def test_verify_normalizes_corrupt_streams_and_rejects_hash_mismatch(self):
        result = self._create()
        tampered = self.root / "tampered.tar.gz"
        data = bytearray(Path(result["archive_path"]).read_bytes())
        data[-4096] ^= 0xFF
        tampered.write_bytes(bytes(data))
        # An arbitrary compressed-byte mutation may fail at decompression or at
        # a later per-file digest check; both are valid fail-closed outcomes.
        with self.assertRaises(snap.SnapshotError):
            snap.verify_snapshot(tampered)
        with self.assertRaises(snap.SnapshotError):
            snap.verify_snapshot(result["archive_path"], "0" * 64)

        class BrokenTar:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def getmembers(self):
                raise snap.zlib.error("deterministic decompression failure")

        with mock.patch.object(snap.tarfile, "open", return_value=BrokenTar()):
            with self.assertRaises(snap.SnapshotError) as caught:
                snap.verify_snapshot(result["archive_path"])
        self.assertIn("unreadable archive", str(caught.exception))

        truncated = self.root / "truncated.tar.gz"
        truncated.write_bytes(bytes(data[:256]))
        with tarfile.open(truncated, "r:gz") as archive:
            with self.assertRaises(EOFError):
                archive.getmembers()
        with self.assertRaises(snap.SnapshotError) as caught:
            snap.verify_snapshot(truncated)
        self.assertIn("unreadable archive", str(caught.exception))

    def test_verify_rejects_extra_payload_and_unsafe_members(self):
        good = self._create()
        manifest = snap.verify_snapshot(good["archive_path"])

        # Extra payload member not listed in the manifest.
        evil = self.root / "evil.tar.gz"
        with tarfile.open(evil, "w:gz") as tar:
            payload = json.dumps(manifest).encode()
            info = tarfile.TarInfo("manifest.json")
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
            for name, kind in (
                ("rootfs/etc/escape", "symlink-out"),
                ("rootfs/etc/abs", "symlink-abs"),
                ("rootfs/etc/hard", "hardlink"),
                ("rootfs/etc/extra", "file"),
            ):
                info = tarfile.TarInfo(name)
                if kind == "symlink-out":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "../../outside"
                elif kind == "symlink-abs":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/passwd"
                elif kind == "hardlink":
                    info.type = tarfile.LNKTYPE
                    info.linkname = "rootfs/etc/passwd"
                else:
                    info.type = tarfile.REGTYPE
                    blob = b"x"
                    info.size = len(blob)
                    tar.addfile(info, io.BytesIO(blob))
                    continue
                tar.addfile(info)
        with self.assertRaises(snap.SnapshotError):
            snap.verify_snapshot(evil)

    def test_missing_critical_file_aborts_snapshot(self):
        (self.source / "var/lib/pingu-gate/devices.json").unlink()
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.create_snapshot(self.output, self.source)
        self.assertIn("devices.json", str(ctx.exception))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_restore_ip_remap_preserves_identities(self):
        result = self._create()
        dest = self.root / "remap"
        snap.restore_snapshot(
            result["archive_path"], dest, result["sha256"], public_ip=NEW_IP
        )
        config = json.loads(
            (dest / "rootfs/usr/local/etc/xray/config.json").read_text()
        )
        self.assertEqual(config["outbounds"][0]["sendThrough"], NEW_IP)
        inbound = config["inbounds"][0]
        self.assertEqual(inbound["listen"], NEW_IP)
        reality = inbound["streamSettings"]["realitySettings"]
        # Reality decoy fields must NOT be rewritten: they are not the
        # source identity and changing them breaks the decoy contract.
        self.assertEqual(reality["dest"], OLD_IP + ":443")
        self.assertEqual(reality["serverNames"], [OLD_IP])
        # Identity material must be untouched.
        self.assertEqual(
            inbound["settings"]["clients"][0]["id"],
            "b831381d-6324-4d53-ad4f-8cda48b30811",
        )
        self.assertEqual(reality["privateKey"], "oMGgMh-secret-private-key")
        self.assertEqual(reality["shortIds"], ["0123abcd"])
        devices = json.loads(
            (dest / "rootfs/var/lib/pingu-gate/devices.json").read_text()
        )
        self.assertEqual(devices["devices"][0]["token_hash"], "deadbeef")
        self.assertEqual(
            (dest / "rootfs/usr/local/etc/xray/certs/cksheuen.site.crt").read_text(),
            "TLS-CERT\n",
        )
        # The direct Reality node host is rewritten; the WS node is not.
        sub = (dest / "rootfs/etc/pingu-gate.subscription.txt").read_text()
        direct_line, ws_line = sub.splitlines()
        self.assertIn("@" + NEW_IP + ":443", direct_line)
        self.assertNotIn(OLD_IP, direct_line)
        self.assertIn("sid=0123abcd", direct_line)
        self.assertIn("sni=cksheuen.site", direct_line)
        self.assertEqual(
            ws_line,
            "vless://b831381d-6324-4d53-ad4f-8cda48b30811@cksheuen.site:443"
            "?type=ws&security=tls&sni=cksheuen.site&path=%2Fws%2Fpath#WS",
        )
        deployment = json.loads((dest / "deployment.json").read_text())
        self.assertEqual(deployment["schema"], "pingu-vps-deployment/v1")
        self.assertEqual(deployment["target_ipv4"], NEW_IP)
        self.assertEqual(deployment["source_ipv4"], OLD_IP)
        self.assertEqual(
            deployment["changed_paths"],
            [
                "usr/local/etc/xray/config.json",
                "etc/pingu-gate.subscription.txt",
            ],
        )
        self.assertTrue(deployment["changed_fields"])

    def test_restore_without_public_ip_keeps_old_ip(self):
        result = self._create()
        dest = self.root / "plain"
        snap.restore_snapshot(result["archive_path"], dest, result["sha256"])
        config = json.loads(
            (dest / "rootfs/usr/local/etc/xray/config.json").read_text()
        )
        self.assertEqual(config["outbounds"][0]["sendThrough"], OLD_IP)
        self.assertFalse((dest / "deployment.json").exists())

    def test_archive_never_contains_excluded_secrets(self):
        result = self._create()
        with tarfile.open(result["archive_path"], "r:gz") as tar:
            names = tar.getnames()
        self.assertTrue(any(n == "manifest.json" for n in names))
        for name in names:
            self.assertNotIn("rclone.conf", name)
            self.assertNotIn(".ssh", name)
            self.assertNotIn("machine-id", name)
            self.assertNotIn("etc/sysctl.d", name)
        for entry in result["manifest"]["entries"]:
            self.assertNotIn("rclone.conf", entry["path"])
            self.assertNotIn("topsecret", json.dumps(entry))
            self.assertNotIn("etc/sysctl.d", entry["path"])

    def test_network_tuning_is_metadata_only(self):
        result = self._create()
        tuning = result["manifest"]["network_tuning"]
        self.assertEqual(
            tuning["values"]["net.ipv4.tcp_congestion_control"], "bbr"
        )
        self.assertEqual(tuning["values"]["net.core.default_qdisc"], "fq")
        self.assertEqual(tuning["values"]["net.ipv4.tcp_fastopen"], "3")
        self.assertNotIn("fs.file-max", tuning["values"])
        self.assertIn("etc/sysctl.d/10-bufferbloat.conf", tuning["files"])
        self.assertIn("etc/sysctl.d/99-sysctl.conf", tuning["files"])

    def test_metadata_comes_from_source_config_not_local_machine(self):
        # No monkeypatch: detection must read the mounted source root and
        # never the worker's own interfaces.
        result = snap.create_snapshot(self.output, self.source)
        source = result["manifest"]["source"]
        self.assertEqual(source["public_ipv4"], OLD_IP)
        self.assertEqual(source["public_ipv4_origin"], "xray-config:sendThrough")
        self.assertEqual(source["public_origin"], "https://cksheuen.site")

    def test_detect_public_origin_normalizes_ws_node(self):
        subscription = self.source / "etc/pingu-gate.subscription.txt"
        subscription.write_text(
            "vless://00000000-0000-0000-0000-000000000000@origin.example:8443"
            "/ws/path?type=ws&security=tls#WS\n"
        )
        self.assertEqual(
            snap.detect_public_origin(self.source),
            "https://origin.example:8443",
        )

    def test_malformed_critical_json_aborts_before_publish(self):
        (self.source / "var/lib/pingu-gate/devices.json").write_text("{broken")
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.create_snapshot(self.output, self.source)
        self.assertIn("device registry", str(ctx.exception))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_malformed_xray_config_aborts_before_publish(self):
        (self.source / "usr/local/etc/xray/config.json").write_text("{broken")
        with self.assertRaises(snap.SnapshotError):
            snap.create_snapshot(self.output, self.source)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_empty_xray_data_dir_aborts_snapshot(self):
        share = self.source / "usr/local/share/xray"
        for child in share.iterdir():
            child.unlink()
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.create_snapshot(self.output, self.source)
        self.assertIn("geoip.dat", str(ctx.exception))

    def test_missing_referenced_cert_aborts_snapshot(self):
        (self.source / "usr/local/etc/xray/certs/cksheuen.site.key").unlink()
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.create_snapshot(self.output, self.source)
        self.assertIn("cksheuen.site.key", str(ctx.exception))

    # --- counterexamples for archive verification / restore safety ---------

    def _repack(self, output_path, entry_filter=None, extra_files=None,
                extra_symlinks=None, mode_overrides=None, replace_files=None):
        """Rebuild the good archive with real mutations and matching hashes."""
        good = self._create()
        with tarfile.open(good["archive_path"], "r:gz") as tar:
            blobs, modes, symlinks = {}, {}, {}
            for member in tar.getmembers():
                if member.isfile() and member.name != "manifest.json":
                    blobs[member.name] = tar.extractfile(member).read()
                    modes[member.name] = stat.S_IMODE(member.mode)
                elif member.issym():
                    symlinks[member.name] = member.linkname
                    modes[member.name] = stat.S_IMODE(member.mode)
        entries = [dict(entry) for entry in good["manifest"]["entries"]]
        if entry_filter:
            entries = entry_filter(entries)
        if replace_files:
            blobs.update(replace_files)
        if extra_files:
            blobs.update(extra_files)
        if extra_symlinks:
            symlinks.update(extra_symlinks)
        if mode_overrides:
            modes.update(mode_overrides)
        _craft_archive(output_path, blobs, symlinks, entries, modes)
        return good

    def test_verify_rejects_member_beneath_archive_symlink(self):
        evil = self.root / "evil-symlink-child.tar.gz"
        sentinel = self.root / "outside-sentinel"
        sentinel.write_text("untouched\n")

        def add_entries(entries):
            entries.append({
                "path": "var/www/cksheuen-portal/evil-link",
                "type": "symlink", "mode": 0o777,
                "size": 0, "link_target": "releases/20260811-032313",
            })
            entries.append({
                "path": "var/www/cksheuen-portal/evil-link/pwned",
                "type": "file", "mode": 0o644,
                "size": 5,
                "sha256": hashlib.sha256(b"pwned").hexdigest(),
            })
            return entries

        self._repack(
            evil, entry_filter=add_entries,
            extra_files={
                "rootfs/var/www/cksheuen-portal/evil-link/pwned": b"pwned"
            },
            extra_symlinks={
                "rootfs/var/www/cksheuen-portal/evil-link":
                    "releases/20260811-032313"
            },
        )
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.verify_snapshot(evil)
        self.assertIn("beneath archive symlink", str(ctx.exception))
        # Verification must have no extraction side effects.
        self.assertEqual(sentinel.read_text(), "untouched\n")
        self.assertFalse((self.root / "rootfs").exists())

    def test_verify_rejects_forbidden_ssh_path_even_with_matching_sha(self):
        evil = self.root / "evil-ssh.tar.gz"
        blob = b"PermitRootLogin yes\n"

        def add_entry(entries):
            entries.append({
                "path": "etc/ssh/sshd_config", "type": "file", "mode": 0o644,
                "size": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
            })
            return entries

        self._repack(
            evil, entry_filter=add_entry,
            extra_files={"rootfs/etc/ssh/sshd_config": blob},
        )
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.verify_snapshot(evil)
        self.assertIn("allowlist", str(ctx.exception))

    def test_verify_rejects_missing_required_entry(self):
        evil = self.root / "evil-missing.tar.gz"
        good = self._create()
        with tarfile.open(good["archive_path"], "r:gz") as tar:
            blobs, modes, symlinks = {}, {}, {}
            for member in tar.getmembers():
                if member.isfile() and member.name not in (
                    "manifest.json", "rootfs/usr/local/bin/xray"
                ):
                    blobs[member.name] = tar.extractfile(member).read()
                    modes[member.name] = stat.S_IMODE(member.mode)
                elif member.issym():
                    symlinks[member.name] = member.linkname
                    modes[member.name] = stat.S_IMODE(member.mode)
        entries = [
            dict(e) for e in good["manifest"]["entries"]
            if e["path"] != "usr/local/bin/xray"
        ]
        _craft_archive(evil, blobs, symlinks, entries, modes)
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.verify_snapshot(evil)
        self.assertIn("usr/local/bin/xray", str(ctx.exception))

    def test_verify_rejects_dot_and_backslash_members(self):
        for arcname in ("rootfs/./etc/evil", "rootfs/etc/evil\\name"):
            evil = self.root / ("evil-" + arcname.replace("/", "_") + ".tar.gz")
            self._repack(evil, extra_files={arcname: b"x"})
            with self.assertRaises(snap.SnapshotError):
                snap.verify_snapshot(evil)

    def test_verify_rejects_mode_mismatch(self):
        evil = self.root / "evil-mode.tar.gz"
        self._repack(
            evil, mode_overrides={"rootfs/etc/pingu-gate.token": 0o777}
        )
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.verify_snapshot(evil)
        self.assertIn("mode mismatch", str(ctx.exception))

    def test_verify_rejects_malformed_critical_json_in_archive(self):
        evil = self.root / "evil-json.tar.gz"
        broken = b"{broken json"

        def fix_entry(entries):
            for entry in entries:
                if entry["path"] == "var/lib/pingu-gate/devices.json":
                    entry["size"] = len(broken)
                    entry["sha256"] = hashlib.sha256(broken).hexdigest()
            return entries

        self._repack(
            evil, entry_filter=fix_entry,
            replace_files={"rootfs/var/lib/pingu-gate/devices.json": broken},
        )
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.verify_snapshot(evil)
        self.assertIn("malformed critical JSON", str(ctx.exception))

    def test_restore_rejects_preexisting_rootfs_symlink(self):
        result = self._create()
        dest = self.root / "attack"
        (dest / "rootfs").mkdir(parents=True)
        outside = self.root / "outside"
        outside.mkdir()
        (dest / "rootfs/usr").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(snap.SnapshotError):
            snap.restore_snapshot(result["archive_path"], dest, result["sha256"])
        self.assertEqual(list(outside.iterdir()), [])

    def test_restore_rejects_nonempty_destination(self):
        result = self._create()
        dest = self.root / "nonempty"
        dest.mkdir()
        (dest / "sentinel").write_text("keep\n")
        with self.assertRaises(snap.SnapshotError):
            snap.restore_snapshot(result["archive_path"], dest, result["sha256"])
        self.assertEqual((dest / "sentinel").read_text(), "keep\n")

    def test_restore_allows_empty_real_destination(self):
        result = self._create()
        dest = self.root / "empty"
        dest.mkdir()  # controller pre-creates an empty destination
        snap.restore_snapshot(result["archive_path"], dest, result["sha256"])
        self.assertTrue((dest / "rootfs/usr/local/bin/xray").is_file())

    def test_restore_invalid_ip_writes_nothing(self):
        result = self._create()
        dest = self.root / "bad-ip"
        with self.assertRaises(snap.SnapshotError):
            snap.restore_snapshot(
                result["archive_path"], dest, result["sha256"],
                public_ip="999.1.1.1",
            )
        self.assertFalse(dest.exists())

    def test_restore_remap_without_old_ip_errors_before_writes(self):
        good = self._create()
        entries = [dict(e) for e in good["manifest"]["entries"]]
        source = dict(good["manifest"]["source"])
        source["public_ipv4"] = None
        archive = self.root / "no-old-ip.tar.gz"
        with tarfile.open(good["archive_path"], "r:gz") as tar:
            blobs, modes, symlinks = {}, {}, {}
            for member in tar.getmembers():
                if member.isfile() and member.name != "manifest.json":
                    blobs[member.name] = tar.extractfile(member).read()
                    modes[member.name] = stat.S_IMODE(member.mode)
                elif member.issym():
                    symlinks[member.name] = member.linkname
                    modes[member.name] = stat.S_IMODE(member.mode)
        _craft_archive(
            archive, blobs, symlinks, entries, modes,
            manifest_extra={"source": source},
        )
        dest = self.root / "no-old-ip-dest"
        with self.assertRaises(snap.SnapshotError) as ctx:
            snap.restore_snapshot(
                archive, dest, public_ip=NEW_IP,
            )
        self.assertIn("no source public IPv4", str(ctx.exception))
        self.assertFalse(dest.exists())


    def test_restore_remaps_owned_reality_ipv6_and_keeps_foreign(self):
        owned = "b831381d-6324-4d53-ad4f-8cda48b30811"
        foreign = "00000000-0000-0000-0000-000000000009"
        fake_v6 = "2001:db8::1"
        foreign_v4 = "203.0.113.9"
        self.source.joinpath("etc/pingu-gate.subscription.txt").write_text(
            "vless://" + owned + "@[" + fake_v6 + "]:443?security=reality"
            "&sni=cksheuen.site&pbk=reality-pubkey&sid=0123abcd"
            "&flow=xtls-rprx-vision&type=tcp#Direct-Reality-v6\n"
            "vless://" + foreign + "@[" + fake_v6 + "]:443?security=reality"
            "&sni=foreign.example&pbk=foreign-pubkey&sid=9999"
            "&type=tcp#Foreign-v6\n"
            "vless://" + foreign + "@" + foreign_v4 + ":443?security=reality"
            "&sni=foreign.example&pbk=foreign-pubkey&sid=9999"
            "&type=tcp#Foreign-v4\n"
            "vless://" + owned + "@cksheuen.site:443?type=ws&security=tls"
            "&sni=cksheuen.site&path=%2Fws%2Fpath#WS\n"
        )
        result = self._create()
        dest = self.root / "remap-v6"
        snap.restore_snapshot(
            result["archive_path"], dest, result["sha256"], public_ip=NEW_IP
        )
        lines = (
            dest / "rootfs/etc/pingu-gate.subscription.txt"
        ).read_text().splitlines()
        v6_line, foreign_v6_line, foreign_v4_line, ws_line = lines
        # Owned Reality node on literal IPv6 is repointed at the new IPv4...
        self.assertIn("@" + NEW_IP + ":443", v6_line)
        self.assertNotIn(fake_v6, v6_line)
        # ...with identity and cryptographic material preserved exactly.
        self.assertTrue(v6_line.startswith("vless://" + owned + "@"))
        for field in ("sni=cksheuen.site", "pbk=reality-pubkey",
                      "sid=0123abcd", "flow=xtls-rprx-vision",
                      "#Direct-Reality-v6"):
            self.assertIn(field, v6_line)
        # Foreign Reality URIs (unknown UUID, any IP) are untouched.
        self.assertIn("[" + fake_v6 + "]:443", foreign_v6_line)
        self.assertIn(foreign_v4, foreign_v4_line)
        # WS node is byte-identical.
        self.assertEqual(
            ws_line,
            "vless://" + owned + "@cksheuen.site:443?type=ws&security=tls"
            "&sni=cksheuen.site&path=%2Fws%2Fpath#WS",
        )
        report = (dest / "deployment.json").read_text()
        deployment = json.loads(report)
        self.assertIn(
            "etc/pingu-gate.subscription.txt", deployment["changed_paths"]
        )
        self.assertNotIn(owned, report)
        self.assertNotIn("vless://", report)


class MihomoSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        build_mihomo_source(self.source)
        self.output = self.root / "output"

    def create(self):
        return snap.create_snapshot(self.output, self.source)

    def test_roundtrip_without_xray_preserves_assets_and_permissions(self):
        result = self.create()
        manifest = snap.verify_snapshot(result["archive_path"], result["sha256"])
        self.assertEqual(manifest["schema"], "pingu-vps-snapshot/v2")
        self.assertEqual(manifest["runtime_profile"], "mihomo")
        self.assertEqual(manifest["source"]["public_ipv4_origin"],
                         "mihomo-config:pingu-public-ipv4")
        self.assertFalse(any("xray" in entry["path"] for entry in manifest["entries"]))
        destination = self.root / "restore"
        snap.restore_snapshot(result["archive_path"], destination, result["sha256"])
        for rel in snap.MIHOMO_FILES:
            self.assertEqual((destination / "rootfs" / rel).read_bytes(),
                             (self.source / rel).read_bytes(), rel)
        self.assertEqual((destination / "rootfs/etc/mihomo/config.json").stat().st_mode & 0o777, 0o600)
        self.assertFalse((destination / "rootfs/usr/local/bin/xray").exists())

    def test_remap_changes_binding_and_owned_uri_not_reality_keys_or_decoy(self):
        result = self.create()
        destination = self.root / "restore"
        snap.restore_snapshot(result["archive_path"], destination, public_ip=NEW_IP,
                              target_interface="ens3")
        config = json.loads((destination / "rootfs/etc/mihomo/config.json").read_text())
        self.assertEqual(config["pingu-public-ipv4"], NEW_IP)
        self.assertEqual(config["proxies"][0]["interface-name"], "ens3")
        self.assertEqual(config["listeners"][0]["listen"], NEW_IP)
        self.assertEqual(config["listeners"][1], MIHOMO_CONFIG["listeners"][1])
        self.assertEqual(config["listeners"][0]["reality-config"],
                         MIHOMO_CONFIG["listeners"][0]["reality-config"])
        self.assertEqual(config["secret"], MIHOMO_CONFIG["secret"])
        lines = (destination / "rootfs/etc/pingu-gate.subscription.txt").read_text().splitlines()
        self.assertIn("@" + NEW_IP + ":443", lines[0])
        self.assertEqual(lines[1], (self.source / "etc/pingu-gate.subscription.txt").read_text().splitlines()[1])
        deployment = json.loads((destination / "deployment.json").read_text())
        self.assertEqual(deployment["target_interface"], "ens3")

    def test_same_ip_still_remaps_interface(self):
        result = self.create()
        destination = self.root / "restore"
        snap.restore_snapshot(result["archive_path"], destination, public_ip=OLD_IP,
                              target_interface="enp1s0")
        config = json.loads((destination / "rootfs/etc/mihomo/config.json").read_text())
        self.assertEqual(config["proxies"][0]["interface-name"], "enp1s0")

    def test_mihomo_remap_requires_explicit_safe_interface_before_extraction(self):
        result = self.create()
        for interface in (None, "../../eth0", "a" * 16):
            with self.subTest(interface=interface), self.assertRaises(snap.SnapshotError):
                snap.restore_snapshot(result["archive_path"], self.root / "refused",
                                      public_ip=NEW_IP, target_interface=interface)
            self.assertFalse((self.root / "refused").exists())

    def test_migrated_host_excludes_stale_xray_but_can_create_explicit_rollback(self):
        legacy = self.root / "legacy"
        legacy.mkdir()
        build_source(legacy)
        for rel in ("usr/local/bin/xray", "usr/local/etc/xray", "usr/local/share/xray",
                    "etc/systemd/system/xray.service"):
            target = self.source / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            original = legacy / rel
            if original.is_dir():
                shutil.copytree(original, target)
            else:
                shutil.copyfile(original, target)
        config_path = self.source / "etc/mihomo/config.json"
        config = json.loads(config_path.read_text())
        config["pingu-public-ipv4"] = NEW_IP
        config_path.write_text(json.dumps(config))
        current = self.create()
        self.assertFalse(any("xray" in e["path"] for e in current["manifest"]["entries"]))
        legacy_result = snap.create_snapshot(self.output, self.source, runtime_profile="xray")
        manifest = snap.verify_snapshot(legacy_result["archive_path"], legacy_result["sha256"])
        self.assertEqual(manifest["schema"], snap.MANIFEST_SCHEMA)
        self.assertEqual(manifest["source"]["public_ipv4"], OLD_IP)
        self.assertFalse(any("mihomo" in e["path"] for e in manifest["entries"]))

    def test_new_profile_missing_assets_does_not_fallback_to_xray(self):
        (self.source / "etc/mihomo/GeoIP.dat").unlink()
        with self.assertRaisesRegex(snap.SnapshotError, "GeoIP.dat"):
            self.create()

    def test_missing_identity_aborts_before_backup_can_be_published(self):
        path = self.source / "etc/mihomo/config.json"
        config = json.loads(path.read_text())
        config.pop("pingu-public-ipv4")
        path.write_text(json.dumps(config))
        with self.assertRaisesRegex(snap.SnapshotError, "public IPv4 metadata"):
            self.create()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_profile_disallows_foreign_runtime_and_host_files(self):
        for rel in ("usr/local/bin/xray", "usr/local/etc/xray/config.json", "etc/ssh/sshd_config"):
            self.assertFalse(snap._allowed_restore_path(rel, "file", "mihomo"), rel)
        self.assertFalse(snap._allowed_restore_path("etc/mihomo/unrelated", "file", "mihomo"))
        for manifest in ({"schema": snap.MANIFEST_SCHEMA, "runtime_profile": "mihomo"},
                         {"schema": snap.MIHOMO_MANIFEST_SCHEMA},
                         {"schema": snap.MIHOMO_MANIFEST_SCHEMA, "runtime_profile": "xray"}):
            with self.assertRaises(snap.SnapshotError):
                snap.snapshot_profile(manifest)

    def test_verification_rejects_hash_tampering_and_missing_new_asset(self):
        result = self.create()
        with self.assertRaisesRegex(snap.SnapshotError, "SHA256 mismatch"):
            snap.verify_snapshot(result["archive_path"], "0" * 64)
        with tarfile.open(result["archive_path"], "r:gz") as tar:
            blobs, modes, symlinks = {}, {}, {}
            for member in tar.getmembers():
                if member.isfile() and member.name not in (
                        "manifest.json", "rootfs/usr/local/sbin/pingu_connections.py"):
                    blobs[member.name] = tar.extractfile(member).read()
                    modes[member.name] = stat.S_IMODE(member.mode)
                elif member.issym():
                    symlinks[member.name] = member.linkname
                    modes[member.name] = stat.S_IMODE(member.mode)
        manifest = dict(result["manifest"])
        manifest["entries"] = [entry for entry in manifest["entries"]
                               if entry["path"] != "usr/local/sbin/pingu_connections.py"]
        evil = self.root / "missing-helper.tar.gz"
        _craft_archive(evil, blobs, symlinks, manifest["entries"], modes, manifest)
        with self.assertRaisesRegex(snap.SnapshotError, "pingu_connections.py"):
            snap.verify_snapshot(evil)


if __name__ == "__main__":
    unittest.main()
