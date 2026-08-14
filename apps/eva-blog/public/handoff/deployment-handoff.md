# Eva Blog Public Reader Deployment Handoff

Deploy this app as the public static reader. Deploy `apps/eva-blog-admin` as a
separate private author API/editor and run `apps/eva-blog-status` only on the
author device.

## Public API Boundary

- `GET /api/articles`
- `GET /api/articles/:slug`
- `GET /api/articles/:id/comments`
- `POST /api/articles/:id/comments` (signed GitHub session required)
- `GET /api/status`
- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`

Author write routes, Admin UI, Status UI, and mock session routes are absent
from this public app.

Production requires `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`SESSION_SECRET`, and approved `ALLOWED_ORIGINS`/
`ALLOWED_REDIRECT_ORIGINS` values. The public and private apps should share a
durable production persistence boundary for published content and statuses.
