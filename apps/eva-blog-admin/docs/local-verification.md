# Private author workspace local verification

This package contains a private Web author workspace for article drafting,
Markdown import, and publishing only. Status publishing lives in the sibling
`apps/eva-blog-status` local app.

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify:handoff
pnpm dev
```

The editor defaults to `http://localhost:4174`. Its Worker protects article
save/publish, comment, summary, and status write routes with a signed GitHub
session plus the `AUTHOR_GITHUB_LOGINS` allowlist. The browser editor is a
private local drafting surface; production writes must go through the Worker.

## Manual flow

1. Open the private workspace and confirm the three desktop-first regions:
   Article archive, Writing desk, and Publication ledger.
2. Confirm the unauthorised view never loads article inventory; authorise an
   allowlisted GitHub account and confirm the private inventory then appears.
3. Save a new entry and confirm it remains a private draft. Use `Publish to
   reader` and confirm the ledger exposes the public-reader preview link.
4. Import a Markdown file and confirm it creates a new draft without replacing
   the entry currently being edited.
5. Use the `Status console` link in the private header to open the sibling
   local status app on port `4175`; status form and background-agent setup stay
   outside the article editor.
6. Use the local status app to publish a public status or connect the
   background agent.
7. Sign out and confirm the browser clears the in-memory article archive.
8. Confirm anonymous and non-allowlisted author API writes are rejected.
