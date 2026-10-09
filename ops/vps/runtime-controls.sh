#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
identity="${PINGU_VPS_IDENTITY:-$repo_root/heuen-ed25519./id_rsa.pem}"
host="${PINGU_VPS_HOST:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["host"])' "$script_dir/remote-manifest.json")}"
if [[ $# -eq 0 ]]; then set -- status; fi
for argument in "$@"; do
  case "$argument" in status|set|off|restore|reconcile|reconnect|on|--apply|--warp|--source-guard|--destination-filter|--traffic-guard) ;;
    *) printf 'Unsupported argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done
result_file="$(mktemp -t pingu-runtime-switch.XXXXXX)"
trap 'rm -f "$result_file"' EXIT
ssh -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "$host" /usr/local/sbin/pingu-runtime-controls "$@" >"$result_file"
cat "$result_file"
python3 - "$result_file" <<'PYLOCAL'
import json, os, pathlib, tempfile
result=json.loads(pathlib.Path(__import__('sys').argv[1]).read_text())
# The desktop reads Gate settings on every renewal. Reflect a successfully
# applied source-guard switch locally, without restarting or exposing its token.
if result.get('applied') and 'source_guard' in result.get('state', {}):
    path=pathlib.Path.home()/'Library/Application Support/sing-proxy/gate.json'
    if path.exists():
        config=json.loads(path.read_text())
        enabled=result['state']['source_guard']
        if config.get('enabled') != enabled and config.get('token') and config.get('endpoint'):
            config['enabled']=enabled
            fd,tmp=tempfile.mkstemp(prefix='.pingu-gate-',dir=path.parent)
            try:
                with os.fdopen(fd,'w') as handle:
                    os.fchmod(handle.fileno(),0o600)
                    json.dump(config,handle,indent=2)
                    handle.flush();os.fsync(handle.fileno())
                os.replace(tmp,path)
            finally:
                if os.path.exists(tmp):os.unlink(tmp)
            print('Local automatic Gate renewal: '+('on' if enabled else 'off'))
PYLOCAL
