# Verification evidence

The package gate is `pnpm verify`, which runs the Node tests, static build, and
bounded local dev-server smoke check.

Latest evidence: public reader 10/10, author console 14/14, and status
publisher 14/14 tests passed. Status built at 586 KB and its dev-server smoke
passed 4 checks; the author console build passed at 589 KB with 6 smoke
checks. Public/admin handoff checks remain covered by their package gates.

The current verification set covers structured music/token payloads, safe
automatic payload filtering, token privacy defaults, local token snapshot
normalization, the real Codex `token_count` adapter, macOS player probing,
non-macOS source fallbacks, the `/api/local/signals` contract, and a real
loopback HTTP flow that persists both private automatic records, and a spawned
background CLI that configures a scoped token, probes a real local source, and
persists a private status. The live probe
must report a Codex provider and percentage when the current session log is
available; it reports no music signal when Apple Music/Spotify has no active
track. No fixture is used as a fallback for an unavailable player.
