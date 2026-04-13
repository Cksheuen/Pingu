#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import subprocess
from typing import Optional
from urllib.parse import urlparse


CONFIG_CANDIDATES = [
    Path.home() / "Library" / "Application Support" / "sing-proxy" / "config.json",
    Path.home() / ".config" / "sing-proxy" / "config.json",
]

BASE_CASES = [
    {
        "id": "baidu",
        "label": "百度首页",
        "url": "https://www.baidu.com",
        "expected_route": "direct",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-direct",
    },
    {
        "id": "bilibili",
        "label": "Bilibili 首页",
        "url": "https://www.bilibili.com",
        "expected_route": "direct",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-direct",
    },
    {
        "id": "netease",
        "label": "网易首页",
        "url": "https://www.163.com",
        "expected_route": "direct",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-direct",
    },
    {
        "id": "google",
        "label": "Google 首页",
        "url": "https://www.google.com",
        "expected_route": "proxy",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-proxy",
    },
    {
        "id": "wikipedia",
        "label": "Wikipedia 首页",
        "url": "https://www.wikipedia.org",
        "expected_route": "proxy",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-proxy",
    },
    {
        "id": "github",
        "label": "GitHub 首页",
        "url": "https://github.com",
        "expected_route": "proxy",
        "allowed_status_prefixes": ["2", "3"],
        "source": "baseline-proxy",
    },
]

POLICY_CASES = {
    "feishu.cn": {
        "id": "feishu",
        "label": "飞书官网",
        "url": "https://www.feishu.cn",
        "expected_route": "direct",
        "allowed_status_prefixes": ["2", "3"],
        "source": "policy-domain",
    },
    "bytedance.net": {
        "id": "bytedance-net",
        "label": "Bytedance 网络域名",
        "url": "https://www.bytedance.net",
        "expected_route": "direct",
        "allowed_status_prefixes": ["2", "3"],
        "source": "policy-domain",
    },
    "npmjs.org": {
        "id": "npmjs",
        "label": "npm Registry",
        "url": "https://registry.npmjs.org",
        "expected_route": "proxy",
        "allowed_status_prefixes": ["2", "3"],
        "source": "policy-domain",
    },
}

POLICY_ROUTE_HINTS = {
    "byted.org": "direct",
    "bytedance.net": "direct",
    "feishu.cn": "direct",
    "npmjs.org": "proxy",
    "lan": "direct",
    "local": "direct",
}


def normalize_suffix(value: str) -> str:
    return value.lstrip("+.").strip().lower()


def read_active_group() -> Optional[dict]:
    for path in CONFIG_CANDIDATES:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        active_group_id = data.get("active_group_id")
        for group in data.get("rule_groups", []):
            if group.get("id") == active_group_id:
                return group
    return None


def read_npm_registry_url() -> Optional[str]:
    try:
        result = subprocess.run(
            ["npm", "config", "get", "registry"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None

    registry = result.stdout.strip()
    if result.returncode != 0 or not registry or registry == "undefined":
        return None
    if not registry.startswith(("http://", "https://")):
        return None
    return registry


def suffix_matches(host: str, suffix: str) -> bool:
    return host == suffix or host.endswith("." + suffix)


def infer_expected_route(host: str, active_group: Optional[dict]) -> str:
    host = host.lower()
    if active_group:
        for rule in active_group.get("rules", []):
            rule_type = rule.get("rule_type")
            match_value = str(rule.get("match_value", "")).strip().lower()
            outbound = str(rule.get("outbound", "")).strip().lower()
            if outbound not in ("direct", "proxy"):
                continue
            if rule_type == "domain" and host == match_value:
                return outbound
            if rule_type == "domain_suffix" and suffix_matches(host, match_value.lstrip(".")):
                return outbound

    for suffix, route in POLICY_ROUTE_HINTS.items():
        if suffix_matches(host, suffix):
            return route

    if active_group:
        default_strategy = str(active_group.get("default_strategy", "")).strip().lower()
        if default_strategy in ("direct", "proxy"):
            return default_strategy

    return "proxy"


def build_case_matrix() -> list[dict]:
    cases = [dict(case) for case in BASE_CASES]
    seen_ids = {case["id"] for case in cases}
    seen_hosts = {urlparse(case["url"]).hostname or "" for case in cases}

    active_group = read_active_group()
    if not active_group:
        return enrich_cases(add_runtime_cases(cases, seen_ids, seen_hosts, active_group))

    suffixes = {
        normalize_suffix(item.get("domain_suffix", ""))
        for item in active_group.get("nameserver_policy", [])
        if item.get("domain_suffix")
    }

    for suffix in sorted(suffixes):
        template = POLICY_CASES.get(suffix)
        if not template or template["id"] in seen_ids:
            continue
        case = dict(template)
        case["matched_policy_suffix"] = suffix
        cases.append(case)
        seen_ids.add(case["id"])

    return enrich_cases(add_runtime_cases(cases, seen_ids, seen_hosts, active_group))


def add_runtime_cases(
    cases: list[dict],
    seen_ids: set[str],
    seen_hosts: set[str],
    active_group: Optional[dict],
) -> list[dict]:
    registry_url = read_npm_registry_url()
    if not registry_url:
        return cases

    parsed = urlparse(registry_url)
    host = (parsed.hostname or "").lower()
    if not host or host in seen_hosts:
        return cases

    cases.append(
        {
            "id": "npm-registry-active",
            "label": "当前 npm registry",
            "url": registry_url,
            "expected_route": infer_expected_route(host, active_group),
            "allowed_status_prefixes": ["2", "3"],
            "source": "runtime-config",
            "matched_runtime_host": host,
        }
    )
    return cases


def enrich_cases(cases: list[dict]) -> list[dict]:
    enriched = []
    for case in cases:
        parsed = urlparse(case["url"])
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        item = dict(case)
        item["host"] = host
        item["port"] = port
        enriched.append(item)
    return enriched


def emit_tsv(cases: list[dict]) -> None:
    for case in cases:
        fields = [
            case["id"],
            case["label"],
            case["url"],
            case["host"],
            str(case["port"]),
            case["expected_route"],
            ",".join(case["allowed_status_prefixes"]),
            case["source"],
        ]
        print("\t".join(fields))


def main() -> int:
    parser = argparse.ArgumentParser(description="输出 routing 验证用例矩阵")
    parser.add_argument("--format", choices=["json", "tsv"], default="json")
    args = parser.parse_args()

    cases = build_case_matrix()
    if args.format == "tsv":
        emit_tsv(cases)
    else:
        print(json.dumps(cases, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
