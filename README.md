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

## Desktop network sources (Mihomo)

`apps/desktop` runs a Mihomo core as its proxy engine and owns the whole
runtime: it generates the core config, starts and stops the core, talks to it
over a loopback controller, and drives the macOS system proxy. The packaged app
supplies the core binary as a build input (`PINGU_MIHOMO_BIN`); a repo build can
instead resolve a core from `PATH`. An imported
subscription is never executed directly — only routing data (`proxies`,
`proxy-groups`, `proxy-providers`, `rule-providers`, `rules`, `dns`) is taken
from it, and app-owned settings such as `mixed-port`, `external-controller`,
`secret` and `tun` are dropped with a reported warning.

Multiple sources can stay enabled at once. A source can be an HTTPS subscription
URL, Mihomo/Clash YAML, a proxy-provider payload, or a base64/URI node list:

- **HTTPS URL** — a single `https://` line. The app follows no redirects; a
  non-200 response is reported instead of being followed.
- **Mihomo/Clash YAML** — a config or provider document. Only the six routing
  keys above are kept; every other key becomes an import warning.
- **Proxy-provider payload** — a YAML mapping of proxies and groups, accepted as
  a normal source body.
- **base64 / URI list** — one node per line; the body is auto-detected against
  base64 when no line contains `://`. Up to 2000 nodes. Duplicate display names
  get an occurrence suffix so no node is lost.

**Source namespacing.** Enabled sources are kept from colliding at the top
level. The top-level `proxies`, `proxy-groups`, `proxy-providers` and
`rule-providers` entries a source declares are renamed
`<source name> [<id prefix>] / <name>`, and `include-all`, `include-all-proxies`
and `include-all-providers` are recomposed per source instead of being passed to
the core, which would otherwise build one group from every top-level proxy in
the document. Membership is resolved against that source's own objects, in the
core's order (explicit references first, then include-all matches over sorted
names with the filter patterns), on the source's *original* names, so an
anchored `filter` pattern keeps its meaning after the prefix is added.

This is a rename of declared keys, not a total isolation guarantee: node names
that arrive at runtime inside a provider payload are not renamed, and global
provider choices can still share display names across sources. What is
guaranteed is that a source's own *groups* resolve only against its own declared
proxies and providers.

**Source-local groups.** `url-test` (shown as automatic selection), `fallback`
and `select` groups are preserved as authored, with their `filter`,
`exclude-filter`, `empty-fallback`, `default-selected` and provider `use`
references rewritten to the namespaced names. The core keeps whatever provider
groups inherit globally, so provider node names are never renamed and provider
filtering stays native to the core. The app additionally injects
`Pingu Auto` (a `url-test` over every imported proxy) and `Pingu Proxy` (a
`select` over all sources, used as the router's default target). Manual group
selections — including provider nodes — and the saved active node are emitted
as native `default-selected` values. If a saved member disappears, Mihomo falls
back to the first available member.

**Compatibility bounds.** Import is deliberate about what it refuses, because a
silently changed policy is worse than a rejected import:

- **4 MiB** per source; the desktop dialog and the backend both measure bytes.
- **HTTPS redirects are currently rejected** — a 3xx response is reported, never
  followed.
- **Provider URLs must be HTTPS** for both `proxy-providers` and
  `rule-providers`; local file providers cannot be imported. Remote provider
  caches are written under the app-owned `providers/` path.
- **Common URI fields are supported; advanced options should use YAML.** The URI
  parser understands the common VLESS/VMess/Shadowsocks/Trojan/Hysteria2/SOCKS/
  HTTP fields (server, port, credentials, TLS/SNI, and WS host/path). It does
  *not* reject every unknown option: for most schemes only selected query keys
  are read, so an unrecognized option is not necessarily an error. Where the
  parser genuinely cannot represent a node it rejects the entry and points at
  YAML — a Shadowsocks URI carrying plugin options is the explicit case. Treat
  YAML as the reliable path for anything beyond the common fields.
- **Generator-evaluated static filters are bounded by Rust `regex`.** For static
  proxies, the generator evaluates `exclude-filter` before namespacing explicit
  lists, and evaluates `filter` / `exclude-filter` while resolving include-all
  lists. Each `` ` ``-separated segment is compiled with Rust `regex`; a pattern
  Mihomo's `regexp2` accepts but the generator cannot is reported rather than
  silently dropped. Provider-only filtering remains native to Mihomo.
- **Mixed static proxies + providers + `exclude-filter` is rejected explicitly.**
  This applies whether the static proxies are listed directly or resolved from
  include-all. Mihomo applies the exclusion to both real providers and the
  compatible provider synthesized for static proxies, so one pattern cannot be
  preserved for both without changing membership. The error asks for separate
  groups or removal of `exclude-filter`.

This is not a claim that every generic subscription works. Imports that use an
unsupported protocol, transport or option are reported at import time; the
supported set is the VLESS/VMess/Shadowsocks/Trojan/Hysteria2/SOCKS/HTTP URI
families plus whatever the YAML path allows, minus the rejections above.

**Live connections.** The Connections page lists active connections from the
loopback controller — target, source, matched rule and route, per-connection
traffic and duration — and closes one connection or all of them. Credentials
never reach the page: the controller secret is generated in the app process and
only ever sent as a bearer header to `127.0.0.1`.

**App-owned runtime settings.** The generated config binds `mixed-port` to a
loopback-only listener (default `2080`, advancing to the next free port when it
is taken), sets `external-controller` to `127.0.0.1:<port>`, and keeps
`allow-lan: false`, `mode: rule` and `ipv6: false`. No `tun` section is
emitted, and no TUN device or privileged helper is started. The macOS system
proxy is set to the app's own loopback listener and cleared again on stop — the
app only clears a system proxy it recorded itself as owning.

**Retained manual nodes and the legacy config directory.** Manual VLESS nodes
keep their IDs and share-link secrets; an active manual node is selected through
Mihomo's native `default-selected`. App state still lives in the existing
per-user config directory `sing-proxy` — on
macOS that is
`~/Library/Application Support/sing-proxy`, on Linux `~/.config/sing-proxy` —
holding `config.json` for app state, `gate.json` for the Gate endpoint, and
`logs/` for the daily `sing-proxy-<date>.log` files, which are pruned after
7 days.

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
