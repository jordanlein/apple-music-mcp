-- Shared leases serialize collection across requests and Worker instances.
-- No existing history, diagnostics, or authorization rows are changed.
CREATE TABLE collector_control (
  name TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(lease_until_ms >= 0),
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(cooldown_until_ms >= 0)
);
