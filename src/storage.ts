import { decryptJson, encryptJson } from "./crypto";
import type { AppleTokenSet, Env } from "./types";

export async function saveAppleToken(env: Env, musicUserToken: string): Promise<void> {
  const encrypted = await encryptJson(
    { musicUserToken, capturedAt: new Date().toISOString() } satisfies AppleTokenSet,
    env.TOKEN_ENCRYPTION_KEY
  );
  await env.DB.prepare(
    "INSERT INTO auth_tokens (provider, encrypted_token_json, updated_at) VALUES ('apple', ?, CURRENT_TIMESTAMP) ON CONFLICT(provider) DO UPDATE SET encrypted_token_json = excluded.encrypted_token_json, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(encrypted)
    .run();
}

export async function loadAppleToken(env: Env): Promise<AppleTokenSet | null> {
  const row = await env.DB.prepare("SELECT encrypted_token_json FROM auth_tokens WHERE provider = 'apple'")
    .first<{ encrypted_token_json: string }>();
  if (!row) return null;
  return decryptJson<AppleTokenSet>(row.encrypted_token_json, env.TOKEN_ENCRYPTION_KEY);
}

export async function appleTokenStatus(env: Env): Promise<{ connected: boolean; updatedAt?: string }> {
  const row = await env.DB.prepare("SELECT updated_at FROM auth_tokens WHERE provider = 'apple'")
    .first<{ updated_at: string }>();
  return { connected: Boolean(row), updatedAt: row?.updated_at };
}

export async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(key, value)
    .run();
}

export async function getConfig(env: Env, key: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value;
}

export async function audit(
  env: Env,
  pokeUserId: string | undefined,
  toolName: string,
  action: string,
  detail: unknown
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (poke_user_id, tool_name, action, detail_json) VALUES (?, ?, ?, ?)"
  )
    .bind(pokeUserId ?? null, toolName, action, JSON.stringify(detail ?? null))
    .run();
}
