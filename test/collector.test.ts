import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Production uses Worker bundler resolution for extensionless TS imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
});
const { refreshRecentListeningAnalytics, analyticsStatus } = await import("../src/analytics.ts");
const { AppleMusicApi } = await import("../src/apple.ts");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0001_init", "0002_listening_analytics", "0003_indefinite_history", "0004_resource_versions", "0005_generic_audit_log", "0006_collector_diagnostics", "0007_collector_control"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8"));
  }
  let failEventInsert = false;
  const db = {
    prepare(sql: string) {
      const statement = {
        sql, values: [] as any[],
        bind(...values: any[]) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null; },
        async run() { return execute(this); }
      };
      return statement;
    },
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(execute);
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
  function execute(statement: any) {
    if (failEventInsert && statement.sql.includes("INSERT OR IGNORE INTO listen_events")) throw new Error("simulated storage failure");
    const prepared = sqlite.prepare(statement.sql);
    if (/^SELECT/i.test(statement.sql)) return { results: prepared.all(...statement.values), meta: { changes: 0 } };
    const result = prepared.run(...statement.values);
    return { results: [], meta: { changes: result.changes } };
  }
  return { sqlite, env: { DB: db } as any, failInserts: () => { failEventInsert = true; } };
}

function tracks(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, type: "songs", attributes: { name: `Song ${i}`, durationInMillis: 180_000 } }));
}

test("collector records empty and successful scheduled polls with a complete snapshot", async (t) => {
  const { sqlite, env } = database();
  t.after(() => sqlite.close());
  let response = tracks("old", 30);
  t.mock.method(AppleMusicApi.prototype, "recentlyPlayed", async (limit: number) => {
    assert.equal(limit, 30);
    return response;
  });
  const initial = await refreshRecentListeningAnalytics(env, { limit: 1, trigger: "scheduled" });
  assert.equal(initial.inserted, 30);
  assert.equal(initial.initialSnapshot, true);
  const unchanged = await refreshRecentListeningAnalytics(env);
  assert.equal(unchanged.inserted, 0);
  assert.equal(unchanged.overlapItems, 30);
  response = tracks("new", 30);
  const replaced = await refreshRecentListeningAnalytics(env);
  assert.equal(replaced.gapDetected, true);
  const run = sqlite.prepare("SELECT * FROM collector_runs WHERE id = ?").get(replaced.runId)!;
  assert.equal(run.status, "succeeded");
  assert.equal(run.gap_detected, 1);
  assert.equal(run.overlap_count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM listen_events").get()!.n, 60);
  const status = await analyticsStatus(env);
  assert.equal(status.recentCollectorRuns.length, 3);
  assert.equal(status.collector.timestampsAreEstimated, true);
});

test("an empty response does not erase a snapshot or duplicate its returning tracks", async (t) => {
  const { sqlite, env } = database();
  t.after(() => sqlite.close());
  let response = tracks("a", 3);
  t.mock.method(AppleMusicApi.prototype, "recentlyPlayed", async () => response);
  await refreshRecentListeningAnalytics(env);
  const previous = sqlite.prepare("SELECT value FROM analytics_state WHERE key = 'recent_snapshot_v2'").get()!.value;
  response = [];
  await refreshRecentListeningAnalytics(env);
  assert.equal(sqlite.prepare("SELECT value FROM analytics_state WHERE key = 'recent_snapshot_v2'").get()!.value, previous);
  response = tracks("a", 3);
  const result = await refreshRecentListeningAnalytics(env);
  assert.equal(result.inserted, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM listen_events").get()!.n, 3);
});

test("Apple failures persist safe diagnostics and leave the snapshot intact", async (t) => {
  const { sqlite, env } = database();
  t.after(() => sqlite.close());
  const { AppleMusicApiError } = await import("../src/apple-transport.ts");
  t.mock.method(AppleMusicApi.prototype, "recentlyPlayed", async () => { throw new AppleMusicApiError(401, "private token must never be logged"); });
  await assert.rejects(refreshRecentListeningAnalytics(env), /Apple Music API 401/);
  const run = sqlite.prepare("SELECT * FROM collector_runs").get()!;
  assert.equal(run.status, "failed");
  assert.equal(run.apple_http_status, 401);
  assert.equal(run.error_kind, "apple_api_error");
  assert.doesNotMatch(JSON.stringify(run), /private token/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analytics_state").get()!.n, 0);
});

test("a failed event write rolls back payloads and snapshot advancement", async (t) => {
  const db = database();
  t.after(() => db.sqlite.close());
  t.mock.method(AppleMusicApi.prototype, "recentlyPlayed", async () => tracks("a", 3));
  db.failInserts();
  await assert.rejects(refreshRecentListeningAnalytics(db.env), /simulated storage failure/);
  for (const table of ["listen_events", "track_resource_versions", "analytics_state"]) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
  }
  assert.equal(db.sqlite.prepare("SELECT status FROM collector_runs").get()!.status, "failed");
});

test('concurrent scheduled and MCP requests share one durable collection lease', async (t) => {
  const {sqlite, env} = database(); t.after(() => sqlite.close());
  let finish!: (value: any[]) => void;
  let called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  let calls = 0;
  t.mock.method(AppleMusicApi.prototype, 'recentlyPlayed', async () => {
    calls++; called(); return new Promise<any[]>(resolve => { finish = resolve; });
  });
  const first = refreshRecentListeningAnalytics(env, {trigger: 'scheduled'});
  await started;
  const second = await refreshRecentListeningAnalytics(env, {trigger: 'mcp'});
  assert.equal(second.deferred, 'busy');
  assert.equal(calls, 1);
  finish(tracks('a', 3));
  assert.equal((await first).inserted, 3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM collector_runs').get()!.n, 1);
  assert.equal(sqlite.prepare("SELECT lease_until_ms FROM collector_control WHERE name='recently_played'").get()!.lease_until_ms, 0);
});

test('Apple 429 persists its complete cooldown across requests without advancing the snapshot', async (t) => {
  const {sqlite, env} = database(); t.after(() => sqlite.close());
  const {AppleMusicApiError} = await import('../src/apple-transport.ts');
  let calls = 0;
  t.mock.method(AppleMusicApi.prototype, 'recentlyPlayed', async () => { calls++; throw new AppleMusicApiError(429, 'private body', '900'); });
  const before = Date.now();
  await assert.rejects(refreshRecentListeningAnalytics(env), /429/);
  const row = sqlite.prepare("SELECT * FROM collector_control WHERE name='recently_played'").get()!;
  assert.ok(Number(row.cooldown_until_ms) >= before + 900_000);
  assert.equal((await refreshRecentListeningAnalytics(env)).deferred, 'cooldown');
  assert.equal(calls, 1);
  const status = await analyticsStatus({...env, COLLECTOR_POLL_INTERVAL_SECONDS: '120'});
  assert.equal(status.collector.expectedPollIntervalMs, 120_000);
  assert.ok(status.collector.cooldownUntil);
  assert.equal(status.collector.collectionInProgress, false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_state').get()!.n, 0);
  assert.equal(sqlite.prepare('SELECT apple_http_status FROM collector_runs').get()!.apple_http_status, 429);
});

test('an expired writer cannot commit after a successor takes the lease or release its lease', async (t) => {
  const {sqlite, env} = database(); t.after(() => sqlite.close());
  t.mock.method(AppleMusicApi.prototype, 'recentlyPlayed', async () => {
    sqlite.prepare("UPDATE collector_control SET owner='successor', lease_until_ms=? WHERE name='recently_played'").run(Date.now()+180_000);
    return tracks('stale', 3);
  });
  await assert.rejects(refreshRecentListeningAnalytics(env), /CHECK constraint failed/);
  for (const table of ['listen_events', 'track_resource_versions', 'analytics_state']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
  }
  assert.equal(sqlite.prepare("SELECT owner FROM collector_control WHERE name='recently_played'").get()!.owner, 'successor');
});

test('leases recover after crashes and standalone KV maintenance is claimed only once an hour', async (t) => {
  const {sqlite, env} = database(); t.after(() => sqlite.close());
  const {acquireLease, claimScheduledMaintenance, recordRateLimitCooldown, COLLECTION_CONTROL} = await import('../src/collector-control.ts');
  const now = Date.now();
  assert.equal((await acquireLease(env.DB, COLLECTION_CONTROL, 'old', now)).acquired, true);
  assert.equal((await acquireLease(env.DB, COLLECTION_CONTROL, 'other', now + 10)).acquired, false);
  assert.equal((await acquireLease(env.DB, COLLECTION_CONTROL, 'new', now + 180_000)).acquired, true);
  await recordRateLimitCooldown(env.DB, 300_000, now);
  assert.equal((await acquireLease(env.DB, COLLECTION_CONTROL, 'retry', now + 200_000)).acquired, false);
  assert.equal((await acquireLease(env.DB, COLLECTION_CONTROL, 'retry', now + 400_000)).acquired, true);
  assert.equal(await claimScheduledMaintenance(env.DB, now), true);
  assert.equal(await claimScheduledMaintenance(env.DB, now + 120_000), false);
  assert.equal(await claimScheduledMaintenance(env.DB, now + 3_600_000), true);
});


test('a missing lease row prevents history and snapshot writes', async (t) => {
  const {sqlite, env} = database(); t.after(() => sqlite.close());
  t.mock.method(AppleMusicApi.prototype, 'recentlyPlayed', async () => {
    sqlite.prepare("DELETE FROM collector_control WHERE name='recently_played'").run();
    return tracks('stale', 3);
  });
  await assert.rejects(refreshRecentListeningAnalytics(env), /CHECK constraint failed/);
  for (const table of ['listen_events', 'track_resource_versions', 'analytics_state']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
  }
});
