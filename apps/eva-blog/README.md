# Eva Blog Public Reader

Public-facing Eva Blog reader. This app contains only published article
reading, public status display, and a GitHub-authenticated comment submission
surface. Article authoring, publishing, and author status controls live in the separate
`apps/eva-blog-admin` app and are not included in this app's public bundle.
Public status text can summarize a synced now-playing track or an explicitly
public token usage signal; private token statuses are filtered at the API
boundary.

## Quick Start

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm dev
```

The local dev server runs at:

```text
http://localhost:4173
```

Use a different port when needed:

```bash
PORT=4180 pnpm dev
```

## Verification

Run the full local gate:

```bash
pnpm verify
```

The explicit package verification commands are:

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify:handoff
```

`pnpm smoke:dev` starts the local server on an open loopback port, checks the app shell, seed data, and public handoff runbook, then stops the server. In restricted sandboxes that reject loopback listen, it reports a bounded skip instead of hanging. `pnpm verify:handoff` checks the handoff docs, required environment variable documentation, Vercel config, Wrangler config, and GitHub Actions workflow.

## Product Surface

- `Public`: published article list, article detail, deterministic AI article summary, public status strip, authenticated comments.

## Project Layout

- `app/index.html`: static shell.
- `src/main.js`: public reader UI rendering and event binding.
- `src/domain/*`: public article/status read models and comment validation used by tests.
- `src/services/*`: local test API/storage boundaries; runtime reads and writes go through the public Worker.
- `server/worker.js`: Cloudflare Worker style API contract reference.
- `api/contracts.js`: shared route and env contract constants.
- `tests/*.test.mjs`: Node built-in test coverage.
- `docs/`: verification, deployment, and design handoff docs.

## Handoff Docs

- [Local Verification](docs/local-verification.md)
- [Deployment Handoff](docs/deployment-handoff.md)
- [Design Handoff](docs/design-handoff.md)
- [Verification Evidence](docs/verification-evidence.md)

No custom VPS or manually managed server is required for the recommended deployment path. Deploy the author console separately and keep its host private.
