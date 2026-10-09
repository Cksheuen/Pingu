import copy
from contextlib import ExitStack
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from ops.vps.sbin import pingu_runtime_controls as controls


def config():
    return {'mode':'rule','secret':'test-only-secret-which-is-not-a-real-credential',
        'external-controller':'127.0.0.1:19090',
        'listeners':[{'port':8443,'reality-config':{'private-key':'test-only'},'users':[{'uuid':'test-only'}]}],
        'proxies':[{'name':'direct','type':'direct','interface-name':'eth0'},
                   {'name':'WARP','type':'socks5','server':'127.0.0.1','port':40000,'udp':False}],
        'rules':controls.FILTERS+['NETWORK,UDP,direct','MATCH,WARP']}


class RuntimeControlsTests(unittest.TestCase):
    def test_off_and_on_preserve_identity_and_have_explicit_udp_route(self):
        original=config(); before=copy.deepcopy(original)
        disabled=controls.candidate(original,{k:False for k in controls.FIELDS})
        self.assertEqual(disabled['rules'],['NETWORK,UDP,direct','MATCH,direct'])
        self.assertEqual(disabled['listeners'],original['listeners'])
        self.assertEqual(disabled['secret'],original['secret'])
        enabled=controls.candidate(disabled,{k:True for k in controls.FIELDS})
        self.assertEqual(enabled['rules'],original['rules'])
        self.assertEqual(original,before)

    def test_unknown_policy_and_wrong_warp_are_not_silently_overwritten(self):
        c=config();c['rules'].insert(0,'DOMAIN,work.example,direct')
        with self.assertRaises(controls.ControlError):controls.candidate(c,{k:False for k in controls.FIELDS})
        c=config();c['proxies'][1]['server']='remote.example'
        with self.assertRaises(controls.ControlError):controls.candidate(c,{k:True for k in controls.FIELDS})

    def test_source_switch_changes_only_owned_rule_and_is_atomic(self):
        with mock.patch.object(controls,'nft_rules',return_value=[{'handle':12,'comment':'keep this'},{'handle':18,'comment':controls.BYPASS}]),mock.patch.object(controls,'run') as run:
            controls.set_source_guard(True)
            self.assertEqual(run.call_count,2)
            self.assertEqual(run.call_args.kwargs['input'],'delete rule inet pingu_guard input handle 18\n')
        with mock.patch.object(controls,'nft_rules',return_value=[]),mock.patch.object(controls,'run') as run:
            controls.set_source_guard(False)
            self.assertIn('tcp dport 8443 counter accept',run.call_args.kwargs['input'])
            self.assertNotIn('tcp dport 443 ',run.call_args.kwargs['input'])
            self.assertNotIn('flush',run.call_args.kwargs['input'])

    def test_traffic_switch_never_stops_or_restarts_proxy(self):
        with mock.patch.object(controls,'run') as run:
            controls.set_traffic_guard(False);controls.set_traffic_guard(True)
            commands=[c.args[0] for c in run.call_args_list]
            self.assertFalse(any('mihomo' in c or 'pingu-gate' in c or 'restart' in c for c in commands))
            self.assertIn(['systemctl','enable','--now','pingu-traffic-guard.timer'],commands)

    def apply_fixture(self, source, settings, directory, stack):
        path=Path(directory)/'config.json';path.write_text(json.dumps(source))
        before={**{k:True for k in controls.FIELDS},'traffic_guard_boot_enabled':True}
        after={**settings,'traffic_guard_boot_enabled':settings['traffic_guard']}
        stack.enter_context(mock.patch.object(controls,'BACKUP_ROOT',Path(directory)/'backups'))
        observed=stack.enter_context(mock.patch.object(controls,'observe',side_effect=[before,after]))
        stack.enter_context(mock.patch.object(controls,'timer_state',return_value={'enabled':True,'active':True}))
        stack.enter_context(mock.patch.object(controls,'pids',return_value={'mihomo':1,'pingu-gate':2}))
        mocks={name:stack.enter_context(mock.patch.object(controls,name)) for name in ('run','controller','set_source_guard','set_traffic_guard','check_warp_ready')}
        return path,mocks,observed

    def test_source_only_switch_does_not_reload_proxy_or_touch_quota(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            c=config();settings={k:True for k in controls.FIELDS};settings['source_guard']=False
            path,mocks,_=self.apply_fixture(c,settings,tmp,stack)
            result=controls.apply(c,settings,path)
            self.assertEqual(result['components_changed'],['source_guard'])
            mocks['controller'].assert_not_called()
            mocks['run'].assert_not_called()
            mocks['set_traffic_guard'].assert_not_called()
            mocks['set_source_guard'].assert_called_once_with(False)
            self.assertEqual(json.loads(path.read_text())[controls.STATE_KEY],settings)

    def test_quota_only_switch_does_not_reload_proxy_or_touch_firewall(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            c=config();settings={k:True for k in controls.FIELDS};settings['traffic_guard']=False
            path,mocks,_=self.apply_fixture(c,settings,tmp,stack)
            controls.apply(c,settings,path)
            mocks['controller'].assert_not_called()
            mocks['set_source_guard'].assert_not_called()
            mocks['set_traffic_guard'].assert_called_once_with(False)

    def test_repeat_request_has_no_mutation_or_backup(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            c=config();settings={k:True for k in controls.FIELDS};c[controls.STATE_KEY]=settings
            path,mocks,_=self.apply_fixture(c,settings,tmp,stack)
            before=path.read_bytes()
            self.assertFalse(controls.apply(c,settings,path)['changed'])
            self.assertEqual(before,path.read_bytes())
            self.assertFalse((Path(tmp)/'backups').exists())
            for action in mocks.values():action.assert_not_called()

    def test_failed_hot_update_restores_only_touched_components(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            c=config();settings={k:False for k in controls.FIELDS}
            path,mocks,_=self.apply_fixture(c,settings,tmp,stack);before=path.read_bytes()
            mocks['controller'].side_effect=[controls.ControlError('rejected'),{}]
            with self.assertRaises(controls.ControlError):controls.apply(c,settings,path)
            self.assertEqual(path.read_bytes(),before)
            mocks['set_source_guard'].assert_not_called()
            self.assertEqual(mocks['controller'].call_count,2)
            mocks['run'].assert_any_call(['systemctl','start','pingu-traffic-guard.timer'])
            mocks['run'].assert_any_call(['systemctl','enable','pingu-traffic-guard.timer'])

    def test_controller_rollback_failure_still_restores_firewall_and_timer(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            c=config();settings={k:False for k in controls.FIELDS}
            path,mocks,_=self.apply_fixture(c,settings,tmp,stack);before=path.read_bytes()
            mocks['controller'].side_effect=[{},controls.ControlError('offline')]
            mocks['set_source_guard'].side_effect=[controls.ControlError('nft failure'),None]
            with self.assertRaisesRegex(controls.ControlError,'Rollback incomplete for routing'):
                controls.apply(c,settings,path)
            self.assertEqual(path.read_bytes(),before)
            mocks['set_source_guard'].assert_called_with(True)
            mocks['run'].assert_any_call(['systemctl','start','pingu-traffic-guard.timer'])
            mocks['run'].assert_any_call(['systemctl','enable','pingu-traffic-guard.timer'])

    def test_unavailable_warp_is_rejected_before_any_live_mutation(self):
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            old_settings={k:False for k in controls.FIELDS};c=controls.candidate(config(),old_settings)
            settings={**old_settings,'warp':True}
            path,mocks,observed=self.apply_fixture(c,settings,tmp,stack)
            observed.side_effect=[{**old_settings,'traffic_guard_boot_enabled':False}]
            before=path.read_bytes()
            mocks['check_warp_ready'].side_effect=controls.ControlError('unreachable')
            with self.assertRaises(controls.ControlError):controls.apply(c,settings,path)
            self.assertEqual(path.read_bytes(),before)
            for name in ('controller','set_source_guard','set_traffic_guard'):mocks[name].assert_not_called()
            self.assertFalse((Path(tmp)/'backups').exists())

    def test_readiness_requires_a_real_warp_egress(self):
        with mock.patch.object(controls,'run',return_value='warp=off\nip=192.0.2.1\n'):
            with self.assertRaises(controls.ControlError):controls.check_warp_ready()
        with mock.patch.object(controls,'run',return_value='warp=on\nip=not-an-ip\n'):
            with self.assertRaises(controls.ControlError):controls.check_warp_ready()
        with mock.patch.object(controls,'run',return_value='warp=on\nip=192.0.2.1\n'):
            controls.check_warp_ready()

    def test_reconnect_closes_only_existing_warp_connections(self):
        rows={'connections':[{'id':'warp-1','chains':['WARP']},{'id':'direct-1','chains':['direct']},{'id':'../../configs','chains':['WARP']}]}
        with mock.patch.object(controls,'live_policy',return_value={'warp':False}),mock.patch.object(controls,'controller',return_value=rows) as api:
            preview=controls.reconnect_old_warp(config())
            self.assertEqual(preview['affected_warp_connections'],1)
            self.assertEqual(api.call_count,1)
            controls.reconnect_old_warp(config(),True)
            api.assert_called_with(config(),'DELETE','/connections/warp-1')

if __name__=='__main__':unittest.main()
