# Eva Blog Public Reader Runbook

This deployment contains the public reader only: published articles, public
status display, and authenticated comment submission. Article editing,
publishing, author identity, and status publishing are separate private apps.

```bash
pnpm test
pnpm build
pnpm smoke:dev
pnpm dev
```

The public reader defaults to `http://localhost:4173`. Anonymous comment
requests must return `401`; the public Worker has no article/status write
routes and no mock session route.
