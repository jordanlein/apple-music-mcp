import type { CloudflareEnv } from './types';

export async function forwardSitesCollection(url: string, token: string, fetcher: typeof fetch = fetch) {
  const destination = new URL(url);
  if (destination.protocol !== 'https:' || !destination.hostname.endsWith('.chatgpt.site') ||
      destination.pathname !== '/internal/collect' || destination.search || destination.hash ||
      destination.username || destination.password || destination.port || !token) {
    throw new Error('Sites collector access is not configured correctly');
  }
  const response = await fetcher(destination.toString(), {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'OAI-Sites-Authorization': `Bearer ${token}`, Authorization: `Bearer ${token}`},
    body: '{}',
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`Sites collection returned HTTP ${response.status}`);
  const result = await response.json() as {runId?: unknown; fetched?: unknown; inserted?: unknown; deferred?: unknown; retryAt?: unknown};
  if (typeof result.runId !== 'string' || typeof result.fetched !== 'number' || result.fetched < 0 || result.fetched > 30) {
    throw new Error('Sites did not confirm collection');
  }
  if (result.deferred !== undefined && result.deferred !== 'busy' && result.deferred !== 'cooldown') {
    throw new Error('Sites returned an invalid collection deferral');
  }
  console.log(JSON.stringify({event: result.deferred ? 'sites_collector_deferred' : 'sites_collector_succeeded',
    runId: result.runId, fetched: result.fetched, inserted: result.inserted, deferred: result.deferred, retryAt: result.retryAt}));
  return result;
}

// Preserve the existing MCP fetch handler when reusing its established timer.
export function withSitesScheduled(legacy: ExportedHandler<CloudflareEnv>): ExportedHandler<CloudflareEnv> {
  if (!legacy.fetch) throw new Error('Existing MCP fetch handler is unavailable');
  return {
    fetch(request, env, ctx) { return legacy.fetch!(request, env, ctx); },
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(forwardSitesCollection(env.SITE_COLLECTOR_URL ?? '', env.SITE_SERVICE_TOKEN ?? ''));
    }
  };
}
