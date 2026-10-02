import assert from "node:assert/strict";
import test from "node:test";
import { requireSitesOwner } from "../src/sites-access.ts";

test("Sites MCP refuses absent identity and unconfigured ownership", () => {
  const request = new Request("https://example.test/mcp");
  assert.equal(requireSitesOwner(request, undefined)?.status, 503);
  assert.equal(requireSitesOwner(request, "owner@example.test")?.status, 401);
});

test("sharing the Site does not grant another visitor the owner's Apple Music", () => {
  const request = new Request("https://example.test/mcp", { headers: {
    "oai-authenticated-user-id": "another-user",
    "oai-authenticated-user-email": "visitor@example.test"
  } });
  assert.equal(requireSitesOwner(request, "owner@example.test")?.status, 403);
});

test("the verified owner can use the Sites MCP endpoint", () => {
  const request = new Request("https://example.test/mcp", { headers: {
    "oai-authenticated-user-id": "site-scoped-owner",
    "oai-authenticated-user-email": "Owner@example.test"
  } });
  assert.equal(requireSitesOwner(request, "owner@example.test"), undefined);
});
