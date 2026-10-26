import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from 'cloudflare:workers';
import { hasCapabilityPath, hasCapabilityToken } from './capability-access';
import { AppleMusicApi, type SongLookupInput } from './apple';
import { refreshRecentListeningAnalytics } from "./analytics";
import { applySecurityHeaders, HttpRequestError, readCookie, readUrlEncodedForm, secureEqual } from "./http-security";
import { saveAppleAuthToken, setupPage } from "./setup";
import { purgeAuditLog } from "./storage";
import { forwardSitesCollection } from "./sites-trigger";
import { claimScheduledMaintenance } from "./collector-control";
import type { CloudflareEnv as Env, ToolContext } from "./types";

// Cron and catalog RPC do not need the SDK/schema/OAuth initialization work.
// Wrangler bundles these imports, but defers their initialization until used.
async function handleMcp(request: Request, context: ToolContext): Promise<Response> {
  return (await import('./mcp-http')).handleMcp(request, context);
}

const AUTH_FORM_MAX_BYTES = 2_048;
const OAUTH_CSRF_COOKIE = "AM_MCP_CSRF";

type AuthenticatedProps = {
  authentication?: string;
  clientId?: string;
  userId?: string;
};

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const originError = rejectCrossOriginRequest(request);
    if (originError) return originError;
    const props = (ctx.props ?? {}) as AuthenticatedProps;
    const clientId = props.clientId ?? props.authentication ?? props.userId ?? "authenticated-client";
    return handleMcp(request, { env, clientId });
  }
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({
        name: "Apple Music Custom MCP",
        description:
          "Connects to Apple Music to search the catalog, create and manage playlists, explore personalized recommendations, and view recent listening history, stats, and Replay insights.",
        mcp: "/mcp",
        setup: "/setup"
      });
    }
    if (url.pathname === "/setup") return setupPage(request, env);
    if (url.pathname === "/auth/apple/token" && request.method === "POST") return saveAppleAuthToken(request, env);
    if (url.pathname === "/authorize") return authorize(request, env);

    // Keep the legacy SSE endpoint available to existing clients that use the
    // original static bearer key. Streamable HTTP at /mcp uses OAuth.
    if (url.pathname === "/sse") {
      const originError = rejectCrossOriginRequest(request);
      if (originError) return originError;
      const authError = await requireMcpApiKey(request, env);
      if (authError) return authError;
      return handleMcp(request, { env, clientId: "static-bearer" });
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

let oauthProvider: OAuthProvider<Env> | undefined;
async function getOAuthProvider(): Promise<OAuthProvider<Env>> {
  const { OAuthProvider } = await import('@cloudflare/workers-oauth-provider');
  return oauthProvider ??= new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["apple_music"],
  allowPlainPKCE: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  resourceMetadata: {
    scopes_supported: ["apple_music"],
    bearer_methods_supported: ["header"],
    resource_name: "Apple Music Custom MCP"
  },
  // A static bearer key keeps the server usable with any Streamable HTTP MCP
  // client, including clients that do not implement OAuth discovery.
  async resolveExternalToken({ token, env }) {
    if (env.MCP_API_KEY && await secureEqual(token, env.MCP_API_KEY)) {
      return { props: { userId: "owner", clientId: "static-bearer", authentication: "static-bearer" } };
    }
    if (await hasCapabilityToken(token, env.POKE_MCP_API_KEY ?? env.MCP_API_KEY)) {
      return { props: { userId: "owner", clientId: "owner-shared-url", authentication: "shared-capability-bearer" } };
    }
    return null;
  }
});
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (await hasCapabilityPath(path, env.POKE_MCP_API_KEY ?? env.MCP_API_KEY)) {
      const originError = rejectCrossOriginRequest(request);
      if (originError) return originError;
      return handleMcp(request, { env, clientId: 'owner-shared-url' });
    }
    return (await getOAuthProvider()).fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.SITE_COLLECTOR_URL) {
      ctx.waitUntil(forwardSitesCollection(env.SITE_COLLECTOR_URL ?? '', env.SITE_SERVICE_TOKEN ?? ''));
      return;
    }
    if (env.COLLECTOR_ACTIVE === 'false') return;
    ctx.waitUntil(
      Promise.all([
        refreshRecentListeningAnalytics(env, { limit: 30, trigger: "scheduled" }),
        (async () => {
          if (await claimScheduledMaintenance(env.DB)) {
            await Promise.all([
              getOAuthProvider().then(provider => provider.purgeExpiredData(env, { batchSize: 10 })),
              purgeAuditLog(env),
              env.DB.prepare("DELETE FROM analytics_ingest_runs WHERE started_at < ?")
                .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run(),
              env.DB.prepare('DELETE FROM catalog_cache WHERE expires_at_ms < ?').bind(Date.now()).run()
            ]);
          }
        })()
      ]).then(() => undefined)
    );
  }
} satisfies ExportedHandler<Env>;

// Private RPC keeps each catalog chunk below Free's per-invocation subrequest
// limit. It reuses this Worker's existing secrets and has no public HTTP route.
export class CatalogResolver extends WorkerEntrypoint<Env> {
  async resolve(tracks: SongLookupInput[]) {
    if (tracks.length > 10) throw new Error('Catalog chunks must contain at most ten songs');
    return new AppleMusicApi(this.env).resolveSongIds(tracks, true);
  }
}

async function authorize(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const secureCookie = new URL(request.url).protocol === "https:";

  if (request.method === "POST") {
    let form: URLSearchParams;
    try {
      form = await readUrlEncodedForm(request, AUTH_FORM_MAX_BYTES);
    } catch (error) {
      if (error instanceof HttpRequestError) return new Response(error.message, { status: error.status });
      throw error;
    }
    const csrfCookie = readCookie(request, OAUTH_CSRF_COOKIE);
    const csrfForm = form.get("csrf_token") ?? "";
    const passcode = form.get("passcode") ?? "";

    if (csrfForm.length > 128 || passcode.length > 512) {
      return htmlPage("Authorization failed", "<p>The authorization request contained an invalid field.</p>", 400);
    }
    if (!csrfCookie || !csrfForm || !(await secureEqual(csrfCookie, csrfForm))) {
      return htmlPage("Authorization failed", "<p>The authorization request expired. Return to your MCP client and try again.</p>", 403);
    }
    if (!env.OAUTH_CONSENT_TOKEN || !(await secureEqual(passcode, env.OAUTH_CONSENT_TOKEN))) {
      return consentPage(client?.clientName, csrfCookie, secureCookie, "The authorization passcode was incorrect.", 401);
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "owner",
      metadata: { clientName: client?.clientName ?? "MCP client" },
      scope: oauthRequest.scope.filter((scope) => scope === "apple_music"),
      props: { userId: "owner", clientId: oauthRequest.clientId, authentication: "oauth" }
    });
    // Some embedded OAuth browsers do not follow a cross-origin redirect after
    // a form POST. A refresh response completes the same top-level navigation.
    const safeRedirect = escapeHtml(redirectTo);
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeRedirect}">
       <title>Authorization complete</title><p>Authorization complete. <a href="${safeRedirect}">Return to your MCP client</a>.</p></html>`,
      {
        headers: applySecurityHeaders(new Headers({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "Set-Cookie": cookieHeader(OAUTH_CSRF_COOKIE, "", 0, secureCookie)
        }))
      }
    );
  }

  const csrfToken = crypto.randomUUID();
  return consentPage(client?.clientName, csrfToken, secureCookie);
}

function consentPage(
  clientName: string | undefined,
  csrfToken: string,
  secureCookie: boolean,
  error?: string,
  status = 200
): Response {
  const safeClientName = escapeHtml(clientName ?? "MCP client");
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return htmlPage(
    "Authorize Apple Music Custom MCP",
    `<p><strong>${safeClientName}</strong> is requesting access to use the Apple Music tools connected to your library.</p>
     ${errorHtml}
     <form method="post">
       <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
       <label for="passcode">Access passcode</label>
       <input id="passcode" name="passcode" type="password" required autocomplete="current-password">
       <button type="submit">Authorize MCP client</button>
     </form>`,
    status,
    cookieHeader(OAUTH_CSRF_COOKIE, csrfToken, 600, secureCookie)
  );
}

function htmlPage(title: string, body: string, status = 200, cookie?: string): Response {
  const headers = applySecurityHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }));
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(title)}</title>
     <style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#171717}form{display:grid;gap:.8rem;margin-top:1.5rem}input,button{font:inherit;padding:.75rem;border-radius:.55rem;border:1px solid #aaa}button{background:#111;color:#fff;border-color:#111;cursor:pointer}.error{color:#b42318}</style>
     <main><h1>${escapeHtml(title)}</h1>${body}</main></html>`,
    { status, headers }
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function requireMcpApiKey(request: Request, env: Env): Promise<Response | undefined> {
  if (!env.MCP_API_KEY) return new Response("Server missing MCP_API_KEY", { status: 500 });
  const token = bearerToken(request);
  if (token && await secureEqual(token, env.MCP_API_KEY)) return undefined;
  return new Response("Unauthorized", { status: 401 });
}

function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function rejectCrossOriginRequest(request: Request): Response | undefined {
  const origin = request.headers.get("Origin");
  if (!origin || origin === new URL(request.url).origin) return undefined;
  return new Response("Cross-origin MCP requests are not allowed", { status: 403 });
}
