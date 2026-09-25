#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu 24.04 x86_64 VPS from a verified Pingu snapshot.
#
# Invariants (contract.md v1):
#   * refuses incompatible OS/arch, or a snapshot built on another arch,
#     BEFORE any write
#   * refuses to install over any existing Pingu artifact (units, configs,
#     tokens, the loaded pingu_guard nft table) when no marker is present
#   * verifies archive checksum + safe extraction BEFORE installing anything
#   * never touches SSH, network, cloud-init, watchdog, fstab, machine identity
#   * never flushes the nft ruleset and never edits /etc/nftables.conf;
#     boot persistence is a dedicated pingu-firewall.service + loader that
#     loads only the managed inet pingu_guard table
#   * rolls back every Pingu-owned file/service/table on failure (apt kept)
#   * a same-snapshot/same-IP marker makes re-runs a read-only health
#     validation with ZERO mutations (on-host state such as device
#     revocations always survives; mtime is never consulted)
#   * the success marker is written atomically only after every required
#     service AND timer is active; failed health rolls back, no marker
#   * external HTTPS/WS after DNS cutover is NOT verified here
#
# Test hooks (not for production use):
#   PINGU_ROOT   prefix every target path with this directory
#   PINGU_ARCH   override architecture detection
set -euo pipefail

ARCHIVE=""
SHA_SUMS=""
HELPER=""
PUBLIC_IP=""
SNAPSHOT_ID=""
ENABLE_BACKUP=0
RCLONE_CONF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2;;
    --sha256sums) SHA_SUMS="$2"; shift 2;;
    --helper) HELPER="$2"; shift 2;;
    --public-ip) PUBLIC_IP="$2"; shift 2;;
    --snapshot) SNAPSHOT_ID="$2"; shift 2;;
    --enable-backup) ENABLE_BACKUP=1; shift;;
    --rclone-conf) RCLONE_CONF="$2"; shift 2;;
    *) echo "bootstrap: unknown argument: $1" >&2; exit 64;;
  esac
done

ROOT="${PINGU_ROOT:-}"
STAGING="$(cd "$(dirname "$ARCHIVE")" && pwd)"
MARKER_DIR="$ROOT/etc/pingu-migration"
MARKER="$MARKER_DIR/deployment.json"
ORIG_BACKUP="$STAGING/orig"
INSTALLED_LIST="$STAGING/installed.list"
TOUCHED_LIST="$STAGING/touched.list"
STARTED_UNITS_LIST="$STAGING/started-units.list"
RESTORE_DIR=""
ROOTFS=""

RUNTIME_PROFILE=""
TARGET_INTERFACE=""
SERVICES=()
TIMERS=(pingu-traffic-guard.timer pingu-traffic-report.timer)
[[ "$ENABLE_BACKUP" == "1" ]] && TIMERS+=(pingu-backup.timer)
MUTATIONS_BEGUN=0
NFT_TABLE_LOADED=0
MARKER_WRITTEN=0

die() { echo "bootstrap: error: $*" >&2; exit 1; }

check_os() {
  local osrel="$ROOT/etc/os-release"
  [[ -r "$osrel" ]] || die "cannot read $osrel"
  local id ver
  id="$(. "$osrel" 2>/dev/null; echo "${ID:-}")"
  ver="$(. "$osrel" 2>/dev/null; echo "${VERSION_ID:-}")"
  [[ "$id" == "ubuntu" && "$ver" == "24.04" ]] \
    || die "unsupported OS: $id $ver (fresh Ubuntu 24.04 required)"
  local arch
  if [[ -n "${PINGU_ARCH:-}" ]]; then
    arch="$PINGU_ARCH"
  elif command -v dpkg >/dev/null 2>&1; then
    arch="$(dpkg --print-architecture)"
  else
    arch="$(uname -m)"
  fi
  [[ "$arch" == "amd64" || "$arch" == "x86_64" ]] \
    || die "unsupported architecture: $arch (amd64/x86_64 required)"
}

validate_ipv4() {
  local ip="$1"
  local -a octets
  IFS='.' read -ra octets <<< "$ip"
  [[ ${#octets[@]} -eq 4 ]] || die "invalid IPv4: $ip"
  local part
  for part in "${octets[@]}"; do
    [[ "$part" =~ ^[0-9]+$ && "$part" -le 255 ]] || die "invalid IPv4: $ip"
  done
}

check_public_ip() {
  local addr_json
  addr_json="$(ip -j -4 addr)" \
    || die "cannot inspect host IPv4 addresses with ip -j -4 addr"
  TARGET_INTERFACE="$(python3 - "$PUBLIC_IP" "$addr_json" <<'PY'
import json
import re
import sys

needle, payload = sys.argv[1:3]
try:
    interfaces = json.loads(payload)
except ValueError as exc:
    print(f"ip -j -4 addr returned invalid JSON: {exc}", file=sys.stderr)
    sys.exit(1)
if not isinstance(interfaces, list):
    print("ip -j -4 addr returned unexpected JSON", file=sys.stderr)
    sys.exit(1)
matches = set()
for iface in interfaces:
    if not isinstance(iface, dict):
        continue
    flags = iface.get("flags", [])
    if "UP" not in flags or "LOOPBACK" in flags:
        continue
    for addr in iface.get("addr_info") or []:
        if (
            isinstance(addr, dict)
            and addr.get("family") == "inet"
            and addr.get("local") == needle
        ):
            matches.add(iface.get("ifname"))
if len(matches) != 1:
    print(
        f"public IPv4 {needle} is not directly assigned to exactly one UP non-loopback "
        "interface; NAT-only or ambiguous host networking; refusing",
        file=sys.stderr,
    )
    sys.exit(1)
name = matches.pop()
if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", name):
    print("invalid interface name from ip addr", file=sys.stderr)
    sys.exit(1)
print(name)
PY
)" || die "cannot resolve target public IPv4 interface"
  echo "bootstrap: public IPv4 $PUBLIC_IP directly assigned to $TARGET_INTERFACE"
}

verify_archive() {
  [[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"
  [[ -f "$SHA_SUMS" ]] || die "SHA256SUMS not found: $SHA_SUMS"
  [[ -f "$HELPER" ]] || die "snapshot helper not found: $HELPER"
  (cd "$STAGING" && sha256sum -c "$(basename "$SHA_SUMS")" >/dev/null) \
    || die "archive checksum verification failed"
  local expected
  expected="$(awk -v f="$(basename "$ARCHIVE")" '$2 == f {print $1}' "$SHA_SUMS")"
  [[ -n "$expected" ]] || die "archive hash missing from SHA256SUMS"
  RUNTIME_PROFILE="$(python3 - "$HELPER" "$ARCHIVE" "$expected" <<'PY'
import importlib.util
import sys

helper, archive, expected = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("pingu_snapshot_helper", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = module.verify_snapshot(archive, expected_sha256=expected)
source = manifest.get("source", {}) if isinstance(manifest, dict) else {}
arch = source.get("architecture", "")
if arch not in ("amd64", "x86_64"):
    print(f"unsupported snapshot source architecture: {arch!r}", file=sys.stderr)
    sys.exit(1)
schema = manifest.get("schema")
profile = manifest.get("runtime_profile", "xray")
if not ((schema == "pingu-vps-snapshot/v1" and profile == "xray")
        or (schema == "pingu-vps-snapshot/v2" and profile == "mihomo")):
    print("unsupported snapshot runtime profile", file=sys.stderr)
    sys.exit(1)
print(profile)
PY
)" || die "snapshot verification failed"
  SERVICES=(pingu-gate.service "$RUNTIME_PROFILE.service" cksheuen-portal.service)
}

idempotent_health_check() {
  local unit failed=0
  for unit in "${SERVICES[@]}" "${TIMERS[@]}"; do
    if systemctl is-active "$unit" >/dev/null 2>&1; then
      echo "bootstrap: $unit is active"
    else
      echo "bootstrap: WARNING: $unit is not active" >&2
      failed=1
    fi
  done
  return $failed
}

fresh_host_guard() {
  if [[ -f "$MARKER" ]]; then
    local prev_id prev_ip
    prev_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("snapshot_id",""))' "$MARKER" 2>/dev/null || true)"
    prev_ip="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("target_ip",""))' "$MARKER" 2>/dev/null || true)"
    if [[ "$prev_id" == "$SNAPSHOT_ID" && "$prev_ip" == "$PUBLIC_IP" ]]; then
      echo "bootstrap: deployment marker matches (snapshot=$SNAPSHOT_ID ip=$PUBLIC_IP)"
      echo "bootstrap: idempotent re-run: read-only health validation, no mutations"
      if idempotent_health_check; then
        echo "bootstrap: deployment healthy; nothing to do"
        exit 0
      fi
      echo "bootstrap: marker matches but health validation FAILED; no changes made" >&2
      exit 1
    fi
    die "managed Pingu installation already present (snapshot=$prev_id ip=$prev_ip); refusing to overwrite"
  fi
  local artifact
  for artifact in \
    "$ROOT/etc/pingu-gate.token" \
    "$ROOT/etc/pingu-gate.tokens" \
    "$ROOT/var/lib/pingu-gate/devices.json" \
    "$ROOT/usr/local/etc/xray/config.json" \
    "$ROOT/usr/local/bin/xray" \
    "$ROOT/etc/mihomo/config.json" \
    "$ROOT/usr/local/bin/mihomo" \
    "$ROOT/etc/systemd/system/mihomo.service" \
    "$ROOT/etc/pingu-gate/certs/cksheuen.site.crt" \
    "$ROOT/etc/pingu-gate/certs/cksheuen.site.key" \
    "$ROOT/etc/systemd/system/pingu-gate.service" \
    "$ROOT/etc/systemd/system/xray.service" \
    "$ROOT/etc/systemd/system/cksheuen-portal.service" \
    "$ROOT/etc/systemd/system/pingu-firewall.service" \
    "$ROOT/usr/local/sbin/pingu-firewall-loader.sh" \
    "$ROOT/etc/nftables.d/pingu-guard.nft" ; do
    if [[ -e "$artifact" || -L "$artifact" ]]; then
      die "fresh-host guard: existing Pingu artifact found: ${artifact#$ROOT}; refusing to install over it"
    fi
  done
  if nft list table inet pingu_guard >/dev/null 2>&1; then
    die "fresh-host guard: inet pingu_guard nft table already loaded; refusing"
  fi
}

install_packages() {
  local pkgs=(python3 ca-certificates curl nftables qrencode iproute2)
  [[ "$ENABLE_BACKUP" == "1" ]] && pkgs+=(rclone)
  if [[ -n "$ROOT" ]]; then
    echo "bootstrap(test): apt install ${pkgs[*]}"
    return
  fi
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}"
}

provision_rclone_conf() {
  [[ -n "$RCLONE_CONF" ]] || return 0
  [[ -f "$RCLONE_CONF" ]] || die "rclone.conf not found: $RCLONE_CONF"
  local dst="$ROOT/root/.config/rclone/rclone.conf"
  if [[ -e "$dst" || -L "$dst" ]]; then
    die "refusing to overwrite existing rclone.conf at $dst; remove it explicitly if intended"
  fi
  mkdir -p "$ROOT/root/.config/rclone"
  chmod 0700 "$ROOT/root/.config/rclone"
  install -m 0600 "$RCLONE_CONF" "$dst"
  echo "root/.config/rclone/rclone.conf" >> "$INSTALLED_LIST"
  echo "bootstrap: rclone.conf provisioned to /root/.config/rclone/rclone.conf (0600)"
}

extract_snapshot() {
  RESTORE_DIR="$(mktemp -d "$STAGING/restore.XXXXXX")"
  chmod 0700 "$RESTORE_DIR"
  local expected
  expected="$(awk -v f="$(basename "$ARCHIVE")" '$2 == f {print $1}' "$SHA_SUMS")"
  python3 - "$HELPER" "$ARCHIVE" "$RESTORE_DIR" "$expected" "$PUBLIC_IP" "$TARGET_INTERFACE" "$RUNTIME_PROFILE" <<'PY'
import importlib.util
import sys

helper, archive, destination, expected, public_ip, interface, profile = sys.argv[1:8]
spec = importlib.util.spec_from_file_location("pingu_snapshot_helper", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
kwargs = {"target_interface": interface} if profile == "mihomo" else {}
module.restore_snapshot(archive, destination, expected_sha256=expected, public_ip=public_ip, **kwargs)
PY
  ROOTFS="$RESTORE_DIR/rootfs"
  [[ -d "$ROOTFS" ]] || die "helper did not produce rootfs"
}

install_path() {
  local rel="$1"
  [[ "$rel" != /* && "$rel" != *..* ]] || die "unsafe path in snapshot: $rel"
  local src="$ROOTFS/$1" dst="$ROOT/$1"
  if [[ -d "$src" && ! -L "$src" ]]; then
    mkdir -p "$dst"
    return
  fi
  [[ -e "$src" || -L "$src" ]] || return 0
  if [[ -e "$dst" || -L "$dst" ]]; then
    mkdir -p "$ORIG_BACKUP/$(dirname "$rel")"
    echo "$rel" >> "$TOUCHED_LIST"
    mv "$dst" "$ORIG_BACKUP/$rel"
  fi
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  echo "$rel" >> "$INSTALLED_LIST"
}

install_all() {
  local rel
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    install_path "$rel"
  done < <(cd "$ROOTFS" && find . -mindepth 1 | sed 's|^\./||' | sort)
}

setup_nft() {
  local nft_file="$ROOT/etc/nftables.d/pingu-guard.nft"
  [[ -f "$nft_file" ]] || die "pingu-guard.nft missing from snapshot"
  nft -c -f "$nft_file" || die "nft syntax check failed"
  if nft list table inet pingu_guard >/dev/null 2>&1; then
    die "inet pingu_guard table already exists; refusing to overwrite"
  fi
  nft -f "$nft_file" || die "failed to load inet pingu_guard table"
  NFT_TABLE_LOADED=1
  # Boot persistence: own loader + own unit. The global /etc/nftables.conf
  # is preserved byte-for-byte; nothing is flushed and no unrelated table
  # is ever deleted.
  local loader="$ROOT/usr/local/sbin/pingu-firewall-loader.sh"
  local unit_file="$ROOT/etc/systemd/system/pingu-firewall.service"
  mkdir -p "$(dirname "$loader")"
  cat > "$loader" <<'EOF'
#!/usr/bin/env bash
# Pingu-managed: load only the inet pingu_guard table at boot.
# Generated by pingu bootstrap; the global nft ruleset is untouched.
set -euo pipefail
nft -f /etc/nftables.d/pingu-guard.nft
EOF
  chmod 0755 "$loader"
  cat > "$unit_file" <<EOF
[Unit]
Description=Pingu managed nftables table (inet pingu_guard)
After=network-pre.target nftables.service
Before=pingu-gate.service $RUNTIME_PROFILE.service cksheuen-portal.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pingu-firewall-loader.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$unit_file"
  echo "usr/local/sbin/pingu-firewall-loader.sh" >> "$INSTALLED_LIST"
  echo "etc/systemd/system/pingu-firewall.service" >> "$INSTALLED_LIST"
  systemctl daemon-reload
  echo "pingu-firewall.service" >> "$STARTED_UNITS_LIST"
  systemctl enable --now pingu-firewall.service \
    || die "failed to enable pingu-firewall.service"
}

unit_exists() {
  local unit="$1"
  [[ -f "$ROOT/etc/systemd/system/$unit" ]] \
    || [[ -f "$ROOT/usr/local/lib/systemd/system/$unit" ]] \
    || [[ -f "$ROOT/lib/systemd/system/$unit" ]]
}

validate_configs() {
  if [[ "$RUNTIME_PROFILE" == "mihomo" ]]; then
    "$ROOT/usr/local/bin/mihomo" -t -d "$ROOT/etc/mihomo" -f "$ROOT/etc/mihomo/config.json" \
      || die "mihomo config test failed"
  else
    "$ROOT/usr/local/bin/xray" run -test -c "$ROOT/usr/local/etc/xray/config.json" \
      || die "xray config test failed"
  fi
  local units=()
  while IFS= read -r unit; do
    units+=("$unit")
  done < <(
    cd "$ROOTFS" \
      && find etc/systemd/system -type f \( -name '*.service' -o -name '*.timer' \) 2>/dev/null \
      | sed "s|^|$ROOT/|"
  )
  if [[ ${#units[@]} -gt 0 ]]; then
    systemd-analyze verify "${units[@]}" || die "systemd unit verification failed"
  fi
}

enable_services() {
  systemctl daemon-reload
  local unit
  for unit in "${SERVICES[@]}" "${TIMERS[@]}"; do
    unit_exists "$unit" || die "mandatory unit $unit is missing from the snapshot"
    # Record intent BEFORE the attempt: a failed `enable --now` may still
    # have started the unit, so rollback must stop it.
    echo "$unit" >> "$STARTED_UNITS_LIST"
    systemctl enable --now "$unit" || die "failed to enable $unit"
  done
}

health_check() {
  local unit
  for unit in "${SERVICES[@]}" "${TIMERS[@]}"; do
    if systemctl is-active "$unit" >/dev/null 2>&1; then
      echo "bootstrap: $unit is active"
    else
      die "required unit $unit is not active after enable"
    fi
  done
}

write_marker() {
  mkdir -p "$MARKER_DIR"
  chmod 0700 "$MARKER_DIR"
  local tmp
  tmp="$(mktemp "$MARKER_DIR/.deployment.XXXXXX")"
  python3 - "$tmp" "$SNAPSHOT_ID" "$PUBLIC_IP" "$RUNTIME_PROFILE" "$TARGET_INTERFACE" <<'PY'
import datetime
import json
import sys

path, snapshot_id, public_ip, profile, interface = sys.argv[1:6]
with open(path, "w") as handle:
    json.dump(
        {
            "schema": "pingu-deployment/v1",
            "snapshot_id": snapshot_id,
            "target_ip": public_ip,
            "runtime_profile": profile,
            "target_interface": interface,
            "installed_at": datetime.datetime.utcnow().isoformat() + "Z",
        },
        handle,
        indent=2,
    )
PY
  chmod 0600 "$tmp"
  mv -f "$tmp" "$MARKER"
  MARKER_WRITTEN=1
}

rollback() {
  # Never roll back pre-mutation failures (OS/arch/checksum/fresh-host guard):
  # nothing was touched, and on an idempotent re-run the live deployment must
  # not be disturbed.
  [[ "$MUTATIONS_BEGUN" == "1" ]] || return 0
  echo "bootstrap: rolling back Pingu-owned changes (apt packages are kept)" >&2
  if [[ -f "$STARTED_UNITS_LIST" ]]; then
    local unit
    while IFS= read -r unit; do
      [[ -n "$unit" ]] || continue
      systemctl stop "$unit" >/dev/null 2>&1 || true
      systemctl disable "$unit" >/dev/null 2>&1 || true
    done < "$STARTED_UNITS_LIST"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if [[ "$NFT_TABLE_LOADED" == "1" ]]; then
    nft delete table inet pingu_guard >/dev/null 2>&1 || true
  fi
  local all_list
  all_list="$(mktemp)"
  { cat "$INSTALLED_LIST" 2>/dev/null || true; \
    cat "$TOUCHED_LIST" 2>/dev/null || true; } | sort -u > "$all_list"
  local rel
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    rm -rf "$ROOT/$rel"
    if [[ -e "$ORIG_BACKUP/$rel" || -L "$ORIG_BACKUP/$rel" ]]; then
      mkdir -p "$(dirname "$ROOT/$rel")"
      mv "$ORIG_BACKUP/$rel" "$ROOT/$rel"
    fi
  done < "$all_list"
  rm -f "$all_list"
  if [[ "$MARKER_WRITTEN" == "1" ]]; then
    rm -f "$MARKER"
  fi
  rm -f "$MARKER_DIR"/.deployment.* 2>/dev/null || true
  rmdir "$MARKER_DIR" 2>/dev/null || true
  rm -rf "$ORIG_BACKUP"
}

main() {
  [[ -n "$ARCHIVE" && -n "$SHA_SUMS" && -n "$HELPER" \
    && -n "$PUBLIC_IP" && -n "$SNAPSHOT_ID" ]] || die "missing required arguments"
  trap 'rc=$?; if [[ $rc -ne 0 ]]; then rollback; fi' EXIT
  check_os
  validate_ipv4 "$PUBLIC_IP"
  check_public_ip
  verify_archive
  fresh_host_guard
  MUTATIONS_BEGUN=1
  : > "$INSTALLED_LIST"
  : > "$TOUCHED_LIST"
  : > "$STARTED_UNITS_LIST"
  install_packages
  provision_rclone_conf
  extract_snapshot
  install_all
  setup_nft
  validate_configs
  enable_services
  health_check
  write_marker
  echo "bootstrap: complete. External HTTPS/WS reachability requires the future manual"
  echo "bootstrap: Cloudflare DNS cutover and is NOT verified by this run."
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
