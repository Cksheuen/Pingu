# Local verification

Run the private author API on port `4174`, then start this app on port `4175`.

```bash
pnpm --dir apps/eva-blog-admin dev
pnpm --dir apps/eva-blog-status dev
```

Open `http://127.0.0.1:4175`, authorize with GitHub, and submit a status. The
browser sends credentials to the author API; anonymous `POST /api/status`
requests must return `401`, and non-allowlisted GitHub users must return `403`.

Click `Read device` to verify the local signal bridge. On macOS it checks
Apple Music and Spotify for a playing or paused track. It also checks
`.local/eva-blog-token-usage.json` (or `EVA_BLOG_TOKEN_USAGE_FILE`) for a token
snapshot. When no explicit snapshot is configured and the app runs inside the
Codex desktop environment, it reads the current thread's local session log and
extracts only the latest `token_count` counters. Set
`EVA_BLOG_CODEX_SESSION_FILE` to select a session explicitly, or set
`EVA_BLOG_CODEX_THREAD_ID` / `CODEX_THREAD_ID` to select a thread. Prompt and
reply content is not read into the report and is never sent to the API. Token
usage is private by default; the public checkbox is an explicit opt-in.

For a sanitized direct probe, run this from the status app directory:

```bash
node --input-type=module <<'NODE'
import { readLocalSignals } from "./scripts/localSources.mjs";
const { tokenUsage, nowPlaying } = await readLocalSignals();
console.log({
  tokenUsage: tokenUsage && {
    provider: tokenUsage.provider,
    usagePercent: tokenUsage.usagePercent,
    unit: tokenUsage.unit,
    capturedAt: tokenUsage.capturedAt
  },
  nowPlaying
});
NODE
```

This probe intentionally omits raw token counts and does not print session
transcript data.

For unattended use, the browser page is only the setup/control surface:
authorize in the page, select `Connect background agent`,
copy the short-lived setup token, and run:

```bash
printf '%s' '<copied-token>' | pnpm --dir apps/eva-blog-status daemon configure --token-stdin
pnpm --dir apps/eva-blog-status daemon once
pnpm --dir apps/eva-blog-status daemon run
```

The local page reads `GET /api/local/agent` for a sanitized heartbeat. The
daemon has no HTTP listener, serializes its 60-second cycles, and only sends
the same safe private payload accepted by the Blog author API. `pnpm daemon
status` confirms local configuration without printing the token.
