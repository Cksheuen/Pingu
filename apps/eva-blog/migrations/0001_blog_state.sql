CREATE TABLE IF NOT EXISTS blog_state (
  state_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO blog_state (state_id, payload, updated_at)
VALUES ('primary', '{"articles":[],"artworks":[],"comments":[],"revisions":[],"statuses":[]}', CURRENT_TIMESTAMP);
