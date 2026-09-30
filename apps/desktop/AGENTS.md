# Desktop testing

- Run `pnpm test --plan` before verification. `pnpm test` selects changed modules
  and their consumers, and skips inputs already verified in this checkout.
- For a bounded change use `pnpm test --scope <module>`; inspect
  `scripts/test-scopes.mjs` for ownership and dependencies. Update that mapping
  when adding a module or changing its dependencies.
- Use `pnpm test:all` for a deliberate cross-module regression or release gate.
  Do not repeat full tests/builds after a local change when relevant checks pass.
- Rust tests live beside their module in `<module>/tests.rs`. Keep each test
  focused on one behavior or failure mode. Use isolated ports, files and state.
- Add tests for observable behavior and credible regressions. Do not assert
  constants, language/standard-library behavior, or repeat lower-level coverage
  in synthetic end-to-end chains. Remove redundant cases instead of accumulating
  them. A mock's success is not evidence of native UI or proxy connectivity.
- UI changes require a focused visual/interaction check. Typecheck and store
  tests alone do not verify rendering. Live proxy/VPS checks are explicit, not
  part of routine local tests.
