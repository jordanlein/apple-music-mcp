import { AppleMusicApi, hasAppleCredentials } from "./apple";
import { randomToken } from "./crypto";
import { saveAppleToken, setConfig } from "./storage";
import type { Env } from "./types";

export async function setupPage(request: Request, env: Env): Promise<Response> {
  const auth = requireSetupToken(request, env);
  if (auth) return auth;
  if (!hasAppleCredentials(env)) {
    return html(`<!doctype html><html lang="en"><body style="font-family: system-ui; margin: 2rem; max-width: 720px;"><h1>Apple credentials needed</h1><p>Set <code>APPLE_TEAM_ID</code>, <code>APPLE_KEY_ID</code>, and <code>APPLE_PRIVATE_KEY</code> as Worker secrets, then reload this setup page.</p></body></html>`);
  }
  const state = await randomToken();
  await setConfig(env, "apple_auth_state", state);
  const developerToken = await new AppleMusicApi(env).developerToken();
  const origin = new URL(request.url).origin;
  return html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Apple Music</title>
  <script src="https://js-cdn.music.apple.com/musickit/v1/musickit.js"></script>
  <style>
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
    <p>This stores an encrypted Apple Music user token for the Poke MCP. Apple does not provide a refresh token, so this may need to be repeated about every six months.</p>
    <button id="connect">Authorize Apple Music</button>
    <pre id="status">Waiting.</pre>
  </main>
  <script>
    const status = document.getElementById("status");
    document.getElementById("connect").addEventListener("click", async () => {
      try {
        status.textContent = "Opening Apple Music authorization...";
        await MusicKit.configure({
          developerToken: ${JSON.stringify(developerToken)},
          app: { name: "Poke Apple Music MCP", build: "0.1.0" },
          storefrontId: ${JSON.stringify(env.APPLE_STOREFRONT ?? "us")}
        });
        const token = await MusicKit.getInstance().authorize();
        const response = await fetch(${JSON.stringify(`${origin}/auth/apple/token`)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, state: ${JSON.stringify(state)} })
        });
        if (!response.ok) throw new Error(await response.text());
        status.textContent = "Apple Music connected. You can close this tab.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  </script>
</body>
</html>`);
}

export async function saveAppleAuthToken(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { token?: string; state?: string };
  if (!body.token || !body.state) return new Response("Missing token or state", { status: 400 });
  const expectedState = await env.DB.prepare("SELECT value FROM config WHERE key = 'apple_auth_state'")
    .first<{ value: string }>();
  if (!expectedState?.value || expectedState.value !== body.state) return new Response("Auth state mismatch", { status: 403 });
  await saveAppleToken(env, body.token);
  const api = new AppleMusicApi(env);
  const storefront = await api.refreshAndStoreStorefront().catch(() => undefined);
  return Response.json({ ok: true, storefront });
}

function requireSetupToken(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  const token = url.searchParams.get("setup_token") ?? bearerToken(request);
  if (env.SETUP_TOKEN && token === env.SETUP_TOKEN) return undefined;
  return new Response("Unauthorized", { status: 401 });
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
