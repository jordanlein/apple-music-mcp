-- Immutable migration evidence keeps complete historical diagnostics without
-- recreating tens of thousands of indexed operational rows during cutover.
CREATE TABLE migration_archive (
  name TEXT PRIMARY KEY NOT NULL,
  encoding TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
