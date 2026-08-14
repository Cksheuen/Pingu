# Eva Author Workspace

Private author app for Eva Blog. It contains article drafting, markdown import,
and publishing in a desktop-first Web workspace. It is intended to be deployed
separately from the public reader and must not be mounted under the public
blog's static output. Status publishing is in the sibling
`apps/eva-blog-status` local app.

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
http://localhost:4174
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

`pnpm smoke:dev` starts the local server on an open loopback port, checks the app shell, private API boundary, and handoff runbook, then stops the server. In restricted sandboxes that reject loopback listen, it reports a bounded skip instead of hanging. `pnpm verify:handoff` checks the handoff docs, required environment variable documentation, Vercel config, Wrangler config, and GitHub Actions workflow.

## Product Surface

- `Article archive`: a private inventory of drafts and published notes.
- `Writing desk`: create/edit title, reader path, tags, Markdown, and imported
  Markdown drafts.
- `Publication ledger`: shows visibility, reader time, saved summary, and a
  public-reader preview only after explicit publication.

The writing desk uses a separate author controller and API service boundary:
the view renders workspace state and dispatches events, the controller handles
session-aware author flows, and `src/services/authorApi.js` is the sole browser
API caller.

The editor reads and writes through the private Worker. Local `4173` and
`4174` servers share `.local/eva-blog-state.json`; production should replace
that ignored file adapter with durable storage.

## Project Layout

- `app/index.html`: private author shell.
- `src/main.js`: author workspace rendering and event binding.
- `src/authorController.js`: session-aware author state and write flows.
- `src/domain/*`: pure article, comment, and status domain logic.
- `src/services/*`: browser author API, auth contract, local domain API used by
  tests, storage, and summary provider boundaries.
- `server/worker.js`: Cloudflare Worker style API contract reference.
- `api/contracts.js`: shared route and env contract constants.
- `tests/*.test.mjs`: Node built-in test coverage.
- `docs/`: verification, deployment, and design handoff docs.

## Handoff Docs

- [Local Verification](docs/local-verification.md)
- [Deployment Handoff](docs/deployment-handoff.md)
- [Design Handoff](docs/design-handoff.md)
- [Verification Evidence](docs/verification-evidence.md)

The public reader lives in the sibling `apps/eva-blog` app. Both apps share the
same API contract and should use the same production persistence boundary.
