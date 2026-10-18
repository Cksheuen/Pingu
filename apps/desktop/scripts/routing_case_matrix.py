#!/usr/bin/env python3
"""Build connectivity probes from explicit user policy without region assumptions."""
import argparse
import json
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

CONFIG_CANDIDATES = [
    Path.home() / 'Library' / 'Application Support' / 'sing-proxy' / 'config.json',
    Path.home() / '.config' / 'sing-proxy' / 'config.json',
]
BASE_URLS = [
    ('example', 'Example site', 'https://example.com'),
    ('wikipedia', 'Wikipedia', 'https://www.wikipedia.org'),
    ('github', 'GitHub', 'https://github.com'),
    ('egress', 'IP echo', 'https://api.ipify.org'),
]


def read_active_group() -> Optional[dict]:
    for path in CONFIG_CANDIDATES:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        groups = {group['id']: group for group in data.get('rule_groups', [])}
        stack = data.get('rule_stack')
        if stack is not None:
            return {
                'rules': [rule for group_id in stack.get('enabled_group_ids', [])
                          for rule in groups.get(group_id, {}).get('rules', [])],
                'default_strategy': stack.get('default_strategy', 'proxy'),
                # Imported rules follow local rules; their matching is runtime data.
                'has_imported_rules': any(source.get('enabled') and not source.get('nodes_only')
                                          for source in data.get('subscriptions', [])),
            }
        group = groups.get(data.get('active_group_id'))
        if group is not None:
            return {**group, 'has_imported_rules': any(
                source.get('enabled') and not source.get('nodes_only')
                for source in data.get('subscriptions', []))}
    return None


def infer_expected_route(host: str, group: Optional[dict]) -> str:
    host = host.lower()
    if group is None:
        return 'runtime'
    for rule in group.get('rules', []):
        kind = rule.get('rule_type')
        value = str(rule.get('match_value', '')).strip().lower().lstrip('+.')
        if kind in ('geoip', 'geosite', 'ip_cidr'):
            return 'runtime'
        matches = (kind == 'domain' and host == value) or (
            kind == 'domain_suffix' and (host == value or host.endswith('.' + value)))
        if matches:
            return {'direct': 'direct', 'proxy': 'proxy', 'block': 'block'}.get(rule.get('outbound'), 'runtime')
    if group.get('has_imported_rules'):
        return 'runtime'
    return group.get('default_strategy') if group.get('default_strategy') in ('direct', 'proxy') else 'runtime'


def build_case_matrix() -> list[dict]:
    group = read_active_group()
    result = []
    for case_id, label, url in BASE_URLS:
        parsed = urlparse(url)
        result.append({'id': case_id, 'label': label, 'url': url,
                       'host': parsed.hostname, 'port': parsed.port or 443,
                       'expected_route': infer_expected_route(parsed.hostname, group),
                       'allowed_status_prefixes': ['2', '3'], 'source': 'connectivity'})
    return result


def emit_tsv(cases):
    for case in cases:
        print('\t'.join([case['id'], case['label'], case['url'], case['host'],
                         str(case['port']), case['expected_route'],
                         ','.join(case['allowed_status_prefixes']), case['source']]))


def main():
    parser = argparse.ArgumentParser(description='Build a region-neutral connectivity probe matrix')
    parser.add_argument('--format', choices=['json', 'tsv'], default='json')
    args = parser.parse_args()
    cases = build_case_matrix()
    if args.format == 'tsv':
        emit_tsv(cases)
    else:
        print(json.dumps(cases, indent=2))


if __name__ == '__main__':
    main()
