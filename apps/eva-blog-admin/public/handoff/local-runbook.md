# Eva Blog Private Author Runbook

This app contains article drafting, Markdown import, and publishing. Status
publishing is intentionally moved to the local `apps/eva-blog-status` app.

```bash
pnpm test
pnpm build
pnpm smoke:dev
pnpm dev
```

The editor defaults to `http://localhost:4174`. Keep the host private and
configure GitHub OAuth, `SESSION_SECRET`, and `AUTHOR_GITHUB_LOGINS` before
allowing write requests.
