#!/usr/bin/env python3
"""Content-addressed unittest selection for independent VPS modules."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import tempfile
import time


REPO_ROOT = Path(__file__).resolve().parents[3]
CACHE_PATH = REPO_ROOT / ".local/test-dist/vps-scopes-v1.json"
COMMON_INPUTS = (
    "ops/vps/__init__.py",
    "ops/vps/sbin/__init__.py",
    "ops/vps/tests/__init__.py",
)
# Documentation and the live audit ledger do not affect local test execution.
INVENTORY_EXCLUDED = {
    "ops/vps/README.md",
    "ops/vps/MIGRATION.md",
    "ops/vps/TRAFFIC.md",
    "ops/vps/remote-manifest.json",
}

# Test files belong to exactly one scope. Production files may fan out to every
# consumer whose behavior they affect.
SCOPES = {
    "runtime-controls": {
        "module": "ops.vps.tests.test_pingu_runtime_controls",
        "paths": ("ops/vps/sbin/pingu_runtime_controls.py", "ops/vps/tests/test_pingu_runtime_controls.py", "ops/vps/runtime-controls.sh", "ops/vps/systemd/pingu-runtime-controls.service"),
    },
    "backup": {
        "module": "ops.vps.tests.test_pingu_backup",
        "paths": (
            "ops/vps/tests/test_pingu_backup.py",
            "ops/vps/tests/test_pingu_snapshot.py",
            "ops/vps/sbin/pingu_backup.py",
            "ops/vps/sbin/pingu_snapshot.py",
            "ops/vps/config/pingu-backup.conf.example",
            "ops/vps/systemd/pingu-backup.service",
            "ops/vps/systemd/pingu-backup.timer",
            "ops/vps/systemd/pingu-backup.path",
        ),
    },
    "connections": {
        "module": "ops.vps.tests.test_pingu_connections",
        "paths": (
            "ops/vps/tests/test_pingu_connections.py",
            "ops/vps/sbin/pingu_connections.py",
        ),
    },
    "device-access": {
        "module": "ops.vps.tests.test_pingu_device_access",
        "paths": (
            "ops/vps/tests/test_pingu_device_access.py",
            "ops/vps/sbin/pingu_device_access.py",
        ),
    },
    "gate": {
        "module": "ops.vps.tests.test_pingu_gate",
        "paths": (
            "ops/vps/tests/test_pingu_gate.py",
            "ops/vps/sbin/pingu_gate.py",
            "ops/vps/sbin/pingu_device_access.py",
            "ops/vps/sbin/pingu_mihomo.py",
            "ops/vps/sbin/pingu_connections.py",
            "ops/vps/config/pingu-gate.env.example",
            "ops/vps/systemd/pingu-gate.service",
            "ops/vps/systemd/pingu-gate.service.d/lease.conf",
        ),
    },
    "mihomo": {
        "module": "ops.vps.tests.test_pingu_mihomo",
        "paths": (
            "ops/vps/tests/test_pingu_mihomo.py",
            "ops/vps/sbin/pingu_mihomo.py",
            "ops/vps/config/mihomo-release.json",
            "ops/vps/config/xray-direct-ipv4.fragment.json",
            "ops/vps/systemd/mihomo.service",
        ),
    },
    "snapshot": {
        "module": "ops.vps.tests.test_pingu_snapshot",
        "paths": (
            "ops/vps/tests/test_pingu_snapshot.py",
            "ops/vps/sbin/pingu_snapshot.py",
            "ops/vps/sbin/pingu_runtime_controls.py",
            "ops/vps/sbin/pingu_device_access.py",
            "ops/vps/sbin/pingu_mihomo.py",
            "ops/vps/sbin/pingu_connections.py",
            "ops/vps/systemd",
            "ops/vps/nftables",
        ),
    },
    "traffic": {
        "module": "ops.vps.tests.test_pingu_traffic_tools",
        "paths": (
            "ops/vps/tests/test_pingu_traffic_tools.py",
            "ops/vps/sbin/pingu_traffic_guard.py",
            "ops/vps/sbin/pingu_traffic_report.py",
            "ops/vps/config/pingu-traffic-guard.conf.example",
            "ops/vps/nftables/pingu-guard.nft",
            "ops/vps/systemd/pingu-traffic-guard.service",
            "ops/vps/systemd/pingu-traffic-guard.timer",
            "ops/vps/systemd/pingu-traffic-report.service",
            "ops/vps/systemd/pingu-traffic-report.timer",
        ),
    },
    "migration": {
        "module": "ops.vps.tests.test_vps_migration",
        "paths": (
            "ops/vps/tests/test_vps_migration.py",
            "ops/vps/tests/test_pingu_snapshot.py",
            "ops/vps/vps.py",
            "ops/vps/bootstrap.sh",
            "ops/vps/audit-remote.sh",
            "ops/vps/sbin/pingu_snapshot.py",
            "ops/vps/sbin/pingu_runtime_controls.py",
            "ops/vps/config/mihomo-release.json",
            "ops/vps/systemd",
            "ops/vps/nftables",
        ),
    },
    "runner": {
        "module": "ops.vps.tests.test_vps_test_runner",
        "paths": (
            "ops/vps/tests/test_vps_test_runner.py",
            "ops/vps/tests/run.py",
        ),
    },
}


def _hash_paths(repo_root, paths, seed):
    digest = hashlib.sha256(seed.encode())
    for rel in paths:
        target = repo_root / rel
        files = sorted(p for p in target.rglob("*") if p.is_file()) if target.is_dir() else [target]
        for path in files:
            name = path.relative_to(repo_root).as_posix() if path.exists() else rel
            digest.update(name.encode())
            digest.update(b"\0")
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else -1
            digest.update(str(mode).encode())
            digest.update(b"\0")
            digest.update(path.read_bytes() if path.is_file() else b"<missing>")
            digest.update(b"\0")
    return digest.hexdigest()


def optional_capabilities():
    yaml_available = importlib.util.find_spec("yaml") is not None
    try:
        yaml_version = importlib.metadata.version("PyYAML") if yaml_available else None
    except importlib.metadata.PackageNotFoundError:
        yaml_version = "unknown"
    return {"pyyaml_available": yaml_available, "pyyaml_version": yaml_version}


def toolchain_stamp(repo_root=REPO_ROOT, capabilities=None):
    package = json.loads((repo_root / "package.json").read_text())
    scripts = {
        key: value for key, value in package.get("scripts", {}).items()
        if key == "check:vps" or key.startswith("test:vps")
    }
    inventories = [
        path.relative_to(repo_root).as_posix()
        for path in (repo_root / "ops/vps").rglob("*")
        if path.is_file()
        and "tests" not in path.relative_to(repo_root / "ops/vps").parts
        and path.name not in {"README.md", "MIGRATION.md", "TRAFFIC.md", "remote-manifest.json"}
        and "__pycache__" not in path.parts
    ]
    seed = json.dumps({
        "version": 1,
        "python": sys.version,
        "implementation": platform.python_implementation(),
        "capabilities": capabilities if capabilities is not None else optional_capabilities(),
        "scripts": scripts,
        "inventories": sorted(inventories),
    }, sort_keys=True)
    return _hash_paths(repo_root, ("ops/vps/tests/run.py", *COMMON_INPUTS), seed)


def scope_fingerprints(repo_root=REPO_ROOT, scopes=SCOPES, toolchain=None):
    stamp = toolchain if toolchain is not None else toolchain_stamp(repo_root)
    return {
        name: _hash_paths(repo_root, definition["paths"], stamp)
        for name, definition in scopes.items()
    }


def load_cache(path=CACHE_PATH):
    try:
        payload = json.loads(path.read_text())
        if not isinstance(payload, dict) or payload.get("schema") != "pingu-vps-tests/v1":
            return {}
        scopes = payload.get("scopes")
        if not isinstance(scopes, dict) or not all(
            isinstance(key, str) and key in SCOPES and isinstance(value, str)
            for key, value in scopes.items()
        ):
            return {}
        return scopes
    except (OSError, ValueError, AttributeError):
        return {}


def validate_scope_inventory(repo_root=REPO_ROOT, scopes=SCOPES):
    mapped_tests = {
        definition["module"].replace(".", "/") + ".py"
        for definition in scopes.values()
    }
    actual_tests = {
        path.relative_to(repo_root).as_posix()
        for path in (repo_root / "ops/vps").rglob("test_*.py")
    }
    mapped_inputs = set(COMMON_INPUTS)
    mapped_inputs.update(
        rel for definition in scopes.values() for rel in definition["paths"]
    )

    def covered(rel):
        for mapped in mapped_inputs:
            target = repo_root / mapped
            if rel == mapped or (target.is_dir() and rel.startswith(mapped.rstrip("/") + "/")):
                return True
        return False

    actual_inputs = {
        path.relative_to(repo_root).as_posix()
        for path in (repo_root / "ops/vps").rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
        and path.relative_to(repo_root).as_posix() not in INVENTORY_EXCLUDED
    }
    problems = []
    for label, paths in (
        ("unmapped tests", actual_tests - mapped_tests),
        ("missing mapped tests", mapped_tests - actual_tests),
        ("unmapped inputs", {rel for rel in actual_inputs if not covered(rel)}),
    ):
        if paths:
            problems.append("{}: {}".format(label, ", ".join(sorted(paths))))
    if problems:
        raise ValueError("VPS test scope inventory is incomplete; " + "; ".join(problems))


def select_scopes(fingerprints, cached, requested=None, run_all=False):
    if run_all:
        return list(fingerprints), {name: "--all" for name in fingerprints}
    if requested:
        names = list(dict.fromkeys(requested))
        return names, {name: "explicit --scope" for name in names}
    selected, reasons = [], {}
    for name, fingerprint in fingerprints.items():
        if name not in cached:
            selected.append(name)
            reasons[name] = "no successful stamp"
        elif cached[name] != fingerprint:
            selected.append(name)
            reasons[name] = "content changed"
    return selected, reasons


def display_status(name, selected, reasons, fingerprints, cached):
    if name in selected:
        return "RUN", reasons[name]
    if name not in cached:
        return "DEFER", "not selected; no successful stamp"
    if cached[name] != fingerprints[name]:
        return "DEFER", "not selected; content changed since stamp"
    return "SKIP", "unchanged successful stamp"


def write_cache(path, fingerprints):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({
        "schema": "pingu-vps-tests/v1",
        "scopes": fingerprints,
    }, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile("w", dir=str(path.parent), delete=False) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.replace(str(temporary), str(path))


def run_scopes(selected, fingerprints, cached=None, cache_path=CACHE_PATH,
               scopes=SCOPES, runner=subprocess.run, recompute=None):
    failed = []
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    for name in selected:
        started = time.monotonic()
        with tempfile.TemporaryDirectory(
            prefix="pycache-{}-".format(name), dir=str(cache_path.parent)
        ) as pycache:
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = pycache
            completed = runner(
                [sys.executable, "-m", "unittest", scopes[name]["module"]],
                env=env,
            )
        elapsed = time.monotonic() - started
        if completed.returncode:
            failed.append(name)
            print("FAIL {} ({:.2f}s)".format(name, elapsed))
        else:
            print("PASS {} ({:.2f}s)".format(name, elapsed))
    if failed:
        print("No stamps written because this test run failed: {}".format(", ".join(failed)))
        return 1
    current = (recompute or scope_fingerprints)()
    changed = [name for name in selected if current.get(name) != fingerprints.get(name)]
    if changed:
        print("No stamps written because inputs changed during the run: {}".format(
            ", ".join(changed)
        ))
        return 1
    updated = dict(cached or {})
    updated.update({name: current[name] for name in selected})
    write_cache(cache_path, updated)
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["--"]:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="show selection without running tests")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--scope", action="append", choices=tuple(SCOPES), help="run one scope; repeatable")
    selection.add_argument("--all", action="store_true", help="run the complete VPS release suite")
    args = parser.parse_args(argv)

    try:
        validate_scope_inventory()
    except ValueError as error:
        parser.error(str(error))
    fingerprints = scope_fingerprints()
    cached = load_cache()
    selected, reasons = select_scopes(fingerprints, cached, args.scope, args.all)
    print("VPS test selection:")
    for name in SCOPES:
        action, reason = display_status(
            name, selected, reasons, fingerprints, cached
        )
        print("  {:5} {:13} {}".format(action, name, reason))
    if args.plan:
        return 0
    if not selected:
        print("SKIP: all VPS scopes are unchanged; 0 tests executed (skip is not pass).")
        return 0
    return run_scopes(selected, fingerprints, cached)


if __name__ == "__main__":
    raise SystemExit(main())
