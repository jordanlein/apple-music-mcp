import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { refreshRecentListeningAnalytics } from "./analytics";
import { createAppleMusicMcp } from "./mcp";
import { saveAppleAuthToken, setupPage } from "./setup";
import type { Env } from "./types";

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pokeUserId = request.headers.get("X-Poke-User-Id") ?? undefined;
    const server = createAppleMusicMcp({ env, pokeUserId });
    return createMcpHandler(server)(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
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
    if (url.pathname === "/auth/apple/token" && request.method === "POST") return cors(await saveAppleAuthToken(request, env));
    if (url.pathname === "/authorize") return authorize(request, env);

    // Keep the legacy SSE endpoint available to existing clients that use the
    // original static bearer key. Streamable HTTP at /mcp uses OAuth.
    if (url.pathname === "/sse") {
      const authError = requireMcpApiKey(request, env);
      if (authError) return authError;
      const pokeUserId = request.headers.get("X-Poke-User-Id") ?? undefined;
      const server = createAppleMusicMcp({ env, pokeUserId });
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
  // Preserve compatibility for Poke and other trusted clients that already
  // send the server's static bearer key.
  async resolveExternalToken({ token, env }) {
    if (env.POKE_MCP_API_KEY && token === env.POKE_MCP_API_KEY) {
      return { props: { userId: "owner", authentication: "static-bearer" } };
    }
    return null;
  }
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        refreshRecentListeningAnalytics(env, { limit: 30 }),
        oauthProvider.purgeExpiredData(env, { batchSize: 100 })
      ]).then(() => undefined)
    );
  }
} satisfies ExportedHandler<Env>;

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);

  if (request.method === "POST") {
    const form = await request.formData();
    const csrfCookie = readCookie(request, "__Host-AM_MCP_CSRF");
    const csrfForm = String(form.get("csrf_token") ?? "");
    const passcode = String(form.get("passcode") ?? "");

    if (!csrfCookie || !csrfForm || !(await secureEqual(csrfCookie, csrfForm))) {
      return htmlPage("Authorization failed", "<p>The authorization request expired. Please return to ChatGPT and try again.</p>", 403);
    }
    if (!env.SETUP_TOKEN || !(await secureEqual(passcode, env.SETUP_TOKEN))) {
      return consentPage(oauthRequest, client?.clientName, csrfCookie, "The access passcode was incorrect.", 401);
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "owner",
      metadata: { clientName: client?.clientName ?? "ChatGPT" },
      scope: oauthRequest.scope.filter((scope) => scope === "apple_music"),
      props: { userId: "owner", authentication: "oauth" }
    });
    // Some embedded OAuth browsers do not follow a cross-origin redirect after
    // a form POST. A refresh response completes the same top-level navigation.
    const safeRedirect = escapeHtml(redirectTo);
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeRedirect}">
       <title>Authorization complete</title><p>Authorization complete. <a href="${safeRedirect}">Return to ChatGPT</a>.</p></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        }
      }
    );
  }

  const csrfToken = crypto.randomUUID();
  return consentPage(oauthRequest, client?.clientName, csrfToken);
}

function consentPage(
  _oauthRequest: unknown,
  clientName: string | undefined,
  csrfToken: string,
  error?: string,
  status = 200
): Response {
  const safeClientName = escapeHtml(clientName ?? "ChatGPT");
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return htmlPage(
    "Authorize Apple Music Custom MCP",
    `<p><strong>${safeClientName}</strong> is requesting access to use the Apple Music tools connected to your library.</p>
     ${errorHtml}
     <form method="post">
       <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
       <label for="passcode">Access passcode</label>
       <input id="passcode" name="passcode" type="password" required autocomplete="current-password">
       <button type="submit">Authorize ChatGPT</button>
     </form>`,
    status,
    `__Host-AM_MCP_CSRF=${encodeURIComponent(csrfToken)}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
  );
}

function htmlPage(title: string, body: string, status = 200, cookie?: string): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(title)}</title>
     <style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#171717}form{display:grid;gap:.8rem;margin-top:1.5rem}input,button{font:inherit;padding:.75rem;border-radius:.55rem;border:1px solid #aaa}button{background:#111;color:#fff;border-color:#111;cursor:pointer}.error{color:#b42318}</style>
     <main><h1>${escapeHtml(title)}</h1>${body}</main></html>`,
    { status, headers }
  );
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function requireMcpApiKey(request: Request, env: Env): Response | undefined {
  if (!env.POKE_MCP_API_KEY) return new Response("Server missing POKE_MCP_API_KEY", { status: 500 });
  const token = bearerToken(request);
  if (token === env.POKE_MCP_API_KEY) return undefined;
  return new Response("Unauthorized", { status: 401 });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function cors(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("Access-Control-Allow-Origin", "*");
  next.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return next;
}
