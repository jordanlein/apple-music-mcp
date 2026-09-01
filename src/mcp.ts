import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyticsStatus, appleReplaySummary, listeningSummary, recentListeningHistory, refreshRecentListeningAnalytics, topListeningStats } from "./analytics";
import { AppleMusicApi, hasAppleCredentials } from "./apple";
import { compactResource, compactResources, jsonText } from "./format";
import { audit, appleTokenStatus } from "./storage";
import { timeframePresetValues } from "./timeframe";
import type { ToolContext } from "./types";

const TIMEFRAME_INPUT_SCHEMA = {
  preset: z.enum(timeframePresetValues).optional().describe("Convenient range: today, rolling 24h/7d/30d/90d, ytd, last_year, or all_time. Defaults to 7d. Do not combine with start or end."),
  start: z.string().optional().describe("Custom inclusive start as an ISO 8601 timestamp with Z or a UTC offset. Use instead of preset."),
  end: z.string().optional().describe("Optional custom exclusive end as an ISO 8601 timestamp with Z or a UTC offset. Requires start and defaults to now."),
  timeZone: z.string().optional().describe("IANA time zone for calendar presets such as today, ytd, and last_year. Defaults to America/Denver.")
};

const READ_ONLY_APPLE = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const READ_ONLY_BACKEND = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const REFRESHING_READ = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const CREATE_APPLE_RESOURCE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

const ADD_TO_APPLE_RESOURCE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

const REFRESH_BACKEND = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

export function createAppleMusicMcp(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "apple-music",
    version: "0.1.0"
  });

  server.registerTool(
    "apple_music_status",
    {
      title: "Check Apple Music Connection",
      description: "Use when setup, authorization, or another Apple Music tool may be failing. Reports whether server credentials exist, whether the user authorized Apple Music, when that token was stored, and which storefront catalog searches use. This diagnoses configuration only; it does not modify Apple Music.",
      annotations: READ_ONLY_BACKEND,
      inputSchema: {}
    },
    async () => {
      const api = new AppleMusicApi(ctx.env);
      const token = await appleTokenStatus(ctx.env);
      let storefront: string | undefined;
      if (token.connected) storefront = await api.userStorefront();
      return jsonText({
        appleCredentialsConfigured: hasAppleCredentials(ctx.env),
        connected: token.connected,
        tokenUpdatedAt: token.updatedAt,
        storefront
      });
    }
  );

  server.registerTool(
    "apple_music_recently_played",
    {
      title: "Get Recently Played History",
      description: "Use when the user asks which tracks they listened to during any observed timeframe. Choose one preset or provide an exact custom start/end range; history is retained indefinitely from the collector's first observation. Returns a bounded newest-first page from Cloudflare D1. If hasMore is true, repeat the same timeframe with nextCursor; never request all matching tracks in one response. Coverage is approximate and cannot predate the collector; use apple_music_replay_summary for official year-level totals. With refreshFirst=true this safely updates the backend ledger but never changes the Apple Music library.",
      annotations: REFRESHING_READ,
      inputSchema: {
        ...TIMEFRAME_INPUT_SCHEMA,
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum songs in this page, from 1 to 200. Keep this small for agent efficiency."),
        cursor: z.string().max(1024).optional().describe("Opaque nextCursor from the previous page. It preserves the original range, so other timeframe fields may be omitted while paging."),
        refreshFirst: z.boolean().default(true).describe("Refresh the 30-track Apple window before querying Cloudflare history.")
      }
    },
    async ({ preset, start, end, timeZone, limit, cursor, refreshFirst }) => {
      if (refreshFirst) await refreshRecentListeningAnalytics(ctx.env);
      const result = await recentListeningHistory(ctx.env, { preset, start, end, timeZone, limit, cursor });
      await audit(ctx.env, ctx.pokeUserId, "apple_music_recently_played", "read", {
        preset,
        start,
        end,
        timeZone,
        limit,
        cursorApplied: Boolean(cursor),
        refreshFirst,
        count: result.tracks.length
      });
      return jsonText(result);
    }
  );

  server.registerTool(
    "apple_music_heavy_rotation",
    {
      title: "Get Heavy Rotation",
      description: "Use when the user asks for their heavy rotation, frequently played music, favorites they keep returning to, or an Apple Music equivalent of 'On Repeat'. Returns Apple's current personalized heavy-rotation resources. This is Apple's opaque ranking rather than a requested date-range calculation; use apple_music_top_stats for ranked observed plays over a specific supported period.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {
        limit: z.number().int().min(1).max(10).default(10).describe("Maximum heavy-rotation resources to return, from 1 to Apple Music's endpoint maximum of 10.")
      }
    },
    async ({ limit }) => {
      const api = new AppleMusicApi(ctx.env);
      const items = await api.heavyRotation(limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_heavy_rotation", "read", { limit, count: items.length });
      return jsonText({ items: compactResources(items) });
    }
  );

  server.registerTool(
    "apple_music_recommendations",
    {
      title: "Get Personalized Recommendations",
      description: "Use when the user wants personalized Apple Music discovery ideas or recommendations based on their account. Returns Apple's recommendation groups, not listening history, catalog search results, or guaranteed individual song matches.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {
        limit: z.number().int().min(1).max(10).default(10).describe("Maximum Apple recommendation groups to return, from 1 to 10.")
      }
    },
    async ({ limit }) => {
      const api = new AppleMusicApi(ctx.env);
      const items = await api.recommendations(limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_recommendations", "read", { limit, count: items.length });
      return jsonText({ items: compactResources(items) });
    }
  );

  server.registerTool(
    "apple_music_replay_summary",
    {
      title: "Get Official Replay Summary",
      description: "Use when the user asks for their official Apple Music Replay, latest eligible year totals, listening minutes, or year-level top artists, albums, and songs. Returns Apple's authoritative Replay summary. Prefer this over apple_music_listening_summary or apple_music_top_stats for year-level claims because the backend observed-history ledger is incomplete.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {}
    },
    async () => {
      const result = await appleReplaySummary(ctx.env);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_replay_summary", "read", { year: result.coverage.year, period: result.coverage.period });
      return jsonText(result);
    }
  );

  server.registerTool(
    "apple_music_list_playlists",
    {
      title: "List Library Playlists",
      description: "Use when the user asks to see their Apple Music playlists or when another playlist operation needs a playlist ID. Returns library playlist IDs, names, and canEdit metadata. Select an editable playlist and pass its ID to apple_music_get_playlist_tracks or apple_music_add_tracks_to_playlist.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100).describe("Maximum library playlists to return, from 1 to 500.")
      }
    },
    async ({ limit }) => {
      const api = new AppleMusicApi(ctx.env);
      const playlists = await api.listPlaylists(limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_list_playlists", "read", { limit, count: playlists.length });
      return jsonText({ playlists: compactResources(playlists) });
    }
  );

  server.registerTool(
    "apple_music_get_playlist_tracks",
    {
      title: "Get Playlist Tracks",
      description: "Use to inspect an Apple Music library playlist, verify an append, or see which tracks it already contains. Pass the library playlist ID returned by apple_music_list_playlists or apple_music_create_playlist, usually beginning with 'p.'. An empty playlist returns an empty tracks array.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {
        playlistId: z.string().min(1).describe("Apple Music library playlist ID, usually beginning with p."),
        limit: z.number().int().min(1).max(500).default(100).describe("Maximum playlist tracks to return, from 1 to 500.")
      }
    },
    async ({ playlistId, limit }) => {
      const api = new AppleMusicApi(ctx.env);
      const tracks = await api.playlistTracks(playlistId, limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_get_playlist_tracks", "read", { playlistId, limit, count: tracks.length });
      return jsonText({ playlistId, tracks: compactResources(tracks) });
    }
  );

  server.registerTool(
    "apple_music_search_catalog",
    {
      title: "Search Apple Music Catalog",
      description: "Use to browse or disambiguate songs, albums, artists, playlists, or music videos in the connected user's storefront and retrieve canonical catalog IDs. This searches the Apple Music catalog, not only the user's library. For adding many songs to a library playlist, do not call this once per song: pass the entire batch of IDs, search terms, or name/artist pairs directly to apple_music_add_tracks_to_playlist, which resolves unknown songs itself.",
      annotations: READ_ONLY_APPLE,
      inputSchema: {
        term: z.string().min(1).describe("Catalog search text. Include both title and artist when looking for a specific song."),
        types: z.enum(["songs", "albums", "artists", "playlists", "music-videos"]).default("songs").describe("Single catalog resource type to search. Defaults to songs."),
        limit: z.number().int().min(1).max(25).default(10).describe("Maximum matches to return, from 1 to Apple's per-search maximum of 25.")
      }
    },
    async ({ term, types, limit }) => {
      const api = new AppleMusicApi(ctx.env);
      const results = await api.searchCatalog(term, types, limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_search_catalog", "read", { term, types, limit });
      return jsonText(Object.fromEntries(Object.entries(results).map(([key, values]) => [key, compactResources(values)])));
    }
  );

  server.registerTool(
    "apple_music_create_playlist",
    {
      title: "Create Library Playlist",
      description: "Use when the user explicitly wants a new Apple Music library playlist. Creates an empty playlist and returns its library playlist ID. Capture that ID, then call apple_music_add_tracks_to_playlist once with the complete track batch. Repeating this call creates another playlist, and this API cannot later rename or edit playlist metadata.",
      annotations: CREATE_APPLE_RESOURCE,
      inputSchema: {
        name: z.string().min(1).max(120).describe("User-visible playlist name, from 1 to 120 characters."),
        description: z.string().max(500).default("").describe("Optional user-visible playlist description, up to 500 characters.")
      }
    },
    async ({ name, description }) => {
      const api = new AppleMusicApi(ctx.env);
      const playlist = await api.createPlaylist(name, description);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_create_playlist", "write", { name, playlistId: playlist?.id });
      return jsonText({ playlist: playlist ? compactResource(playlist) : null });
    }
  );

  server.registerTool(
    "apple_music_add_tracks_to_playlist",
    {
      title: "Add Tracks to Playlist",
      description: "Use to safely append 1 to 100 songs to an existing editable Apple Music library playlist. Prefer one call containing the complete batch and provide separate name and artist fields for every song without a known catalog ID. The resolver compares up to 10 candidates per song, requires a strong title/artist/version match, rejects unintended remixes, live recordings, covers, and other variants, checks both existing playlist contents and duplicates within the request, and reports unresolved or ambiguous songs with candidate details. By default the write is atomic at the resolution stage: if any song is unresolved or ambiguous, nothing is added. Run dryRun=true first for important or large playlists, inspect every proposed match, then repeat with dryRun=false. Set allowPartial=true only when the user explicitly accepts skipping questionable songs. After Apple accepts a write, the tool retries playlist readback; verificationStatus=pending_apple_propagation means the library has not reflected the change yet, not that the append failed. Apple’s public API cannot remove or reorder playlist tracks, so prevention and preflight verification are essential.",
      annotations: ADD_TO_APPLE_RESOURCE,
      inputSchema: {
        playlistId: z.string().min(1).describe("Apple Music library playlist ID, usually beginning with p."),
        tracks: z.array(z.object({
          id: z.string().optional().describe("Apple Music catalog song ID. Prefer this when known."),
          term: z.string().optional().describe("Fallback search phrase used when ID is unknown. For reliable matching, also provide separate name and artist fields."),
          name: z.string().optional().describe("Exact requested song title, including a version label such as Remix or Live only when that version is intended."),
          artist: z.string().optional().describe("Expected primary song artist. Strongly recommended whenever ID is unknown; mismatched artists are rejected.")
        }).refine((track) => Boolean(track.id || track.term || track.name), {
          message: "Each track needs an id, term, or name."
        })).min(1).max(100).describe("Complete batch of 1 to 100 songs to resolve, deduplicate, and append in this call."),
        dryRun: z.boolean().default(false).describe("Set true to preview every match, ambiguity, unresolved item, duplicate, and proposed addition without modifying Apple Music. Strongly recommended before large writes."),
        allowPartial: z.boolean().default(false).describe("Defaults to false, so any unresolved or ambiguous song blocks the entire write. Set true only when the user explicitly accepts adding confident matches while skipping questionable songs.")
      }
    },
    async ({ playlistId, tracks, dryRun, allowPartial }) => {
      const api = new AppleMusicApi(ctx.env);
      const [existing, resolution] = await Promise.all([
        api.playlistTracks(playlistId, 500),
        api.resolveSongIds(tracks)
      ]);
      const existingIds = new Set(existing.flatMap((track) => {
        const attrs = track.attributes ?? {};
        const playParams = attrs.playParams as { id?: string; catalogId?: string } | undefined;
        return [track.id, playParams?.id, playParams?.catalogId].filter(Boolean) as string[];
      }));
      const seenRequestIds = new Set<string>();
      const requestDuplicates: typeof resolution.resolved = [];
      const uniqueResolved = resolution.resolved.filter((track) => {
        if (seenRequestIds.has(track.id)) {
          requestDuplicates.push(track);
          return false;
        }
        seenRequestIds.add(track.id);
        return true;
      });
      const existingDuplicates = uniqueResolved.filter((track) => existingIds.has(track.id));
      const toAdd = uniqueResolved.filter((track) => !existingIds.has(track.id));
      const hasResolutionIssues = resolution.unresolved.length > 0 || resolution.ambiguous.length > 0;
      const blocked = !allowPartial && hasResolutionIssues;
      if (!dryRun && !blocked && toAdd.length) await api.addTracksToPlaylist(playlistId, toAdd);
      const added = !dryRun && !blocked ? toAdd : [];
      const verification = added.length
        ? await verifyPlaylistAdditions(api, playlistId, added.map((track) => track.id))
        : undefined;
      const verifiedAdded = added.filter((track) => verification?.observedIds.has(track.id));
      const pendingVerification = added.filter((track) => !verification?.observedIds.has(track.id));
      await audit(ctx.env, ctx.pokeUserId, "apple_music_add_tracks_to_playlist", dryRun ? "preview_write" : blocked ? "blocked_write" : "write", {
        playlistId,
        requested: tracks.length,
        resolved: resolution.resolved.length,
        unresolved: resolution.unresolved.length,
        ambiguous: resolution.ambiguous.length,
        blocked,
        added: added.length,
        skippedDuplicates: existingDuplicates.length + requestDuplicates.length
      });
      return jsonText({
        playlistId,
        dryRun,
        allowPartial,
        blocked,
        blockedReason: blocked ? "Nothing was added because at least one requested song was unresolved or ambiguous. Review the candidates, correct the inputs or use known catalog IDs, and retry." : undefined,
        requested: tracks.length,
        resolved: resolution.resolved,
        unresolved: resolution.unresolved,
        ambiguous: resolution.ambiguous,
        skippedExistingDuplicates: existingDuplicates,
        skippedRequestDuplicates: requestDuplicates,
        added,
        verifiedAdded,
        pendingVerification,
        verificationStatus: added.length
          ? pendingVerification.length
            ? "pending_apple_propagation"
            : "confirmed"
          : undefined,
        verificationPassed: added.length && pendingVerification.length === 0 ? true : undefined,
        verificationNote: pendingVerification.length
          ? "Apple accepted the append request, but some catalog IDs were not visible in immediate playlist readback after several retries. Apple documents that library changes may be delayed; this is pending propagation, not a failed add."
          : undefined,
        wouldAdd: dryRun ? toAdd : undefined
      });
    }
  );

  server.registerTool(
    "apple_music_analytics_refresh",
    {
      title: "Refresh Listening Analytics",
      description: "Use only to force a maintenance refresh of the Cloudflare observed listening ledger or diagnose ingestion. Normally do not call this directly: apple_music_recently_played, apple_music_listening_summary, and apple_music_top_stats refresh automatically by default. Fetches Apple's current recently-played window of at most 30 tracks, compares it with the prior snapshot, and stores newly observed events. It cannot backfill older history and never modifies the Apple Music library.",
      annotations: REFRESH_BACKEND,
      inputSchema: {
        limit: z.number().int().min(1).max(30).default(30).describe("Number of tracks to request from Apple's current recently-played window, from 1 to the maximum of 30.")
      }
    },
    async ({ limit }) => {
      const result = await refreshRecentListeningAnalytics(ctx.env, { limit });
      await audit(ctx.env, ctx.pokeUserId, "apple_music_analytics_refresh", "write", result);
      return jsonText(result);
    }
  );

  server.registerTool(
    "apple_music_analytics_status",
    {
      title: "Check Analytics Coverage",
      description: "Use when observed listening results look incomplete or stale, or when diagnosing the collector. Reports stored event count, first and last observed timestamps, cursor state, and recent ingestion runs. This reads backend coverage metadata only and does not refresh Apple Music or modify the library.",
      annotations: READ_ONLY_BACKEND,
      inputSchema: {}
    },
    async () => {
      const result = await analyticsStatus(ctx.env);
      return jsonText(result);
    }
  );

  server.registerTool(
    "apple_music_listening_summary",
    {
      title: "Summarize Observed Listening",
      description: "Use for a Stats.fm/Airbuds-style overview of observed listening during any preset or exact custom timeframe. Returns SQL-computed estimated plays and listening minutes, unique counts, top tracks/artists/albums/genres, recent tracks, and explicit coverage metadata without loading the full history into the agent or Worker. The ledger is retained indefinitely but begins when the collector first observed plays; use apple_music_replay_summary for official year-level totals, apple_music_recently_played for a paged track sequence, or apple_music_top_stats for one ranked category.",
      annotations: REFRESHING_READ,
      inputSchema: {
        ...TIMEFRAME_INPUT_SCHEMA,
        refreshFirst: z.boolean().default(true).describe("Refresh Apple's current 30-track window into the backend ledger before summarizing; defaults to true and does not modify the Apple Music library.")
      }
    },
    async ({ preset, start, end, timeZone, refreshFirst }) => {
      if (refreshFirst) await refreshRecentListeningAnalytics(ctx.env);
      const timeframe = { preset, start, end, timeZone };
      const result = await listeningSummary(ctx.env, timeframe);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_listening_summary", "read", { ...timeframe, refreshFirst });
      return jsonText(result);
    }
  );

  server.registerTool(
    "apple_music_top_stats",
    {
      title: "Rank Observed Listening Stats",
      description: "Use when the user asks for one ranked observed category—top tracks, artists, albums, or genres—during any preset or exact custom timeframe. D1 performs the aggregation and returns only the requested ranking plus coverage metadata, making even all-time questions efficient for the agent. These are collector observations, not authoritative year-level totals; use apple_music_replay_summary for official Replay or apple_music_listening_summary for a multi-category overview.",
      annotations: REFRESHING_READ,
      inputSchema: {
        ...TIMEFRAME_INPUT_SCHEMA,
        kind: z.enum(["tracks", "artists", "albums", "genres"]).default("tracks").describe("Single category to rank: tracks, artists, albums, or genres. Defaults to tracks."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum ranked items to return, from 1 to 50."),
        refreshFirst: z.boolean().default(true).describe("Refresh Apple's current 30-track window into the backend ledger before ranking; defaults to true and does not modify the Apple Music library.")
      }
    },
    async ({ preset, start, end, timeZone, kind, limit, refreshFirst }) => {
      if (refreshFirst) await refreshRecentListeningAnalytics(ctx.env);
      const timeframe = { preset, start, end, timeZone };
      const result = await topListeningStats(ctx.env, timeframe, kind, limit);
      await audit(ctx.env, ctx.pokeUserId, "apple_music_top_stats", "read", { ...timeframe, kind, limit, refreshFirst });
      return jsonText(result);
    }
  );

  return server;
}

async function verifyPlaylistAdditions(
  api: AppleMusicApi,
  playlistId: string,
  expectedIds: string[]
): Promise<{ observedIds: Set<string>; attempts: number }> {
  let observedIds = new Set<string>();
  const delays = [0, 400, 1_200, 2_400];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    const tracks = await api.playlistTracks(playlistId, 500);
    observedIds = new Set(tracks.flatMap((track) => {
      const attrs = track.attributes ?? {};
      const playParams = attrs.playParams as { id?: string; catalogId?: string } | undefined;
      return [track.id, playParams?.id, playParams?.catalogId].filter(Boolean) as string[];
    }));
    if (expectedIds.every((id) => observedIds.has(id))) return { observedIds, attempts: attempt + 1 };
  }
  return { observedIds, attempts: delays.length };
}
