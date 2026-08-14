# Verification evidence

The private author editor gate is:

```bash
pnpm install
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify:handoff
pnpm verify
```

Latest evidence: tests 19, pass 19, fail 0; Built dist (598 KB); Dev server smoke
passed (7 checks); handoff verification passed. Coverage includes article
domain operations, OAuth contract shape, guarded article/status/comment Worker
routes, allowlisted author writes, the absence of the mock-session route, the
browser author API boundary, session-aware inventory loading, draft/publish
controller flows, Markdown-import error feedback, and sign-out state clearing.
