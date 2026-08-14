# Verification evidence

The public reader gate is:

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify:handoff
pnpm verify
```

The current Node suite covers 10 tests: published-only reads, injected-session
comment creation, anonymous comment rejection, GitHub OAuth
state/cookie handling, the public Worker routes, and the absence of author
write/mock-session routes. The build
regenerates static assets and the smoke check uses a bounded loopback server.

Latest evidence: tests 10, pass 10, fail 0; Built dist; Dev server smoke passed.
Public status rendering also accepts structured now-playing metadata and
explicitly public token usage metadata; private token statuses remain filtered
by the author API before reaching this app.
