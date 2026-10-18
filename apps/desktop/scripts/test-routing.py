#!/usr/bin/env python3
import argparse
import json
import re
import socket
import subprocess
import sys
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

from routing_case_matrix import build_case_matrix


IP_ECHO_URLS = ["https://api.ipify.org", "https://ifconfig.me/ip"]

CONFIG_CANDIDATES = [
    Path.home() / "Library" / "Application Support" / "sing-proxy" / "mihomo-config.json",
    Path.home() / ".config" / "sing-proxy" / "mihomo-config.json",
]


@dataclass
class CurlResult:
    ok: bool
    output: str
    error: str
    http_code: Optional[str] = None


def run_curl(url: str, proxy: Optional[str], timeout: int, body: bool) -> CurlResult:
    last_result = CurlResult(False, "", "no request attempted", None)
    for _ in range(3):
        cmd = ["curl", "-sS", "-L", "--connect-timeout", str(timeout), "--max-time", str(timeout)]
        cmd += ["--noproxy", ""] if proxy else ["--noproxy", "*"]
        if proxy:
            cmd += ["--proxy", proxy]

        if body:
            cmd.append(url)
        else:
            cmd += ["-o", "/dev/null", "-w", "%{http_code}", url]

        proc = subprocess.run(cmd, capture_output=True, text=True)
        last_result = CurlResult(
            ok=proc.returncode == 0,
            output=proc.stdout.strip(),
            error=proc.stderr.strip(),
            http_code=None if body else proc.stdout.strip(),
        )
        if last_result.ok and (body or (last_result.http_code not in (None, "", "000"))):
            return last_result
    return last_result


def extract_ip(text: str) -> Optional[str]:
    match = re.search(r"((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{2,})", text)
    return match.group(1) if match else None


def fetch_first_success(urls: list[str], proxy: Optional[str], timeout: int, body: bool) -> tuple[str, CurlResult]:
    last_result = None
    for url in urls:
        result = run_curl(url, proxy=proxy, timeout=timeout, body=body)
        if result.ok and result.output:
            return url, result
        last_result = result
    raise RuntimeError(last_result.error if last_result else "no request attempted")


def read_route_final() -> Optional[str]:
    for path in CONFIG_CANDIDATES:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                return next((rule.split(",", 1)[1] for rule in reversed(data.get("rules", [])) if rule.startswith("MATCH,")), None)
            except Exception:
                return None
    return None


def ensure_proxy_listening(host: str, port: int, timeout: int) -> None:
    with socket.create_connection((host, port), timeout=timeout):
        return


def is_allowed_http_code(http_code: Optional[str], allowed_prefixes: list[str]) -> bool:
    if not http_code or http_code == "000":
        return False
    return any(http_code.startswith(prefix) for prefix in allowed_prefixes)


def smoke_check(cases: list[dict], proxy: str, timeout: int, label: str) -> bool:
    print(f"\n[{label}]")
    all_ok = True
    for case in cases:
        result = run_curl(case["url"], proxy=proxy, timeout=timeout, body=False)
        ok = result.ok and is_allowed_http_code(result.http_code, case["allowed_status_prefixes"])
        status = "OK" if ok else "FAIL"
        print(
            f"- {status} {case['label']} route={case['expected_route']} "
            f"url={case['url']} http_code={result.http_code or 'n/a'}"
        )
        if not ok and result.error:
            print(f"  error: {result.error}")
        all_ok = all_ok and ok
    return all_ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Check local proxy connectivity without geographic assumptions")
    parser.add_argument("--proxy-host", default="127.0.0.1")
    parser.add_argument("--proxy-port", type=int, default=2080)
    parser.add_argument("--timeout", type=int, default=15)
    args = parser.parse_args()
    proxy = f"http://{args.proxy_host}:{args.proxy_port}"
    print(f"Configured fallback: {read_route_final() or 'unknown'}")
    try:
        ensure_proxy_listening(args.proxy_host, args.proxy_port, args.timeout)
    except OSError as exc:
        print(f"FAIL: Local proxy is not listening: {exc}")
        return 1
    for label, route in [("Direct network", None), ("Through local proxy", proxy)]:
        try:
            url, result = fetch_first_success(IP_ECHO_URLS, proxy=route, timeout=args.timeout, body=True)
            print(f"{label}: {extract_ip(result.output) or 'unknown'} ({url})")
        except RuntimeError as exc:
            print(f"WARN: {label} IP probe failed: {exc}")
    cases = build_case_matrix()
    blocked = [case for case in cases if case['expected_route'] == 'block']
    for case in blocked:
        print(f"SKIP: {case['label']} is explicitly blocked by user policy")
    passed = smoke_check([case for case in cases if case not in blocked], proxy, args.timeout, "Connectivity")
    if passed:
        print("PASS: Selected targets responded through the local listener. Confirm actual routing in live connections; IP equality alone does not prove a route.")
    else:
        print("FAIL: At least one connectivity probe failed.")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
