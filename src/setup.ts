import { AppleMusicApi, hasAppleCredentials } from "./apple";
import { base64UrlEncode, randomToken } from "./crypto";
import {
  applySecurityHeaders,
  HttpRequestError,
  readBoundedText,
  readCookie,
  readUrlEncodedForm,
  secureEqual
} from "./http-security";
import { createSetupSession, SETUP_SESSION_TTL_MS, verifySetupSession } from "./setup-session";
import { consumeConfigValue, getConfig, saveAppleToken, setConfig } from "./storage";
import type { Env } from "./types";

const SETUP_SESSION_COOKIE = "AM_MCP_SETUP_SESSION";
const APPLE_AUTH_STATE_KEY = "apple_auth_state_v2";
const SETUP_FORM_MAX_BYTES = 2_048;
const APPLE_TOKEN_BODY_MAX_BYTES = 16_384;

type StoredAppleAuthState = { version: 1; stateHash: string; sessionId: string; expiresAt: number };

export async function setupPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  const url = new URL(request.url);
  if (url.searchParams.has("setup_token")) {
    return secureText("Setup tokens are not accepted in URLs. Open /setup and enter the token in the protected form.", 400);
  }

  if (request.method === "POST") {
    let form: URLSearchParams;
    try {
      form = await readUrlEncodedForm(request, SETUP_FORM_MAX_BYTES);
    } catch (error) {
      return requestError(error);
    }
    const passcode = form.get("setup_token") ?? "";
    if (passcode.length > 512 || !env.SETUP_TOKEN || !(await secureEqual(passcode, env.SETUP_TOKEN))) {
      return setupLoginPage("The setup token was incorrect.", 401);
    }
    const sessionToken = await createSetupSession(env.SETUP_TOKEN);
    return new Response(null, {
      status: 303,
      headers: applySecurityHeaders(new Headers({
        Location: "/setup",
        "Set-Cookie": setupSessionCookie(sessionToken, url.protocol === "https:")
      }))
    });
  }

  let sessionToken = readCookie(request, SETUP_SESSION_COOKIE);
  let session = sessionToken ? await verifySetupSession(sessionToken, env.SETUP_TOKEN) : undefined;
  let setSessionCookie = false;
  const bearer = bearerToken(request);
  if (!session && bearer && env.SETUP_TOKEN && await secureEqual(bearer, env.SETUP_TOKEN)) {
    sessionToken = await createSetupSession(env.SETUP_TOKEN);
    session = await verifySetupSession(sessionToken, env.SETUP_TOKEN);
    setSessionCookie = true;
  }
  if (!session || !sessionToken) return setupLoginPage();

  if (!hasAppleCredentials(env)) {
    return html(
      "Apple credentials needed",
      `<p>Set <code>APPLE_TEAM_ID</code>, <code>APPLE_KEY_ID</code>, and <code>APPLE_PRIVATE_KEY</code> as Worker secrets, then reload this page.</p>`,
      { cookie: setSessionCookie ? setupSessionCookie(sessionToken, url.protocol === "https:") : undefined }
    );
  }

  const state = await randomToken();
  const storedState: StoredAppleAuthState = {
    version: 1,
    stateHash: await sha256Token(state),
    sessionId: session.sessionId,
    expiresAt: Date.now() + SETUP_SESSION_TTL_MS
  };
  await setConfig(env, APPLE_AUTH_STATE_KEY, JSON.stringify(storedState));
  const developerToken = await new AppleMusicApi(env).developerToken();
  const nonce = await randomToken();
  const headers = applySecurityHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://js-cdn.music.apple.com`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self' https://*.music.apple.com",
      "frame-src https://*.music.apple.com",
      "img-src data: https://*.apple.com https://*.mzstatic.com",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'"
    ].join("; ")
  }));
  if (setSessionCookie) headers.set("Set-Cookie", setupSessionCookie(sessionToken, url.protocol === "https:"));

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Apple Music</title>
  <script nonce="${nonce}" src="https://js-cdn.music.apple.com/musickit/v1/musickit.js"></script>
  <style nonce="${nonce}">
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #1d1d1b; }
    main { max-width: 680px; margin: 8vh auto; padding: 0 24px; }
    h1 { font-size: 32px; margin: 0 0 12px; }
    p { line-height: 1.5; color: #55524a; }
    button { border: 0; background: #111; color: white; padding: 12px 16px; border-radius: 8px; font-weight: 700; cursor: pointer; }
    pre { white-space: pre-wrap; background: white; border: 1px solid #dedbd2; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Apple Music</h1>
    <p>This stores an encrypted Apple Music user token for this MCP deployment. Apple does not provide a refresh token, so authorization may need to be repeated periodically.</p>
    <button id="connect">Authorize Apple Music</button>
    <pre id="status">Waiting.</pre>
  </main>
  <script nonce="${nonce}">
    const status = document.getElementById("status");
    document.getElementById("connect").addEventListener("click", async () => {
      try {
        status.textContent = "Opening Apple Music authorization...";
        await MusicKit.configure({
          developerToken: ${scriptJson(developerToken)},
          app: { name: "Apple Music MCP", build: "0.1.0" },
          storefrontId: ${scriptJson(env.APPLE_STOREFRONT ?? "us")}
        });
        const token = await MusicKit.getInstance().authorize();
        const response = await fetch("/auth/apple/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, state: ${scriptJson(state)} })
        });
        if (!response.ok) throw new Error(await response.text());
        status.textContent = "Apple Music connected. You can close this tab.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  </script>
</body>
</html>`, { headers });
}

export async function saveAppleAuthToken(request: Request, env: Env): Promise<Response> {
  const sessionToken = readCookie(request, SETUP_SESSION_COOKIE);
  const session = sessionToken ? await verifySetupSession(sessionToken, env.SETUP_TOKEN) : undefined;
  if (!session) return secureText("Unauthorized", 401);

  let body: { token?: unknown; state?: unknown };
  try {
    const text = await readBoundedText(request, APPLE_TOKEN_BODY_MAX_BYTES, "application/json");
    body = JSON.parse(text) as { token?: unknown; state?: unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return secureText("Invalid JSON", 400);
    return requestError(error);
  }
  if (typeof body.token !== "string" || typeof body.state !== "string") {
    return secureText("Missing token or state", 400);
  }
  if (body.token.length < 1 || body.token.length > 12_000 || body.state.length < 1 || body.state.length > 128) {
    return secureText("Invalid token or state", 400);
  }

  const storedValue = await getConfig(env, APPLE_AUTH_STATE_KEY);
  const storedState = parseStoredState(storedValue);
  const stateMatches = storedState
    && storedState.expiresAt >= Date.now()
    && storedState.sessionId === session.sessionId
    && await secureEqual(storedState.stateHash, await sha256Token(body.state));
  if (!stateMatches || !storedValue || !(await consumeConfigValue(env, APPLE_AUTH_STATE_KEY, storedValue))) {
    return secureText("Auth state mismatch or expired", 403);
  }

  await saveAppleToken(env, body.token);
  const api = new AppleMusicApi(env);
  const storefront = await api.refreshAndStoreStorefront().catch(() => undefined);
  const headers = applySecurityHeaders(new Headers({ "Content-Type": "application/json" }));
  return new Response(JSON.stringify({ ok: true, storefront }), { headers });
}

function setupLoginPage(error?: string, status = 200): Response {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return html(
    "Unlock Apple Music setup",
    `<p>Enter the deployment's setup token. It is exchanged for a short-lived browser session and is never placed in the URL.</p>
     ${errorHtml}
     <form method="post">
       <label for="setup_token">Setup token</label>
       <input id="setup_token" name="setup_token" type="password" required autocomplete="current-password">
       <button type="submit">Continue</button>
     </form>`,
    { status }
  );
}

function html(title: string, body: string, options: { status?: number; cookie?: string } = {}): Response {
  const headers = applySecurityHeaders(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  }));
  if (options.cookie) headers.set("Set-Cookie", options.cookie);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${escapeHtml(title)}</title>
     <style>body{font:16px system-ui;max-width:38rem;margin:4rem auto;padding:0 1.25rem;color:#171717}form{display:grid;gap:.8rem;margin-top:1.5rem}input,button{font:inherit;padding:.75rem;border-radius:.55rem;border:1px solid #aaa}button{background:#111;color:#fff;border-color:#111;cursor:pointer}.error{color:#b42318}</style>
     <main><h1>${escapeHtml(title)}</h1>${body}</main></html>`,
    { status: options.status ?? 200, headers }
  );
}

function requestError(error: unknown): Response {
  if (error instanceof HttpRequestError) return secureText(error.message, error.status);
  throw error;
}

function secureText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: applySecurityHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8" }))
  });
}

function setupSessionCookie(token: string, secure: boolean): string {
  return `${SETUP_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=600${secure ? "; Secure" : ""}`;
}

function bearerToken(request: Request): string | undefined {
  return (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
}

function parseStoredState(value: string | undefined): StoredAppleAuthState | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredAppleAuthState>;
    if (
      parsed.version !== 1
      || typeof parsed.stateHash !== "string"
      || typeof parsed.sessionId !== "string"
      || typeof parsed.expiresAt !== "number"
      || !Number.isSafeInteger(parsed.expiresAt)
    ) return undefined;
    return parsed as StoredAppleAuthState;
  } catch {
    return undefined;
  }
}

async function sha256Token(value: string): Promise<string> {
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function scriptJson(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
