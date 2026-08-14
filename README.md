# Pingu workspace

This repository contains independently built applications:

- `apps/desktop` — the Pingu Tauri desktop client.
- `apps/portal` — the public `cksheuen.site` landing page.
- `apps/eva-blog` — the public Eva Blog reader only.
- `apps/eva-blog-admin` — the private Eva Blog article editor/API.
- `apps/eva-blog-status` — the local-only author status publisher.

The Eva Blog public reader and author console are separate deployables. The
public app does not include Admin/Status author UI or author write routes. Keep
the author API/editor private or behind an access layer. Run the status
publisher only on the author's device, and connect the public/private apps to
the same production persistence boundary. The status publisher supports work,
activity, now-playing music, and token-usage signals; token usage is private by
default. Music is read from the local player through macOS AppleScript, while
Token usage can come from a local producer snapshot or the current Codex
session's local `token_count` counters. Automatic reporting is handled only by
the configured local CLI, which sends private safe summaries without transcript
content or credentials; the browser author page never needs to remain open.

Eva Blog public modules now include:

- Reader home: latest note, featured folio plate, and public signal ribbon.
- Archive: search, year index, tags, series, related-note paths, and long-form
  reader entry points.
- Long-form reader: TOC, progress cue, Markdown code/image rendering, copy
  link, digest, related notes, and comments.
- Now: public timeline for sanitized work/music signals; token usage remains
  private by default.
- Sketchbook: artwork folio grid and detail pages with captions, artist notes,
  alt text, dimensions, license, and related articles.
- Distribution: RSS 2.0 feed, sitemap, robots, canonical, and Open Graph.

The private author app additionally owns scheduling, preview, revisions,
publishing checks, unpublish, artwork derivative upload, and gallery lifecycle.
Durable deployment uses D1 for the blog state, KV for OAuth state, and R2 for
private originals plus public display/thumb derivatives. Local development
continues to use the shared file-backed state.

## Development

```bash
pnpm install
pnpm dev:desktop
pnpm dev:portal
pnpm dev:eva-blog
pnpm dev:eva-blog-admin
pnpm dev:eva-blog-status
```

The local status app can stay headless after author setup:

```bash
printf '%s' '<daemon-token>' | pnpm --dir apps/eva-blog-status daemon configure --token-stdin
pnpm --dir apps/eva-blog-status daemon run
```

It uses one serialized 60-second timer, does not serve a network port, and
sends only private safe status summaries to the author API.

Development ports:

- Desktop: `1420`
- Portal: `1422`
- Public Eva Blog: `4173`
- Private author editor/API: `4174`
- Local status publisher: `4175`

## Build

```bash
pnpm build
pnpm check:vps
pnpm test:vps
```

Independent Eva Blog checks:

```bash
pnpm verify:eva-blog
pnpm verify:eva-blog-admin
pnpm verify:eva-blog-status
```

## Desktop proxy diagnostics

```bash
pnpm debug:proxy:status
pnpm check:config
pnpm debug:proxy:start
pnpm test:routing
```

`pnpm verify:routing` runs the desktop routing smoke chain end to end.

## VPS Gate

The desktop client renews a short-lived IP lease before connecting and every
five minutes while connected. The server implementation and deployment notes
are in `ops/vps`.

The live VPS inventory captured during import is recorded in
`ops/vps/remote-manifest.json`. To verify that the remote host has not drifted
from that snapshot:

```bash
PINGU_VPS_IDENTITY=/path/to/private-key pnpm audit:vps
```

The audit is read-only. Runtime secrets, Xray credentials, subscriptions,
firewall state, reports, and logs are intentionally excluded from this repo.
