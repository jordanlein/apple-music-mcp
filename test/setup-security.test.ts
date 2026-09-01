import assert from "node:assert/strict";
import test from "node:test";
import { createSetupSession, verifySetupSession } from "../src/setup-session.ts";

const SECRET = "a-test-secret-long-enough-to-represent-production-use";
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

test("setup sessions validate only with the signing secret", async () => {
  const token = await createSetupSession(SECRET, NOW);

  assert.ok(await verifySetupSession(token, SECRET, NOW + 1_000));
  assert.equal(await verifySetupSession(token, `${SECRET}-different`, NOW + 1_000), undefined);
});

test("setup sessions reject tampering and expiration", async () => {
  const token = await createSetupSession(SECRET, NOW);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  assert.equal(await verifySetupSession(tampered, SECRET, NOW + 1_000), undefined);
  assert.equal(await verifySetupSession(token, SECRET, NOW + 10 * 60 * 1_000 + 1), undefined);
});
