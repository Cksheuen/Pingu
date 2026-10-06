# Pingu control plane

Cloudflare Workers serves the management UI and stable subscriptions. D1 holds
nodes and device assignments. Subscription downloads use cached encrypted node
URIs and do not call a VPS. The actual VLESS traffic stays on the individual VPS.

## Development

The service is part of the pnpm workspace. Install from the repository root with
`pnpm install --frozen-lockfile`, then run `pnpm --dir apps/control-plane dev`.
Use ignored `.dev.vars` for local test keys. Never deploy those development keys.

## Configuration

- `ADMIN_KEY`: random 32-byte base64url operator login key, stored as a Worker secret.
- `DATA_KEY`: random 32-byte base64url AES-GCM key, stored as a Worker secret.
- D1 binding `DB`: create `pingu-control`, apply `migrations/0001_control.sql`.
- Copy `wrangler.jsonc` to ignored `wrangler.production.json`, set the actual D1 ID
  and account ID, and deploy with `wrangler deploy --config wrangler.production.json`.
- Leave request logs/observability off: subscription paths contain bearer tokens.
- Preserve `DATA_KEY` securely with database backups. Losing it loses access to
  encrypted node credentials and cached subscriptions. Do not rotate it in place.

The node UI accepts an upsert array (omitted nodes are preserved):

```json
[
  {
    "id": "vps-a",
    "name": "VPS A",
    "origin": "https://node-a.example.com",
    "enabled": true,
    "key": "<dedicated-node-control-key>"
  }
]
```

Each node runs the updated `ops/vps/sbin/pingu_gate.py` and
`pingu_device_access.py`. Put a separate random 32-byte base64url credential into
`/etc/pingu-gate.control-token` (root:root, 0600). Without this file the new
provisioning API is disabled. This credential cannot log into the old operator
UI or create source-IP leases. The origin needs a publicly valid HTTPS endpoint
(e.g. its own proxied Cloudflare hostname). Do not point it at the control Worker.

In Pingu Desktop, import the general URL from the **订阅** page (the legacy
single-node import dialog accepts only one node). The current subscriptions
parser supports multiple VLESS lines and preserves the device WebSocket path.

After adding a node, use **同步全部设备**. Each existing device keeps its `/s/<token>`
URL. Node IDs/origins are immutable; register a replacement with a new ID so
revocation can still reach old assignments. `enabled=false` only removes the
node from subscription downloads; it does not revoke previously downloaded
credentials. To remove a device's access, use device revocation.

## Migration and failure behavior

- Existing VPS subscriptions and operator UI keep working unchanged. Their tokens
  cannot be recovered from the old digest-only registry. Create/import independent
  new subscriptions and migrate clients deliberately; never silently disable old ones.
- A repeated create with the same device ID is idempotent. A failed node remains
  in the assignment list; sync retries it. A temporary failure preserves the last
  usable cached URI. New nodes appear after a successful sync and client refresh.
- Revocation blocks the central feed immediately, then persists revocation on every
  assigned node, including hidden nodes. Unreachable nodes leave `revoking` and
  require a retry; the UI never reports them as fully revoked. Node tombstones
  prevent a delayed provision request from resurrecting the identity.
- The Gate rejects new WebSocket sessions after revocation. Existing relays retain
  the Gate's existing behavior and finish on disconnect or relay timeout.
- No administrator key or node credential is sent in URLs or included in public
  Git. D1 stores node keys, device tokens and URIs using AES-GCM with record-specific
  associated data. The UI renders user values as text and stores no browser secrets.
- Management sessions expire after one hour. Cookie mutations require same-origin
  requests; CLI requests may use the operator key in `Authorization: Bearer ...`.
- Maximum 16 nodes; no billing plan changes are required by this implementation.

## Verification

`pnpm --dir apps/control-plane test` uses real SQLite plus the Worker Request/Response code, covering
multi-node subscription generation, storage confidentiality, retry, revocation,
CSRF, and concurrent delayed provisioning. `pnpm --dir apps/control-plane build` validates the Worker
bundle with Wrangler. Node-side tests live alongside the existing Gate tests.
