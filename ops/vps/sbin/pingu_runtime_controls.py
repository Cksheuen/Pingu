#!/usr/bin/env python3
"""Hot switches for Pingu VPS optional policies. Preview by default; --apply writes.

Does not change listeners, credentials, TLS, SSH or the system default route.
Only the app-owned proxy rules, one scoped nft rule and quota timer are managed.
"""
import argparse
import copy
import datetime
import fcntl
import http.client
import ipaddress
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile

CONFIG_PATH = Path('/etc/mihomo/config.json')
STATE_KEY = 'pingu-runtime-controls'
LOCK_PATH = '/run/pingu-runtime-controls.lock'
BACKUP_ROOT = Path('/var/lib/pingu-runtime-controls')
BYPASS = 'pingu runtime source guard off'
FILTERS = ['GEOIP,private,REJECT', 'GEOSITE,cn,REJECT', r'DOMAIN-REGEX,.*\.cn$,REJECT', 'GEOIP,cn,REJECT']
FIELDS = ('warp', 'source_guard', 'destination_filter', 'traffic_guard')

class ControlError(Exception):
    pass

def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30, **kwargs)
    if result.returncode:
        # Never expose config-validation output: it can contain node credentials.
        raise ControlError('Command failed: ' + ' '.join(argv[:3]))
    return result.stdout

def atomic_write(path, content):
    path = Path(path)
    fd, tmp = tempfile.mkstemp(prefix='.pingu-controls-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def nft_rules():
    value = json.loads(run(['nft', '-j', '-a', 'list', 'chain', 'inet', 'pingu_guard', 'input']))
    return [item['rule'] for item in value.get('nftables', []) if 'rule' in item]

def source_guard_enabled():
    return not any(rule.get('comment') == BYPASS for rule in nft_rules())

def set_source_guard(enabled):
    owned = [rule for rule in nft_rules() if rule.get('comment') == BYPASS]
    commands = ['delete rule inet pingu_guard input handle {}'.format(int(rule['handle'])) for rule in owned]
    if not enabled:
        # UUID/Reality authentication remains in the proxy protocol. This bypass
        # owns only source-IP/ban checks for the single Reality port.
        commands.append('insert rule inet pingu_guard input tcp dport 8443 counter accept comment "{}"'.format(BYPASS))
    if commands:
        script = '\n'.join(commands) + '\n'
        run(['nft', '-c', '-f', '-'], input=script)
        run(['nft', '-f', '-'], input=script)

def timer_state():
    def query(verb):
        return subprocess.run(['systemctl', verb, 'pingu-traffic-guard.timer'], capture_output=True, text=True, timeout=10).stdout.strip()
    return {'active': query('is-active') == 'active', 'enabled': query('is-enabled') == 'enabled'}

def set_traffic_guard(enabled):
    if enabled:
        run(['systemctl', 'enable', '--now', 'pingu-traffic-guard.timer'])
    else:
        # Stop an in-flight one-shot as well, so it cannot stop the proxy after
        # the user has disabled enforcement. The proxy itself is never stopped.
        run(['systemctl', 'stop', 'pingu-traffic-guard.timer', 'pingu-traffic-guard.service'])
        run(['systemctl', 'disable', 'pingu-traffic-guard.timer'])

def controller(config, method, path, body=None):
    if config.get('external-controller') != '127.0.0.1:19090' or len(config.get('secret', '')) < 32:
        raise ControlError('Unexpected controller address or missing credential')
    connection = http.client.HTTPConnection('127.0.0.1', 19090, timeout=15)
    try:
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
            headers={'Authorization': 'Bearer ' + config['secret'], 'Content-Type': 'application/json'})
        response = connection.getresponse()
        content = response.read(1024 * 1024)
        if response.status not in (200, 204): raise ControlError('Controller rejected update: HTTP {}'.format(response.status))
        return json.loads(content) if content else {}
    finally:
        connection.close()

def live_policy(config):
    rules = controller(config, 'GET', '/rules').get('rules', [])
    match = [r for r in rules if str(r.get('type', '')).lower() == 'match']
    if len(match) != 1 or match[0].get('proxy') not in ('direct', 'WARP'):
        raise ControlError('Unrecognized live final route')
    rejected = [r for r in rules if r.get('proxy') == 'REJECT']
    if len(rejected) not in (0, len(FILTERS)):
        raise ControlError('Unrecognized live destination filter')
    return {'warp': match[0]['proxy'] == 'WARP', 'destination_filter': bool(rejected)}

def observe(config):
    timer = timer_state()
    rules = config.get('rules', [])
    present = [rule for rule in FILTERS if rule in rules]
    if present and len(present) != len(FILTERS): raise ControlError('Destination filter is partially configured; inspect before switching')
    live = live_policy(config)
    if live['destination_filter'] != bool(present): raise ControlError('Saved and live destination policies differ')
    return {**live, 'source_guard': source_guard_enabled(), 'traffic_guard': timer['active'],
            'traffic_guard_boot_enabled': timer['enabled']}

def validate_contract(config):
    if config.get('mode') != 'rule': raise ControlError('Only rule mode is supported')
    reality = [x for x in config.get('listeners', []) if x.get('reality-config') and x.get('port') == 8443]
    if len(reality) != 1: raise ControlError('Expected the existing Reality listener on 8443')
    if not any(p.get('name') == 'direct' and p.get('type') == 'direct' for p in config.get('proxies', [])):
        raise ControlError('Missing original direct outbound')
    rules = config.get('rules', [])
    matches = [r for r in rules if r.startswith(('MATCH,', 'FINAL,'))]
    if len(matches) != 1 or rules[-1] not in ('MATCH,WARP', 'MATCH,direct'):
        raise ControlError('Unexpected final route; refusing to overwrite custom routing')
    if any(rule not in FILTERS + ['NETWORK,UDP,direct', 'MATCH,WARP', 'MATCH,direct'] for rule in rules):
        raise ControlError('Unknown routing policy; refusing to replace unrelated rules')

def candidate(config, settings):
    validate_contract(config)
    if set(settings) != set(FIELDS) or any(type(v) is not bool for v in settings.values()):
        raise ControlError('Invalid switch values')
    result = copy.deepcopy(config)
    if settings['warp']:
        warp = next((p for p in result['proxies'] if p.get('name') == 'WARP'), {})
        if (warp.get('type'), warp.get('server'), warp.get('port'), warp.get('udp')) != ('socks5', '127.0.0.1', 40000, False):
            raise ControlError('WARP loopback proxy is not configured')
    result['rules'] = (list(FILTERS) if settings['destination_filter'] else []) + ['NETWORK,UDP,direct', 'MATCH,' + ('WARP' if settings['warp'] else 'direct')]
    result[STATE_KEY] = dict(settings)
    return result

def check_warp_ready():
    """Probe the dedicated loopback outbound before changing any live route."""
    body = run(['curl', '--silent', '--show-error', '--fail',
                '--proxy', 'socks5h://127.0.0.1:40000', '--noproxy', '',
                '--connect-timeout', '3', '--max-time', '8', '--max-filesize', '16384',
                'https://www.cloudflare.com/cdn-cgi/trace'])
    fields = dict(line.split('=', 1) for line in body.splitlines() if '=' in line)
    if fields.get('warp') != 'on':
        raise ControlError('WARP did not pass the egress check; current route retained')
    try:
        ipaddress.ip_address(fields.get('ip', ''))
    except ValueError:
        raise ControlError('WARP returned an invalid egress check; current route retained') from None


def pids():
    return {name: int(run(['systemctl','show',name,'--property=MainPID','--value']).strip()) for name in ['mihomo','pingu-gate']}

def rollback(config, old_text, config_path, before, old_timer, touched):
    """Attempt every owned restoration even when the controller is unavailable."""
    failures = []
    def restore(name, action):
        try:
            action()
        except Exception:
            failures.append(name)
    if 'config' in touched:
        restore('configuration', lambda: atomic_write(config_path, old_text))
    if 'routing' in touched:
        restore('routing', lambda: controller(config, 'PUT', '/configs?force=true', {'path': str(config_path)}))
    if 'source_guard' in touched:
        restore('source_guard', lambda: set_source_guard(before['source_guard']))
    if 'traffic_guard' in touched:
        # Activity and boot enablement are independent. Restore both, including
        # disabled-but-active and enabled-but-inactive states.
        restore('quota_activity', lambda: run(['systemctl', 'start' if old_timer['active'] else 'stop', 'pingu-traffic-guard.timer']))
        restore('quota_boot', lambda: run(['systemctl', 'enable' if old_timer['enabled'] else 'disable', 'pingu-traffic-guard.timer']))
    return failures


def apply(config, settings, config_path=CONFIG_PATH):
    old_text = Path(config_path).read_text()
    if json.loads(old_text) != config: raise ControlError('Configuration changed; retry')
    before = observe(config)
    old_timer = timer_state()
    old_pids = pids()
    if not all(old_pids.values()): raise ControlError('Proxy and Gate must be running for a hot switch')
    updated = candidate(config, settings)
    if settings['warp'] and not before['warp']:
        check_warp_ready()
    routing_changed = updated['rules'] != config['rules']
    source_changed = before['source_guard'] != settings['source_guard']
    traffic_changed = any(old_timer[k] != settings['traffic_guard'] for k in ('active', 'enabled'))
    changed = []
    if routing_changed: changed.append('routing')
    if source_changed: changed.append('source_guard')
    if traffic_changed: changed.append('traffic_guard')
    if config == updated and not changed:
        return {'applied': True, 'changed': False, 'state': before, 'pids': old_pids, 'restarted': False, 'components_changed': []}
    path = Path(config_path).parent / '.pingu-controls-candidate.json'
    try:
        if routing_changed:
            atomic_write(path, json.dumps(updated, indent=2) + '\n')
            run(['/usr/local/bin/mihomo', '-t', '-d', str(Path(config_path).parent), '-f', str(path)])
        backup_dir = BACKUP_ROOT / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup_dir.mkdir(parents=True, mode=0o700)
        atomic_write(backup_dir / 'config.before.json', old_text)
        atomic_write(backup_dir / 'state.before.json', json.dumps(before))
        touched = set()
        try:
            if Path(config_path).read_text() != old_text: raise ControlError('Concurrent configuration change')
            if traffic_changed and not settings['traffic_guard']:
                touched.add('traffic_guard')
                set_traffic_guard(False)
            touched.add('config')
            atomic_write(config_path, json.dumps(updated, indent=2) + '\n')
            if routing_changed:
                touched.add('routing')
                controller(updated, 'PUT', '/configs?force=true', {'path': str(config_path)})
            if source_changed:
                touched.add('source_guard')
                set_source_guard(settings['source_guard'])
            if traffic_changed and settings['traffic_guard']:
                touched.add('traffic_guard')
                set_traffic_guard(True)
            after = observe(updated)
            if any(after[k] != settings[k] for k in FIELDS) or after['traffic_guard_boot_enabled'] != settings['traffic_guard']:
                raise ControlError('Live switch verification failed')
            if pids() != old_pids: raise ControlError('Unexpected service PID change during hot switch')
            return {'applied': True, 'changed': True, 'components_changed': changed, 'state': after,
                    'pids': old_pids, 'restarted': False, 'backup': str(backup_dir),
                    'connections': 'New connections use the new route; existing streams keep their route until closed.'}
        except BaseException as error:
            failures = rollback(config, old_text, config_path, before, old_timer, touched)
            if failures:
                raise ControlError('Rollback incomplete for {}; private snapshot: {}'.format(', '.join(failures), backup_dir)) from None
            if isinstance(error, ControlError): raise
            raise ControlError('Update failed; previous state restored') from None
    finally:
        path.unlink(missing_ok=True)

def reconnect_old_warp(config, do_apply=False):
    if live_policy(config)['warp']:
        raise ControlError('Disable WARP before reconnecting its old streams')
    rows = controller(config, 'GET', '/connections').get('connections', []) or []
    ids = [row['id'] for row in rows if 'WARP' in row.get('chains', [])
           and isinstance(row.get('id'), str) and re.fullmatch(r'[A-Za-z0-9-]{1,128}', row['id'])]
    if do_apply:
        for connection_id in ids: controller(config, 'DELETE', '/connections/' + connection_id)
    return {'applied': do_apply, 'affected_warp_connections': len(ids), 'restarted': False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['status', 'set', 'off', 'restore', 'reconcile', 'reconnect'])
    for flag in FIELDS: parser.add_argument('--' + flag.replace('_','-'), choices=['on','off'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        with open(LOCK_PATH, 'a') as lock:
            os.chmod(LOCK_PATH, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            config = json.loads(CONFIG_PATH.read_text())
            if args.command == 'reconcile':
                # This boot hook only needs nftables and the saved policy. It
                # must not race the proxy controller becoming ready at startup.
                saved = config.get(STATE_KEY)
                if not saved: print(json.dumps({'applied': False, 'reason': 'No saved controls'})); return
                if type(saved.get('source_guard')) is not bool: raise ControlError('Invalid saved source guard')
                if args.apply: set_source_guard(saved['source_guard'])
                print(json.dumps({'applied': args.apply, 'source_guard': saved['source_guard']})); return
            state = observe(config)
            if args.command == 'status':
                print(json.dumps({'state': state, 'saved': config.get(STATE_KEY), 'pids': pids()}, indent=2)); return
            if args.command == 'reconnect':
                print(json.dumps(reconnect_old_warp(config, args.apply), indent=2)); return
            settings = {k: state[k] for k in FIELDS}
            if args.command == 'off': settings = {k: False for k in FIELDS}
            elif args.command == 'restore': settings = {k: True for k in FIELDS}
            for key in FIELDS:
                if getattr(args, key) is not None: settings[key] = getattr(args, key) == 'on'
            candidate(config, settings)
            result = apply(config, settings) if args.apply else {'applied': False, 'current': state, 'requested': settings}
            print(json.dumps(result, indent=2))
    except ControlError as error:
        print('Runtime switch failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Runtime switch failed; inspect service state and the private rollback snapshot. No credentials are included in this error.', file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__': main()
