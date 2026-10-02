import { HttpRequestError, readBoundedText, secureEqual } from './http-security';
import { migrationTables } from './migration-tables';
import { refreshRecentListeningAnalytics, analyticsStatus } from './analytics';
import { loadAppleToken } from './storage';
import type { Env } from './types';
import { AppleMusicApi } from './apple';

export interface OperationsEnv extends Env {
  SITE_SERVICE_ACCESS_TOKEN?: string;
  SITE_MIGRATION_ENABLED?: string;
  SITE_COLLECTOR_ACTIVE?: string;
}

// Only for this owner's server-to-server migration and collector. MCP and
// browser routes continue to require Sites' verified owner identity.
export async function siteOperation(request: Request, env: OperationsEnv): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!env.SITE_SERVICE_ACCESS_TOKEN || !token || !await secureEqual(token, env.SITE_SERVICE_ACCESS_TOKEN)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (request.headers.has('Origin')) return new Response('Service requests only', { status: 403 });
  const pathname = new URL(request.url).pathname;
  try {
    if (pathname === '/internal/check') {
      const connected = Boolean(await loadAppleToken(env));
      const recentTrackCount = connected ? (await new AppleMusicApi(env).recentlyPlayed(30)).length : 0;
      return Response.json({ connected, recentTrackCount, analytics: await analyticsStatus(env) });
    }
    if (pathname === '/internal/collect') {
      if (env.SITE_COLLECTOR_ACTIVE !== 'true') return Response.json({ error: 'Collector paused' }, { status: 409 });
      return Response.json(await refreshRecentListeningAnalytics(env, { trigger: 'scheduled' }));
    }
    if (pathname !== '/internal/migration' || env.SITE_MIGRATION_ENABLED !== 'true') return new Response('Not found', { status: 404 });
    const body = JSON.parse(await readBoundedText(request, 512_000, 'application/json'));
    if (!body || typeof body !== 'object' || !Object.hasOwn(migrationTables, body.table)) throw new HttpRequestError(400, 'Unknown table');
    const table = body.table as keyof typeof migrationTables;
    const { columns, primaryKey } = migrationTables[table];
    if (body.action === 'import') {
      if (!Array.isArray(body.rows) || body.rows.length > 50) throw new HttpRequestError(400, 'Import at most 50 rows');
      const statements = body.rows.map((row: Record<string, unknown>) => {
        if (!row || Object.keys(row).length !== columns.length || !columns.every(c => Object.hasOwn(row, c))) throw new HttpRequestError(400, 'Row columns do not match');
        const values = columns.map(c => row[c]);
        if (!values.every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v)))) throw new HttpRequestError(400, 'Invalid row value');
        const update = columns.filter(c => c !== primaryKey).map(c => `"${c}"=excluded."${c}"`).join(',');
        return env.DB.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT("${primaryKey}") DO UPDATE SET ${update}`).bind(...values);
      });
      if (statements.length) await env.DB.batch(statements);
      return Response.json({ imported: statements.length });
    }
    if (body.action === 'page') {
      const offset = body.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpRequestError(400, 'Invalid offset');
      const rows = await env.DB.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${table}" ORDER BY "${primaryKey}" LIMIT 50 OFFSET ?`).bind(offset).all();
      return Response.json({ rows: rows.results });
    }
    if (body.action === 'digest') {
      const excludeKeys = body.excludeKeys ?? [];
      if (!Array.isArray(excludeKeys) || excludeKeys.length > 100 || !excludeKeys.every(v => typeof v === 'string' || Number.isSafeInteger(v))) throw new HttpRequestError(400, 'Invalid excluded keys');
      const values: unknown[][] = [];
      let offset = 0;
      while (true) {
        const result = await env.DB.prepare(`SELECT ${columns.map(c => `"${c}"`).join(',')} FROM "${table}" ORDER BY "${primaryKey}" LIMIT 200 OFFSET ?`).bind(offset).all<Record<string, unknown>>();
        for (const row of result.results) if (!excludeKeys.includes(row[primaryKey])) values.push(columns.map(c => row[c]));
        offset += result.results.length;
        if (result.results.length < 200) break;
      }
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
      return Response.json({ count: values.length, sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') });
    }
    if (body.action === 'sequence') {
      if (!['listen_events', 'analytics_ingest_runs', 'audit_log', 'd1_migrations'].includes(table) || !Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new HttpRequestError(400, 'Invalid sequence');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sqlite_sequence WHERE name = ?').bind(table),
        env.DB.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').bind(table, body.sequence)
      ]);
      return Response.json({ restored: true });
    }
    throw new HttpRequestError(400, 'Unknown action');
  } catch (error) {
    const status = error instanceof HttpRequestError ? error.status : error instanceof SyntaxError ? 400 : 500;
    return Response.json({ error: status === 500 ? 'Operation failed' : error instanceof HttpRequestError ? error.message : 'Invalid JSON' }, { status });
  }
}
