# Pingu VPS Gate

`sbin/pingu_gate.py` is the source for `/usr/local/sbin/pingu-gate` on the VPS.

This directory is the local maintenance source for the independently developed
VPS layer. Subdirectory names match the deployment targets: `sbin/` →
`/usr/local/sbin/`, `systemd/` → `/etc/systemd/system/`, `nftables/` →
`/etc/nftables.d/`, `config/` holds configuration schemas and non-secret
fragments, and `tests/` holds the unittest suite.

| Local source | VPS target | Role |
| --- | --- | --- |
| `sbin/pingu_gate.py` | `/usr/local/sbin/pingu-gate` | TLS edge, lease auth, portal/WS routing, authenticated connection view |
| `sbin/pingu_device_access.py` | `/usr/local/sbin/pingu_device_access.py` | Generic-client registry and subscription derivation |
| `sbin/pingu_mihomo.py` | `/usr/local/sbin/pingu_mihomo.py` | Xray→Mihomo config conversion and loopback controller client |
| `sbin/pingu_connections.py` | `/usr/local/sbin/pingu_connections.py` | Authenticated connections page (HTML + script) |
| `nftables/pingu-guard.nft` | `/etc/nftables.d/pingu-guard.nft` | Static firewall policy and dynamic sets |
| `sbin/pingu_traffic_guard.py` | `/usr/local/sbin/pingu-traffic-guard` | Quota enforcement and emergency stop |
| `sbin/pingu_traffic_report.py` | `/usr/local/sbin/pingu-traffic-report` | Read-only maintenance report |
| `sbin/pingu_backup.py` | `/usr/local/sbin/pingu-backup` | Encrypted off-site backup of assets and state |
| `systemd/pingu-gate.service.d/lease.conf` | `/etc/systemd/system/pingu-gate.service.d/lease.conf` | Gate lease TTL drop-in |
| `systemd/*.service`, `systemd/*.timer`, `systemd/*.path` | `/etc/systemd/system/` | Process, schedule, and change-trigger ownership |
| `config/xray-direct-ipv4.fragment.json` | merged into Xray config | Non-secret outbound policy reference |
| `config/mihomo-release.json` | not deployed | Pinned Mihomo release digest for the staged migration |

The production proxy core was migrated in place from Xray to **Mihomo
v1.19.31** on 2026-09-24 (pinned by the release digest in
`config/mihomo-release.json`). `sbin/pingu_mihomo.py`
converts the deployed Xray VLESS/Reality plus loopback-WS contract into
`/etc/mihomo/config.json` (0600, root-only): Reality listeners keep their
private key, server names and short IDs; the plaintext WS backend stays
loopback-only; the `direct` outbound is bound to the host's own IPv4 interface
and carried alongside a `pingu-public-ipv4` marker used by snapshot remap.
Unknown protocols, transports or routing semantics fail the conversion instead
of silently changing policy. The same module is the only client for Mihomo's
loopback controller (`127.0.0.1:19090`, 32+ character secret from the config):
it whitelists `GET /connections`, `GET /version` and `DELETE /connections[...]`
and never proxies an arbitrary controller path.

The Gate's authenticated connections view is served from
`/__pingu_gate__/devices/connections`, behind the same device-management session
and CSRF checks as the device list. It renders a table of live connections and
allows closing one or all of them. The page never receives the controller
secret; the Gate is the only process that talks to the controller.

**WS source identity.** Mihomo derives a WS connection's source from
`conn.RemoteAddr()`, which for relayed device traffic is the Gate itself, so the
connection list would show only the Gate loopback address and the shared WS
user. The Gate therefore keeps a small thread-safe in-memory map from the
*backend socket's own local endpoint* (`getsockname()`) to the authenticated
source it just validated — sanitized source IP plus device id/owner/name, never
a raw token, UUID or secret. Authenticated `GET /connections` is enriched from
that map, but only for connections whose reported endpoint and inbound match a
loopback WS listener read from the deployed Mihomo config; the original endpoint
is preserved separately and the backend port is never presented as a real client
source port. Unmatched connections and Reality connections keep the source
Mihomo itself reported, because for those it is already the real client. Each
registration carries a per-connection identity so a late cleanup cannot remove a
newer registration that reused the same port. Allowlisted legacy WS origins are
recorded with their real source IP and no fabricated device.

`remote-manifest.json` records the live paths and hashes most recently observed
during the **2026-09-24 post-cutover audit** (originally imported 2026-08-11;
refreshed from the live host after the Xray→Mihomo cutover). `audit-remote.sh`
verifies that remote snapshot without reading file bodies or changing the
server. The deployed Mihomo binary is not committed, so it is tracked under
`runtime_packages` with its pinned release digest and observed installed hash
rather than under `artifacts`. The portal release entry is `remote_audited`
only — the remote files were re-read and are unchanged, but no local
`apps/portal/dist` build exists in this tree, so no recursive local alignment
is claimed.

The desktop app sends `POST /__pingu_gate__/lease` with a bearer token before
connecting and periodically while connected. The Gate detects the public source
IP from Cloudflare headers, grants a short nftables lease, and returns its expiry.

The origin firewall must continue to restrict port 443 to Cloudflare ranges;
otherwise forwarded identity/IP headers must not be trusted.

Non-Gate HTTPS requests are forwarded to the independently deployed portal on
`127.0.0.1:10080`. WebSocket upgrades continue to go to the proxy core on
`127.0.0.1:10000` (the loopback WS listener); the two backends are separate
processes and release units.

The portal build is produced by `apps/portal` and deployed as immutable release
directories under `/var/www/cksheuen-portal/releases`. The `current` symlink is
the only release pointer used by `cksheuen-portal.service`, so a rollback only
requires repointing that symlink and restarting the service.

Deployment requires a syntax check, a timestamped backup, service restart, live
HTTPS lease verification, and nftables inspection. The manual HTML form remains
available at `/__pingu_gate__/` for devices without the desktop client.

## Third-party device subscriptions

Clients that cannot run Pingu, including iOS subscription clients, use a
device-specific WebSocket credential instead of a source-IP lease. Open
`/__pingu_gate__/devices`, enter a valid Gate access key once, and create a
record with the person and device labels. The resulting subscription URL and
QR code are shown only on that creation response.

The creation response shows, once, three clearly labeled outputs: the Pingu /
generic HTTPS subscription link with its own QR code, the Clash Verge / Mihomo
HTTPS subscription link with its own QR code, and the raw VLESS node text for
clients that accept a pasted node URI. The default subscription URL returns
the raw VLESS node for Pingu and generic clients; appending `?format=clash`
returns a complete Mihomo/Clash YAML config (VLESS + WS + TLS, including
`ws-opts.path` and `headers.Host`) for Clash Verge and compatible clients.
Unknown `format` values return HTTP 400; invalid or revoked tokens return
HTTP 403 for every format without leaking subscription content.

The subscription template must contain a VLESS node with `type=ws`,
`security=tls`, a valid UUID, host, and port. Nodes declaring `flow` or
Reality parameters are rejected at creation time instead of producing broken
client output.

The subscription bearer token is stored only as a SHA-256 digest in
`/var/lib/pingu-gate/devices.json`. A valid token returns only the existing
WebSocket/TLS node, with a device-specific path. Gate verifies that path before
forwarding it to the localhost-only WS inbound and records the device, source
IP, last-seen time, and connection count. Revocation blocks new
subscription fetches and WebSocket connections immediately. Legacy Pingu and
Reality lease behavior is unchanged.

QR codes are rendered locally with `qrencode`; never use an external QR API for
subscription URLs. Install the runtime dependency before enabling this surface:

```bash
apt-get install qrencode
```

The management key is submitted only in a POST body. The resulting management
session is short-lived and uses a Secure, HttpOnly, SameSite=Strict cookie plus
CSRF validation. Device tokens appear in imported subscription and WebSocket
paths, so Gate redacts those paths from its own access log; Cloudflare and
client configuration must still be treated as secret-bearing infrastructure.

`nftables/pingu-guard.nft` is the static firewall source. Its permanent Reality sets
must stay empty; dynamic leases are intentionally held only in live nft state
and expire automatically.

The server-side proxy core's `direct` outbound follows the bound-IP policy in
`config/xray-direct-ipv4.fragment.json` (the legacy Xray form: `UseIPv4` plus
`sendThrough`). Under Mihomo the actual binding is the `direct` proxy's
`ip-version: ipv4` together with its `interface-name`; the `pingu-public-ipv4`
value in the config is metadata used for snapshot identification and remap, not
a bind. Either way the source is bound to `154.26.187.44`, so IP-check pages
report the VPS address users recognize.

## Off-site backup

`sbin/pingu_backup.py` is the source for `/usr/local/sbin/pingu-backup`. It stages
the fixed assets and runtime state into a root-only temporary directory and
syncs them with rclone to an encrypted remote:

- Fixed assets: Gate token files, subscription file, traffic-guard config,
  proxy-core config, TLS cert/key, and Reality public key/short id.
- Runtime state: the third-party device registry and traffic-guard counters.
- Logs and reports are intentionally excluded; they are regenerable.

Each run creates a complete manifest-bound archive under an immutable
`snapshots/<snapshot-id>` remote path. It verifies the upload with
`rclone cryptcheck` and only then replaces `LATEST.json`; failed uploads or
verification never promote a new latest snapshot. Remote snapshots are not
purged automatically. On the current production host `pingu-backup.timer` is
enabled for the daily run, while `pingu-backup.path` intentionally stays
disabled so device connection-counter churn cannot trigger full snapshots.

Prerequisites on the VPS:

```bash
apt-get install rclone
rclone config  # Google Drive remote, then a crypt remote wrapping it
```

The rclone OAuth token in `/root/.config/rclone/rclone.conf` is itself a
secret and must never be copied into the repository. Point `RCLONE_REMOTE`
in `/etc/pingu-backup.conf` (root-only, schema in
`config/pingu-backup.conf.example`) at the crypt remote. Check the last run with
`pingu-backup --status`; state lives in `/var/lib/pingu-backup/last-run.json`.

## Hot runtime switches

`pnpm vps:controls` manages four independent optional policies over the existing
SSH connection: WARP TCP egress, Reality source-IP restriction, private/CN
outbound filtering, and automatic traffic-quota enforcement. TLS and client
credentials remain part of the connection protocol. These controls do not
change SSH, the Cloudflare-only HTTPS origin boundary, listener addresses or
server identity.

```bash
pnpm vps:controls status
pnpm vps:controls off                         # preview all optional policies off
pnpm vps:controls off --apply                 # apply without restarting the proxy
pnpm vps:controls set --warp on --apply       # change only WARP
pnpm vps:controls set --source-guard on --apply
pnpm vps:controls set --destination-filter on --apply
pnpm vps:controls set --traffic-guard on --apply
pnpm vps:controls restore --apply             # all four policies on
pnpm vps:controls reconnect                   # preview old WARP streams
pnpm vps:controls reconnect --apply           # close only those streams
```

The VPS command is `/usr/local/sbin/pingu-runtime-controls`. It validates routing candidates with the pinned Mihomo binary and checks real
WARP egress before enabling it. Only routing changes use the loopback controller
to hot-reload the proxy: source-only and quota-only changes never reload the
core. It saves a root-only rollback snapshot and atomically changes only its
named nftables rule on Reality port 8443. It never flushes the firewall or
regenerates proxy credentials. Failed operations attempt every affected restoration independently and report
any incomplete rollback; identical requests are no-ops. The observed live route, filter, firewall
state and quota timer are checked after applying, along with unchanged Mihomo
and Gate PIDs.

Source restriction off bypasses the existing Reality source/ban checks; source
restriction on restores them without clearing the lease/ban sets. Quota off
stops the quota timer and any running enforcement job, not the proxy. Turning
quotas on resumes existing accounting and thresholds. WARP's local daemon stays
available for fast switching, while `MATCH,direct` bypasses it completely for
new connections. UDP remains direct because the installed WARP SOCKS endpoint
does not support UDP association.

Existing TCP streams keep their original route and continue transferring. Use
`reconnect` if existing WARP streams must immediately be replaced; this is a
connection reset, not a service restart. A successful local source-guard change
also updates the desktop's automatic Gate-renewal flag without exposing its
credential or restarting the app.

Saved state is embedded in the private Mihomo config; the timer's enable state
is persistent. Install and enable `systemd/pingu-runtime-controls.service` to
reconcile the volatile nftables switch after boot. Mihomo snapshots now include the control script and boot unit together with
saved switch values. A config with saved controls requires both assets in the
snapshot. Fresh-host recovery enables the reconciler and preserves a disabled
quota timer without briefly starting enforcement. Older snapshots without
saved controls retain their original startup behavior. Desktop switch
buttons can consume these independent states after the pending UI design; no
new page layout is prescribed here.

## Local verification

From the workspace root:

```bash
pnpm check:vps
pnpm test:vps --plan             # show incremental scope selection
pnpm test:vps                    # run only stale scopes; warm unchanged = SKIP
pnpm test:vps --scope gate       # force one independent module
pnpm test:vps:all                # complete release/publication regression
PINGU_VPS_IDENTITY=/path/to/private-key pnpm audit:vps
```

The Python tests do not require Linux, nftables, systemd, Xray, or live VPS
access. Successful scope fingerprints are stored only under the ignored
`.local/test-dist/`; a failed run writes no stamps. The remote audit does
require SSH but is read-only.

## Configuration and secret boundary

Use `config/pingu-gate.env.example` and `config/pingu-traffic-guard.conf.example` as schemas.
Production values belong in root-owned files under `/etc`.

Never copy these runtime files into the repository:

- Gate token files and inline bearer tokens
- Xray UUIDs, private keys, and full subscription URLs
- TLS private keys
- Live nftables elements, traffic state, reports, or logs
- Device registry state under `/var/lib/pingu-gate`
- The rclone configuration and OAuth token under `/root/.config/rclone`
- Backup runtime state under `/var/lib/pingu-backup` and `/etc/pingu-backup.conf`

The full exclusion list is also machine-readable in
`remote-manifest.json`. The Gate service template uses
`EnvironmentFile=-/etc/pingu-gate.env` so future deploys no longer need to put
environment values directly in the unit file.

## Deployment boundary

Local files are the maintenance source. The 2026-09-24 same-host Mihomo cutover
was deployed and verified, but later local source edits still require their own
reviewed deployment. Before changing the VPS:

1. Run local syntax/tests and the read-only remote audit.
2. Review the diff from the recorded remote snapshot.
3. Copy to a temporary remote path and validate syntax there.
4. Create timestamped backups of every target.
5. Install files atomically, reload systemd/nftables as needed, and restart only
   the affected unit.
6. Verify the portal, lease endpoint, WebSocket upgrade, proxy-core listener,
   dynamic lease, unknown-source drop, timers, and rollback path.

`vps.py deploy` targets a **fresh host only**. It is not an in-place cutover and
must not be repurposed as one: it refuses the current source host as a target
and refuses to install over any existing Pingu artifact. The one-time operation
on the *current* host is separate, and exists only as a reviewed private
administrative workflow — no public command for it is shipped in this
repository. That same-host cutover **was performed and verified on 2026-09-24**;
the fresh-host deploy path is still unverified. See `MIGRATION.md`.

See `TRAFFIC.md` for guard/report operator commands.

## VPS migration controller

`vps.py` is the local controller for encrypted backups and fresh-host
deployment; `bootstrap.sh` bootstraps a new Ubuntu 24.04 amd64 host from a
verified snapshot. Both are safety-first: targets are mandatory, the current
source host is refused as a deploy target, every mutation needs an explicit
`--apply`, archive checksums are verified before any destination write, and
restore destinations must live outside this repository.

| Command | Purpose |
| --- | --- |
| `pnpm vps:status` | show the verified `LATEST.json` on the `drive-crypt:` crypt remote |
| `pnpm vps:list` | list immutable snapshot IDs |
| `pnpm vps:backup --target root@HOST --identity FILE --apply` | run the installed `pingu-backup` over SSH |
| `pnpm vps:recover --snapshot latest --dest /var/tmp/pingu-restore --apply` | verify + restore a snapshot locally |
| `pnpm vps:deploy --target root@NEW_IP --identity FILE --public-ip NEW_IP --snapshot latest --apply` | stage and bootstrap a fresh host |
| `pnpm test:vps:migration` | controller tests (mocked SSH/rclone) + bootstrap sandbox tests |

The full operator runbook — restore gate, DNS TTL/readback procedure, rollback,
the backup-key recovery caveat, and the literal-IP Reality cutover limitation —
is in `MIGRATION.md`. The same-host Xray→Mihomo cutover on the current
production host **was performed and verified on 2026-09-24**. A full
**new-host deployment is still unverified** (no fresh VPS exists); external
HTTPS/WS reachability for a new host also still requires the future manual
Cloudflare DNS cutover.

Tailscale and an AI-server feature are not implemented by this VPS package and
are outside this migration's verified scope.
