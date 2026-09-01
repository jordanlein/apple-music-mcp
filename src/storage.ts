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

export async function consumeConfigValue(env: Env, key: string, expectedValue: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM config WHERE key = ? AND value = ?")
    .bind(key, expectedValue)
    .run();
  return result.meta.changes === 1;
}

export async function audit(
  env: Env,
  clientId: string,
  toolName: string,
  action: string,
  detail: unknown
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (client_id, tool_name, action, detail_json) VALUES (?, ?, ?, ?)"
    )
      .bind(clientId, toolName, action, JSON.stringify(detail ?? null))
      .run();
  } catch (error) {
    console.error("Audit insert failed", error instanceof Error ? error.message : String(error));
  }
}

export async function purgeAuditLog(env: Env): Promise<void> {
  const configured = Number(env.AUDIT_RETENTION_DAYS ?? "90");
  const retentionDays = Number.isInteger(configured) && configured >= 1 && configured <= 3650 ? configured : 90;
  await env.DB.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
    .bind(`-${retentionDays} days`)
    .run();
}
