import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';

export const d1_migrations = sqliteTable("d1_migrations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  applied_at: text("applied_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [uniqueIndex("d1_migrations_name_unique").on(t.name)]);

export const auth_tokens = sqliteTable("auth_tokens", {
  provider: text("provider").primaryKey().notNull(),
  encrypted_token_json: text("encrypted_token_json").notNull(),
  updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const config = sqliteTable("config", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const listen_events = sqliteTable("listen_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  event_key: text("event_key").notNull(),
  track_id: text("track_id").notNull(),
  resource_type: text("resource_type").notNull(),
  name: text("name").notNull(),
  artist_name: text("artist_name"),
  album_name: text("album_name"),
  duration_ms: integer("duration_ms"),
  genre_names_json: text("genre_names_json"),
  artwork_url: text("artwork_url"),
  apple_url: text("apple_url"),
  source: text("source").notNull().default(sql`'recently_played'`),
  observed_at: text("observed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  raw_json: text("raw_json"),
  resource_hash: text("resource_hash"),
}, (t) => [index("idx_listen_events_observed_at_id").on(sql`${t.observed_at} DESC`, sql`${t.id} DESC`), index("idx_listen_events_artist").on(t.artist_name, t.observed_at), uniqueIndex("listen_events_event_key_unique").on(t.event_key)]);

export const analytics_state = sqliteTable("analytics_state", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const analytics_ingest_runs = sqliteTable("analytics_ingest_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  fetched_count: integer("fetched_count").notNull(),
  inserted_count: integer("inserted_count").notNull(),
  skipped_count: integer("skipped_count").notNull(),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const track_resource_versions = sqliteTable("track_resource_versions", {
  resource_hash: text("resource_hash").primaryKey().notNull(),
  track_id: text("track_id").notNull(),
  resource_type: text("resource_type").notNull(),
  raw_json: text("raw_json").notNull(),
  first_observed_at: text("first_observed_at").notNull(),
}, (t) => [index("idx_track_resource_versions_track").on(t.track_id, t.resource_type)]);

export const audit_log = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  client_id: text("client_id"),
  tool_name: text("tool_name").notNull(),
  action: text("action").notNull(),
  detail_json: text("detail_json"),
  created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("idx_audit_log_created_at").on(t.created_at)]);

export const collector_runs = sqliteTable("collector_runs", {
  id: text("id").primaryKey().notNull(),
  trigger_source: text("trigger_source").notNull(),
  status: text("status").notNull(),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
  previous_poll_at: text("previous_poll_at"),
  poll_interval_ms: integer("poll_interval_ms"),
  fetched_count: integer("fetched_count"),
  inserted_count: integer("inserted_count"),
  duplicate_event_count: integer("duplicate_event_count"),
  inferred_new_count: integer("inferred_new_count"),
  overlap_count: integer("overlap_count"),
  initial_snapshot: integer("initial_snapshot"),
  gap_detected: integer("gap_detected"),
  error_kind: text("error_kind"),
  apple_http_status: integer("apple_http_status"),
}, (t) => [index("idx_collector_runs_started_at").on(sql`${t.started_at} DESC`), check('collector_runs_status', sql`${t.status} IN ('running', 'succeeded', 'failed')`)]);


export const collector_control = sqliteTable('collector_control', {
  name: text('name').primaryKey().notNull(),
  owner: text('owner').notNull(),
  lease_until_ms: integer('lease_until_ms').notNull().default(0),
  cooldown_until_ms: integer('cooldown_until_ms').notNull().default(0),
}, t => [check('collector_control_lease_nonnegative', sql`${t.lease_until_ms} >= 0`),
  check('collector_control_cooldown_nonnegative', sql`${t.cooldown_until_ms} >= 0`)]);
