# Private email address generator

Adds `/generator/` to the existing `temp-mail-worker`. Each generated address
forwards to one fixed, verified mailbox; addresses can be disabled independently.
It is a receive-and-forward service, not a separate SMTP/IMAP account per address.
The entered prefix is used directly: `mail` creates `mail@your-domain`, with no
random suffix. Existing addresses are reported as conflicts. Previously created
addresses that contain random suffixes remain valid and can still be managed.

The deployed Worker source was recovered on 2026-10-08 into `src/legacy.js`.
The wrapper preserves its health endpoints, existing mailbox APIs and KV data.
Only records created by this generator (`forward-address:` keys) use forwarding.
Other addresses retain the existing incoming-email behavior. Disabled generated
addresses retain their record and reject incoming mail rather than falling back
to the old mailbox. Forwarded message bodies are not stored by this generator.

## Run and verify

Install with the workspace's `pnpm install`, then:

```sh
pnpm --dir apps/email-generator test
pnpm --dir apps/email-generator build
pnpm --dir apps/email-generator dev
```

Use ignored `.dev.vars` for local `GENERATOR_PASSWORD` and `FORWARD_TO` values.
Open `http://localhost:8791/generator/`. Wrangler's local email simulation is not
proof that Gmail received a message.

## Production configuration

Copy `wrangler.jsonc` to ignored `wrangler.production.json` and set the existing
Worker name, account, KV binding ID, allowed `EMAIL_DOMAINS`, and any existing
plain-text variables. Preserve the existing compatibility configuration.
Keep existing DNS, email catch-all rules, routes, and old secrets intact.

- `GENERATOR_PASSWORD`: a separate strong Worker secret, used only by this UI/API.
- `FORWARD_TO`: the user's verified external destination, stored as a Worker secret.
- `ADMIN_PASSWORD`: existing mailbox secret, left intact by `--keep-vars`.

Export the old script and settings before deploy; keep exports and credentials
outside Git. Deploy the existing Worker with `--keep-vars`, leaving `routes` and
`addresses` omitted. Configure no new Email Routing rules or catch-all takeover.
Verify public health, authenticated address generation/list/toggle, and the
rendered page after deployment. Record the previous deployment version for
rollback. Retain the KV data on rollback so existing messages are not lost.

The generator password is held only in page memory, never localStorage or a URL.
The UI/API is no-store, denies framing and cross-origin API calls, and renders
labels as text. The app accepts no client-controlled forwarding destination.

KV is eventually consistent: creating, enabling or disabling an address usually
takes about a minute to become visible across locations, sometimes longer.
Disabling is not an immediate global revocation guarantee. Forwarding errors
propagate from the email handler, rather than silently returning success.
Cloudflare accepts forwarding only to verified destination addresses. A real
incoming email and destination inbox confirmation are needed for end-to-end
acceptance. Do not infer mailbox arrival from an HTTP check or a mocked forward.

Sources: [Email Workers](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
[verified destinations](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
