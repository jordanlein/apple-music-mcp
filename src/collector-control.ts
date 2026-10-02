import type { Env } from './types';

export const COLLECTION_LEASE_MS = 180_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 300_000;
export const COLLECTION_CONTROL = 'recently_played';

export function expectedPollIntervalMs(env: Pick<Env, 'COLLECTOR_POLL_INTERVAL_SECONDS'>): number {
  const seconds = Number(env.COLLECTOR_POLL_INTERVAL_SECONDS ?? '120');
  return Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 86_400 ? seconds * 1_000 : 120_000;
}

export async function acquireLease(db: D1Database, name: string, owner: string, now: number, duration = COLLECTION_LEASE_MS) {
  const claimed = await db.prepare(
    `INSERT INTO collector_control (name, owner, lease_until_ms, cooldown_until_ms) VALUES (?, ?, ?, 0)
     ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, lease_until_ms = excluded.lease_until_ms
     WHERE collector_control.lease_until_ms <= ? AND collector_control.cooldown_until_ms <= ?`
  ).bind(name, owner, now + duration, now, now).run();
  if (claimed.meta.changes > 0) return { acquired: true as const };
  const row = await db.prepare('SELECT lease_until_ms, cooldown_until_ms FROM collector_control WHERE name = ?')
    .bind(name).first<{lease_until_ms: number; cooldown_until_ms: number}>();
  const cooling = (row?.cooldown_until_ms ?? 0) > now;
  return { acquired: false as const, reason: cooling ? 'cooldown' as const : 'busy' as const,
    retryAt: new Date(Math.max(row?.lease_until_ms ?? now, row?.cooldown_until_ms ?? now)).toISOString() };
}

// First statement in the history transaction: a stale writer violates the
// migration's CHECK and rolls back the complete batch before changing history.
export function collectionFence(db: D1Database, owner: string, now: number) {
  return db.prepare(`INSERT INTO collector_control (name, owner, lease_until_ms, cooldown_until_ms)
    SELECT ?, ?, COALESCE((SELECT lease_until_ms FROM collector_control
      WHERE name = ? AND owner = ? AND lease_until_ms > ?), -1), 0
    ON CONFLICT(name) DO UPDATE SET lease_until_ms = excluded.lease_until_ms`)
    .bind(COLLECTION_CONTROL, owner, COLLECTION_CONTROL, owner, now);
}

export async function releaseCollectionLease(db: D1Database, owner: string) {
  await db.prepare('UPDATE collector_control SET owner = ?, lease_until_ms = 0 WHERE name = ? AND owner = ?')
    .bind('', COLLECTION_CONTROL, owner).run();
}

export async function recordRateLimitCooldown(db: D1Database, delayMs: number, now = Date.now()) {
  await db.prepare('UPDATE collector_control SET cooldown_until_ms = MAX(cooldown_until_ms, ?) WHERE name = ?')
    .bind(now + Math.max(delayMs, 60_000), COLLECTION_CONTROL).run();
}

export async function claimScheduledMaintenance(db: D1Database, now = Date.now()) {
  // Retain this lease for the full hour, including when cleanup fails, so a
  // repeated failure cannot turn every collection tick into another KV scan.
  return (await acquireLease(db, 'scheduled_maintenance', crypto.randomUUID(), now, 3_600_000)).acquired;
}
