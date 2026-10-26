-- Preserve every existing row. Indexed maintenance replaces per-poll scans.
CREATE INDEX IF NOT EXISTS idx_analytics_ingest_runs_started_at
  ON analytics_ingest_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_collector_runs_status_started_at
  ON collector_runs(status, started_at DESC);
