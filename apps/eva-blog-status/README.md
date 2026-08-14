# Eva Status Publisher

`eva-blog-status` is a local-only author tool. It runs on the author's device
and sends public status updates to the private `eva-blog-admin` API. It is not
copied into `apps/eva-blog` and should not be deployed with the public reader.

It supports four signal types: work, activity, now playing, and token usage.
The local bridge executes AppleScript against Apple Music or Spotify on macOS;
it does not invent a track when neither player is active. For Token usage, an
explicit `EVA_BLOG_TOKEN_USAGE_FILE` snapshot takes precedence. Otherwise, in
the Codex desktop environment it reads only the latest `token_count` counter
from the current local Codex session (`EVA_BLOG_CODEX_SESSION_FILE` or
`EVA_BLOG_CODEX_THREAD_ID` / `CODEX_THREAD_ID`). If neither source is
available, the signal is `null`. Prompt text, assistant replies, credentials,
and the session transcript are never included in the status payload. Token
signals are private by default and must be explicitly marked public before they
appear in the reader.

Example token snapshot:

```json
{
  "usedTokens": 128000,
  "limitTokens": 256000,
  "provider": "OpenAI",
  "model": "gpt-5",
  "window": "current task",
  "resetAt": "2026-08-12T18:00:00+08:00"
}
```

```bash
pnpm dev
```

The default local URL is `http://127.0.0.1:4175`. The dev server refuses
non-loopback hosts so the local signal endpoint cannot be exposed on the
network. Configure the author API
origin in `app/index.html` when the private API is hosted elsewhere. The API
must allow this origin for credentialed requests and must enforce the GitHub
author allowlist. Click `Probe now` in the publisher to load local music and
token signals, then choose which signal to sync. The browser page never runs
automatic reporting; unattended reporting belongs to the background agent
below. The private `POST /api/status/auto` endpoint accepts the agent's nested
safe `meta` payload and strips all other fields before persistence.

## Background agent

For unattended reporting, use the CLI instead of leaving this browser page
open. In the author console, choose `Connect background agent`, copy the
short-lived setup token, then configure the local agent without putting the token
in shell history:

```bash
printf '%s' '<copied-token>' | pnpm daemon configure --token-stdin
pnpm daemon once
pnpm daemon run
```

The agent is a single Node process with one timer. Each cycle reads at most the
tail of the local Codex session log, asks the installed music players for their
current state, and sends only eligible safe summaries. It does not start a web
server, retain signal history, scan article content, or run overlapping polls.
Configuration is stored with `0700` directory / `0600` file permissions under
the platform config directory. Use `pnpm daemon status` to check local setup;
set `STATUS_DAEMON_TOKEN` for an ephemeral token in a service manager.

```bash
pnpm test
pnpm build
pnpm smoke:dev
pnpm verify
```
