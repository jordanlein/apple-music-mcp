CREATE TABLE catalog_cache (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_catalog_cache_expiry ON catalog_cache(expires_at_ms);
