-- Supports bounded newest-first keyset pagination without scanning or sorting
-- the complete listening ledger. Every existing event and raw payload remains
-- untouched; content-addressed payload storage is added by the next migration.
CREATE INDEX IF NOT EXISTS idx_listen_events_observed_at_id
  ON listen_events(observed_at DESC, id DESC);

-- The composite index covers all previous observed_at-only queries.
DROP INDEX IF EXISTS idx_listen_events_observed_at;

PRAGMA optimize;
