import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const analytics = readFileSync(new URL("../src/analytics.ts", import.meta.url), "utf8");
const migrations = [
  readFileSync(new URL("../migrations/0003_indefinite_history.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0004_resource_versions.sql", import.meta.url), "utf8")
].join("\n");

test("indefinite-history migration never mutates or deletes listen events", () => {
  assert.doesNotMatch(migrations, /(?:DELETE\s+FROM|UPDATE|DROP\s+TABLE)\s+listen_events/i);
  assert.match(migrations, /track_resource_versions/);
  assert.match(migrations, /idx_listen_events_observed_at_id/);
});

test("future raw payloads are deduplicated without dropping event rows", () => {
  assert.match(analytics, /INSERT OR IGNORE INTO track_resource_versions/);
  assert.match(analytics, /resource_hash/);
  assert.match(analytics, /INSERT OR IGNORE INTO listen_events/);
  assert.doesNotMatch(analytics, /DELETE FROM listen_events/);
  assert.doesNotMatch(analytics, /INSERT OR REPLACE INTO listen_events/);
});

test("analytics aggregate in D1 instead of materializing the full ledger", () => {
  assert.match(analytics, /COUNT\(DISTINCT track_id\)/);
  assert.match(analytics, /GROUP BY \$\{groupBy\}/);
  assert.doesNotMatch(analytics, /function fetchEvents|const rows = await fetchEvents/);
});
