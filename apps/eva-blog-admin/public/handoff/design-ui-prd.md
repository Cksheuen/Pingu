# Eva Blog Private Author Workspace Design Handoff

The private Web author workspace is a desktop-first writing instrument with
three deliberate regions: a graphite Article archive, ice-white Writing desk,
and pale-blue Publication ledger. Authors can save a private draft, import
Markdown as a new draft, or explicitly publish an entry to the separate public
reader. The public-preview link is not shown until publication succeeds.

GitHub authorization and the author allowlist gate the archive. The browser
only requests private inventory after that gate succeeds, and signing out clears
the in-memory archive from the page.

Status publishing is designed and implemented in `apps/eva-blog-status`, a
local-only app that calls the private author API with credentialed requests.
It is not a form or feature inside this author workspace.
