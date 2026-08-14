# Eva Blog private author API handoff

Deploy this API separately from the public reader and keep its host private.
Use GitHub OAuth and the low-ops Cloudflare Pages/Workers path. No custom VPS
is required.
The local status publisher at `apps/eva-blog-status` is the only UI for status
publishing; the editor UI is the only UI for article drafting/publishing.

## Routes

```text
GET  /api/articles
GET  /api/articles/:slug
POST /api/articles                         # authenticated author
POST /api/articles/:id/publish             # authenticated author
POST /api/articles/:id/unpublish           # authenticated author
GET  /api/articles/:id/revisions            # authenticated author
POST /api/articles/:id/restore             # authenticated author
GET  /api/articles/:id/check               # authenticated author
GET  /api/artworks                         # authenticated author
POST /api/artworks                        # authenticated author
POST /api/artworks/:id/publish             # authenticated author
POST /api/artworks/:id/unpublish           # authenticated author
POST /api/media/upload                     # authenticated author, original + safe derivatives
GET  /api/articles/:id/comments
POST /api/articles/:id/comments             # authenticated GitHub user
GET  /api/status
POST /api/status                            # authenticated author
POST /api/status/auto                       # authenticated author, safe private background sync
POST /api/status/daemon-token               # authenticated author, scoped CLI token
POST /api/summaries/activity                # authenticated author
GET /api/session
GET  /api/auth/github/start
GET  /api/auth/github/callback
POST /api/logout
```

There is no mock session route. Article/status writes require a valid signed
HTTP-only GitHub session whose login is included in `AUTHOR_GITHUB_LOGINS`.
Status payloads support `kind: "song"` with structured track metadata and
`kind: "token"` with usage metadata. Token statuses should normally use
`isPublic: false`; the local publisher defaults them to private.
The automatic route strips raw token counts, provider/model/window fields,
music album/URL/artwork fields, free-form details, and public visibility before
persisting the report.
The daemon-token route is cookie-authenticated and returns a short-lived
`status:auto` bearer token. That token is accepted only by `/api/status/auto`
and cannot read articles, comments, sessions, or public status history.

## Environment

| Name | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | OAuth authorization start |
| `GITHUB_CLIENT_SECRET` | OAuth callback token exchange |
| `SESSION_SECRET` | HMAC signing for the HTTP-only session cookie |
| `AUTHOR_GITHUB_LOGINS` | comma-separated author allowlist |
| `ALLOWED_ORIGINS` | credentialed requests from `eva-blog-status` |
| `ALLOWED_REDIRECT_ORIGINS` | approved OAuth callback redirect origins |
| `AI_PROVIDER` | hosted article/activity summaries |
| `AI_API_KEY` | hosted AI provider credential |
| `BLOG_STORAGE_NAMESPACE` | local/deployment namespace label |
| `BLOG_DB` | Cloudflare D1 binding for the durable aggregate state |
| `OAUTH_STATE_KV` | Cloudflare KV binding for expiring OAuth state |
| `ARTWORK_BUCKET` | R2 bucket for private originals and public derivatives |

Configure secrets through the host secret manager, for example:

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put AUTHOR_GITHUB_LOGINS
wrangler secret put AI_API_KEY
```

Cloudflare Pages/Workers with Cloudflare D1, KV, and R2 is the preferred
low-ops production shape. D1 stores the versioned `blog_state` aggregate,
KV stores short-lived OAuth state, and R2 stores original artwork plus browser-
prepared WebP display/thumb derivatives. Run the migration in
`migrations/0001_blog_state.sql`; the Worker switches to D1 whenever `BLOG_DB`
is bound, while local development keeps the file-backed adapter.

When `AI_PROVIDER` is empty or set to `deterministic-fallback`, local summaries
remain stable and do not require an external AI credential.
