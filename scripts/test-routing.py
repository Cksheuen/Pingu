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


DOMESTIC_IP_ECHO_URLS = [
    "https://myip.ipip.net",
    "https://cip.cc",
]

FOREIGN_IP_ECHO_URLS = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
]

CN_SITES = [
    "https://www.baidu.com",
    "https://www.qq.com",
]

FOREIGN_SITES = [
    "https://www.google.com",
    "https://www.wikipedia.org",
]

CONFIG_CANDIDATES = [
    Path.home() / "Library" / "Application Support" / "sing-proxy" / "sing-box-config.json",
    Path.home() / ".config" / "sing-proxy" / "sing-box-config.json",
]


@dataclass
class CurlResult:
    ok: bool
    output: str
    error: str
    http_code: Optional[str] = None


def run_curl(url: str, proxy: Optional[str], timeout: int, body: bool) -> CurlResult:
    cmd = ["curl", "-sS", "-L", "--connect-timeout", str(timeout), "--max-time", str(timeout)]
    if proxy:
        cmd += ["--proxy", proxy]

    if body:
        cmd.append(url)
    else:
        cmd += ["-o", "/dev/null", "-w", "%{http_code}", url]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    return CurlResult(
        ok=proc.returncode == 0,
        output=proc.stdout.strip(),
        error=proc.stderr.strip(),
        http_code=None if body else proc.stdout.strip(),
    )


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
                return data.get("route", {}).get("final")
            except Exception:
                return None
    return None


def ensure_proxy_listening(host: str, port: int, timeout: int) -> None:
    with socket.create_connection((host, port), timeout=timeout):
        return


def smoke_check(urls: list[str], proxy: str, timeout: int, label: str) -> bool:
    print(f"\n[{label}]")
    all_ok = True
    for url in urls:
        result = run_curl(url, proxy=proxy, timeout=timeout, body=False)
        ok = result.ok and result.http_code not in (None, "", "000")
        status = "OK" if ok else "FAIL"
        print(f"- {status} {url} http_code={result.http_code or 'n/a'}")
        if not ok and result.error:
            print(f"  error: {result.error}")
        all_ok = all_ok and ok
    return all_ok


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 SingProxy 启动后的本地代理连通性与分流表现")
    parser.add_argument("--proxy-host", default="127.0.0.1")
    parser.add_argument("--proxy-port", type=int, default=2080)
    parser.add_argument("--timeout", type=int, default=15)
    args = parser.parse_args()

    proxy = f"http://{args.proxy_host}:{args.proxy_port}"
    route_final = read_route_final()

    if route_final:
        print(f"当前生成配置的 route.final: {route_final}")

    print(f"检查本地代理监听: {args.proxy_host}:{args.proxy_port}")
    try:
        ensure_proxy_listening(args.proxy_host, args.proxy_port, args.timeout)
    except OSError as exc:
        print(f"FAIL: 本地代理未监听或无法连接: {exc}")
        print("请先在应用内点击连接，确认 sing-box 已启动。")
        return 1

    ip_probe_failed = False
    try:
        local_ip_url, local_ip_result = fetch_first_success(
            DOMESTIC_IP_ECHO_URLS, proxy=None, timeout=args.timeout, body=True
        )
    except RuntimeError as exc:
        print(f"FAIL: 获取本机直连出口失败: {exc}")
        return 1

    try:
        proxy_ip_url, proxy_ip_result = fetch_first_success(
            FOREIGN_IP_ECHO_URLS, proxy=proxy, timeout=args.timeout, body=True
        )
    except RuntimeError as exc:
        proxy_ip_url, proxy_ip_result = "<failed>", CurlResult(False, "", str(exc))
        ip_probe_failed = True

    try:
        cn_proxy_ip_url, cn_proxy_ip_result = fetch_first_success(
            DOMESTIC_IP_ECHO_URLS, proxy=proxy, timeout=args.timeout, body=True
        )
    except RuntimeError as exc:
        cn_proxy_ip_url, cn_proxy_ip_result = "<failed>", CurlResult(False, "", str(exc))
        ip_probe_failed = True

    local_ip = extract_ip(local_ip_result.output)
    proxy_ip = extract_ip(proxy_ip_result.output)
    cn_proxy_ip = extract_ip(cn_proxy_ip_result.output)

    print("\n[IP 探针]")
    print(f"- 本机直连出口 ({local_ip_url}): {local_ip or 'unknown'}")
    print(f"- 代理出口 ({proxy_ip_url} via proxy): {proxy_ip or 'unknown'}")
    print(f"- 国内站点经代理访问出口 ({cn_proxy_ip_url} via proxy): {cn_proxy_ip or 'unknown'}")

    passed = True

    if route_final and route_final != "proxy":
        print("FAIL: 当前生成配置的默认出站不是 proxy，无法满足“国外代理、国内直连”的基准预期")
        passed = False

    if ip_probe_failed:
        print("WARN: 至少一个代理 IP 探针失败")
        if proxy_ip_result.error:
            print(f"  foreign probe error: {proxy_ip_result.error}")
        if cn_proxy_ip_result.error:
            print(f"  domestic probe error: {cn_proxy_ip_result.error}")
    elif not local_ip or not proxy_ip:
        print("WARN: 无法解析本机或代理出口 IP")
    elif local_ip == proxy_ip:
        print("WARN: 国外探针经本地代理后的出口 IP 与本机相同；这不一定代表失败，也可能是出口探针口径差异或代理端与本机出口一致")
    else:
        print("OK: 国外探针显示代理出口 IP 与本机不同")

    if local_ip and cn_proxy_ip:
        if cn_proxy_ip == local_ip:
            print("OK: 国内探针经本地代理后的出口仍是本机 IP，说明国内流量大概率走直连")
        elif proxy_ip and cn_proxy_ip == proxy_ip:
            print("WARN: 国内探针经本地代理后的出口看起来与代理出口一致，请结合运行日志继续判断")
        else:
            print("WARN: 国内探针出口 IP 无法明确归类，请结合日志继续判断")
    else:
        print("WARN: 无法解析国内探针出口 IP")

    passed = smoke_check(CN_SITES, proxy=proxy, timeout=args.timeout, label="国内站点可达性") and passed
    passed = smoke_check(FOREIGN_SITES, proxy=proxy, timeout=args.timeout, label="国外站点可达性") and passed

    if passed:
        print("\nPASS: 代理可用，且脚本观测到国外流量走代理、国内流量大概率走直连。")
        return 0

    print("\nFAIL: 至少一项代理/分流检查失败。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
