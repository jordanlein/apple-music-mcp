CREATE TABLE `analytics_ingest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`fetched_count` integer NOT NULL,
	`inserted_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text,
	`tool_name` text NOT NULL,
	`action` text NOT NULL,
	`detail_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_created_at` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`provider` text PRIMARY KEY NOT NULL,
	`encrypted_token_json` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collector_control` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`lease_until_ms` integer DEFAULT 0 NOT NULL,
	`cooldown_until_ms` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collector_control_lease_nonnegative" CHECK("collector_control"."lease_until_ms" >= 0),
	CONSTRAINT "collector_control_cooldown_nonnegative" CHECK("collector_control"."cooldown_until_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE `collector_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_source` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`previous_poll_at` text,
	`poll_interval_ms` integer,
	`fetched_count` integer,
	`inserted_count` integer,
	`duplicate_event_count` integer,
	`inferred_new_count` integer,
	`overlap_count` integer,
	`initial_snapshot` integer,
	`gap_detected` integer,
	`error_kind` text,
	`apple_http_status` integer,
	CONSTRAINT "collector_runs_status" CHECK("collector_runs"."status" IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_collector_runs_started_at` ON `collector_runs` ("started_at" DESC);--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `d1_migrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `d1_migrations_name_unique` ON `d1_migrations` (`name`);--> statement-breakpoint
CREATE TABLE `listen_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`track_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`name` text NOT NULL,
	`artist_name` text,
	`album_name` text,
	`duration_ms` integer,
	`genre_names_json` text,
	`artwork_url` text,
	`apple_url` text,
	`source` text DEFAULT 'recently_played' NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`raw_json` text,
	`resource_hash` text
);
--> statement-breakpoint
CREATE INDEX `idx_listen_events_observed_at_id` ON `listen_events` ("observed_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `idx_listen_events_artist` ON `listen_events` (`artist_name`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `listen_events_event_key_unique` ON `listen_events` (`event_key`);--> statement-breakpoint
CREATE TABLE `track_resource_versions` (
	`resource_hash` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`raw_json` text NOT NULL,
	`first_observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_track_resource_versions_track` ON `track_resource_versions` (`track_id`,`resource_type`);