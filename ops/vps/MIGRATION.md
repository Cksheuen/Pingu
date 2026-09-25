# Pingu VPS migration runbook

Status: implementation complete and unit-tested locally (mocked SSH/rclone and a
fixture bootstrap sandbox). The **in-place Xray→Mihomo cutover on the current
production host was performed and verified on 2026-09-24** (same-host
migration, see [Same-host cutover result](#same-host-cutover-result-2026-09-24-verified)).
A **full deployment onto a brand-new Ubuntu 24.04 host remains UNVERIFIED**: no
fresh host exists, Docker is unavailable, and no live SSH/cloud/DNS operations
were performed. The fresh-host procedure below is the planned path for the
coordinator once a fresh host exists.

Tailscale and an AI-server feature are not implemented here and are excluded
from both the same-host result and the fresh-host procedure.

## Components

| Piece | Owner | Role |
| --- | --- | --- |
| `sbin/pingu_snapshot.py` | A | snapshot create/verify/restore with safe extraction, versioned runtime profile, and IP/interface remap |
| `sbin/pingu_backup.py` | A | VPS-side encrypted backup to the `drive-crypt:` crypt remote |
| `vps.py` | B | local controller: backup/status/list/recover/deploy (fresh host only) |
| `bootstrap.sh` | B | fresh Ubuntu 24.04 amd64 host bootstrap from a verified snapshot |

The rclone remote is a **crypt** remote (`drive-crypt:`); the controller refuses
any non-crypt remote. The independent recovery credential is the local
`rclone.conf` copy — it is never uploaded into snapshots or committed.

## Snapshot profiles

Snapshots are strictly versioned. **Verification and restore** take the profile
from the manifest, never from what happens to be on disk: a `v1` manifest must
declare the `xray` profile, a `v2` manifest must declare `mihomo`, and anything
else is rejected rather than migrated implicitly. A `v1` manifest may omit
`runtime_profile` entirely, which defaults to `xray`; the `schema` field itself
is required. **Creation** is explicit: pass `--runtime-profile`, or let the
tool autodetect from the canonical assets present in the source root (the
presence of a canonical Mihomo asset selects `mihomo`).

| Schema | `runtime_profile` | Meaning |
| --- | --- | --- |
| `pingu-vps-snapshot/v1` | `xray` (default when omitted) | Immutable legacy Xray contract |
| `pingu-vps-snapshot/v2` | `mihomo` (required) | Mihomo runtime profile |

**Legacy Xray snapshot v1 creation, verification and restore keep working
unchanged** — a v1 snapshot remains restorable, and restoring one is the
supported way back to the pre-Mihomo runtime.

The **v2 Mihomo profile** differs from v1 in three ways:

- **Geodata assets.** `etc/mihomo/GeoIP.dat` and `etc/mihomo/GeoSite.dat` are
  part of the profile, alongside `etc/mihomo/config.json`, the pinned
  `/usr/local/bin/mihomo`, `pingu_mihomo.py` and `mihomo.service`. The Xray
  binary, config, certs and share tree are not.
- **Canonical Gate certificate paths.** In v2 the TLS cert and key are stored at
  `/etc/pingu-gate/certs/cksheuen.site.{crt,key}`, which is where the Gate's
  `PINGU_GATE_CERT_FILE` / `PINGU_GATE_KEY_FILE` defaults already point. The
  cutover copies the existing certificate material to those canonical paths and
  changes only those two environment keys to match — the certificate material
  itself is unchanged.
- **Target interface remap.** A Mihomo restore with `--public-ip` additionally
  requires `--target-interface` (it is refused without one). The remap rewrites
  the owned `pingu-public-ipv4` marker, any listener bound to the old address,
  and the `direct` proxy's `interface-name` — while preserving Reality
  credentials and decoy targets untouched. The source address is read from the
  marker `mihomo-config:pingu-public-ipv4`, falling back to the legacy
  `xray-config:sendThrough` for a v1 root.

Note that `pingu-public-ipv4` is **metadata**, not a binding. What actually
binds egress is the `direct` proxy's `ip-version: ipv4` plus its
`interface-name`; the marker exists so a restore can identify and remap the
source address. The `UseIPv4` / `sendThrough` pair remains the legacy Xray
mechanism, described in `config/xray-direct-ipv4.fragment.json`.

Restore still requires the archive checksum to verify before any destination
write, and extraction stays safe (0600/0700, no traversal).

Quotas, the custom traffic-guard implementation, and the guard/report timers are
carried across the migration unchanged: only `WATCH_SERVICE` moves to `mihomo`,
because the live guard implementation on the host differs from this repository's
baseline and must not be overwritten by it.

## Daily operation

```bash
pnpm vps:status                     # show verified LATEST.json from the crypt remote
pnpm vps:list                       # list immutable snapshot IDs
pnpm vps:backup --target root@154.26.187.44 --identity ./heuen-ed25519 --apply
```

Current-source examples name a repo-root key (`./heuen-ed25519` or
`./id_rsa.pem`); use whichever exists locally. New-target examples use
`/path/to/new-key`.

`vps:backup` SSHes into the VPS and runs the installed `pingu-backup
--remote drive-crypt:`, then prints its sanitized JSON report. The daily backup
timer is enabled on the current production host; the path watcher stays
**disabled** (WS connection counter churn must not trigger full backups). A
manual verified backup is still mandatory before any cutover.

## Local restore (verification / disaster recovery)

```bash
pnpm vps:recover --snapshot latest --dest /var/tmp/pingu-restore --apply
# or a specific ID, remapping the Xray source IP at restore time:
pnpm vps:recover --snapshot 20260905-010101-abc123 --dest /var/tmp/pingu-restore \
  --public-ip 203.0.113.10 --apply
```

The destination must be **outside this repository**. The archive and its
SHA256SUMS are downloaded into a 0700 temp dir, the checksum is verified
**before any destination write**, then the snapshot helper verifies the archive
and performs a safe extraction into `--dest/rootfs` (plus `manifest.json` and
`deployment.json`). A tampered or corrupt archive fails closed.

## Fresh host deployment (one command, after a host exists)

```bash
pnpm vps:deploy \
  --target root@203.0.113.10 \
  --identity /path/to/new-key \
  --public-ip 203.0.113.10 \
  --snapshot latest \
  --apply
```

`--target` is mandatory and the current source IP (`154.26.187.44`) is refused
as a deployment target. Without `--apply` the command prints a concrete plan
and performs no SSH writes. With `--apply` it:

1. resolves and verifies the snapshot locally (checksum + helper verify);
2. stages `snapshot.tar.gz`, `SHA256SUMS`, `pingu_snapshot.py`, `bootstrap.sh`
   into `root@target:/root/.pingu-migration/staging/<id>/` (0700);
3. runs `bootstrap.sh`, which first performs a read-only `ip -j -4 addr`
   preflight and refuses unless `--public-ip` is directly assigned to an UP,
   non-loopback interface, then refuses non-Ubuntu-24.04/amd64 hosts AND
   snapshots built on another architecture, refuses to install over any
   existing Pingu artifact (units, configs, tokens, a loaded `pingu_guard`
   table) when no deployment marker is present, verifies the archive again,
   safely extracts via the helper into a private per-attempt
   `staging/restore.XXXXXX` directory, installs the proxy core, units, secrets,
   state, portal and the static `pingu_guard` nft table, validates the core
   config (`mihomo -t` for a v2 profile, `xray run -test` for v1) plus
   `systemd-analyze verify` and `nft -c`, then enables the Gate/core/portal
   services and the guard/report timers.

This supports only a fresh Ubuntu 24.04 amd64 VPS whose public IPv4 is directly
assigned to the host. NAT-only cloud hosts and other OS/architecture platforms
are explicitly unsupported and are refused rather than silently configured with
an unroutable Xray `sendThrough` address.

The controller uses `StrictHostKeyChecking=yes` with `ConnectTimeout` and a
10-second connect timeout. Remote completion budgets are 4500 seconds for
`vps:backup` and 1800 seconds for bootstrap, covering a normal 65 MiB backup or
apt bootstrap without treating a slow host as a hard failure. If either budget
is reached, the remote state is uncertain: inspect the host before retrying or
changing DNS; the controller never performs an automatic DNS switch. Connect
to the new host once out-of-band (e.g.
`ssh -i /path/to/new-key root@203.0.113.10`) so its host key is in
`known_hosts` before running `vps:deploy`. A target (or `--public-ip`) equal
to the current source IP, or a hostname that resolves to it, is refused before
any SSH or system write.

Bootstrap never touches SSH, network, cloud-init, watchdog, fstab or machine
identity, never flushes the nft ruleset, and never edits `/etc/nftables.conf`
— boot persistence is a dedicated `pingu-firewall.service` (ordered before
the Gate/core/portal units) whose loader loads only the managed
`inet pingu_guard` table. On failure it rolls back every Pingu-owned file,
service and table, stopping and disabling only units this run started (apt
packages are kept, by design). The success marker at
`/etc/pingu-migration/deployment.json` is written atomically only after every
required service AND timer is active; a failed health check rolls back and
writes no marker. A same-snapshot/same-IP re-run is a read-only health
validation with zero mutations — on-host state such as device revocations
always survives (mtime is never consulted), and dynamic nft state such as
leases is never reset. An unhealthy idempotent re-run exits nonzero without
touching the live deployment.

Optional flags: `--enable-backup` installs rclone and enables the backup timer;
`--with-rclone-conf /path/to/rclone.conf` provisions the Google credential to
`/root/.config/rclone/rclone.conf` (0600) on the new host. Restore works
without it — Google tokens are not required on the target.

## Cutover

Two distinct operations are involved, and they must not be confused:

- **Fresh-host deployment** (`vps.py deploy` / `bootstrap.sh`) — the shipped,
  tested path. It builds a *new* host and refuses the current host as a target.
  **Still unverified: no fresh host has ever been deployed.**
- **In-place Xray→Mihomo cutover on the current host** — a one-time operation
  that exists only as a reviewed private administrative workflow. **No public
  command for it is shipped in this repository**, and `vps.py deploy` must not
  be repurposed for it. Its contract: plan by default with an explicit
  `--apply`, snapshot the old Xray profile *before* installing any canonical
  Mihomo asset (snapshot autodetection selects Mihomo once any exists),
  preserve UUIDs/Reality keys/Gate keys/device registry/nftables leases/quota
  values/timers and the custom guard, keep the Xray assets for rollback, and on
  any failure restore every changed file and pre-existing service state. The
  original ports stay the same, so Xray is stopped only immediately before
  Mihomo starts.

### Same-host cutover result (2026-09-24, verified)

The in-place cutover above **has been performed and verified on the production
host**. This is a **same-host in-place migration, not a fresh-host cutover
proof** — it says nothing about `vps.py deploy`.

What was observed on the live host:

- Mihomo **v1.19.31** is active and enabled; Xray is stopped and disabled, with
  the old Xray assets retained for rollback.
- The **first attempt failed and was rolled back automatically**: its health
  probe used a raw loopback `:443` request, which is incompatible with the
  existing Cloudflare-only nft policy. The rollback was verified to restore the
  old state (Xray and Gate active, Mihomo inactive). A retry with a corrected
  probe — controller auth, listener ownership, and public Cloudflare HTTPS —
  succeeded.
- Post-cutover live checks passed: real WebSocket and Reality egress, device to
  source mapping, single-close semantics, raw and Clash subscription endpoints,
  and rejection of private destinations. The temporary test device was revoked
  and its two-minute lease expired.
- A new **v2 (Mihomo) encrypted backup** was created and its restore verified:
  43 restored file hashes/modes checked, the restored core binary passed `-t`,
  temporary secrets were removed, and live services were unchanged.
- Packaged desktop acceptance completed on **2026-09-24**: a debug macOS app
  built with pinned Mihomo v1.19.31 used a bundled binary whose SHA-256 matched
  the verified input. Native OFFLINE import of two YAML sources (four nodes,
  including same-name nodes), toggle/rename/delete, and offline strategy and
  connections UI passed. Test entries were removed, the app quit, the original
  user config and Gate file were restored byte-for-byte, and system proxies
  stayed off. Connected/system-proxy traffic mode was deliberately not exercised
  under the user constraint; real WebSocket/Reality egress was verified
  separately on the VPS.

Immutable backups useful for recovery (both on `drive-crypt:`, immutable):

| Role | Snapshot ID | Protocol / profile | SHA256 |
| --- | --- | --- | --- |
| Pre-cutover (Xray) | `20260924T075857Z-70cd9ce9` | `v1` / `xray` | `72f628b88052925494116f11e080b3d6613ee9abb54783704b67b2868b553617` |
| Post-cutover (Mihomo) | `20260924T090935Z-921e0ea9` | `v2` / `mihomo` | `5695e86c2d7ec7f9e1eba55c04cc4f0305dd112fc36aa8e4b4f1d7202cd59290` |

These are **recovery material, not an in-place revert command.** `vps.py deploy`
refuses the live host, so no shipped command reverts the current host in place:
the pre-cutover `v1` snapshot is the supported way to rebuild the pre-Mihomo
runtime, not a one-shot rollback of this host.

The actual same-host rollback baseline is a **private, root-only on-host copy**
taken by the cutover workflow, holding every changed/created path plus
pre-existing service state:

- `/var/lib/pingu-migration/mihomo-20260924T025738Z-retry1/rollback` — the
  applied attempt's baseline;
- `/var/lib/pingu-migration/mihomo-20260924T025738Z` — the original attempt's
  baseline, preserved separately.

**Rollback was exercised only for the failed first attempt** (automatic, and
verified to restore the old state). A rollback *after* the successful cutover,
with real users active, **has not been exercised** and is not claimed.

The live file/service state after cutover is recorded in
`remote-manifest.json` and can be re-checked read-only with `audit-remote.sh`
(a plain Bash script — no local sudo):

```bash
PINGU_VPS_IDENTITY=/path/to/operator-private-key bash ops/vps/audit-remote.sh
```

The identity is an operator-supplied private key: this repository/worktree
deliberately excludes private keys.

No DNS is edited here. When the new host is ready:

1. Lower the Cloudflare DNS TTL for the stable WS domain well in advance.
2. **Pause device create/revoke operations** for the duration of the final
   snapshot + DNS window, so no revocation lands only on the old host after
   the snapshot is taken.
3. Confirm `pnpm vps:status` shows a fresh verified snapshot and run a manual
   `vps:backup` immediately before the switch.
4. Switch the Cloudflare record to the new IP and **read it back** with
   `dig +short <domain>` from an external resolver before declaring success.
5. Verify WS subscriptions on the stable domain — they survive the cutover
   because credentials are domain-bound, not IP-bound.
6. Keep the old VPS intact until the new public WS/lease path is proven
   working; rollback is a DNS repoint — the old host was never modified.
7. Only after the new host is proven, **stop and disable `pingu-backup.timer`
   on the old host** — otherwise it can promote a fresh `LATEST.json` from
   the old host after cutover and confuse recovery.

**Literal-IP Reality clients** (port 8443 via the `pingu_guard` nft policy) are
the one exception. Reality subscription templates can contain a literal IPv6
server address; with `--public-ip`, migration rewrites only this server's
matching-credential Reality literal IP to the new IPv4, while DNS/WS links stay
unchanged. Existing installed clients that pinned a literal IP still need a
reimport or a stable DNS-only hostname. There is no auto-cutover for them.

## Rollback procedure

- *Failed bootstrap*: automatic — Pingu-owned files/services/table are rolled
  back and the host remains reachable over SSH.
- *Bad deployment after cutover*: repoint Cloudflare DNS back to the old host
  (TTL already low), verify with `dig`, then investigate; the old host's state
  was never migrated or stopped.
- *Bad snapshot restore locally*: delete the `--dest` directory; the source
  VPS and the crypt remote are untouched (remote snapshots are immutable).

## Backup key recovery caveat

The crypt remote's encryption key lives only in the local `rclone.conf` copy.
If that copy is lost, the cloud archive is unrecoverable even with full Google
account access. Back it up separately (offline, sealed) and never commit it.

## Tests

```bash
pnpm test:vps --plan     # incremental selection without execution
pnpm test:vps            # stale scopes only; unchanged scopes are reported SKIP
pnpm test:vps:all        # complete release/publication regression
pnpm test:vps:migration     # Snapshot + Backup + Controller tests (mocked SSH/rclone + bootstrap sandbox)
pnpm check:vps              # python compile check
bash -n ops/vps/bootstrap.sh
```
