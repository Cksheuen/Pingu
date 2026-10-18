import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import routing_case_matrix as probes


class RoutingProbesTests(unittest.TestCase):
    def test_stack_order_and_global_fallback_drive_probe_expectations(self):
        groups = [
            {'id': 'a', 'rules': [{'rule_type': 'domain_suffix', 'match_value': 'example.com', 'outbound': 'direct'}]},
            {'id': 'b', 'rules': [{'rule_type': 'domain', 'match_value': 'example.com', 'outbound': 'proxy'}]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            data = {'rule_groups': groups, 'active_group_id': 'a', 'rule_stack': {'enabled_group_ids': ['b', 'a'], 'default_strategy': 'direct'}}
            path.write_text(json.dumps(data))
            with patch.object(probes, 'CONFIG_CANDIDATES', [path]):
                group = probes.read_active_group()
                self.assertEqual(probes.infer_expected_route('example.com', group), 'proxy')
                self.assertEqual(probes.infer_expected_route('unmatched.example', group), 'direct')
                data['rule_stack']['enabled_group_ids'] = ['a', 'b']
                path.write_text(json.dumps(data))
                self.assertEqual(probes.infer_expected_route('example.com', probes.read_active_group()), 'direct')

    def test_dataset_and_imported_rules_are_not_reported_as_verified_static_routes(self):
        group = {'rules': [{'rule_type': 'geosite', 'match_value': 'category-dev', 'outbound': 'proxy'}], 'default_strategy': 'direct'}
        self.assertEqual(probes.infer_expected_route('example.com', group), 'runtime')
        group['rules'] = [{'rule_type': 'domain', 'match_value': 'example.com', 'outbound': 'block'}]
        group['has_imported_rules'] = True
        self.assertEqual(probes.infer_expected_route('example.com', group), 'block')
        self.assertEqual(probes.infer_expected_route('unmatched.example', group), 'runtime')
        self.assertEqual(probes.infer_expected_route('example.com', None), 'runtime')


if __name__ == '__main__':
    unittest.main()
