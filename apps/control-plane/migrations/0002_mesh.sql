ALTER TABLE devices ADD COLUMN mesh_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN mesh_generation TEXT;
CREATE TABLE mesh_assignments (
  device_id TEXT NOT NULL REFERENCES devices(id),
  generation TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  state TEXT NOT NULL CHECK(state IN ('active','revoking','revoked')),
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(device_id,generation)
);
