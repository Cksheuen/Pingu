#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
manifest="$script_dir/remote-manifest.json"
vps_host="${PINGU_VPS_HOST:-$(jq -r '.host' "$manifest")}"
vps_identity="${PINGU_VPS_IDENTITY:-$repo_root/heuen-ed25519./id_rsa.pem}"

if [[ ! -f "$vps_identity" ]]; then
  printf 'Missing SSH identity: %s\n' "$vps_identity" >&2
  printf 'Set PINGU_VPS_IDENTITY to the private-key path.\n' >&2
  exit 2
fi

snapshot_file="$(mktemp -t pingu-vps-audit.XXXXXX)"
trap 'rm -f "$snapshot_file"' EXIT

jq -r '.artifacts[].remote_path' "$manifest" |
  ssh \
    -i "$vps_identity" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=yes \
    "$vps_host" \
    'while IFS= read -r path; do
       if [ -f "$path" ]; then
         sha256sum "$path"
       else
         printf "MISSING  %s\n" "$path"
       fi
     done' >"$snapshot_file"

failures=0
while IFS=$'\t' read -r remote_path local_path expected_hash import_policy; do
  remote_hash="$(awk -v path="$remote_path" '$2 == path { print $1 }' "$snapshot_file")"
  if [[ -z "$remote_hash" || "$remote_hash" == "MISSING" ]]; then
    printf 'MISSING remote=%s\n' "$remote_path"
    failures=$((failures + 1))
    continue
  fi

  if [[ "$remote_hash" != "$expected_hash" ]]; then
    printf 'DRIFT remote=%s expected=%s actual=%s\n' \
      "$remote_path" "$expected_hash" "$remote_hash"
    failures=$((failures + 1))
    continue
  fi

  if [[ ! -f "$repo_root/$local_path" ]]; then
    printf 'MISSING local=%s\n' "$local_path"
    failures=$((failures + 1))
    continue
  fi

  if [[ "$import_policy" == "exact" ]]; then
    local_hash="$(shasum -a 256 "$repo_root/$local_path" | awk '{ print $1 }')"
    if [[ "$local_hash" != "$remote_hash" ]]; then
      printf 'LOCAL_DRIFT local=%s remote=%s\n' "$local_path" "$remote_path"
      failures=$((failures + 1))
      continue
    fi
  fi

  printf 'OK policy=%s local=%s remote=%s\n' \
    "$import_policy" "$local_path" "$remote_path"
done < <(
  jq -r '.artifacts[] | [.remote_path, .local_path, .remote_sha256, .import_policy] | @tsv' "$manifest"
)

if [[ "$failures" -ne 0 ]]; then
  printf 'Audit failed: %s artifact(s) need review.\n' "$failures" >&2
  exit 1
fi

printf 'Audit passed: remote snapshot and exact local mirrors are aligned.\n'
