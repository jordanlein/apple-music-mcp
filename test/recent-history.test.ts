import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHistoryCursor,
  diffRecentSnapshots,
  encodeHistoryCursor,
  estimateObservedTimes,
  parseRecentSnapshot
} from "../src/recent-history.ts";

test("initial snapshot stores every returned track", () => {
  assert.deepEqual(diffRecentSnapshots(["c", "b", "a"], []), {
    newCount: 3,
    overlapCount: 0,
    gapDetected: false,
    initialSnapshot: true
  });
});

test("unchanged snapshot stores no duplicate events", () => {
  assert.deepEqual(diffRecentSnapshots(["c", "b", "a"], ["c", "b", "a"]), {
    newCount: 0,
    overlapCount: 3,
    gapDetected: false,
    initialSnapshot: false
  });
});

test("new prefix is inferred from the longest overlap", () => {
  assert.equal(diffRecentSnapshots(["e", "d", "c", "b"], ["c", "b", "a"]).newCount, 2);
});

test("a repeated current track at the head is counted as a new play", () => {
  const result = diffRecentSnapshots(["a", "a", "b", "c"], ["a", "b", "c", "d"]);
  assert.equal(result.newCount, 1);
  assert.equal(result.overlapCount, 3);
});

test("a replayed item moved from inside the prior window is inferred", () => {
  const result = diffRecentSnapshots(["c", "a", "b", "d"], ["a", "b", "c", "d"]);
  assert.equal(result.newCount, 1);
  assert.equal(result.overlapCount, 2);
});

test("a completely replaced full Apple window reports a coverage gap", () => {
  const current = Array.from({ length: 30 }, (_, index) => `new-${index}`);
  const previous = Array.from({ length: 30 }, (_, index) => `old-${index}`);
  assert.equal(diffRecentSnapshots(current, previous).gapDetected, true);
});

test("estimated timestamps remain newest-first within the polling interval", () => {
  const values = estimateObservedTimes(3, "2026-07-25T12:05:00.000Z", "2026-07-25T12:00:00.000Z");
  assert.equal(values.length, 3);
  assert.ok(values[0] > values[1]);
  assert.ok(values[1] > values[2]);
  assert.ok(values.every((value) => value > "2026-07-25T12:00:00.000Z" && value < "2026-07-25T12:05:00.000Z"));
});

test("snapshot parser rejects malformed state", () => {
  assert.equal(parseRecentSnapshot('{"capturedAt":3,"fingerprints":[]}'), undefined);
  assert.deepEqual(parseRecentSnapshot('{"capturedAt":"2026-07-25T00:00:00Z","fingerprints":["a"]}'), {
    capturedAt: "2026-07-25T00:00:00Z",
    fingerprints: ["a"]
  });
});

test("history cursors round-trip without exposing query structure", () => {
  const cursor = {
    observedAt: "2026-07-25T12:00:00.000Z",
    id: 42,
    timeframe: {
      mode: "preset" as const,
      preset: "7d" as const,
      startIso: "2026-07-18T12:00:00.000Z",
      endIso: "2026-07-25T12:00:00.000Z",
      label: "Last 7 days",
      timeZone: "America/Denver"
    }
  };
  const encoded = encodeHistoryCursor(cursor);
  assert.doesNotMatch(encoded, /observedAt/);
  assert.deepEqual(decodeHistoryCursor(encoded), cursor);
});

test("malformed history cursors fail safely", () => {
  assert.throws(() => decodeHistoryCursor("not-a-valid-cursor"), /invalid or expired/);
});
