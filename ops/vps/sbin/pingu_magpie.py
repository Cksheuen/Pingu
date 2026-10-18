"""Private, loopback-only adapter for Magpie v0.1.1255's provider API.

Only an allowlisted projection crosses SSH. Provider credentials and the web
key stay on the VPS. Saves start from the persisted provider, not the public
view (whose key/model shapes differ), retaining unrelated provider settings.
"""
import copy
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import urllib.request
import urllib.parse


class MagpieError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Magpie:
    def __init__(self, env='/etc/magpie/service.env',
                 providers='/var/lib/magpie/config/magpie/providers.json', port=3430):
        self.env_path, self.providers_path = Path(env), Path(providers)
        self.port = port

    @property
    def installed(self):
        return self.env_path.is_file()

    def environment(self):
        values = {}
        for line in self.env_path.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                values[k] = v.strip().strip('"').strip("'")
        return values

    def api(self, route, payload=None):
        key = self.environment().get('MAGPIE_WEB_KEY', '')
        if not re.fullmatch(r'[A-Za-z0-9._~-]{16,256}', key):
            raise MagpieError('Magpie web authentication is not configured')
        headers = {'Cookie': f'magpie_web_{self.port}={key}', 'Content-Type': 'application/json'}
        url = f'http://127.0.0.1:{self.port}' + route
        request = urllib.request.Request(url, headers=headers,
            data=None if payload is None else json.dumps(payload).encode())
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=30) as response:
                body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise ValueError()
            value = json.loads(body)
            if not isinstance(value, dict) or value.get('error'):
                raise ValueError()
            return value
        except (OSError, ValueError):
            # Upstream error text/URLs can contain credentials.
            raise MagpieError('Magpie did not acknowledge the request; refresh before retrying') from None

    def raw(self):
        if not self.providers_path.exists():
            return {'providers': []}
        try:
            value = json.loads(self.providers_path.read_text(encoding='utf-8-sig'))
            if not isinstance(value.get('providers', []), list):
                raise ValueError()
            return value
        except (OSError, ValueError, AttributeError):
            raise MagpieError('Magpie provider configuration cannot be read safely') from None

    @staticmethod
    def revision(provider):
        return hashlib.sha256(json.dumps(provider, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    @staticmethod
    def targets(provider):
        account = provider.get('account')
        if account:
            logins = account.get('logins') or [account]
            seen = set()
            for login in logins:
                ref = login.get('user', '').strip().lower()
                if ref and ref not in seen:
                    seen.add(ref)
                    yield ref, provider.get('accountNames', {}).get(ref) or login['user'], 'account', login.get('on', True)
        else:
            for key in provider.get('keyList', []):
                yield key['id'], key.get('name') or key.get('masked') or key['id'], 'key', key.get('on', True)

    @staticmethod
    def proxy_warning(provider):
        for field in ('chat', 'responses', 'anthropic', 'gemini', 'decide'):
            host = urllib.parse.urlsplit(provider.get(field, '')).hostname or ''
            local = host == 'localhost' or host.endswith('.localhost')
            try:
                local = local or ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
            if local:
                return 'Magpie bypasses proxies for localhost upstreams; WARP cannot be applied to this provider'
        return None

    @staticmethod
    def reference_set(providers, exit):
        addresses = {f'{s}://127.0.0.1:{exit["port"]}' for s in ('http', 'socks5', 'socks5h')}
        refs = set()
        for p in providers:
            if p.get('proxy') in addresses:
                refs.add(p['id'] + '/provider')
            for ref, proxy in p.get('accountProxies', {}).items():
                if proxy in addresses:
                    refs.add(p['id'] + '/' + ref)
        return sorted(refs)

    def view(self, exits):
        result = {'available': self.installed, 'providers': [], 'references': {}, 'error': None, 'web_url': None}
        if not self.installed:
            return result
        url = self.environment().get('MAGPIE_WEB_URL', '')
        if re.fullmatch(r'https://[a-zA-Z0-9.:-]+/?', url):
            result['web_url'] = url
        raw = {p['id']: p for p in self.raw().get('providers', [])}
        data = self.api('/api/providers')
        if data.get('fileError'):
            raise MagpieError('Magpie reports an unreadable provider configuration')
        for exit in exits:
            result['references'][exit['id']] = len(self.reference_set(list(raw.values()) + data.get('providers', []), exit))
        addresses = {f'{scheme}://127.0.0.1:{e["port"]}': e['id']
                     for e in exits for scheme in ('http', 'socks5', 'socks5h')}
        for provider in data.get('providers', []):
            pid = provider['id']
            members = []
            for ref, name, kind, on in self.targets(provider):
                own = provider.get('accountProxies', {}).get(ref, '')
                effective = own or provider.get('proxy', '')
                members.append({'ref': ref, 'name': name, 'kind': kind, 'enabled': on,
                    'selection': addresses.get(own, 'direct' if own == 'direct' else 'inherit' if not own else 'external'),
                    'effective_exit': addresses.get(effective),
                    'effective_direct': effective == 'direct'})
            if members:
                result['providers'].append({'id': pid, 'name': provider.get('name') or pid,
                    'revision': self.revision(raw.get(pid, {'id': pid})), 'targets': members,
                    'warning': self.proxy_warning(provider)})
        return result

    def references(self, exit):
        """Include hidden/stale overrides, not just accounts visible today."""
        if not self.installed:
            return []
        # Fail closed if Magpie is offline; do not delete a possibly used exit.
        live = self.api('/api/providers').get('providers', [])
        stored = self.raw().get('providers', [])
        return self.reference_set(stored + live, exit)

    def bind(self, pid, ref, selection, revision, exits, backup):
        if not all(isinstance(v, str) and 0 < len(v) <= 512 for v in (pid, ref, selection, revision)):
            raise MagpieError('Invalid Magpie binding')
        data = self.api('/api/providers')
        live = next((p for p in data.get('providers', []) if p['id'] == pid), None)
        if live is None or ref not in {x[0] for x in self.targets(live)}:
            raise MagpieError('This Magpie account or key no longer exists; refresh')
        original = self.raw()
        saved = next((p for p in original.get('providers', []) if p['id'] == pid), {'id': pid})
        if self.revision(saved) != revision:
            raise MagpieError('Magpie settings changed since they were loaded; refresh')
        if selection in ('direct', 'inherit'):
            proxy = 'direct' if selection == 'direct' else ''
        else:
            warning = self.proxy_warning(live)
            if warning:
                raise MagpieError(warning)
            exit = next((e for e in exits if e['id'] == selection and e['phase'] == 'ready'), None)
            if exit is None:
                raise MagpieError('The selected exit is not ready')
            # HTTP CONNECT works for Magpie's Go clients AND Claude subprocesses.
            proxy = f'http://127.0.0.1:{exit["port"]}'
        changed = copy.deepcopy(saved)
        overrides = changed.setdefault('accountProxies', {})
        if proxy:
            overrides[ref] = proxy
        else:
            overrides.pop(ref, None)
        if changed == saved:
            return
        backup(original)
        if self.raw() != original:
            raise MagpieError('Magpie settings changed during validation; refresh')
        # Use native save for normalization, invalidation and active consumers.
        self.api('/api/provider/save', changed)
        after = self.raw()
        provider = next((p for p in after.get('providers', []) if p['id'] == pid), {})
        if provider.get('accountProxies', {}).get(ref, '') != proxy:
            raise MagpieError('Magpie did not retain the binding; refresh before retrying')
        live = self.api('/api/providers')
        provider = next((p for p in live.get('providers', []) if p['id'] == pid), {})
        if provider.get('accountProxies', {}).get(ref, '') != proxy:
            raise MagpieError('Magpie live binding could not be confirmed')
