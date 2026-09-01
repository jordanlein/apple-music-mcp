import { AppleMusicApi } from "./apple";
import { compactResource } from "./format";
import {
  decodeHistoryCursor,
  diffRecentSnapshots,
  encodeHistoryCursor,
  estimateObservedTimes,
  parseRecentSnapshot,
  RECENTLY_PLAYED_LIMIT,
  resourceFingerprint
} from "./recent-history";
import { resolveTimeframe, type ResolvedTimeframe, type TimeframeOptions } from "./timeframe";
import type { AppleResource, Env } from "./types";

const RECENT_SNAPSHOT_STATE_KEY = "recent_snapshot_v2";
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;
const RESOURCE_ARCHIVE_CHUNK_SIZE = 20;

export async function refreshRecentListeningAnalytics(env: Env, options: { limit?: number } = {}): Promise<AnalyticsRefreshResult> {
  const startedAt = new Date().toISOString();
  const api = new AppleMusicApi(env);
  const limit = Math.max(1, Math.min(options.limit ?? RECENTLY_PLAYED_LIMIT, RECENTLY_PLAYED_LIMIT));
  const resources = await api.recentlyPlayed(limit);
  const [snapshotValue, previousCursor] = await Promise.all([
    getAnalyticsState(env, RECENT_SNAPSHOT_STATE_KEY),
    getAnalyticsState(env, "recent_cursor_event_key")
  ]);
  const storedSnapshot = parseRecentSnapshot(snapshotValue);
  const previousFingerprints = storedSnapshot?.fingerprints ?? (previousCursor ? [previousCursor] : []);
  const fingerprints = resources.map(resourceFingerprint);
  const diff = diffRecentSnapshots(fingerprints, previousFingerprints);
  const newlyObserved = resources.slice(0, diff.newCount);
  const observedTimes = estimateObservedTimes(newlyObserved.length, startedAt, storedSnapshot?.capturedAt);
  const transitionId = await snapshotTransitionId(storedSnapshot?.capturedAt, previousFingerprints, fingerprints);
  const latestKey = fingerprints[0];
  let inserted = 0;
  let skipped = 0;

  // Keep every listen event and every distinct Apple payload version, while
  // deduplicating byte-identical payloads across repeated future plays.
  const resourcesWithTimes = await Promise.all(newlyObserved.map(async (resource, index) => {
    const rawJson = JSON.stringify(resource);
    return {
      resource,
      rawJson,
      resourceHash: await sha256Hex(rawJson),
      observedAt: observedTimes[index] ?? startedAt
    };
  }));
  const resourceStatements = chunk(resourcesWithTimes, RESOURCE_ARCHIVE_CHUNK_SIZE).map((resourceChunk) => {
    const placeholders = resourceChunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const values = resourceChunk.flatMap(({ resource, rawJson, resourceHash, observedAt }) => [
      resourceHash,
      resource.id,
      resource.type,
      rawJson,
      observedAt
    ]);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO track_resource_versions (resource_hash, track_id, resource_type, raw_json, first_observed_at)
       VALUES ${placeholders}`
    ).bind(...values);
  });

  const insertStatements = newlyObserved.map((resource, index) => {
    const eventKey = `v2:${transitionId}:${index}:${fingerprints[index]}`;
    const event = listenEventFromResource(resource, eventKey, observedTimes[index] ?? startedAt);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO listen_events
        (event_key, track_id, resource_type, name, artist_name, album_name, duration_ms, genre_names_json, artwork_url, apple_url, source, observed_at, resource_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recently_played', ?, ?)`
    )
      .bind(
        event.eventKey,
        event.trackId,
        event.resourceType,
        event.name,
        event.artistName,
        event.albumName,
        event.durationMs,
        JSON.stringify(event.genreNames),
        event.artworkUrl,
        event.appleUrl,
        event.observedAt,
        resourcesWithTimes[index]?.resourceHash ?? null
      );
  });
  if (insertStatements.length) {
    const results = await env.DB.batch([...resourceStatements, ...insertStatements]);
    for (const result of results.slice(resourceStatements.length)) {
      if (result.meta.changes > 0) inserted += 1;
      else skipped += 1;
    }
  }

  const stateStatements = [
    env.DB.prepare(
      "INSERT INTO analytics_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).bind(RECENT_SNAPSHOT_STATE_KEY, JSON.stringify({ capturedAt: startedAt, fingerprints })),
    env.DB.prepare(
      "INSERT INTO analytics_ingest_runs (source, fetched_count, inserted_count, skipped_count, started_at) VALUES ('recently_played', ?, ?, ?, ?)"
    ).bind(resources.length, inserted, skipped, startedAt),
    env.DB.prepare("DELETE FROM analytics_ingest_runs WHERE started_at < datetime('now', '-30 days')")
  ];
  if (latestKey) {
    stateStatements.push(
      env.DB.prepare(
        "INSERT INTO analytics_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
      ).bind("recent_cursor_event_key", latestKey)
    );
  }
  await env.DB.batch(stateStatements);

  return {
    source: "recently_played",
    fetched: resources.length,
    inserted,
    skipped,
    startedAt,
    latestCursorUpdated: Boolean(latestKey),
    inferredNewItems: diff.newCount,
    overlapItems: diff.overlapCount,
    initialSnapshot: diff.initialSnapshot,
    gapDetected: diff.gapDetected
  };
}

export async function recentListeningHistory(
  env: Env,
  options: TimeframeOptions & { limit?: number; cursor?: string } = {}
): Promise<RecentListeningHistory> {
  const cursor = decodeHistoryCursor(options.cursor);
  // A cursor carries the original resolved bounds so rolling presets do not
  // shift between pages and accidentally skip or repeat events.
  const window = cursor?.timeframe ?? resolveTimeframe(options);
  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT));
  const where = buildWindowWhere(window, undefined, cursor);
  const rowsStatement = env.DB.prepare(
    `SELECT id, track_id, resource_type, name, artist_name, album_name, duration_ms, genre_names_json, artwork_url, apple_url, observed_at
     FROM listen_events
     WHERE ${where.clause}
     ORDER BY observed_at DESC, id DESC
     LIMIT ?`
  ).bind(...where.values, limit + 1);
  const firstStatement = env.DB.prepare(
    "SELECT observed_at FROM listen_events ORDER BY observed_at ASC, id ASC LIMIT 1"
  );
  const statements = [rowsStatement, firstStatement];
  if (!cursor) {
    const countWhere = buildWindowWhere(window);
    statements.push(
      env.DB.prepare(`SELECT COUNT(*) AS count FROM listen_events WHERE ${countWhere.clause}`).bind(...countWhere.values)
    );
  }
  const results = await env.DB.batch<Record<string, unknown>>(statements);
  const fetched = (results[0]?.results ?? []) as unknown as ListenEventRow[];
  const firstRow = (results[1]?.results?.[0] ?? undefined) as { observed_at?: string } | undefined;
  const countRow = (results[2]?.results?.[0] ?? undefined) as { count?: number } | undefined;
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = rows.at(-1);
  const nextCursor = hasMore && last
    ? encodeHistoryCursor({ observedAt: last.observed_at, id: last.id, timeframe: window })
    : undefined;
  return {
    source: "cloudflare_d1_observed_history",
    query: {
      limit,
      timeframe: serializeTimeframe(window),
      cursorApplied: Boolean(cursor)
    },
    coverage: {
      matched: cursor ? undefined : Number(countRow?.count ?? 0),
      returned: rows.length,
      hasMore,
      collectorFirstObservedAt: firstRow?.observed_at,
      isExactPlayHistory: false,
      retention: "indefinite",
      note: coverageNote()
    },
    nextCursor,
    tracks: rows.map(rowToTrack)
  };
}

export async function listeningSummary(env: Env, options: TimeframeOptions = {}): Promise<ListeningSummary> {
  const window = resolveTimeframe(options);
  const statements = [
    windowStatement(env, `SELECT COUNT(*) AS plays,
      COALESCE(SUM(duration_ms), 0) AS duration_ms,
      COUNT(DISTINCT track_id) AS unique_tracks,
      COUNT(DISTINCT artist_name) AS unique_artists,
      COUNT(DISTINCT album_name) AS unique_albums,
      MIN(observed_at) AS first_observed_at,
      MAX(observed_at) AS last_observed_at
      FROM listen_events`, window),
    rankedStatement(env, "tracks", window, 10),
    rankedStatement(env, "artists", window, 10),
    rankedStatement(env, "albums", window, 10),
    rankedStatement(env, "genres", window, 10),
    windowStatement(env, `SELECT id, track_id, resource_type, name, artist_name, album_name, duration_ms,
      genre_names_json, artwork_url, apple_url, observed_at
      FROM listen_events`, window, "ORDER BY observed_at DESC, id DESC LIMIT 10")
  ];
  const results = await env.DB.batch<Record<string, unknown>>(statements);
  const totals = (results[0]?.results?.[0] ?? {}) as TotalsRow;
  const totalPlays = Number(totals.plays ?? 0);
  return {
    timeframe: serializeTimeframe(window),
    coverage: {
      eventCount: totalPlays,
      firstObservedAt: stringOrUndefined(totals.first_observed_at),
      lastObservedAt: stringOrUndefined(totals.last_observed_at),
      isCompletePeriod: false,
      retention: "indefinite",
      note: summaryCoverageNote()
    },
    totals: {
      plays: totalPlays,
      listeningMinutes: Math.round(Number(totals.duration_ms ?? 0) / 60000),
      uniqueTracks: Number(totals.unique_tracks ?? 0),
      uniqueArtists: Number(totals.unique_artists ?? 0),
      uniqueAlbums: Number(totals.unique_albums ?? 0)
    },
    topTracks: rankedRows(results[1], totalPlays),
    topArtists: rankedRows(results[2], totalPlays),
    topAlbums: rankedRows(results[3], totalPlays),
    topGenres: rankedRows(results[4], totalPlays),
    recentTracks: ((results[5]?.results ?? []) as unknown as ListenEventRow[]).map(rowToTrack)
  };
}

export async function appleReplaySummary(env: Env): Promise<AppleReplaySummary> {
  const api = new AppleMusicApi(env);
  const response = await api.replaySummary();
  const summary = response.data?.[0];
  return {
    source: "apple_music_replay",
    coverage: {
      isOfficialAppleReplay: true,
      period: stringOrNull(summary?.attributes?.period),
      year: numberOrNull(summary?.attributes?.year),
      note: "Official Apple Music Replay data for the latest eligible year. Apple exposes this separately from recently played history; use this for year-level totals and top content."
    },
    totals: extractReplayMetrics(response),
    topArtists: replayView(summary, "top-artists", "artist"),
    topAlbums: replayView(summary, "top-albums", "album"),
    topSongs: replayView(summary, "top-songs", "song"),
    rawSummary: summary ? {
      id: summary.id,
      type: summary.type,
      href: summary.href,
      attributes: summary.attributes,
      meta: summary.meta
    } : null
  };
}

export async function topListeningStats(
  env: Env,
  options: TimeframeOptions,
  kind: TopKind,
  limit: number
): Promise<TopStatsResult> {
  const window = resolveTimeframe(options);
  const capped = Math.max(1, Math.min(limit, 50));
  const totalsStatement = windowStatement(
    env,
    "SELECT COUNT(*) AS plays, MIN(observed_at) AS first_observed_at, MAX(observed_at) AS last_observed_at FROM listen_events",
    window
  );
  const results = await env.DB.batch<Record<string, unknown>>([
    totalsStatement,
    rankedStatement(env, kind, window, capped)
  ]);
  const totals = (results[0]?.results?.[0] ?? {}) as TotalsRow;
  const totalPlays = Number(totals.plays ?? 0);
  return {
    kind,
    timeframe: serializeTimeframe(window),
    items: rankedRows(results[1], totalPlays),
    coverage: {
      eventCount: totalPlays,
      firstObservedAt: stringOrUndefined(totals.first_observed_at),
      lastObservedAt: stringOrUndefined(totals.last_observed_at),
      isCompletePeriod: false,
      retention: "indefinite",
      note: summaryCoverageNote()
    }
  };
}

export async function analyticsStatus(env: Env): Promise<AnalyticsStatus> {
  const results = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM listen_events"),
    env.DB.prepare("SELECT observed_at FROM listen_events ORDER BY observed_at ASC, id ASC LIMIT 1"),
    env.DB.prepare("SELECT observed_at FROM listen_events ORDER BY observed_at DESC, id DESC LIMIT 1"),
    env.DB.prepare("SELECT source, fetched_count, inserted_count, skipped_count, started_at, finished_at FROM analytics_ingest_runs ORDER BY id DESC LIMIT 5"),
    env.DB.prepare("SELECT value FROM analytics_state WHERE key = 'recent_cursor_event_key'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM track_resource_versions")
  ]);
  const countRow = results[0]?.results?.[0] as { count?: number } | undefined;
  const firstRow = results[1]?.results?.[0] as { observed_at?: string } | undefined;
  const lastRow = results[2]?.results?.[0] as { observed_at?: string } | undefined;
  const runRows = (results[3]?.results ?? []) as unknown as IngestRunRow[];
  const cursor = results[4]?.results?.[0] as { value?: string } | undefined;
  const archivedRow = results[5]?.results?.[0] as { count?: number } | undefined;
  return {
    retention: "indefinite",
    listenEvents: countRow?.count ?? 0,
    archivedResourceVersions: archivedRow?.count ?? 0,
    firstObservedAt: firstRow?.observed_at,
    lastObservedAt: lastRow?.observed_at,
    hasRecentCursor: Boolean(cursor?.value),
    recentIngestRuns: runRows
  };
}

export type TopKind = "tracks" | "artists" | "albums" | "genres";

interface ListenEventRow {
  id: number;
  track_id: string;
  resource_type: string;
  name: string;
  artist_name: string | null;
  album_name: string | null;
  duration_ms: number | null;
  genre_names_json: string | null;
  artwork_url: string | null;
  apple_url: string | null;
  observed_at: string;
}

interface IngestRunRow {
  source: string;
  fetched_count: number;
  inserted_count: number;
  skipped_count: number;
  started_at: string;
  finished_at: string;
}

interface TotalsRow extends Record<string, unknown> {
  plays?: number;
  duration_ms?: number;
  unique_tracks?: number;
  unique_artists?: number;
  unique_albums?: number;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
}

interface RankedSqlRow extends Record<string, unknown> {
  key?: string;
  plays?: number;
  duration_ms?: number;
  track_id?: string;
  name?: string;
  artist_name?: string;
  album_name?: string;
  artwork_url?: string;
  apple_url?: string;
}

interface AnalyticsRefreshResult {
  source: "recently_played";
  fetched: number;
  inserted: number;
  skipped: number;
  startedAt: string;
  latestCursorUpdated: boolean;
  inferredNewItems: number;
  overlapItems: number;
  initialSnapshot: boolean;
  gapDetected: boolean;
}

interface RecentListeningHistory {
  source: "cloudflare_d1_observed_history";
  query: {
    limit: number;
    timeframe: ReturnType<typeof serializeTimeframe>;
    cursorApplied: boolean;
  };
  coverage: {
    matched?: number;
    returned: number;
    hasMore: boolean;
    collectorFirstObservedAt?: string;
    isExactPlayHistory: boolean;
    retention: "indefinite";
    note: string;
  };
  nextCursor?: string;
  tracks: Array<Record<string, unknown>>;
}

interface ListeningSummary {
  timeframe: ReturnType<typeof serializeTimeframe>;
  coverage: SummaryCoverage;
  totals: {
    plays: number;
    listeningMinutes: number;
    uniqueTracks: number;
    uniqueArtists: number;
    uniqueAlbums: number;
  };
  topTracks: RankedItem[];
  topArtists: RankedItem[];
  topAlbums: RankedItem[];
  topGenres: RankedItem[];
  recentTracks: Array<Record<string, unknown>>;
}

interface SummaryCoverage {
  eventCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  isCompletePeriod: boolean;
  retention: "indefinite";
  note: string;
}

interface AppleReplaySummary {
  source: "apple_music_replay";
  coverage: {
    isOfficialAppleReplay: true;
    period: string | null;
    year: number | null;
    note: string;
  };
  totals: Array<{ path: string; value: number | string }>;
  topArtists: ReplayRankedItem[];
  topAlbums: ReplayRankedItem[];
  topSongs: ReplayRankedItem[];
  rawSummary: Record<string, unknown> | null;
}

interface ReplayRankedItem {
  rank: number;
  periodSummaryId: string;
  periodSummaryType: string;
  resource?: Record<string, unknown>;
  periodSummaryAttributes?: Record<string, unknown>;
  periodSummaryMeta?: Record<string, unknown>;
}

interface TopStatsResult {
  kind: TopKind;
  timeframe: ReturnType<typeof serializeTimeframe>;
  items: RankedItem[];
  coverage: SummaryCoverage;
}

interface AnalyticsStatus {
  retention: "indefinite";
  listenEvents: number;
  archivedResourceVersions: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  hasRecentCursor: boolean;
  recentIngestRuns: IngestRunRow[];
}

interface RankedItem {
  rank: number;
  key: string;
  plays: number;
  listeningMinutes: number;
  share: number;
  sample?: Record<string, unknown>;
}

function buildWindowWhere(
  window: ResolvedTimeframe,
  alias?: string,
  cursor?: { observedAt: string; id: number }
): { clause: string; values: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (window.startIso) {
    conditions.push(`${prefix}observed_at >= ?`);
    values.push(window.startIso);
  }
  conditions.push(`${prefix}observed_at < ?`);
  values.push(window.endIso);
  if (cursor) {
    conditions.push(`(${prefix}observed_at < ? OR (${prefix}observed_at = ? AND ${prefix}id < ?))`);
    values.push(cursor.observedAt, cursor.observedAt, cursor.id);
  }
  return { clause: conditions.join(" AND "), values };
}

function windowStatement(
  env: Env,
  select: string,
  window: ResolvedTimeframe,
  suffix = "",
  alias?: string,
  extraValues: unknown[] = []
): D1PreparedStatement {
  const where = buildWindowWhere(window, alias);
  return env.DB.prepare(`${select} WHERE ${where.clause} ${suffix}`).bind(...where.values, ...extraValues);
}

function rankedStatement(env: Env, kind: TopKind, window: ResolvedTimeframe, limit: number): D1PreparedStatement {
  if (kind === "genres") {
    const where = buildWindowWhere(window, "e");
    return env.DB.prepare(
      `SELECT CAST(j.value AS TEXT) AS key, COUNT(*) AS plays, COALESCE(SUM(e.duration_ms), 0) AS duration_ms
       FROM listen_events e, json_each(COALESCE(e.genre_names_json, '[]')) j
       WHERE ${where.clause} AND CAST(j.value AS TEXT) <> '' AND lower(CAST(j.value AS TEXT)) <> 'music'
       GROUP BY CAST(j.value AS TEXT)
       ORDER BY plays DESC, duration_ms DESC, key ASC
       LIMIT ?`
    ).bind(...where.values, limit);
  }
  const select = kind === "tracks"
    ? `SELECT track_id AS key, COUNT(*) AS plays, COALESCE(SUM(duration_ms), 0) AS duration_ms,
       track_id, MAX(name) AS name, MAX(artist_name) AS artist_name, MAX(album_name) AS album_name,
       MAX(artwork_url) AS artwork_url, MAX(apple_url) AS apple_url
       FROM listen_events`
    : kind === "artists"
      ? `SELECT artist_name AS key, COUNT(*) AS plays, COALESCE(SUM(duration_ms), 0) AS duration_ms,
         MAX(artist_name) AS artist_name
         FROM listen_events`
      : `SELECT album_name || '||' || COALESCE(artist_name, '') AS key,
         COUNT(*) AS plays, COALESCE(SUM(duration_ms), 0) AS duration_ms,
         MAX(album_name) AS album_name, MAX(artist_name) AS artist_name, MAX(artwork_url) AS artwork_url
         FROM listen_events`;
  const nonNull = kind === "artists" ? "AND artist_name IS NOT NULL" : kind === "albums" ? "AND album_name IS NOT NULL" : "";
  const groupBy = kind === "tracks" ? "track_id" : kind === "artists" ? "artist_name" : "album_name, artist_name";
  return windowStatement(
    env,
    select,
    window,
    `${nonNull} GROUP BY ${groupBy} ORDER BY plays DESC, duration_ms DESC, key ASC LIMIT ?`,
    undefined,
    [limit]
  );
}

function rankedRows(result: D1Result<Record<string, unknown>> | undefined, totalPlays: number): RankedItem[] {
  return ((result?.results ?? []) as RankedSqlRow[]).map((row, index) => {
    const plays = Number(row.plays ?? 0);
    const sample = row.track_id || row.name || row.artist_name || row.album_name || row.artwork_url || row.apple_url
      ? {
          id: row.track_id,
          name: row.name ?? row.album_name,
          artistName: row.artist_name,
          albumName: row.album_name,
          artworkUrl: row.artwork_url,
          url: row.apple_url
        }
      : undefined;
    return {
      rank: index + 1,
      key: String(row.key ?? "Unknown"),
      plays,
      listeningMinutes: Math.round(Number(row.duration_ms ?? 0) / 60000),
      share: totalPlays ? Number((plays / totalPlays).toFixed(3)) : 0,
      sample
    };
  });
}

function serializeTimeframe(window: ResolvedTimeframe) {
  return {
    mode: window.mode,
    preset: window.preset,
    label: window.label,
    startIso: window.startIso,
    endIso: window.endIso,
    timeZone: window.timeZone
  };
}

function listenEventFromResource(resource: AppleResource, key: string, observedAt: string) {
  const compact = compactResource(resource);
  const attributes = resource.attributes ?? {};
  const genreNames = Array.isArray(attributes.genreNames) ? attributes.genreNames.map(String) : [];
  return {
    eventKey: key,
    trackId: resource.id,
    resourceType: resource.type,
    name: String(attributes.name ?? resource.id),
    artistName: stringOrNull(attributes.artistName),
    albumName: stringOrNull(attributes.albumName),
    durationMs: numberOrNull(attributes.durationInMillis),
    genreNames,
    artworkUrl: stringOrNull(compact.artworkUrl),
    appleUrl: stringOrNull(attributes.url),
    observedAt
  };
}

function rowToTrack(row: ListenEventRow): Record<string, unknown> {
  return {
    id: row.track_id,
    name: row.name,
    artistName: row.artist_name,
    albumName: row.album_name,
    durationInMillis: row.duration_ms,
    artworkUrl: row.artwork_url,
    url: row.apple_url,
    observedAt: row.observed_at
  };
}

function replayView(summary: AppleResource | undefined, viewName: string, relationshipName: string): ReplayRankedItem[] {
  const rows = summary?.views?.[viewName]?.data ?? [];
  return rows.map((row, index) => {
    const related = row.relationships?.[relationshipName]?.data?.[0];
    return {
      rank: index + 1,
      periodSummaryId: row.id,
      periodSummaryType: row.type,
      resource: related ? compactResource(related) : undefined,
      periodSummaryAttributes: row.attributes,
      periodSummaryMeta: row.meta
    };
  });
}

function extractReplayMetrics(value: unknown): Array<{ path: string; value: number | string }> {
  const metrics: Array<{ path: string; value: number | string }> = [];
  const interesting = /(minute|duration|play|count|total|time|hour|listen)/i;
  walkMetricValues(value, "$", interesting, metrics);
  return metrics.slice(0, 50);
}

function walkMetricValues(value: unknown, path: string, interesting: RegExp, metrics: Array<{ path: string; value: number | string }>): void {
  if (!value || metrics.length >= 50) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkMetricValues(item, `${path}[${index}]`, interesting, metrics));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (interesting.test(key) && (typeof child === "number" || typeof child === "string")) {
      metrics.push({ path: childPath, value: child });
    }
    walkMetricValues(child, childPath, interesting, metrics);
  }
}

async function getAnalyticsState(env: Env, key: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT value FROM analytics_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value;
}

async function snapshotTransitionId(
  previousCapturedAt: string | undefined,
  previous: string[],
  current: string[]
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({ previousCapturedAt, previous, current }));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function coverageNote(): string {
  return "Apple exposes only the latest 30 tracks and no play timestamps. The Cloudflare collector keeps every newly observed event indefinitely; observedAt is estimated within the polling interval, collection cannot backfill time before it started, and gaps are possible if more than 30 tracks change between polls.";
}

function summaryCoverageNote(): string {
  return "Observed-only indefinite ledger from Apple Music recently played. This is not a complete historical Apple Music total: collection begins when the collector starts, timestamps are estimated, and polling gaps remain possible. Use apple_music_replay_summary for Apple's official latest-year Replay totals.";
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
