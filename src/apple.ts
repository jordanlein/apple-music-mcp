import { signEs256Jwt } from "./crypto";
import { getConfig, loadAppleToken, setConfig } from "./storage";
import type { AppleListResponse, AppleResource, Env } from "./types";
import {
  AppleMusicApiError,
  fetchAppleMusicWithRetry,
  isEmptyPlaylistTracksError,
  mapWithConcurrency
} from "./apple-transport";
import { chooseSongMatch } from "./song-matching";

const API_BASE = "https://api.music.apple.com/v1";
const SONG_LOOKUP_CONCURRENCY = 4;
const SONG_LOOKUP_CANDIDATES = 10;

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
    return signEs256Jwt(
      { alg: "ES256", kid: this.env.APPLE_KEY_ID },
      { iss: this.env.APPLE_TEAM_ID, iat: now, exp: now + ttl },
      this.env.APPLE_PRIVATE_KEY
    );
  }

  async userStorefront(): Promise<string> {
    return (await getConfig(this.env, "apple_storefront")) ?? this.env.APPLE_STOREFRONT ?? "us";
  }

  async refreshAndStoreStorefront(): Promise<string> {
    const response = await this.request("/me/storefront", { user: true });
    const storefront = response.data?.[0]?.id ?? this.env.APPLE_STOREFRONT ?? "us";
    await setConfig(this.env, "apple_storefront", storefront);
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
    const path = `/catalog/${encodeURIComponent(storefront)}/search?types=${encodeURIComponent(types)}&limit=${Math.min(limit, 25)}&term=${encodeURIComponent(term)}`;
    const response = await this.request(path, { user: false });
    const results: Record<string, AppleResource[]> = {};
    for (const [key, value] of Object.entries(response.results ?? {})) {
      results[key] = value.data ?? [];
    }
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

  async resolveSongIds(tracks: SongLookupInput[]): Promise<SongResolutionBatch> {
    const outcomes = await mapWithConcurrency(tracks, SONG_LOOKUP_CONCURRENCY, async (track, inputIndex) => {
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.developerToken()}`
    };
    if (options.user) {
      const token = await loadAppleToken(this.env);
      if (!token?.musicUserToken) throw new Error("Apple Music is not connected. Open /setup with the setup token and authorize Apple Music.");
      headers["Music-User-Token"] = token.musicUserToken;
    }
    if (options.body) headers["Content-Type"] = "application/json";

    const response = await fetchAppleMusicWithRetry(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (options.emptyOk && (response.status === 202 || response.status === 204)) return {};
    if (!response.ok) {
      const text = await response.text();
      throw new AppleMusicApiError(response.status, text, response.headers.get('Retry-After'));
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
