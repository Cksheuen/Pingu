# Eva Blog Private Author Design Handoff

This app is a private, desktop-first Web author workspace. Status publishing is
deliberately separated into `apps/eva-blog-status`, a local-only publisher on
the author's device.

## Pages

### Author Workspace

- `Article archive` is a private draft/published inventory. It is fetched only
  after the session is confirmed to be an allowlisted author.
- `Writing desk` is the large ice-white Markdown composition surface with
  headline, reader path, tags, import, save, and explicit publish actions.
- `Publication ledger` makes the public/private boundary visible: it shows
  reader time, stored excerpt/summary, visibility, and a public reader preview
  only after publishing.
- `Gallery desk` is a separate folio workspace for artwork title, alt text,
  medium, caption, artist note, related article, safe display derivatives,
  and explicit private/public gallery actions.
- The writing desk adds scheduled publishing, series/order, related paths,
  SEO description, publishing checks, unpublish, and revision restore.
- GitHub authorization is handled by the private API; this UI does not fake a
  local user session.

## UI Element Inventory

- Private-host signal, GitHub authorization link, article archive, desktop
  writing desk, Markdown import control, explicit draft/publish controls,
  publication ledger, reader preview bridge, gallery desk/contact sheet,
  derivative upload status, revision trail, quality check, and success/error
  notices.
- The reader preview opens the separate public reader; no public reader route,
  author inventory route, or status publishing form is rendered in this app.

## Forms And Actions

| Form | Fields | Actions |
| --- | --- | --- |
| Writing desk | title, slug, tags, lifecycle, schedule, series, related paths, SEO description, content | Save draft/changes, publish, schedule, unpublish, restore revision, import Markdown |
| Gallery desk | title, image URL or prepared upload, alt text, medium, caption, artist note, related article | Save private sketch, hang in gallery, unhang |

## Data Objects

Articles contain lifecycle timestamps, series/related metadata, SEO description,
excerpt, reading time, summary, and revision records. Artworks contain private
original/display/thumb object keys; only display/thumb derivatives are exposed
to the public reader. Author writes are guarded by a signed GitHub session and
`AUTHOR_GITHUB_LOGINS`.

## Loading, Empty, And Error States

Cover unauthorised access without inventory disclosure, empty inventory, new
article, existing draft, published article, required title/content errors,
import errors, successful save/publish feedback, and sign-out clearing the
in-memory archive.

## Design Model Prompts

Design a focused Silverwing authoring instrument: graphite archive shell,
ice-white writing desk, pale-blue publication ledger, and a warmer paper
sketchbook folio. Use compact mono metadata, cobalt publish actions, cyan focus
signals, small editorial plate labels, and an asymmetric archive → manuscript
→ publication → gallery rhythm. On small screens the writing desk leads,
followed by publication state, archive, and gallery. Avoid generic dashboards,
gradients, glass effects, and decorative HUD noise. Do not add status controls;
those belong to the local status publisher.
