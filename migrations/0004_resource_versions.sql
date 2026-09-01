-- Content-address future Apple payloads so repeated metadata is deduplicated
-- while every distinct version remains recoverable. Existing inline raw_json
-- values remain untouched and existing rows receive a nullable reference.
ALTER TABLE listen_events ADD COLUMN resource_hash TEXT;

CREATE TABLE IF NOT EXISTS track_resource_versions (
  resource_hash TEXT PRIMARY KEY NOT NULL,
  track_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  first_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_resource_versions_track
  ON track_resource_versions(track_id, resource_type);

PRAGMA optimize;
