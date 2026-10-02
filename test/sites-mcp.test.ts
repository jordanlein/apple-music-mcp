import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { default: site } = await import("../src/sites.ts");

test("Sites MCP initializes and discovers tools across independent stateless requests", async () => {
  const env = { SITE_OWNER_EMAIL: "owner@example.test" } as any;
  const context = { waitUntil() {} } as any;
  async function call(method: string, params?: unknown) {
    const request = new Request("https://example.test/mcp", {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.test"
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const response = await site.fetch(request, env, context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);
    return response.json() as Promise<any>;
  }
  const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
  assert.ok(initialized.result.capabilities.tools);
  const discovery = await call("tools/list");
  assert.equal(discovery.result.tools.length, 14);
  assert.ok(discovery.result.tools.some((t: any) => t.name === "apple_music_analytics_status"));
});
