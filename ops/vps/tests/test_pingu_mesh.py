import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mesh", Path(__file__).parents[1] / "sbin" / "pingu_mesh.py")
mesh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh)

class MeshControlTests(unittest.TestCase):
    def test_tombstone_precedes_remote_revocation_and_blocks_late_enrollment(self):
        identity = 'mesh-' + 'a' * 32 + '-' + 'b' * 32
        with tempfile.TemporaryDirectory() as folder:
            journal = Path(folder) / 'revoked.json'
            with patch.object(mesh, 'JOURNAL', str(journal)), patch.object(mesh, 'CONTROL_URL', 'https://mesh.example.com:8444'):
                with patch.object(mesh, '_cli', side_effect=RuntimeError('offline')):
                    with self.assertRaises(RuntimeError): mesh.control({'id':identity,'action':'revoke'})
                self.assertIn(identity, journal.read_text())
                with patch.object(mesh, '_cli') as command:
                    with self.assertRaises(ValueError): mesh.control({'id':identity,'action':'enroll'})
                    command.assert_not_called()
                with patch.object(mesh, '_cli', return_value=[]):
                    self.assertEqual(mesh.control({'id':identity,'action':'revoke'})['state'],'revoked')

    def test_enrollment_credentials_are_single_use_and_never_journaled(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = Path(folder) / 'revoked.json'
            with patch.object(mesh, 'JOURNAL', str(journal)), patch.object(mesh, 'CONTROL_URL', 'https://mesh.example.com:8444'):
                with patch.object(mesh, '_cli', side_effect=[[],{'id':7},{'key':'sensitive'}]) as command:
                    result=mesh.control({'id':'mesh-'+'a'*32+'-'+'b'*32,'action':'enroll'})
                    self.assertEqual(result['auth_key'],'sensitive')
                    self.assertEqual(command.call_args.args,('preauthkeys','create','-u',7,'-e','10m'))
                    self.assertFalse(journal.exists())
