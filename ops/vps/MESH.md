# Pingu private device networking

The Cloudflare manager controls **which devices may join**. Headscale on a VPS
coordinates those devices and supplies an authenticated DERP fallback. Pingu
embeds a separate userspace Tailscale node; an existing Tailscale installation,
host DNS and host routing remain independent. Each desktop defaults to denying
inbound access. Only its locally selected TCP ports can be enabled.

## Server deployment

Use the official Headscale v0.29.4 release and verify its published SHA256. The
example config uses a dedicated DNS-only HTTPS name on TCP 8444, TCP 80 for
ACME HTTP-01, and UDP 3478 for STUN. Keep the existing Cloudflare-only Gate on
443. Headscale's API/metrics and CLI socket stay local. `verify_clients: true`
restricts the embedded relay to enrolled nodes. Verify custom HTTPS/DERP ports
with real peers; a healthy HTTPS endpoint alone does not prove relay traffic.

Install `systemd/pingu-mesh.service`, adapt `config/headscale.example.yaml` to
`/etc/pingu-mesh/config.yaml`, and put the policy at
`/etc/pingu-mesh/policy.hujson`. Create the `pingu-mesh` system user/group first;
config files are root-owned and group-readable only. State is private under
`/var/lib/pingu-mesh`. The service has only the capability needed to bind ACME
port 80. It does not create a VPN host interface or change default routes.

Install `sbin/pingu_mesh.py` next to the Gate and set
`PINGU_MESH_CONTROL_URL` plus `PINGU_MESH_IPV4_CIDR` in a Gate service drop-in.
The existing dedicated node-control credential also authenticates
`POST /__pingu_gate__/control/v1/mesh`. Its enroll/revoke ids are cloud-owned
permission generations. A short-lived single-use auth key is returned only to
the device's authenticated subscription request. Revocation writes a durable
tombstone before expiring keys and deleting the Headscale identity. Failed
revocation stays pending in the manager and can be retried.

Apply control-plane migration `0002_mesh.sql`, set `MESH_NODE_ID` to the issuer
node's immutable id, and deploy the Worker. Existing and new devices start with
mesh disabled. Allow only the intended devices in the manager. Revoking a whole
device waits for both proxy and mesh revocation, including disabled issuers.

## Desktop builds and behavior

Build `apps/mesh` on the authorized development host, then set `PINGU_MESH_BIN`
alongside `PINGU_MIHOMO_BIN` when bundling Pingu. The app sends private launch
configuration through stdin; EOF or app exit tears down the sidecar. Runtime
API/SOCKS secrets are never serialized into the saved application settings.

The Device mesh page selects a Pingu cloud subscription, connects, lists peers,
measures the observed direct/relay path, and stores the local exposure setting.
Only selected TCP services on loopback are forwarded. Turning exposure off closes
existing inbound bridges. Browser traffic to mesh IPv4 addresses uses Pingu's
normal proxy listener; the page supplies an SSH ProxyCommand for terminal use.
This version does not provide OS-wide overlay routes or arbitrary UDP services.
A stopped mesh rejects its owned prefix instead of routing it through other exits.

## Backup and recovery

The existing encrypted `pingu-backup` timer uses `sbin/pingu_snapshot.py`.
When a mesh config exists, snapshots also include the Headscale binary, service,
config/policy, Noise/DERP private keys, ACME cache, the node-control credential,
and revocation tombstones. SQLite uses its online backup API and integrity check
so committed WAL data is included without stopping the service. These assets
must never be copied to a second simultaneously running coordinator.

On recovery, restore with the current snapshot verifier, recreate the dedicated
system user, fix state ownership, and reconcile cloud permission generations
before enabling the coordinator. Move the DNS-only record only after verifying
TLS and control access on the recovered server. Desktop identity directories
belong to one device and must not be cloned onto another machine.

The existing traffic guard controls the proxy core and 443/8443; it does not
currently enforce a quota cutoff for the independent mesh relay. Account for
relay bandwidth separately when enabling a provider quota policy.
