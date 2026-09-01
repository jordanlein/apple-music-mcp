import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
const registrations = source.split("server.registerTool(").slice(1);

test("all 14 tools publish titles, use guidance, and safety annotations", () => {
  assert.equal(registrations.length, 14);
  for (const registration of registrations) {
    const config = registration.slice(0, registration.indexOf("async"));
    assert.match(config, /title:\s*"[^"]+"/);
    assert.match(config, /description:\s*"Use (when|to|only|for)/);
    assert.match(config, /annotations:\s*[A-Z_]+/);
  }
});

test("playlist workflow metadata teaches batching and sequencing", () => {
  assert.match(source, /do not call this once per song/);
  assert.match(source, /call apple_music_add_tracks_to_playlist once with the complete track batch/);
  assert.match(source, /Prefer one call containing the complete batch/);
  assert.match(source, /Each track needs an id, term, or name/);
});

test("analytics metadata distinguishes observed history from official Replay", () => {
  assert.match(source, /use apple_music_replay_summary for official year-level totals/);
  assert.match(source, /apple_music_recently_played for a paged track sequence/);
  assert.match(source, /apple_music_top_stats for one ranked category/);
});

test("history tools expose efficient preset and custom timeframes", () => {
  assert.match(source, /timeframePresetValues/);
  assert.match(source, /Custom inclusive start/);
  assert.match(source, /nextCursor/);
  assert.match(source, /max\(200\)\.default\(50\)/);
  assert.doesNotMatch(source, /withinHours|withinDays|fullWeek/);
});

test("heavy rotation schema matches Apple's actual limit", () => {
  const registration = source.split('server.registerTool(\n    "apple_music_heavy_rotation"')[1]?.split("server.registerTool(")[0] ?? "";
  assert.match(registration, /max\(10\)\.default\(10\)/);
  assert.doesNotMatch(registration, /max\(100\)|default\(25\)/);
});

test("playlist verification never reports propagation delay as false", () => {
  assert.match(source, /pending_apple_propagation/);
  assert.match(source, /verificationPassed: added\.length && pendingVerification\.length === 0 \? true : undefined/);
  assert.doesNotMatch(source, /verificationPassed:[^\n]*false/);
});
