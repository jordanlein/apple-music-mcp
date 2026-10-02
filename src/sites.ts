import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { refreshRecentListeningAnalytics } from "./analytics";
import { createAppleMusicMcp } from "./mcp";
import { saveAppleAuthToken, setupPage } from "./setup";
import { requireSitesOwner } from "./sites-access";
import type { Env } from "./types";
import { siteOperation, type OperationsEnv } from "./sites-operations";

interface SitesEnv extends OperationsEnv {
  SITE_OWNER_EMAIL: string;
}

// Sites owns MCP OAuth and the authentication boundary. The Cloudflare OAuth
// provider and KV grants remain in the original deployment and in its backup.
export default {
  async fetch(request: Request, env: SitesEnv, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (["/internal/migration", "/internal/check", "/internal/collect"].includes(path)) return siteOperation(request, env);
    const denied = requireSitesOwner(request, env.SITE_OWNER_EMAIL);
    if (denied) return denied;
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Cross-origin MCP requests are not allowed", { status: 403 });
      const server = createAppleMusicMcp({ env, clientId: request.headers.get("oai-authenticated-user-id")! });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    }
    if (url.pathname === "/setup") return setupPage(request, env);
    if (url.pathname === "/auth/apple/token" && request.method === "POST") return saveAppleAuthToken(request, env);
    if (url.pathname === "/") {
      return Response.json({ name: "Apple Music MCP", mcp: "/mcp", setup: "/setup" });
    }
    return new Response("Not found", { status: 404 });
  },
  // The destination MUST provision and verify an actual two-minute schedule
  // before cutover. Exporting a scheduled handler alone does not schedule it.
  async scheduled(_controller: ScheduledController, env: SitesEnv, ctx: ExecutionContext): Promise<void> {
    if (env.SITE_COLLECTOR_ACTIVE !== 'true') return;
    ctx.waitUntil(refreshRecentListeningAnalytics(env, { trigger: "scheduled" }).then(() => undefined));
  }
} satisfies ExportedHandler<SitesEnv>;
