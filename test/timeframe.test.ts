import assert from "node:assert/strict";
import test from "node:test";
import { resolveTimeframe } from "../src/timeframe.ts";

const now = new Date("2026-08-30T18:00:00.000Z");

test("timeframes default to a bounded rolling seven days", () => {
  const timeframe = resolveTimeframe({}, now);
  assert.equal(timeframe.preset, "7d");
  assert.equal(timeframe.startIso, "2026-08-23T18:00:00.000Z");
  assert.equal(timeframe.endIso, now.toISOString());
});

test("all-time has no artificial lower bound", () => {
  const timeframe = resolveTimeframe({ preset: "all_time" }, now);
  assert.equal(timeframe.startIso, undefined);
  assert.equal(timeframe.label, "All observed history");
});

test("calendar presets honor America/Denver instead of UTC", () => {
  const today = resolveTimeframe({ preset: "today", timeZone: "America/Denver" }, now);
  assert.equal(today.startIso, "2026-08-30T06:00:00.000Z");

  const ytd = resolveTimeframe({ preset: "ytd", timeZone: "America/Denver" }, now);
  assert.equal(ytd.startIso, "2026-01-01T07:00:00.000Z");
});

test("last year uses exact calendar-year boundaries", () => {
  const timeframe = resolveTimeframe({ preset: "last_year", timeZone: "America/Denver" }, now);
  assert.equal(timeframe.startIso, "2025-01-01T07:00:00.000Z");
  assert.equal(timeframe.endIso, "2026-01-01T07:00:00.000Z");
});

test("custom ranges require unambiguous offsets and valid ordering", () => {
  const timeframe = resolveTimeframe({
    start: "2026-08-01T00:00:00-06:00",
    end: "2026-08-15T00:00:00-06:00"
  }, now);
  assert.equal(timeframe.startIso, "2026-08-01T06:00:00.000Z");
  assert.equal(timeframe.endIso, "2026-08-15T06:00:00.000Z");
  assert.throws(() => resolveTimeframe({ start: "2026-08-01" }, now), /with Z or a UTC offset/);
  assert.throws(() => resolveTimeframe({ end: "2026-08-01T00:00:00Z" }, now), /requires a custom start/);
  assert.throws(() => resolveTimeframe({ preset: "30d", start: "2026-08-01T00:00:00Z" }, now), /not both/);
});

test("future custom endpoints and invalid time zones are rejected", () => {
  assert.throws(() => resolveTimeframe({
    start: "2026-08-01T00:00:00Z",
    end: "2026-09-01T00:00:00Z"
  }, now), /cannot be in the future/);
  assert.throws(() => resolveTimeframe({ preset: "today", timeZone: "Mars/Olympus" }, now), /Invalid IANA time zone/);
});
