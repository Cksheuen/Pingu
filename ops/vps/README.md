# Pingu VPS Gate

`pingu_gate.py` is the source for `/usr/local/sbin/pingu-gate` on the VPS.

This directory is the local maintenance source for the independently developed
VPS layer:

| Local source | VPS target | Role |
| --- | --- | --- |
| `pingu_gate.py` | `/usr/local/sbin/pingu-gate` | TLS edge, lease auth, portal/WS routing |
| `pingu_device_access.py` | `/usr/local/sbin/pingu_device_access.py` | Generic-client registry and subscription derivation |
| `pingu-guard.nft` | `/etc/nftables.d/pingu-guard.nft` | Static firewall policy and dynamic sets |
| `pingu_traffic_guard.py` | `/usr/local/sbin/pingu-traffic-guard` | Quota enforcement and emergency stop |
| `pingu_traffic_report.py` | `/usr/local/sbin/pingu-traffic-report` | Read-only maintenance report |
| `*.service`, `*.timer` | `/etc/systemd/system/` | Process and schedule ownership |
| `xray-direct-ipv4.fragment.json` | merged into Xray config | Non-secret outbound policy reference |

`remote-manifest.json` records the live paths and hashes observed during the
2026-08-11 import. `audit-remote.sh` verifies that remote snapshot without
reading file bodies or changing the server.

The desktop app sends `POST /__pingu_gate__/lease` with a bearer token before
connecting and periodically while connected. The Gate detects the public source
IP from Cloudflare headers, grants a short nftables lease, and returns its expiry.

The origin firewall must continue to restrict port 443 to Cloudflare ranges;
otherwise forwarded identity/IP headers must not be trusted.

Non-Gate HTTPS requests are forwarded to the independently deployed portal on
`127.0.0.1:10080`. WebSocket upgrades continue to go to Xray on
`127.0.0.1:10000`; the two backends are separate processes and release units.

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

The subscription bearer token is stored only as a SHA-256 digest in
`/var/lib/pingu-gate/devices.json`. A valid token returns only the existing
WebSocket/TLS node, with a device-specific path. Gate verifies that path before
forwarding it to the localhost-only Xray WebSocket inbound and records the
device, source IP, last-seen time, and connection count. Revocation blocks new
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

`pingu-guard.nft` is the static firewall source. Its permanent Reality sets
must stay empty; dynamic leases are intentionally held only in live nft state
and expire automatically.

The server-side Xray `direct` outbound follows
`xray-direct-ipv4.fragment.json`: `UseIPv4` avoids an unexpected IPv6 egress,
and `sendThrough` binds the public source to `154.26.187.44` so IP-check pages
report the VPS address users recognize.

## Local verification

From the workspace root:

```bash
pnpm check:vps
pnpm test:vps
PINGU_VPS_IDENTITY=/path/to/private-key pnpm audit:vps
```

The Python tests do not require Linux, nftables, systemd, Xray, or live VPS
access. The remote audit does require SSH but is read-only.

## Configuration and secret boundary

Use `pingu-gate.env.example` and `pingu-traffic-guard.conf.example` as schemas.
Production values belong in root-owned files under `/etc`.

Never copy these runtime files into the repository:

- Gate token files and inline bearer tokens
- Xray UUIDs, private keys, and full subscription URLs
- TLS private keys
- Live nftables elements, traffic state, reports, or logs
- Device registry state under `/var/lib/pingu-gate`

The full exclusion list is also machine-readable in
`remote-manifest.json`. The Gate service template uses
`EnvironmentFile=-/etc/pingu-gate.env` so future deploys no longer need to put
environment values directly in the unit file.

## Deployment boundary

Local files are the future maintenance source, but this import did not replace
the live deployment. Before changing the VPS:

1. Run local syntax/tests and the read-only remote audit.
2. Review the diff from the recorded remote snapshot.
3. Copy to a temporary remote path and validate syntax there.
4. Create timestamped backups of every target.
5. Install files atomically, reload systemd/nftables as needed, and restart only
   the affected unit.
6. Verify the portal, lease endpoint, WebSocket upgrade, Xray listener, dynamic
   lease, unknown-source drop, timers, and rollback path.

See `TRAFFIC.md` for guard/report operator commands.
