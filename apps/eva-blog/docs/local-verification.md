# Public reader local verification

This package is the public reader only. It contains published article reading,
public status display, and a comment submission surface. Article editing,
publishing, author identity, and status publishing are separate apps.

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify:handoff
pnpm dev
```

The default URL is `http://localhost:4173`. The local server exposes only the
public Worker routes. `POST /api/articles/:id/comments` rejects anonymous
requests with `401`; configure GitHub OAuth and `SESSION_SECRET` before testing
an authenticated comment.

## Manual flow

1. Confirm the seeded published article is visible.
2. Open an article and verify the summary, status strip, and comments list.
3. Submit a comment without a session and confirm the request is rejected.
4. Configure GitHub OAuth, authorize, then submit a comment again.
5. Confirm `/api/articles` never returns drafts and `POST /api/articles` and
   `POST /api/status` return `404` from the public Worker.

The public app does not render an Admin or Status route and does not expose a
local mock-login route.
