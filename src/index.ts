import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { refreshRecentListeningAnalytics } from "./analytics";
import { createAppleMusicMcp } from "./mcp";
import { applySecurityHeaders, HttpRequestError, readCookie, readUrlEncodedForm, secureEqual } from "./http-security";
import { saveAppleAuthToken, setupPage } from "./setup";
import { purgeAuditLog } from "./storage";
import { forwardSitesCollection } from "./sites-trigger";
import { claimScheduledMaintenance } from "./collector-control";
import type { CloudflareEnv as Env } from "./types";

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
    const server = createAppleMusicMcp({ env, clientId });
    return createMcpHandler(server)(request, env, ctx);
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
      const server = createAppleMusicMcp({ env, clientId: "static-bearer" });
      return createMcpHandler(server)(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

const oauthProvider = new OAuthProvider<Env>({
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
    return null;
  }
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.SITE_COLLECTOR_URL || env.SITE_SERVICE_TOKEN) {
      ctx.waitUntil(forwardSitesCollection(env.SITE_COLLECTOR_URL ?? '', env.SITE_SERVICE_TOKEN ?? ''));
      return;
    }
    ctx.waitUntil(
      Promise.all([
        refreshRecentListeningAnalytics(env, { limit: 30, trigger: "scheduled" }),
        (async () => {
          if (await claimScheduledMaintenance(env.DB)) {
            await Promise.all([oauthProvider.purgeExpiredData(env, { batchSize: 100 }), purgeAuditLog(env)]);
          }
        })()
      ]).then(() => undefined)
    );
  }
} satisfies ExportedHandler<Env>;

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
