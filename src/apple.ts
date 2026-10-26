import { signEs256Jwt } from "./crypto";
import { getConfig, loadAppleToken, setConfig } from "./storage";
import type { AppleListResponse, AppleResource, AppleTokenSet, CloudflareEnv, Env } from "./types";
import {
  AppleMusicApiError,
  fetchAppleMusicWithRetry,
  isEmptyPlaylistTracksError,
  mapWithConcurrency
} from "./apple-transport";
import { chooseSongMatch } from "./song-matching";

const API_BASE = "https://api.music.apple.com/v1";
const SONG_LOOKUP_CANDIDATES = 10;
let developerTokenCache: { key: string; expiresAt: number; token: Promise<string> } | undefined;

export type SongLookupInput = { id?: string; term?: string; name?: string; artist?: string };
export type ResolvedSong = {
  id: string;
  type: string;
  query?: string;
  name?: string;
  artist?: string;
  album?: string;
  url?: string;
  match: "provided_id" | "exact" | "high_confidence";
};
export type SongResolutionIssue = {
  inputIndex: number;
  input: SongLookupInput;
  query?: string;
  reason: string;
  candidates: Array<{ id: string; name?: string; artist?: string; album?: string; url?: string }>;
};
export type SongResolutionBatch = {
  resolved: Array<ResolvedSong & { inputIndex: number }>;
  unresolved: SongResolutionIssue[];
  ambiguous: SongResolutionIssue[];
};

export class AppleMusicApi {
  private readonly env: Env;
  private storefront?: Promise<string>;
  private userToken?: Promise<AppleTokenSet | null>;
  private upstreamRequests = 0;
  private cooldownUntil = 0;

  constructor(env: Env) {
    this.env = env;
  }

  async developerToken(): Promise<string> {
    if (!hasAppleCredentials(this.env)) {
      throw new Error("Apple Music API credentials are not configured yet. Set APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY as Worker secrets.");
    }
    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(this.env.APPLE_DEVELOPER_TOKEN_TTL_SECONDS ?? "3600");
    if (!Number.isInteger(ttl) || ttl < 300 || ttl > 15_777_000) {
      throw new Error("APPLE_DEVELOPER_TOKEN_TTL_SECONDS must be an integer from 300 through 15777000.");
    }
    const cacheKey = [this.env.APPLE_TEAM_ID, this.env.APPLE_KEY_ID, this.env.APPLE_PRIVATE_KEY, ttl].join('\n');
    if (developerTokenCache?.key === cacheKey && developerTokenCache.expiresAt > now + 60) return developerTokenCache.token;
    const token = signEs256Jwt(
      { alg: "ES256", kid: this.env.APPLE_KEY_ID },
      { iss: this.env.APPLE_TEAM_ID, iat: now, exp: now + ttl },
      this.env.APPLE_PRIVATE_KEY
    );
    developerTokenCache = { key: cacheKey, expiresAt: now + ttl, token };
    token.catch(() => { if (developerTokenCache?.token === token) developerTokenCache = undefined; });
    return token;
  }

  async userStorefront(): Promise<string> {
    return this.storefront ??= getConfig(this.env, "apple_storefront").then(value => value ?? this.env.APPLE_STOREFRONT ?? 'us');
  }

  async refreshAndStoreStorefront(): Promise<string> {
    const response = await this.request("/me/storefront", { user: true });
    const storefront = response.data?.[0]?.id ?? this.env.APPLE_STOREFRONT ?? "us";
    await setConfig(this.env, "apple_storefront", storefront);
    this.storefront = Promise.resolve(storefront);
    return storefront;
  }

  async listPlaylists(limit: number): Promise<AppleResource[]> {
    return this.paginate("/me/library/playlists", Math.min(limit, 500), true);
  }

  async playlistTracks(playlistId: string, limit: number): Promise<AppleResource[]> {
    try {
      return await this.paginate(`/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, Math.min(limit, 500), true);
    } catch (error) {
      if (isEmptyPlaylistTracksError(error)) return [];
      throw error;
    }
  }

  async recentlyPlayed(limit: number): Promise<AppleResource[]> {
    return this.paginate("/me/recent/played/tracks?types=songs,library-songs", Math.min(limit, 30), true, 30);
  }

  async replaySummary(): Promise<AppleListResponse> {
    return this.request("/me/music-summaries?filter%5Byear%5D=latest&views=top-artists,top-albums,top-songs", { user: true });
  }

  async heavyRotation(limit: number): Promise<AppleResource[]> {
    const response = await this.request(`/me/history/heavy-rotation?limit=${Math.min(limit, 10)}`, { user: true });
    return (response.data ?? []).slice(0, limit);
  }

  async recommendations(limit: number): Promise<AppleResource[]> {
    const response = await this.request(`/me/recommendations?limit=${Math.min(limit, 10)}`, { user: true });
    return (response.data ?? []).slice(0, limit);
  }

  async searchCatalog(term: string, types: string, limit: number): Promise<Record<string, AppleResource[]>> {
    const storefront = await this.userStorefront();
    const cacheKey = JSON.stringify([storefront, term.trim().toLowerCase(), types, Math.min(limit, 25)]);
    const cacheEnabled = Boolean((this.env as CloudflareEnv).CATALOG_RESOLVER);
    const cached = cacheEnabled ? await this.env.DB.prepare('SELECT value FROM catalog_cache WHERE key = ? AND expires_at_ms > ?')
      .bind(cacheKey, Date.now()).first<{value: string}>() : null;
    if (cached) return JSON.parse(cached.value);
    const path = `/catalog/${encodeURIComponent(storefront)}/search?types=${encodeURIComponent(types)}&limit=${Math.min(limit, 25)}&term=${encodeURIComponent(term)}`;
    const response = await this.request(path, { user: false });
    const results: Record<string, AppleResource[]> = {};
    for (const [key, value] of Object.entries(response.results ?? {})) {
      results[key] = value.data ?? [];
    }
    if (cacheEnabled) await this.env.DB.prepare('INSERT INTO catalog_cache (key,value,expires_at_ms) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at_ms=excluded.expires_at_ms')
      .bind(cacheKey, JSON.stringify(results), Date.now() + 86_400_000).run();
    return results;
  }

  async createPlaylist(name: string, description = ""): Promise<AppleResource | undefined> {
    const response = await this.request("/me/library/playlists", {
      user: true,
      method: "POST",
      body: {
        attributes: { name, description }
      }
    });
    return response.data?.[0];
  }

  async addTracksToPlaylist(playlistId: string, tracks: Array<{ id: string; type?: string }>): Promise<void> {
    for (const chunk of chunks(tracks, 100)) {
      await this.request(`/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        user: true,
        method: "POST",
        body: {
          data: chunk.map((track) => ({
            id: track.id,
            type: track.type ?? (track.id.startsWith("i.") || track.id.startsWith("l.") ? "library-songs" : "songs")
          }))
        },
        emptyOk: true
      });
    }
  }

  async resolveSongIds(tracks: SongLookupInput[], local = false): Promise<SongResolutionBatch> {
    if (!local) {
      const groups = new Map<string, {track: SongLookupInput; indices: number[]}>();
      tracks.forEach((track,index) => { const key = JSON.stringify(track); const group = groups.get(key); if (group) group.indices.push(index); else groups.set(key,{track,indices:[index]}); });
      if (groups.size < tracks.length) {
        const unique = Array.from(groups.values());
        const result = await this.resolveSongIds(unique.map(g=>g.track));
        return {
          resolved: result.resolved.flatMap(item=>unique[item.inputIndex].indices.map(inputIndex=>({...item,inputIndex}))).sort((a,b)=>a.inputIndex-b.inputIndex),
          unresolved: result.unresolved.flatMap(item=>unique[item.inputIndex].indices.map(inputIndex=>({...item,inputIndex,input:tracks[inputIndex]}))).sort((a,b)=>a.inputIndex-b.inputIndex),
          ambiguous: result.ambiguous.flatMap(item=>unique[item.inputIndex].indices.map(inputIndex=>({...item,inputIndex,input:tracks[inputIndex]}))).sort((a,b)=>a.inputIndex-b.inputIndex)
        };
      }
    }
    const resolver = (this.env as CloudflareEnv).CATALOG_RESOLVER;
    if (!local && resolver && tracks.some(track => !track.id)) {
      const batches = chunks(tracks, 10);
      const results = await mapWithConcurrency(batches, 1, chunk => resolver.resolve(chunk));
      const combined: SongResolutionBatch = { resolved: [], unresolved: [], ambiguous: [] };
      results.forEach((result, batchIndex) => {
        for (const key of ['resolved', 'unresolved', 'ambiguous'] as const) {
          for (const item of result[key]) {
            const adjusted = { ...item, inputIndex: item.inputIndex + batchIndex * 10 };
            if (key === 'resolved') combined.resolved.push(adjusted as SongResolutionBatch['resolved'][number]);
            else combined[key].push(adjusted as SongResolutionIssue);
          }
        }
      });
      return combined;
    }
    const outcomes = await mapWithConcurrency(tracks, 1, async (track, inputIndex) => {
      if (track.id) {
        return {
          status: "resolved" as const,
          value: {
            inputIndex,
            id: track.id,
            type: "songs",
            query: track.term ?? track.name,
            name: track.name,
            artist: track.artist,
            match: "provided_id" as const
          }
        };
      }
      const term = track.term ?? [track.name, track.artist].filter(Boolean).join(" ");
      if (!term) {
        return {
          status: "unresolved" as const,
          issue: { inputIndex, input: track, reason: "No song ID, search term, or title was supplied.", candidates: [] }
        };
      }
      const results = await this.searchCatalog(term, "songs", SONG_LOOKUP_CANDIDATES);
      if (local && tracks.length > 1) await new Promise(resolve => setTimeout(resolve, 250));
      return chooseSongMatch(track, term, results.songs ?? [], inputIndex);
    });
    const batch: SongResolutionBatch = { resolved: [], unresolved: [], ambiguous: [] };
    for (const outcome of outcomes) {
      if (outcome.status === "resolved") batch.resolved.push(outcome.value);
      else if (outcome.status === "unresolved") batch.unresolved.push(outcome.issue);
      else batch.ambiguous.push(outcome.issue);
    }
    return batch;
  }

  private async paginate(path: string, maxItems: number, user: boolean, pageLimit = 100): Promise<AppleResource[]> {
    const items: AppleResource[] = [];
    let offset = 0;
    while (items.length < maxItems) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}limit=${Math.min(pageLimit, maxItems - items.length)}&offset=${offset}`, { user });
      const page = response.data ?? [];
      items.push(...page);
      if (!response.next || page.length === 0) break;
      offset += page.length;
    }
    return items.slice(0, maxItems);
  }

  protected async request(path: string, options: RequestOptions): Promise<AppleListResponse> {
    const control = await this.env.DB.prepare("SELECT cooldown_until_ms FROM collector_control WHERE name = 'recently_played'")
      .first<{cooldown_until_ms: number}>();
    this.cooldownUntil = Math.max(this.cooldownUntil, control?.cooldown_until_ms ?? 0);
    if (this.cooldownUntil > Date.now()) throw new AppleMusicApiError(429, 'Apple Music is cooling down after a rate limit', String(Math.ceil((this.cooldownUntil - Date.now()) / 1000)));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.developerToken()}`
    };
    if (options.user) {
      const token = await (this.userToken ??= loadAppleToken(this.env));
      if (!token?.musicUserToken) throw new Error("Apple Music is not connected. Open /setup with the setup token and authorize Apple Music.");
      headers["Music-User-Token"] = token.musicUserToken;
    }
    if (options.body) headers["Content-Type"] = "application/json";

    const response = await fetchAppleMusicWithRetry(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }, {
      fetcher: async (input, init) => {
        // Reserve room for OAuth, D1, and private RPC calls in the caller.
        if (++this.upstreamRequests > 35) throw new Error('Apple request budget reached; continue verification separately');
        return fetch(input, init);
      }
    });

    if (options.emptyOk && (response.status === 202 || response.status === 204)) return {};
    if (!response.ok) {
      const text = await response.text();
      const error = new AppleMusicApiError(response.status, text, response.headers.get('Retry-After'));
      if (response.status === 429) {
        this.cooldownUntil = Date.now() + Math.max(error.retryAfterMs ?? 300_000, 60_000);
        await this.env.DB.prepare("INSERT INTO collector_control(name,owner,lease_until_ms,cooldown_until_ms) VALUES('recently_played','',0,?) ON CONFLICT(name) DO UPDATE SET cooldown_until_ms=MAX(cooldown_until_ms,excluded.cooldown_until_ms)")
          .bind(this.cooldownUntil).run();
      }
      throw error;
    }
    if (response.status === 204) return {};
    return response.json<AppleListResponse>();
  }
}

export function hasAppleCredentials(env: Env): boolean {
  return Boolean(env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

export type RequestOptions = {
  user: boolean;
  method?: "GET" | "POST";
  body?: unknown;
  emptyOk?: boolean;
};

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
