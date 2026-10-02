-- Preserve existing history and add a durable record of every poll attempt.
-- Legacy ingest runs describe successful polls only and cannot be backfilled
-- with failure or overlap details that were never recorded.
CREATE TABLE collector_runs (
  id TEXT PRIMARY KEY NOT NULL,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  previous_poll_at TEXT,
  poll_interval_ms INTEGER,
  fetched_count INTEGER,
  inserted_count INTEGER,
  duplicate_event_count INTEGER,
  inferred_new_count INTEGER,
  overlap_count INTEGER,
  initial_snapshot INTEGER,
  gap_detected INTEGER,
  error_kind TEXT,
  apple_http_status INTEGER
);

CREATE INDEX idx_collector_runs_started_at ON collector_runs(started_at DESC);
