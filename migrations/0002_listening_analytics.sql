CREATE TABLE IF NOT EXISTS listen_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  track_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  name TEXT NOT NULL,
  artist_name TEXT,
  album_name TEXT,
  duration_ms INTEGER,
  genre_names_json TEXT,
  artwork_url TEXT,
  apple_url TEXT,
  source TEXT NOT NULL DEFAULT 'recently_played',
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_listen_events_observed_at
  ON listen_events(observed_at);

CREATE INDEX IF NOT EXISTS idx_listen_events_artist
  ON listen_events(artist_name, observed_at);

CREATE TABLE IF NOT EXISTS analytics_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analytics_ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  fetched_count INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
