CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  key_cipher TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_cipher TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoking','revoked')),
  created_at TEXT NOT NULL
);
CREATE TABLE assignments (
  device_id TEXT NOT NULL REFERENCES devices(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  state TEXT NOT NULL CHECK(state IN ('pending','active','error','revoked')),
  uri_cipher TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(device_id, node_id)
);
CREATE TABLE login_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
