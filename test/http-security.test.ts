import assert from "node:assert/strict";
import test from "node:test";
import { HttpRequestError, readBoundedText, secureEqual } from "../src/http-security.ts";

test("bounded body reader accepts the expected content type", async () => {
  const request = new Request("https://example.test/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true })
  });

  assert.equal(await readBoundedText(request, 64, "application/json"), '{"ok":true}');
});

test("bounded body reader rejects oversized streamed bodies", async () => {
  const request = new Request("https://example.test/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "too large" })
  });

  await assert.rejects(
    () => readBoundedText(request, 8, "application/json"),
    (error: unknown) => error instanceof HttpRequestError && error.status === 413
  );
});

test("bounded body reader rejects unexpected encodings and media types", async () => {
  const compressed = new Request("https://example.test/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: "compressed"
  });
  const wrongType = new Request("https://example.test/submit", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}"
  });

  await assert.rejects(
    () => readBoundedText(compressed, 64, "application/json"),
    (error: unknown) => error instanceof HttpRequestError && error.status === 415
  );
  await assert.rejects(
    () => readBoundedText(wrongType, 64, "application/json"),
    (error: unknown) => error instanceof HttpRequestError && error.status === 415
  );
});

test("constant-time comparison checks the complete secret value", async () => {
  assert.equal(await secureEqual("correct-secret", "correct-secret"), true);
  assert.equal(await secureEqual("correct-secret", "correct-secret-extra"), false);
  assert.equal(await secureEqual("correct-secret", "wrong-secret"), false);
});
