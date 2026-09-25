import json
import io
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from ops.vps.tests import run


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel, content in {
            "tests/a.py": "a-test\n",
            "tests/b.py": "b-test\n",
            "tests/fixture.py": "fixture\n",
            "src/shared.py": "shared\n",
            "src/a.py": "a-source\n",
        }.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.scopes = {
            "a": {"module": "tests.a", "paths": ("tests/a.py", "tests/fixture.py", "src/a.py", "src/shared.py")},
            "b": {"module": "tests.b", "paths": ("tests/b.py", "tests/fixture.py", "src/shared.py")},
        }

    def tearDown(self):
        self.tmp.cleanup()

    def fingerprints(self, toolchain="tool-v1"):
        return run.scope_fingerprints(self.root, self.scopes, toolchain)

    def test_fresh_cache_runs_every_scope_once(self):
        fingerprints = self.fingerprints()
        selected, reasons = run.select_scopes(fingerprints, {})
        self.assertEqual(selected, ["a", "b"])
        self.assertEqual(set(reasons.values()), {"no successful stamp"})

    def test_warm_unchanged_cache_skips_every_scope(self):
        fingerprints = self.fingerprints()
        selected, reasons = run.select_scopes(fingerprints, fingerprints)
        self.assertEqual(selected, [])
        self.assertEqual(reasons, {})

    def test_explicit_scope_does_not_label_unverified_others_as_skipped(self):
        fingerprints = self.fingerprints()
        selected, reasons = run.select_scopes(fingerprints, {}, ["a"])
        self.assertEqual(
            run.display_status("b", selected, reasons, fingerprints, {}),
            ("DEFER", "not selected; no successful stamp"),
        )

    def test_shared_source_change_invalidates_every_consumer(self):
        before = self.fingerprints()
        (self.root / "src/shared.py").write_text("changed\n")
        after = self.fingerprints()
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a", "b"])
        (self.root / "src/shared.py").write_text("shared\n")
        before = self.fingerprints()
        (self.root / "tests/fixture.py").write_text("changed fixture\n")
        after = self.fingerprints()
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a", "b"])

    def test_changed_test_invalidates_only_its_scope(self):
        before = self.fingerprints()
        (self.root / "tests/a.py").write_text("changed test\n")
        after = self.fingerprints()
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a"])

    def test_deleted_or_mode_changed_dependency_invalidates_its_scope(self):
        before = self.fingerprints()
        (self.root / "src/a.py").chmod(0o755)
        after = self.fingerprints()
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a"])
        (self.root / "src/a.py").unlink()
        after = self.fingerprints()
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a"])

    def test_toolchain_change_invalidates_every_scope(self):
        before = self.fingerprints("tool-v1")
        after = self.fingerprints("tool-v2")
        selected, _ = run.select_scopes(after, before)
        self.assertEqual(selected, ["a", "b"])

    def test_inventory_rejects_unmapped_test_and_code(self):
        tests = self.root / "ops/vps/tests"
        legacy = self.root / "ops/vps/legacy"
        source = self.root / "ops/vps/sbin"
        config = self.root / "ops/vps/config"
        tests.mkdir(parents=True)
        legacy.mkdir(parents=True)
        source.mkdir(parents=True)
        config.mkdir(parents=True)
        (tests / "test_known.py").write_text("\n")
        (legacy / "test_unknown.py").write_text("\n")
        (source / "known.py").write_text("\n")
        (config / "unowned-runtime.conf").write_text("runtime\n")
        scopes = {
            "known": {
                "module": "ops.vps.tests.test_known",
                "paths": ("ops/vps/tests/test_known.py", "ops/vps/sbin/known.py"),
            }
        }
        with self.assertRaisesRegex(ValueError, "unmapped tests.*unmapped inputs"):
            run.validate_scope_inventory(self.root, scopes)

    def test_pyyaml_capability_change_changes_toolchain_stamp(self):
        (self.root / "package.json").write_text('{"scripts":{"test:vps":"runner"}}')
        runner = self.root / "ops/vps/tests/run.py"
        runner.parent.mkdir(parents=True)
        runner.write_text("runner\n")
        package_init = self.root / "ops/vps/__init__.py"
        package_init.parent.mkdir(parents=True, exist_ok=True)
        package_init.write_text("package-v1\n")
        without_yaml = run.toolchain_stamp(
            self.root, {"pyyaml_available": False, "pyyaml_version": None}
        )
        with_yaml = run.toolchain_stamp(
            self.root, {"pyyaml_available": True, "pyyaml_version": "6.0.2"}
        )
        self.assertNotEqual(without_yaml, with_yaml)
        package_init.write_text("package-v2\n")
        changed_package = run.toolchain_stamp(
            self.root, {"pyyaml_available": True, "pyyaml_version": "6.0.2"}
        )
        self.assertNotEqual(with_yaml, changed_package)


class CacheWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache.json"
        self.fingerprints = {"a": "one", "b": "two"}
        self.scopes = {
            "a": {"module": "tests.a", "paths": ()},
            "b": {"module": "tests.b", "paths": ()},
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_success_stamps_only_scopes_that_actually_ran(self):
        def succeed(_command, **_kwargs):
            return SimpleNamespace(returncode=0)

        with redirect_stdout(io.StringIO()):
            result = run.run_scopes(
                ["a"], self.fingerprints, {"old": "kept"}, self.cache,
                self.scopes, succeed, lambda: self.fingerprints
            )
        self.assertEqual(result, 0)
        payload = json.loads(self.cache.read_text())
        self.assertEqual(payload["scopes"], {"a": "one", "old": "kept"})

    def test_failure_writes_no_stamps(self):
        def fail(_command, **_kwargs):
            return SimpleNamespace(returncode=1)

        with redirect_stdout(io.StringIO()):
            result = run.run_scopes(
                ["a"], self.fingerprints, {}, self.cache, self.scopes, fail,
                lambda: self.fingerprints
            )
        self.assertEqual(result, 1)
        self.assertFalse(self.cache.exists())

    def test_source_mutation_during_successful_test_writes_no_stamps(self):
        changed = dict(self.fingerprints, a="changed-during-test")

        with redirect_stdout(io.StringIO()):
            result = run.run_scopes(
                ["a"], self.fingerprints, {}, self.cache, self.scopes,
                lambda _command, **_kwargs: SimpleNamespace(returncode=0),
                lambda: changed
            )

        self.assertEqual(result, 1)
        self.assertFalse(self.cache.exists())

    def test_malformed_cache_shape_is_treated_as_empty(self):
        for scopes in (
            ["not", "a", "mapping"], {"a": 123}, {"unknown": "value"}
        ):
            with self.subTest(scopes=scopes):
                self.cache.write_text(json.dumps({
                    "schema": "pingu-vps-tests/v1", "scopes": scopes
                }))
                self.assertEqual(run.load_cache(self.cache), {})

    def test_fresh_child_pycache_prevents_same_second_same_size_stale_source(self):
        package = Path(self.tmp.name) / "fixture_pkg"
        package.mkdir()
        (package / "__init__.py").write_text("")
        source = package / "behavior.py"
        source.write_text('VALUE = "old"\n')
        test_file = package / "test_behavior.py"
        test_file.write_text(
            "import os, unittest\n"
            "from .behavior import VALUE\n"
            "class BehaviorTest(unittest.TestCase):\n"
            "    def test_value(self): self.assertEqual(VALUE, os.environ['EXPECTED'])\n"
        )
        stale_cache = Path(self.tmp.name) / "stale-pycache"
        env = dict(os.environ, PYTHONPATH=self.tmp.name, EXPECTED="old",
                   PYTHONPYCACHEPREFIX=str(stale_cache))
        seed = subprocess.run(
            [os.sys.executable, "-m", "unittest", "fixture_pkg.test_behavior"],
            cwd=self.tmp.name, env=env, capture_output=True, text=True
        )
        self.assertEqual(seed.returncode, 0, seed.stderr)
        source_stat = source.stat()
        source.write_text('VALUE = "new"\n')
        os.utime(source, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        stale = subprocess.run(
            [os.sys.executable, "-m", "unittest", "fixture_pkg.test_behavior"],
            cwd=self.tmp.name,
            env=dict(env, EXPECTED="new"), capture_output=True, text=True
        )
        self.assertNotEqual(stale.returncode, 0, "fixture must reproduce stale bytecode")

        scopes = {
            "fixture": {
                "module": "fixture_pkg.test_behavior",
                "paths": ("fixture_pkg/behavior.py", "fixture_pkg/test_behavior.py"),
            }
        }
        fingerprints = run.scope_fingerprints(
            Path(self.tmp.name), scopes, toolchain="tool-v1"
        )

        def execute(command, env):
            return subprocess.run(
                command, cwd=self.tmp.name, env=dict(env, EXPECTED="new"),
                capture_output=True, text=True
            )

        with mock.patch.dict(os.environ, {"PYTHONPATH": self.tmp.name}, clear=False), \
             redirect_stdout(io.StringIO()):
            result = run.run_scopes(
                ["fixture"], fingerprints, {}, self.cache, scopes, execute,
                lambda: fingerprints
            )
        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
