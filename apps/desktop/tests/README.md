# Desktop tests

`pnpm test` is incremental. It compares each module's source, tests and production
dependencies with its last successful local run. An unchanged verified module is
skipped, including when earlier work is still uncommitted. On a fresh checkout,
every unstamped module is unverified and selected once.
Pass stamps live in ignored `.test-dist/passed-scopes.json`; failures never gain
a stamp. Deleting `.test-dist` discards the cache.

| Command (from apps/desktop) | Purpose |
| --- | --- |
| `pnpm test --plan` | Show which modules need verification |
| `pnpm test` | Run only changed modules and affected consumers |
| `pnpm test --scope logs` | Force only log writer/process tests |
| `pnpm test --scope traffic,lifecycle` | Force these two modules |
| `pnpm test:frontend` | Run state-management tests without Cargo |
| `pnpm test --scope ui` | Typecheck UI; follow with a focused UI check |
| `pnpm test:all` | Explicit full regression |

The root command `pnpm test:desktop` uses the same incremental runner. The old
`test:functional:ts` name is kept as an alias for `test:frontend`.

`scripts/test-scopes.mjs` owns the source-to-module mapping. Changes to production
dependencies invalidate consumers; changes to a module's tests invalidate only
that module. Cargo still compiles one library test binary (the crate boundary),
then libtest runs the selected module filters as a union; a full Rust selection
runs the binary once. This does not claim to compile each Rust module independently.
New unowned source or test files require a mapping, and `cargo check --bins` owns
the main/diagnostic binaries plus the library modules they consume;
rendering and live network checks are not silently replaced by broad unit tests.
Ownership is checked against the complete default source/test inventory, not a
Git diff, so committed files cannot disappear from validation. Manual routing
and debug scripts such as `scripts/test-routing.py` remain explicit opt-in
commands; the feature-gated fake-Mihomo fixture is likewise excluded.

## Coverage and removals

Rust tests are beside the module they exercise: traffic stream/reconnection,
log persistence, node parsing/import, configuration migration, routing,
preflight, Gate, lifecycle and shutdown. Tests use local fixtures. The npm
registry environment fixture now serializes access and restores its prior value;
port selection uses an OS-assigned occupied port.

Removed six generated Rust chains. Three repeated configuration/runtime unit
tests, one asserted assignments and `clone()` as persistence, one assumed fixed
ports were free, and one duplicated config generation checks. The unique config
compatibility, port fallback and controller-port contracts were moved to their
own modules. Removed eight additional redundant cases, including a derived
default check, a constructed probe-result check, duplicate stream startup,
formatting and subscription paths. The retained formatting test also drops an
assertion whose predicate was always true. Rust count: 102 → 90.

Removed the five frontend mega-chains, their per-command Rust process harness,
and the mock `test-driver` binary. That driver simulated connection state and
could not validate Tauri lifecycle or network connectivity. The modular
frontend tests exercise the real Zustand stores and view transforms with
controlled IPC responses:
request deduplication, unchanged-poll notification suppression, failure/retry,
parallel atomic refresh, and preservation on status-request failure. These are
state-management tests, not rendered component or native UI tests. `listNodes`
and `getProxyInfo` currently catch errors and return fallback values; the failed
refresh test deliberately exercises the propagating `getStatus` path.

The Mihomo release audit removed six more low-value cases: one pure standard-
library address filter, two lifecycle tests that only called an assignment
helper or compared hand-built snapshots, two routing cases strictly subsumed by
stronger source-isolation/filter tests, and one duplicated provider/filter test
harness consolidated into a table that retains both membership branches.
Retained tests still cover shutdown rejection, preflight identity,
runtime-directory ownership, multi-controller close routing, source-local group
membership, credential redaction, and failure rollback. Three focused Rust
regressions were added for unsafe subscription/provider URL authorities, resolver answer-set
validation for the app-owned fetch, and rule payload preservation while
namespacing policies. Two fast Node runner tests cover planning/ownership plus
transactional execution/cache behavior. Current inventory: 132 Rust tests (2
opt-in real-Mihomo tests ignored normally) and 12 Node tests.

The app-owned HTTPS subscription fetch disables inherited proxies and connects
only to its vetted resolver result. Native Mihomo proxy/rule providers are a
different, trusted-subscription capability: Pingu validates their initial URL
authority and isolates cache paths, but Mihomo performs subsequent provider
DNS, redirects, downloads and refreshes with native network access. Imports
with remote providers therefore emit a secret-free warning in the existing UI;
this is an explicit trust limitation, not provider isolation.

Keep a test only when its failure identifies a broken observable contract.
Parameter tables are appropriate for variants of one contract; unrelated
behaviors belong in separate module tests. Do not use test count as coverage.
