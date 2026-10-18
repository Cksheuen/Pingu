import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ops.vps.sbin import pingu_egress as e
from ops.vps.sbin.pingu_magpie import Magpie, MagpieError
from unittest.mock import Mock
import uuid


def configuration():
    return {'mode': 'rule', 'mixed-port': 0, 'external-controller': '127.0.0.1:19090',
        'secret': 'x' * 32, 'proxies': [], 'rules': ['IP-CIDR,10.0.0.0/8,REJECT', 'MATCH,DIRECT'],
        'listeners': [{'name': 'existing-ws', 'type': 'vless', 'listen': '127.0.0.1',
            'port': 10000, 'ws-path': '/', 'allow-insecure': True,
            'users': [{'username': 'original', 'uuid': '45ce0a2f-3a3a-4e9d-a20e-caa9ac1c5204'}]}]}


def record(phase='ready'):
    return {'version': 1, 'name': 'Cloudflare', 'uuid': '2b3f1792-7a14-4637-8b54-44f20d99e273',
            'phase': phase, 'created_at': '2026-10-13T00:00:00Z',
            'registration_fingerprint': 'owned', 'service_started': True}


class RoutingTests(unittest.TestCase):
    def test_add_remove_round_trip_preserves_existing_users_routes_and_ports(self):
        original = configuration()
        enabled = e.routing_candidate(original, record(), True)
        self.assertEqual(original, configuration())
        self.assertEqual(enabled['listeners'][0]['users'][0], original['listeners'][0]['users'][0])
        self.assertEqual([r for r in enabled['rules'] if r not in e.RULES], original['rules'])
        self.assertLess(enabled['rules'].index(original['rules'][0]), enabled['rules'].index(e.RULES[1]))
        self.assertIn('NETWORK,UDP', enabled['rules'][0])
        self.assertEqual(enabled['listeners'][0]['port'], original['listeners'][0]['port'])
        self.assertEqual(e.routing_candidate(enabled, record(), True), enabled)
        self.assertEqual(e.routing_candidate(enabled, record(), False), original)

    def test_foreign_identity_or_outbound_and_bypassing_listener_are_rejected(self):
        variants = []
        config = configuration(); config['listeners'][0]['users'].append({'username': e.USER, 'uuid': 'other'}); variants.append(config)
        config = configuration(); config['proxies'].append({'name': e.OUTBOUND, 'type': 'direct'}); variants.append(config)
        config = configuration(); config['listeners'][0]['proxy'] = 'DIRECT'; variants.append(config)
        for config in variants:
            before = copy.deepcopy(config)
            with self.assertRaises(e.EgressError): e.routing_candidate(config, record(), True)
            self.assertEqual(config, before)

    def test_failed_readback_restores_live_config_without_persisting_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'; e.atomic_json(path, configuration())
            original = path.read_bytes(); candidate = e.routing_candidate(configuration(), record(), True)
            with patch.object(e, 'validate'), patch.object(e, 'controller', side_effect=[{}, {'rules': []}, {}]) as api:
                with self.assertRaisesRegex(e.EgressError, 'Live routing'):
                    e.apply_routing(path, candidate)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(api.call_args_list[-1].args, (configuration(), '/configs', configuration()))

    def test_failed_persistence_rolls_back_live_routing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'; e.atomic_json(path, configuration())
            live = {'rules': [{'type': 'AND', 'payload': f'((IN-USER,{e.USER}),(NETWORK,UDP))', 'proxy': 'REJECT'}, {'type': 'InUser', 'payload': e.USER, 'proxy': e.OUTBOUND}]}
            with patch.object(e, 'validate'), patch.object(e, 'controller', side_effect=[{}, live, {}]) as api, patch.object(e, 'atomic_json', side_effect=OSError('disk full')):
                with self.assertRaisesRegex(e.EgressError, 'previous routing'):
                    e.apply_routing(path, e.routing_candidate(configuration(), record(), True))
            self.assertEqual(json.loads(path.read_text()), configuration())
            self.assertEqual(api.call_args_list[-1].args[2], configuration())

    def test_two_exits_remain_distinct_and_removing_one_preserves_the_other(self):
        a, b = pool_record(), pool_record(port=41002)
        first = e.routing_candidate(configuration(), a, True)
        both = e.routing_candidate(first, b, True)
        self.assertEqual(e.routing_candidate(both, a, True), both)
        self.assertEqual(e.routing_candidate(both, b, True), both)
        self.assertEqual(e.routing_candidate(both, b, False), first)
        remaining = e.routing_candidate(both, a, False)
        self.assertEqual(e.routing_candidate(remaining, b, False), configuration())
        self.assertEqual({p['port'] for p in both['proxies']}, {41001, 41002})
        self.assertEqual(len(both['listeners'][0]['users']), 3)


def pool_record(phase='ready', port=41001):
    return {**record(phase), 'id': str(uuid.uuid4()), 'uuid': str(uuid.uuid4()),
            'runtime': 'podman', 'port': port}


class ManagementTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.runtime = Mock()
        self.runtime.installed.return_value = True
        self.magpie = Mock()
        self.magpie.view.return_value = {'available': True, 'providers': [], 'error': None}
        self.magpie.references.return_value = []
        self.manager = e.Manager(self.path / 'state.json', self.path / 'config.json', self.runtime, self.magpie)
        e.atomic_json(self.manager.config_path, configuration())
        self.proof = {'ip': '192.0.2.22', 'location': 'US', 'checked_at': '2026-10-16T00:00:00Z'}

    def install(self, *records):
        self.manager.save({'version': 2, 'exits': list(records)})
        config = configuration()
        for r in records:
            if r['phase'] == 'ready':
                config = e.routing_candidate(config, r, True)
        e.atomic_json(self.manager.config_path, config)

    def test_failed_create_retains_retry_id_and_never_publishes_route(self):
        exit_id = str(uuid.uuid4())
        with patch.object(e, 'validate'), patch.object(e, 'probe_warp', side_effect=e.EgressError('not ready')), patch.object(e.time, 'sleep'), patch.object(e, 'apply_routing') as apply:
            for _ in range(2):
                with self.assertRaisesRegex(e.EgressError, 'not ready'):
                    self.manager.create('Cloudflare', exit_id)
            apply.assert_not_called()
        pool = self.manager.load()
        self.assertEqual(len(pool['exits']), 1)
        self.assertEqual(pool['exits'][0]['id'], exit_id)
        self.assertEqual(pool['exits'][0]['phase'], 'creating')

    def test_create_probes_before_publishing_and_retry_keeps_credential(self):
        calls = []
        def probe(port, **kwargs): calls.append('probe'); return self.proof
        def apply(path, value): calls.append('route'); e.atomic_json(path, value)
        exit_id = str(uuid.uuid4())
        with patch.object(e, 'validate'), patch.object(e, 'verify_live_routing'), patch.object(e, 'probe_warp', side_effect=probe), patch.object(e, 'apply_routing', side_effect=apply):
            first = self.manager.create('First', exit_id)
            again = self.manager.create('First', exit_id)
        self.assertTrue(first['exits'][0]['ready'])
        self.assertLess(calls.index('probe'), calls.index('route'))
        self.assertEqual(first['exits'][0]['uuid'], again['exits'][0]['uuid'])
        self.runtime.create.assert_called_once()

    def test_bound_exit_cannot_be_deleted_or_switch_phase(self):
        r = pool_record(); self.install(r)
        self.magpie.references.return_value = ['claude/one@example.com']
        with self.assertRaisesRegex(e.EgressError, 'still uses'):
            self.manager.delete(r['id'])
        self.assertEqual(self.manager.load()['exits'][0]['phase'], 'ready')
        self.runtime.delete.assert_not_called()

    def test_duplicate_names_are_rejected_before_creating_an_ambiguous_exit(self):
        r = pool_record(); self.install(r)
        with self.assertRaisesRegex(e.EgressError, 'name already exists'):
            self.manager.create('cloudflare', str(uuid.uuid4()))
        self.runtime.create.assert_not_called()
        self.assertEqual(len(self.manager.load()['exits']), 1)

    def test_failed_route_removal_never_stops_warp(self):
        r = pool_record(); self.install(r)
        with patch.object(e, 'apply_routing', side_effect=e.EgressError('core busy')):
            with self.assertRaisesRegex(e.EgressError, 'core busy'):
                self.manager.delete(r['id'])
        self.runtime.delete.assert_not_called()
        self.assertEqual(self.manager.load()['exits'][0]['phase'], 'deleting')

    def test_delete_preserves_other_exit_and_stops_only_after_removing_route(self):
        a, b = pool_record(), pool_record(port=41002); self.install(a, b)
        calls = []
        self.runtime.delete.side_effect = lambda r, checkpoint: calls.append(('stop', r['id']))
        def apply(path, value): calls.append(('route',)); e.atomic_json(path, value)
        with patch.object(e, 'verify_live_routing'), patch.object(e, 'probe_warp', return_value=self.proof), patch.object(e, 'apply_routing', side_effect=apply):
            result = self.manager.delete(a['id'])
        self.assertEqual(calls, [('route',), ('stop', a['id'])])
        self.assertEqual([x['id'] for x in result['exits']], [b['id']])
        self.assertTrue(result['exits'][0]['ready'])

    def test_container_loss_does_not_erase_an_unconfirmed_registration(self):
        runtime = e.ContainerRuntime()
        r = pool_record()
        with patch.object(runtime, 'inspect', return_value=None):
            with self.assertRaisesRegex(e.EgressError, 'registration volume'):
                runtime.delete(r)
            r['registration_deleted'] = True
            runtime.delete(r)

    def test_saved_route_without_live_rule_is_not_healthy(self):
        r = pool_record(); self.install(r)
        with patch.object(e, 'controller', return_value={'rules': []}), patch.object(e, 'probe_warp') as probe:
            status = self.manager.status(check=True)
        self.assertFalse(status['exits'][0]['ready'])
        self.assertIn('Live routing', status['exits'][0]['error'])
        probe.assert_not_called()

    def test_legacy_migration_preserves_credential_and_does_not_rewrite_on_read(self):
        original = record(); e.atomic_json(self.manager.state_path, original)
        before = self.manager.state_path.read_bytes()
        pool = self.manager.load()
        self.assertEqual(pool['exits'][0]['id'], 'legacy')
        self.assertEqual(pool['exits'][0]['uuid'], original['uuid'])
        self.assertEqual(e.routing_candidate(configuration(), pool['exits'][0], True),
                         e.routing_candidate(configuration(), original, True))
        self.assertEqual(self.manager.state_path.read_bytes(), before)


class MagpieTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.adapter = Magpie(self.path / 'env', self.path / 'providers.json')
        self.adapter.env_path.write_text('MAGPIE_WEB_KEY=not-returned-secret-key\nMAGPIE_WEB_URL=https://models.example.com:2053\n')
        self.saved = {'id': 'relay', 'name': 'Relay', 'key': 'top-secret-key-one',
                      'keys': [{'key': 'top-secret-key-two'}], 'chat': 'https://example.com/v1',
                      'headers': {'Authorization': 'secret-header'}, 'models': ['model-a'],
                      'accountProxies': {'firstkey': 'http://u:password@external.example:8080'},
                      'maxConcurrency': 4, 'extraBody': {'stream_options': {'include_usage': True}}}
        self.raw = {'providers': [self.saved], 'groups': [{'id': 'untouched'}]}
        e.atomic_json(self.adapter.providers_path, self.raw)
        self.live = {'id': 'relay', 'name': 'Relay', 'keyList': [
            {'id': 'firstkey', 'name': 'One', 'masked': 'sk-…one', 'on': True},
            {'id': 'secondkey', 'name': 'Two', 'masked': 'sk-…two', 'on': True}],
            'accountProxies': copy.deepcopy(self.saved['accountProxies'])}
        self.posted = []
        def api(route, payload=None):
            if payload is not None:
                self.posted.append(copy.deepcopy(payload))
                self.raw['providers'][0] = copy.deepcopy(payload)
                e.atomic_json(self.adapter.providers_path, self.raw)
                self.live['accountProxies'] = copy.deepcopy(payload['accountProxies'])
            return {'providers': [copy.deepcopy(self.live)]}
        self.adapter.api = Mock(side_effect=api)
        self.exit = pool_record()

    def test_projection_never_returns_keys_headers_proxy_password_or_web_secret(self):
        view = self.adapter.view([self.exit])
        encoded = json.dumps(view)
        for secret in ['top-secret', 'secret-header', 'password', 'not-returned-secret', 'external.example']:
            self.assertNotIn(secret, encoded)
        self.assertEqual(view['providers'][0]['targets'][0]['selection'], 'external')
        self.assertEqual(view['providers'][0]['targets'][1]['selection'], 'inherit')

    def test_binding_one_key_preserves_other_keys_and_provider_configuration(self):
        self.adapter.bind('relay', 'secondkey', self.exit['id'], self.adapter.revision(self.saved), [self.exit], Mock())
        expected = copy.deepcopy(self.saved)
        expected['accountProxies']['secondkey'] = 'http://127.0.0.1:41001'
        self.assertEqual(self.posted, [expected])
        self.assertEqual(self.adapter.raw()['groups'], [{'id': 'untouched'}])
        view = self.adapter.view([self.exit])
        self.assertEqual(view['providers'][0]['targets'][1]['effective_exit'], self.exit['id'])
        self.adapter.bind('relay', 'secondkey', 'direct', view['providers'][0]['revision'], [self.exit], Mock())
        self.assertEqual(self.adapter.raw()['providers'][0]['accountProxies']['secondkey'], 'direct')
        self.assertEqual(self.adapter.raw()['providers'][0]['accountProxies']['firstkey'], self.saved['accountProxies']['firstkey'])

    def test_concurrent_settings_change_or_missing_key_is_rejected_before_write(self):
        for ref, revision in [('secondkey', 'old-revision'), ('removed-key', self.adapter.revision(self.saved))]:
            with self.assertRaises(MagpieError):
                self.adapter.bind('relay', ref, 'direct', revision, [self.exit], Mock())
        self.assertEqual(self.posted, [])

    def test_delete_guard_includes_hidden_overrides_and_provider_default(self):
        self.raw['providers'][0]['accountProxies']['removed-key'] = 'http://127.0.0.1:41001'
        self.raw['providers'][0]['proxy'] = 'socks5://127.0.0.1:41001'
        e.atomic_json(self.adapter.providers_path, self.raw)
        self.assertEqual(self.adapter.references(self.exit), ['relay/provider', 'relay/removed-key'])

    def test_single_subscription_account_is_addressable_and_normalized(self):
        p = {'id': 'claude', 'account': {'user': 'User@Example.com'}}
        self.assertEqual(list(self.adapter.targets(p)), [('user@example.com', 'User@Example.com', 'account', True)])

    def test_localhost_upstream_cannot_claim_a_warp_binding(self):
        self.live['chat'] = 'http://127.0.0.1:3000/v1'
        self.assertTrue(self.adapter.view([self.exit])['providers'][0]['warning'])
        with self.assertRaisesRegex(MagpieError, 'localhost'):
            self.adapter.bind('relay', 'secondkey', self.exit['id'], self.adapter.revision(self.saved), [self.exit], Mock())
        self.assertFalse(self.posted)


if __name__ == '__main__':
    unittest.main()
