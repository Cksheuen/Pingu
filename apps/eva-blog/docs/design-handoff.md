# Eva Blog Public Reader Design Handoff

The public deployment is a content-first reader. Private authoring and status
publishing are separate apps and are not part of this page bundle.

## Pages

### Public Blog

- Landing reader with a latest-note lead and a featured sketchbook plate.
- Archive with search, year groups, tags, series, related-note paths, and empty states.
- Long-form reader with reading progress, TOC, Markdown headings/lists/code/images,
  copy-link action, AI digest, related notes, and comments.
- Now timeline with only sanitized public work/music signals; token usage is not
  public unless deliberately published by the author.
- Sketchbook gallery with an asymmetric folio grid, artwork detail pages,
  captions, artist notes, alt text, dimensions, license, and related articles.
- RSS 2.0 feed, sitemap, robots, canonical metadata, and Open Graph metadata.

## UI Element Inventory

- Public brand, section navigation, reader lead, folio artwork plate, archive
  index, timeline entries, artwork cards, article TOC, reader tools, comments,
  and banners.
- No Admin navigation, author editor, status form, session chip, or local login
  control is rendered by the public app.

## Forms And Actions

| Form | Fields | Actions |
| --- | --- | --- |
| Comment | body | Post comment; anonymous requests receive `401` |

## Data Objects

The reader consumes published `articles`, `artworks` with only display/thumb
derivatives, public `statuses`, `archives`, `tags`, `series`, `comments`, and
sanitized SEO fields. Original artwork keys, author inventory, drafts,
revisions, and sessions never enter the public response.

## Loading, Empty, And Error States

Cover app loading, no published articles/artworks, search-empty, no comments,
invalid comment body, anonymous comment rejection, unavailable artwork, feed
generation, and successful comment feedback.

## Design Model Prompts

Design a calm Silverwing-inspired public reading deck with frost surfaces,
graphite structure, restrained cobalt actions, cyan focus signals, and strong
article readability. Add a warmer paper folio for artwork, editorial asymmetry,
quiet plate labels, and deliberate whitespace. Avoid generic rounded cards,
gradients, glass effects, noisy dashboards, and author tools. Do not add
analytics, reactions, newsletters, moderation, or private deployment controls.
