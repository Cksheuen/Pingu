#!/usr/bin/env python3
"""SSH-only shared WARP pool, with per-client and Magpie account routing.

Reads one bounded JSON request from stdin; never opens an administration port.
The existing VLESS identities, Gate, public listeners and default route remain
owned by their existing services. A separate VLESS identity selects WARP.
"""
from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
import re
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

CONFIG = Path('/etc/mihomo/config.json')
STATE = Path('/var/lib/pingu-egress/state.json')
USER = 'pingu-cloudflare-egress'
OUTBOUND = 'Pingu Cloudflare Egress'
WARP_PORT = 40000
RULES = [f'AND,((IN-USER,{USER}),(NETWORK,UDP)),REJECT', f'IN-USER,{USER},{OUTBOUND}']


class EgressError(ValueError):
    pass


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.pingu-egress-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(args, timeout=20, required=True):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired):
        raise EgressError(f'{Path(args[0]).name} did not complete') from None
    if required and result.returncode:
        # Vendor output may include registration material; do not echo it.
        raise EgressError(f'{Path(args[0]).name} operation failed')
    return result


def warp(*args, required=True):
    return run(['warp-cli', '--accept-tos', *args], required=required)


def registration():
    result = warp('registration', 'show', required=False)
    if result.returncode == 0:
        return hashlib.sha256(result.stdout.strip().encode()).hexdigest()
    message = (result.stdout + result.stderr).lower()
    if 'missing registration' in message or 'not registered' in message:
        return None
    raise EgressError('WARP registration status is unavailable; no registration was changed')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def controller(config, route, payload=None):
    address = config.get('external-controller', '')
    try:
        host, port = address.rsplit(':', 1)
        if not ipaddress.ip_address(host.strip('[]')).is_loopback or not 0 < int(port) < 65536:
            raise ValueError()
        secret = config['secret']
        if not isinstance(secret, str) or len(secret) < 16:
            raise ValueError()
    except (ValueError, KeyError):
        raise EgressError('A protected loopback Mihomo controller is required') from None
    data = None if payload is None else json.dumps({'payload': json.dumps(payload)}).encode()
    request = urllib.request.Request('http://' + address + route, data=data,
        method='GET' if payload is None else 'PUT',
        headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=40) as response:
            body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError()
        return json.loads(body) if body else {}
    except (OSError, ValueError):
        raise EgressError('Mihomo did not acknowledge the routing update') from None


def routing_names(record):
    if record.get('runtime') == 'legacy' or not record.get('id'):
        return USER, OUTBOUND, WARP_PORT
    return 'pingu-warp-' + record['id'], 'Pingu WARP ' + record['id'], record['port']


def routing_rules(record):
    user, outbound, _ = routing_names(record)
    return [f'AND,((IN-USER,{user}),(NETWORK,UDP)),REJECT', f'IN-USER,{user},{outbound}']


def routing_candidate(config, record, enabled):
    """Own only our exact user, two rules and SOCKS outbound; never the default."""
    user_name, outbound_name, port = routing_names(record)
    rules_owned = routing_rules(record)
    result = copy.deepcopy(config)
    if config.get('mode', 'rule') != 'rule':
        raise EgressError('The VPS must use rule mode')
    listeners = [x for x in result.get('listeners', []) if x.get('type') == 'vless']
    if not listeners:
        raise EgressError('No VLESS listener is available')
    for listener in listeners:
        users = listener.get('users', [])
        if not users or not isinstance(users, list):
            raise EgressError('VLESS listener has no existing users')
        for user in users:
            if user.get('username') == user_name and user.get('uuid') != record['uuid']:
                raise EgressError('An unrelated user occupies the egress identity')
            if user.get('uuid') == record['uuid'] and user.get('username') != user_name:
                raise EgressError('An unrelated user occupies the egress credential')
        old_index = next((i for i, u in enumerate(users) if u.get('username') == user_name), len(users))
        listener['users'] = [u for u in users if u.get('username') != user_name]
        if not listener['users']:
            raise EgressError('Refusing to remove the last original VLESS user')
        if enabled:
            user = {'username': user_name, 'uuid': record['uuid']}
            if listener.get('reality-config'):
                user['flow'] = 'xtls-rprx-vision'
            listener['users'].insert(old_index, user)
    outbound = {'name': outbound_name, 'type': 'socks5', 'server': '127.0.0.1',
                'port': port, 'udp': False}
    for proxy in result.get('proxies', []):
        if proxy.get('name') == outbound_name and proxy != outbound:
            raise EgressError('An unrelated outbound occupies the egress name')
    all_proxies = result.get('proxies', [])
    old_index = next((i for i, p in enumerate(all_proxies) if p.get('name') == outbound_name), len(all_proxies))
    proxies = [p for p in all_proxies if p.get('name') != outbound_name]
    if enabled:
        proxies.insert(old_index, outbound)
    result['proxies'] = proxies
    rules = result.get('rules', [])
    if any(user_name in r and r not in rules_owned for r in rules):
        raise EgressError('Custom routing references the managed egress identity')
    # A named listener proxy bypasses IN-USER rules entirely.
    if enabled and any(l.get('proxy') or l.get('rule') for l in listeners):
        raise EgressError('VLESS listeners with custom proxy/sub-rule routing are not supported')
    original_rules = [r for r in rules if r not in rules_owned]
    if enabled:
        finals = [i for i, rule in enumerate(original_rules) if rule.startswith(('MATCH,', 'FINAL,'))]
        if finals != [len(original_rules) - 1]:
            raise EgressError('Expected one final default rule; custom routing was retained')
        # Existing destination filters retain precedence over the WARP route.
        # Reject this identity's UDP first so an old NETWORK,UDP,DIRECT rule
        # cannot accidentally bypass the TCP-only egress contract.
        if all(r in rules for r in rules_owned):
            result['rules'] = rules
        else:
            result['rules'] = [rules_owned[0]] + original_rules[:-1] + [rules_owned[1], original_rules[-1]]
    else:
        result['rules'] = original_rules
    return result


def validate(config, config_home=Path('/etc/mihomo')):
    binary = shutil.which('mihomo') or '/usr/local/bin/mihomo'
    with tempfile.TemporaryDirectory(prefix='pingu-egress-check-') as directory:
        path = Path(directory) / 'config.json'
        atomic_json(path, config)
        run([binary, '-t', '-d', str(config_home), '-f', str(path)], timeout=30)


def apply_routing(path, candidate):
    """Reload in place; a failed write/readback also rolls back live routing."""
    before_bytes = path.read_bytes()
    before = json.loads(before_bytes)
    if candidate == before:
        verify_live_routing(before, candidate)
        return
    validate(candidate, path.parent)
    if path.read_bytes() != before_bytes:
        raise EgressError('VPS routing changed during validation; retry')
    try:
        # No force flag: retain the public listeners and running connections.
        controller(before, '/configs', candidate)
        verify_live_routing(before, candidate)
        if path.read_bytes() != before_bytes:
            raise EgressError('VPS routing changed while applying the egress')
        atomic_json(path, candidate)
    except Exception as error:
        try:
            controller(before, '/configs', before)
        except Exception:
            raise EgressError('Egress update failed and live rollback could not be confirmed') from None
        if isinstance(error, EgressError):
            raise error
        raise EgressError('Egress update failed; the previous routing was restored') from None


def verify_live_routing(config, candidate):
    live = controller(config, '/rules').get('rules', [])
    expected = {}
    for rule in candidate.get('rules', []):
        bits = rule.split(',')
        if len(bits) == 3 and bits[0] == 'IN-USER' and (bits[1] == USER or bits[1].startswith('pingu-warp-')):
            expected[bits[1]] = bits[2]
    actual = {r.get('payload'): r.get('proxy') for r in live if r.get('type') == 'InUser'
              and (r.get('payload') == USER or r.get('payload', '').startswith('pingu-warp-'))}
    if actual != expected:
        raise EgressError('Live routing did not match the requested egress pool')
    for user in expected:
        if not any(r.get('type') == 'AND' and r.get('proxy') == 'REJECT'
                   and user in r.get('payload', '') and 'udp' in r.get('payload', '').lower()
                   for r in live[:len(expected)]):
            raise EgressError('Live routing did not retain the Cloudflare UDP block')


def probe_warp(port=WARP_PORT, scheme='socks5h'):
    result = run(['curl', '--proxy', f'{scheme}://127.0.0.1:{port}', '--noproxy', '',
        '--silent', '--show-error', '--fail', '--connect-timeout', '3', '--max-time', '10',
        '--max-filesize', '16384', 'https://www.cloudflare.com/cdn-cgi/trace'], timeout=12)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    try:
        address = str(ipaddress.ip_address(fields.get('ip', '')))
    except ValueError:
        raise EgressError('Cloudflare returned an invalid egress address') from None
    if fields.get('warp') != 'on':
        raise EgressError('The candidate does not exit through Cloudflare WARP')
    return {'ip': address, 'location': fields.get('loc', ''), 'checked_at': timestamp()}


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


IMAGE = 'localhost/pingu-warp:1'
LABEL = 'site.pingu.egress'


class ContainerRuntime:
    """One official WARP daemon/registration per isolated Podman container."""
    def installed(self):
        return bool(shutil.which('podman')) and run(
            ['podman', 'image', 'exists', IMAGE], required=False).returncode == 0

    def inspect(self, record):
        name = 'pingu-warp-' + record['id']
        exists = run(['podman', 'container', 'exists', name], required=False)
        if exists.returncode == 1:
            return None
        if exists.returncode != 0:
            raise EgressError('Container ownership could not be checked; no container was changed')
        result = run(['podman', 'container', 'inspect', name])
        try:
            value = json.loads(result.stdout)[0]
            if value['Config']['Labels'].get(LABEL) != record['id']:
                raise ValueError()
            return value
        except (ValueError, KeyError, IndexError, TypeError):
            raise EgressError('A container with this name is not owned by this exit') from None

    def cli(self, record, *args, required=True):
        if not self.inspect(record):
            raise EgressError('The exit container is missing')
        return run(['podman', 'exec', 'pingu-warp-' + record['id'],
                    'warp-cli', '--accept-tos', *args], required=required,
                   timeout=90 if args[:2] == ('registration', 'new') else 45 if args[:2] == ('registration', 'delete') else 20)

    def create(self, record, directory, checkpoint=lambda: None):
        info = self.inspect(record)
        name = 'pingu-warp-' + record['id']
        if info is None:
            memory = Path('/proc/meminfo').read_text()
            available = re.search(r'^MemAvailable:\s+(\d+)', memory, re.M)
            if not available or int(available[1]) < 384 * 1024:
                raise EgressError('Not enough VPS memory for another WARP instance (384 MiB available required)')
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            # No host networking/privileged mode: NET_ADMIN applies inside its
            # own network namespace. WARP cannot replace the host's routes.
            run(['podman', 'run', '-d', '--pull=never', '--name', name,
                 '--label', LABEL + '=' + record['id'], '--network=bridge',
                 '--cap-add=NET_ADMIN', '--device=/dev/net/tun',
                 '--tmpfs=/run:rw,nosuid,nodev,size=32m',
                 '--security-opt=no-new-privileges', '--memory=256m', '--pids-limit=128',
                 '--restart=always', '--log-driver=none',
                 '-p', f'127.0.0.1:{record["port"]}:40001/tcp',
                 '-v', str(directory) + ':/var/lib/cloudflare-warp:Z', IMAGE], timeout=40)
        elif not info.get('State', {}).get('Running'):
            run(['podman', 'start', name])
        for attempt in range(15):
            status = self.cli(record, 'registration', 'show', required=False)
            if status.returncode == 0:
                record['registration_started'] = True
                checkpoint()
                break
            message = (status.stdout + status.stderr).lower()
            if 'missing registration' in message or 'not registered' in message:
                record['registration_started'] = True
                checkpoint()
                self.cli(record, 'registration', 'new')
                break
            if attempt == 14:
                raise EgressError('The WARP daemon did not become ready')
            time.sleep(1)
        self.cli(record, 'mode', 'proxy')
        self.cli(record, 'proxy', 'port', '40000')
        self.cli(record, 'tunnel', 'protocol', 'set', 'MASQUE')
        self.cli(record, 'connect')

    def check(self, record):
        if record.get('runtime') == 'legacy':
            if registration() != record.get('registration_fingerprint'):
                raise EgressError('Legacy WARP registration ownership changed')
            return
        info = self.inspect(record)
        if info is None or not info.get('State', {}).get('Running'):
            raise EgressError('The WARP container is not running')

    def delete(self, record, checkpoint=lambda: None):
        if record.get('runtime') == 'legacy':
            current = registration()
            if current and current != record.get('registration_fingerprint'):
                raise EgressError('Legacy WARP registration ownership changed')
            if current:
                warp('disconnect')
                warp('registration', 'delete')
            if record.get('service_enabled'):
                run(['systemctl', 'disable', 'warp-svc'])
            if record.get('service_started'):
                run(['systemctl', 'stop', 'warp-svc'])
            return
        info = self.inspect(record)
        if info is None:
            if record.get('registration_deleted') or record.get('registration_started') is False:
                return
            raise EgressError('Exit container is missing; restore it with its saved registration volume before cleanup')
        if not info.get('State', {}).get('Running'):
            run(['podman', 'start', 'pingu-warp-' + record['id']])
        # Do not erase registration files until the remote registration has
        # been deleted. A failed cleanup stays visible and can be retried.
        result = self.cli(record, 'registration', 'show', required=False)
        if result.returncode == 0:
            self.cli(record, 'disconnect')
            self.cli(record, 'registration', 'delete')
        elif not any(x in (result.stdout + result.stderr).lower()
                     for x in ('missing registration', 'not registered')):
            raise EgressError('WARP registration cleanup could not be confirmed')
        record['registration_deleted'] = True
        checkpoint()
        run(['podman', 'rm', '-f', 'pingu-warp-' + record['id']])


def magpie_adapter():
    try:
        from .pingu_magpie import Magpie
    except ImportError:
        from pingu_magpie import Magpie
    return Magpie()


class Manager:
    def __init__(self, state=STATE, config=CONFIG, runtime=None, magpie=None):
        self.state_path, self.config_path = Path(state), Path(config)
        self.runtime = runtime or ContainerRuntime()
        self.magpie = magpie or magpie_adapter()

    def load(self):
        if not self.state_path.exists():
            return {'version': 2, 'exits': []}
        try:
            pool = json.loads(self.state_path.read_text())
            if pool.get('version') == 1:
                pool = {'version': 2, 'exits': [{**pool, 'id': 'legacy',
                    'runtime': 'legacy', 'port': WARP_PORT}]}
            if pool.get('version') != 2 or not isinstance(pool['exits'], list):
                raise ValueError()
            ids, ports, credentials = set(), set(), set()
            for record in pool['exits']:
                uuid.UUID(record['uuid'])
                if not (record['id'] == 'legacy' and record['runtime'] == 'legacy'):
                    uuid.UUID(record['id'])
                    if str(uuid.UUID(record['id'])) != record['id'] or record['runtime'] != 'podman':
                        raise ValueError()
                if record['phase'] not in ('creating', 'ready', 'deleting') or not 1024 <= record['port'] <= 65535:
                    raise ValueError()
                if record['id'] in ids or record['port'] in ports or record['uuid'] in credentials:
                    raise ValueError()
                ids.add(record['id']); ports.add(record['port']); credentials.add(record['uuid'])
            return pool
        except (ValueError, KeyError, TypeError):
            raise EgressError('Egress pool state is invalid; existing services were retained') from None

    def save(self, pool):
        atomic_json(self.state_path, pool)

    def unique_name(self, pool, name, exit_id):
        if any(r['id'] != exit_id and r['name'].strip().casefold() == name.strip().casefold()
               for r in pool['exits']):
            raise EgressError('An exit with this name already exists; choose a different name')

    def find(self, pool, exit_id):
        record = next((r for r in pool['exits'] if r['id'] == exit_id), None)
        if record is None:
            raise EgressError('This exit no longer exists; refresh')
        return record

    def checked(self, record, config, check):
        view = {k: record.get(k) for k in ('id', 'name', 'uuid', 'phase', 'created_at', 'ip', 'location', 'checked_at')}
        view['ready'] = False
        if record['phase'] == 'ready' and check:
            try:
                self.runtime.check(record)
                if routing_candidate(config, record, True) != config:
                    raise EgressError('Managed routing is missing or changed')
                view.update(probe_warp(record['port']))
                view['ready'] = True
            except ValueError as error:
                view['error'] = str(error)
        return view

    def status(self, check=False):
        pool = self.load()
        config = json.loads(self.config_path.read_text())
        routing_error = None
        if check and any(r['phase'] == 'ready' for r in pool['exits']):
            try:
                verify_live_routing(config, config)
            except EgressError as error:
                routing_error = str(error)
        with ThreadPoolExecutor(max_workers=4) as workers:
            exits = list(workers.map(lambda r: self.checked(r, config, check and routing_error is None), pool['exits']))
        if routing_error:
            for exit in exits:
                exit['error'] = routing_error
        try:
            magpie = self.magpie.view(pool['exits'])
        except (OSError, ValueError):
            magpie = {'available': self.magpie.installed, 'providers': [],
                      'error': 'Magpie configuration is unavailable; refresh before changing bindings', 'web_url': None}
        return {'version': 2, 'installed': self.runtime.installed(), 'exits': exits, 'magpie': magpie}

    def create(self, name, exit_id):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
            raise EgressError('Use a name containing 1–60 printable characters')
        try:
            if str(uuid.UUID(exit_id)) != exit_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise EgressError('Use a stable UUID for the exit creation request') from None
        pool = self.load()
        record = next((r for r in pool['exits'] if r['id'] == exit_id), None)
        if record and record['phase'] == 'ready':
            return self.status(check=True)
        if record and record['phase'] == 'deleting':
            raise EgressError('Finish deleting this exit before reusing its ID')
        if not self.runtime.installed():
            raise EgressError('Install the Pingu WARP container runtime on this VPS first')
        if record is None:
            self.unique_name(pool, name, exit_id)
            used = {r['port'] for r in pool['exits']}
            port = None
            for candidate in range(41000, 61000):
                if candidate in used:
                    continue
                try:
                    with socket.socket() as sock:
                        sock.bind(('127.0.0.1', candidate))
                    port = candidate
                    break
                except OSError:
                    continue
            if port is None:
                raise EgressError('No free local exit port is available')
            record = {'id': exit_id, 'uuid': str(uuid.uuid4()), 'name': name.strip(),
                      'runtime': 'podman', 'port': port, 'phase': 'creating', 'created_at': timestamp(),
                      'registration_started': False}
            config = json.loads(self.config_path.read_text())
            validate(routing_candidate(config, record, True), self.config_path.parent)
            pool['exits'].append(record)
            self.save(pool)
        self.runtime.create(record, self.state_path.parent / 'instances' / record['id'], lambda: self.save(pool))
        failure = None
        for attempt in range(5):
            try:
                record.update(probe_warp(record['port']))
                probe_warp(record['port'], scheme='http')
                failure = None
                break
            except EgressError as error:
                failure = error
                if attempt < 4:
                    time.sleep(1)
        if failure:
            raise failure
        config = json.loads(self.config_path.read_text())
        apply_routing(self.config_path, routing_candidate(config, record, True))
        record['phase'] = 'ready'
        self.save(pool)
        return self.status(check=True)

    def rename(self, exit_id, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
            raise EgressError('Use a name containing 1–60 printable characters')
        pool = self.load()
        self.unique_name(pool, name, exit_id)
        self.find(pool, exit_id)['name'] = name.strip()
        self.save(pool)
        return self.status(check=True)

    def delete(self, exit_id):
        pool = self.load()
        if not any(r['id'] == exit_id for r in pool['exits']):
            return self.status(check=True)
        record = self.find(pool, exit_id)
        if self.magpie.references(record):
            raise EgressError('Magpie still uses this exit. Change its account/key bindings before deleting it')
        if record.get('runtime') == 'legacy':
            current = registration()
            if current and current != record.get('registration_fingerprint'):
                raise EgressError('Legacy WARP registration ownership changed')
        record['phase'] = 'deleting'
        self.save(pool)
        config = json.loads(self.config_path.read_text())
        apply_routing(self.config_path, routing_candidate(config, record, False))
        self.runtime.delete(record, lambda: self.save(pool))
        directory = self.state_path.parent / 'instances' / record['id']
        if record['runtime'] == 'podman' and directory.exists():
            shutil.rmtree(directory)
        pool['exits'].remove(record)
        self.save(pool)
        return self.status(check=True)

    def bind(self, request):
        pool = self.load()
        selection = request.get('selection')
        if selection not in ('direct', 'inherit'):
            record = self.find(pool, selection)
            if record['phase'] != 'ready':
                raise EgressError('The selected exit is not ready')
            self.runtime.check(record)
            probe_warp(record['port'], scheme='http')
        self.magpie.bind(request.get('provider'), request.get('ref'), selection,
            request.get('revision'), pool['exits'],
            lambda data: atomic_json(self.state_path.parent / 'magpie-before-last-binding.json', data))
        return self.status(check=True)


def main():
    try:
        if sys.argv[1:] != ['--json']:
            raise EgressError('Use --json with a request on stdin')
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise EgressError('Request is too large')
        request = json.loads(raw)
        allowed = {'action', 'name', 'id', 'provider', 'ref', 'selection', 'revision'}
        if not isinstance(request, dict) or set(request) - allowed:
            raise EgressError('Invalid request')
        STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (STATE.parent / 'operation.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise EgressError('Another egress operation is still running') from None
            manager = Manager()
            action = request.get('action')
            if action == 'status':
                result = manager.status(check=True)
            elif action == 'create':
                result = manager.create(request.get('name'), request.get('id'))
            elif action == 'delete':
                result = manager.delete(request.get('id'))
            elif action == 'rename':
                result = manager.rename(request.get('id'), request.get('name'))
            elif action == 'magpie_bind':
                result = manager.bind(request)
            else:
                raise EgressError('Unsupported operation')
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except (ValueError, OSError) as error:
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else 'The egress operation failed; refresh before retrying'
        print(json.dumps({'ok': False, 'error': message}))
        sys.exit(1)


if __name__ == '__main__':
    main()
