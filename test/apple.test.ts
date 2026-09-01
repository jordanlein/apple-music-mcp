import assert from "node:assert/strict";
import test from "node:test";
import {
  AppleMusicApiError,
  fetchAppleMusicWithRetry,
  isEmptyPlaylistTracksError,
  mapWithConcurrency,
} from "../src/apple-transport.ts";

test("an empty playlist relationship is returned as an empty track list", async () => {
  const error = new AppleMusicApiError(
    404,
    JSON.stringify({
      errors: [{
        title: "No related resources",
        detail: "No related resources found for tracks",
        status: "404",
        code: "40403"
      }]
    })
  );
  assert.equal(isEmptyPlaylistTracksError(error), true);
});

test("unrelated playlist errors are not swallowed", async () => {
  const error = new AppleMusicApiError(404, JSON.stringify({ errors: [{ code: "40401" }] }));
  assert.equal(isEmptyPlaylistTracksError(error), false);
});

test("bounded concurrency preserves order and never exceeds its limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test("GET requests retry transient Apple responses", async () => {
  let calls = 0;
  const waits: number[] = [];
  const response = await fetchAppleMusicWithRetry("https://example.test", { method: "GET" }, {
    maxAttempts: 3,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
        : Response.json({ data: [] });
    },
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    }
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test("POST requests are not retried automatically", async () => {
  let calls = 0;
  const response = await fetchAppleMusicWithRetry("https://example.test", { method: "POST" }, {
    maxAttempts: 3,
    fetcher: async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    },
    sleep: async () => {}
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("hung requests are terminated by the configured timeout", async () => {
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test fetch was not aborted")), 1_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal?.reason);
    }, { once: true });
  });
  await assert.rejects(
    () => fetchAppleMusicWithRetry("https://example.test", { method: "GET" }, {
      maxAttempts: 1,
      timeoutMs: 5,
      fetcher,
      sleep: async () => {}
    }),
    /timed out after 5ms/
  );
});
