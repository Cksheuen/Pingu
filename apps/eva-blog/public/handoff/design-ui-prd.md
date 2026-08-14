# Eva Blog Public Reader Design Handoff

The public deployment is a calm, content-first reader for published articles.
It intentionally excludes the private author editor and status publisher.

## Public surface

- Published article list, search, metadata, tags, Markdown body, and summary.
- Public status strip sourced from the read-only status endpoint.
- Comment list and a comment submit surface; the Worker enforces GitHub auth.

## Visual direction

Use the Eva Silverwing system: frost-white reading surfaces, graphite shell,
restrained cobalt actions, and cyan focus/signal details. Keep the article body
readable and keep private tools out of navigation and page copy.

## Boundary

Admin editing, Markdown import, publishing, author session management, status
sync, and activity summaries belong to private sibling apps. They are not
rendered or mounted by this public reader.
