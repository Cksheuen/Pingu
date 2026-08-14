# Eva Blog public reader deployment handoff

Deploy this app as the public reader. Deploy `apps/eva-blog-admin` separately
behind a private host/access layer, and run `apps/eva-blog-status` only on the
author's device.

## Recommended path

Use Cloudflare Pages for the static frontend with a Worker or Pages Function
for `/api/*`. Cloudflare D1 can provide shared production records and
Cloudflare KV can hold short-lived OAuth state. No custom VPS or manually
managed server is required.

## Public routes

- `GET /api/articles`
- `GET /api/articles/:slug`
- `GET /api/articles/:id/comments`
- `POST /api/articles/:id/comments` — requires a signed GitHub session
- `GET /api/archives`
- `GET /api/tags`
- `GET /api/series`
- `GET /api/artworks`
- `GET /api/artworks/:slug`
- `GET /api/status`
- `GET /feed.xml`
- `GET /sitemap.xml`
- `GET /robots.txt`
- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`

Author article/status write routes are intentionally absent from this Worker.
There is no public Admin or Status page and no mock session route.

## Environment variables

```text
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
SESSION_SECRET=
ALLOWED_ORIGINS=
ALLOWED_REDIRECT_ORIGINS=
BLOG_STORAGE_NAMESPACE=eva-blog-system-mvp
PUBLIC_SITE_ORIGIN=https://replace-with-public-domain.example
```

`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SESSION_SECRET` are required
for production GitHub OAuth and signed HTTP-only cookies. `ALLOWED_ORIGINS`
and `ALLOWED_REDIRECT_ORIGINS` must contain only approved private app origins.
Configure production secrets with `wrangler secret put`.

The public reader consumes stored published summaries and public statuses. It
does not expose the author publishing API or activity-summary provider. D1 is
connected through `BLOG_DB`; R2 is connected through `ARTWORK_BUCKET` and the
public Worker returns only display/thumb objects. Apply
`migrations/0001_blog_state.sql` before the first production write. Replace the
binding placeholders in `wrangler.toml` with account resource IDs.
