export const migrationTables = {
  "d1_migrations": {
    "columns": [
      "id",
      "name",
      "applied_at"
    ],
    "primaryKey": "id"
  },
  "auth_tokens": {
    "columns": [
      "provider",
      "encrypted_token_json",
      "updated_at"
    ],
    "primaryKey": "provider"
  },
  "config": {
    "columns": [
      "key",
      "value",
      "updated_at"
    ],
    "primaryKey": "key"
  },
  "listen_events": {
    "columns": [
      "id",
      "event_key",
      "track_id",
      "resource_type",
      "name",
      "artist_name",
      "album_name",
      "duration_ms",
      "genre_names_json",
      "artwork_url",
      "apple_url",
      "source",
      "observed_at",
      "raw_json",
      "resource_hash"
    ],
    "primaryKey": "id"
  },
  "analytics_state": {
    "columns": [
      "key",
      "value",
      "updated_at"
    ],
    "primaryKey": "key"
  },
  "analytics_ingest_runs": {
    "columns": [
      "id",
      "source",
      "fetched_count",
      "inserted_count",
      "skipped_count",
      "started_at",
      "finished_at"
    ],
    "primaryKey": "id"
  },
  "track_resource_versions": {
    "columns": [
      "resource_hash",
      "track_id",
      "resource_type",
      "raw_json",
      "first_observed_at"
    ],
    "primaryKey": "resource_hash"
  },
  "audit_log": {
    "columns": [
      "id",
      "client_id",
      "tool_name",
      "action",
      "detail_json",
      "created_at"
    ],
    "primaryKey": "id"
  },
  "collector_runs": {
    "columns": [
      "id",
      "trigger_source",
      "status",
      "started_at",
      "finished_at",
      "previous_poll_at",
      "poll_interval_ms",
      "fetched_count",
      "inserted_count",
      "duplicate_event_count",
      "inferred_new_count",
      "overlap_count",
      "initial_snapshot",
      "gap_detected",
      "error_kind",
      "apple_http_status"
    ],
    "primaryKey": "id"
  }
  ,"collector_control": {
    "columns": ["name", "owner", "lease_until_ms", "cooldown_until_ms"],
    "primaryKey": "name"
  }
} as const;
