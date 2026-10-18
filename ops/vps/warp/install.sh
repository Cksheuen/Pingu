#!/usr/bin/env bash
set -euo pipefail
# Explicit operator deployment; never invoked by tests or desktop startup.
if [[ $# != 2 || $1 != --warp-version || ! $2 =~ ^[0-9][0-9.-]+$ ]]; then
  echo 'Usage: sudo bash ops/vps/warp/install.sh --warp-version <official-package-version>' >&2
  exit 2
fi
[[ $(id -u) == 0 ]] || { echo 'Root is required' >&2; exit 1; }
command -v podman >/dev/null || { echo 'Install Podman from your distribution first' >&2; exit 1; }
test -c /dev/net/tun
warp_source=$(cd "$(dirname "$0")" && pwd)
podman build --build-arg "WARP_VERSION=$2" -t localhost/pingu-warp:1 "$warp_source"
install -d -m 0700 /var/lib/pingu-egress
warp_backup=/var/lib/pingu-egress/backups/$(date -u +%Y%m%dT%H%M%SZ)
for warp_file in /usr/local/sbin/pingu-egress /usr/local/sbin/pingu_magpie.py; do
  if [[ -f $warp_file ]]; then
    install -d -m 0700 "$warp_backup"
    cp -p "$warp_file" "$warp_backup/"
  fi
done
install -m 0755 "$warp_source/../sbin/pingu_egress.py" /usr/local/sbin/pingu-egress
install -m 0644 "$warp_source/../sbin/pingu_magpie.py" /usr/local/sbin/pingu_magpie.py
# Podman's restart policy needs this service after a host reboot.
systemctl enable podman-restart.service
echo 'Runtime installed. No WARP registration or route was created.'
