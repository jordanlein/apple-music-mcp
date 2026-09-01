# Apple Music MCP on Cloudflare

A remote Model Context Protocol (MCP) server that lets an AI agent safely work with one Apple Music account. It runs as a Cloudflare Worker, stores authorization and observed listening history in Cloudflare D1, and uses only Apple’s official MusicKit and Apple Music API surfaces.

The server can:

- Read indefinitely retained observed history by presets or an exact custom date range.
- Read heavy rotation and personalized Apple Music recommendations.
- Read official Apple Music Replay summaries.
- List library playlists and their tracks.
- Search the Apple Music catalog.
- Create playlists and append tracks, with duplicate checks and dry-run support.
- Build observed listening summaries and rankings by track, artist, album, or genre.
- Keep collecting recently played history every five minutes without an agent calling the MCP.

## Deployment model

Each deployment connects to one Apple Music account and keeps its data in that deployer's own Cloudflare D1 database. MCP requests require `POKE_MCP_API_KEY`, and the browser setup flow requires `SETUP_TOKEN`. Nothing in the repository grants access to an existing deployment, Apple account, or listening history.

## How it works

```mermaid
flowchart LR
    Client["MCP client or AI agent"] -->|"Bearer API key"| Worker["Cloudflare Worker"]
    Worker -->|"Developer token + encrypted user token"| Apple["Apple Music API"]
    Worker --> D1["Cloudflare D1"]
    Setup["Browser setup page<br/>MusicKit authorization"] --> Worker
    Cron["Cloudflare cron<br/>every 5 minutes"] --> Worker
    D1 --> History["Observed listening history<br/>analytics state<br/>audit log"]
```

The Worker signs short-lived Apple developer tokens using the configured Media Services private key. The browser setup page uses MusicKit to obtain the account’s music user token, which is encrypted with AES-GCM before being stored in D1.

Cloudflare’s scheduled handler fetches Apple’s latest 30 played tracks every five minutes. It compares consecutive snapshots and stores the newly observed prefix, allowing repeated tracks to become separate observed events.

## MCP tools

The server currently exposes 14 tools.

| Tool | Capability | Important inputs |
| --- | --- | --- |
| `apple_music_status` | Check Apple credentials, account connection, token age, and storefront. | None |
| `apple_music_recently_played` | Page through D1-backed history from any observed timeframe. | `preset` or `start`/`end`, `limit`, `cursor`, `refreshFirst` |
| `apple_music_heavy_rotation` | Read Apple Music heavy rotation, similar to “On Repeat.” | `limit` up to 10 |
| `apple_music_recommendations` | Read personalized recommendation groups. | `limit` up to 10 |
| `apple_music_replay_summary` | Read official latest-year Replay totals and top content. | None |
| `apple_music_list_playlists` | List library playlists and whether each is editable. | `limit` up to 500 |
| `apple_music_get_playlist_tracks` | Read tracks from a library playlist. | `playlistId`, `limit` |
| `apple_music_search_catalog` | Search songs, albums, artists, playlists, or music videos in the user’s storefront. | `term`, `types`, `limit` |
| `apple_music_create_playlist` | Create a new library playlist. | `name`, `description` |
| `apple_music_add_tracks_to_playlist` | Safely resolve, preflight, deduplicate, and append up to 100 tracks. | `playlistId`, `tracks`, `dryRun`, `allowPartial` |
| `apple_music_analytics_refresh` | Manually refresh the observed listening ledger. | `limit` up to 30 |
| `apple_music_analytics_status` | Inspect ledger coverage and recent ingest runs. | None |
| `apple_music_listening_summary` | Build SQL-side observed totals and top items for any timeframe. | `preset` or `start`/`end` |
| `apple_music_top_stats` | Rank tracks, artists, albums, or genres for any timeframe. | `preset` or `start`/`end`, `kind`, `limit` |

### Recently played query examples

Request the first 20 songs observed during the last 30 days:

```json
{
  "preset": "30d",
  "limit": 20
}
```

Request a custom Mountain Time range:

```json
{
  "start": "2026-08-01T00:00:00-06:00",
  "end": "2026-08-15T00:00:00-06:00",
  "limit": 50
}
```

Request all observed history:

```json
{
  "preset": "all_time",
  "limit": 50
}
```

Presets are `today`, `24h`, `7d`, `30d`, `90d`, `ytd`, `last_year`, and `all_time`. Use either one preset or a custom inclusive `start` and optional exclusive `end`; custom timestamps must include `Z` or a UTC offset. Calendar presets default to `America/Denver`, with an optional IANA `timeZone` override.

History responses are deliberately bounded to 200 tracks and default to 50. When `coverage.hasMore` is true, pass the returned `nextCursor`; it carries the original fixed range so rolling presets cannot shift between pages. Summary and ranking tools aggregate inside D1 and do not return or load the full event ledger.

### Playlist write behavior

The write surface is intentionally conservative:

- The server can create a playlist.
- It can append tracks to an editable library playlist.
- It compares up to 10 catalog candidates per requested song and verifies title, artist, and version.
- It rejects unintended remixes, live recordings, covers, and other variants.
- It reports unresolved and ambiguous requests instead of silently substituting or dropping them.
- It checks the current playlist and the incoming batch for duplicate catalog IDs.
- By default, one unresolved or ambiguous request blocks the entire write; `allowPartial: true` requires an explicit decision to skip questionable songs.
- `dryRun: true` resolves and deduplicates tracks without changing Apple Music and should be used before large or important writes.
- A completed write is read back with bounded retries. If Apple has accepted the append but its eventually consistent library read has not caught up, the tool reports `pending_apple_propagation` rather than incorrectly claiming verification failed.
- It does not remove tracks, reorder tracks, insert at a position, edit playlist metadata, or delete playlists.

## Listening-history accuracy

Apple’s recently played endpoint is not a historical export. It returns at most 30 tracks and does not include a play timestamp.

Consequently:

- History cannot be backfilled retroactively.
- `observedAt` is estimated within the five-minute interval in which the Worker first detected a song.
- If all 30 upstream slots change between polls, the collector flags a possible coverage gap.
- Every observed listen event is retained indefinitely; no automatic event-expiration query exists.
- Existing event rows and their raw payloads remain untouched. Future events keep normalized per-play data and reference a content-addressed raw payload version, so identical JSON is stored once while every changed version remains recoverable.
- Any timeframe is incomplete unless the collector has actually covered that entire period without an upstream polling gap.
- `apple_music_replay_summary` is the correct tool for authoritative latest-year Replay totals.

## Prerequisites

You need:

- Node.js and npm.
- A Cloudflare account with Workers and D1 access.
- An Apple Developer account with permission to create Media IDs and Media Services keys.
- An Apple Music subscription for the account being connected.
- An MCP client that supports remote Streamable HTTP servers.

In the Apple Developer portal:

1. Register a Media ID under Certificates, Identifiers & Profiles.
2. Enable the Apple Music/MusicKit service for that identifier.
3. Create a Media Services private key associated with the Media ID.
4. Download the `.p8` private key immediately; Apple does not allow it to be downloaded again.
5. Record the key ID and Apple Developer team ID.

## Fresh Cloudflare setup

These steps create an independent deployment in your Cloudflare account.

### 1. Install dependencies and sign in

```bash
npm install
npx wrangler login
```

### 2. Create Cloudflare storage and local configuration

Copy the public configuration template:

```bash
cp wrangler.example.toml wrangler.toml
```

Create the OAuth KV namespace:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned namespace ID into the `OAUTH_KV` entry in your local `wrangler.toml`.

Create the D1 database:

Create a database:

```bash
npx wrangler d1 create apple-music-mcp
```

Copy the returned database ID into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "apple-music-mcp"
database_id = "<YOUR_D1_DATABASE_ID>"
migrations_dir = "migrations"
```

Apply the schema:

```bash
npx wrangler d1 migrations apply apple-music-mcp --remote
```

The migrations create:

- `auth_tokens` for the encrypted Apple music user token.
- `config` for authorization state and the cached storefront.
- `listen_events` for indefinitely retained normalized listening events.
- `track_resource_versions` for content-addressed Apple payload versions, deduplicating identical future metadata while preserving every distinct payload and linking it to the listen event.
- `analytics_state` for snapshot comparison state.
- `analytics_ingest_runs` for collector health and coverage.
- `audit_log` for MCP read and write activity.

### 3. Configure Worker secrets

Set all six secrets interactively:

```bash
npx wrangler secret put POKE_MCP_API_KEY
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY
```

Secret meanings:

| Secret | Purpose |
| --- | --- |
| `POKE_MCP_API_KEY` | Bearer token required for every `/mcp` and `/sse` request. |
| `SETUP_TOKEN` | Protects the browser-based `/setup` route. |
| `TOKEN_ENCRYPTION_KEY` | Encrypts the Apple music user token stored in D1. Use a strong random value and preserve it for the lifetime of the stored token. |
| `APPLE_TEAM_ID` | Apple Developer team identifier used as the developer-token issuer. |
| `APPLE_KEY_ID` | Identifier of the Media Services private key. |
| `APPLE_PRIVATE_KEY` | Full PKCS#8 contents of the downloaded `.p8` file, including its header and footer. |

Generate strong random values for the first three secrets with a password manager or a command such as:

```bash
openssl rand -base64 32
```

Never commit these values. The project ignores `work/`, `.wrangler/`, `.dev.vars`, and the local `wrangler.toml` deployment configuration.

### 4. Validate and deploy

```bash
npm test
npm run typecheck
npx wrangler d1 migrations apply apple-music-mcp --remote
npx wrangler deploy --dry-run
npm run deploy
```

Apply migrations before deploying a Worker version that references a new table. Migrations `0003_indefinite_history.sql` and `0004_resource_versions.sql` create the compact resource archive and replacement history index; they do not update or delete any `listen_events` rows or existing inline raw payloads.

The deploy output prints the Worker URL. The MCP endpoint is that URL plus `/mcp`.

### 5. Authorize Apple Music

Open:

```text
https://<YOUR_WORKER>.workers.dev/setup?setup_token=<SETUP_TOKEN>
```

Select **Authorize Apple Music** and complete Apple’s prompt. The setup page sends the resulting music user token directly to the Worker, which encrypts it before saving it in D1.

Apple does not issue a refresh token for this flow. If Apple access later expires, open the same setup URL and authorize again. In practice, this may be needed roughly every six months.

### 6. Verify the connection

Configure an MCP client with:

- URL: `https://<YOUR_WORKER>.workers.dev/mcp`
- Authorization header: `Bearer <POKE_MCP_API_KEY>`
- Transport: Streamable HTTP

Then call `apple_music_status`. A healthy connection reports:

```json
{
  "appleCredentialsConfigured": true,
  "connected": true,
  "storefront": "us"
}
```

For Poke, the existing project used:

```bash
npx poke@latest mcp add https://<YOUR_WORKER>.workers.dev/mcp \
  -n "Apple Music" \
  -k "<POKE_MCP_API_KEY>"
```

The Worker also exposes `/sse` for clients that still use the older endpoint name.

## Local development

Apply the migrations to Wrangler’s local D1 instance:

```bash
npx wrangler d1 migrations apply apple-music-mcp --local
```

Create a `.dev.vars` file containing the six Worker secrets. Do not commit it. For a multiline Apple private key, store the key using the syntax supported by the installed Wrangler version or use a local secrets file.

Start the Worker:

```bash
npm run dev
```

Useful project commands:

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
npx wrangler tail
```

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | Public | Small JSON service descriptor. |
| `/mcp` | `POKE_MCP_API_KEY` | Primary MCP Streamable HTTP endpoint. |
| `/sse` | `POKE_MCP_API_KEY` | Compatibility endpoint using the same MCP handler. |
| `/setup` | `SETUP_TOKEN` | Browser MusicKit authorization page. |
| `/auth/apple/token` | Setup state | Receives and encrypts the authorized Apple music user token. |

`/setup` accepts its token as `?setup_token=...` or as a Bearer token. MCP endpoints accept only the configured Bearer API key.

## Operations and troubleshooting

### Check deployment and database state

```bash
npx wrangler whoami
npx wrangler d1 migrations list apple-music-mcp --remote
npx wrangler secret list
```

Use the MCP tools `apple_music_status` and `apple_music_analytics_status` for application-level health.

`apple_music_analytics_status` reports indefinite retention, total event coverage, and the count of archived resource-payload versions. Monitor D1 storage and rows read in the Cloudflare dashboard as the all-time ledger grows. Pagination and timestamp indexes keep sequence queries bounded; summary and ranking queries aggregate in SQL.

### Apple Music is disconnected

Open the protected setup URL and authorize again. If the setup page says Apple credentials are missing, confirm that `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` exist as Worker secrets.

### MCP returns `Unauthorized`

Confirm the client sends:

```text
Authorization: Bearer <POKE_MCP_API_KEY>
```

The setup token does not grant MCP access, and the MCP API key does not replace the Apple account authorization.

### History is shorter than expected

The collector cannot retrieve plays from before it started. Confirm the five-minute cron is deployed and call `apple_music_analytics_status` to inspect recent ingest runs. The Apple endpoint can also lose coverage if more than 30 tracks move through its window between polls.

### Raw HTTP testing returns `Not Acceptable`

The MCP transport expects both supported response types:

```text
Accept: application/json, text/event-stream
```

Normal MCP clients set this automatically.

## Security notes

- Apple’s `.p8` key, MCP API key, setup token, and encryption key belong in Cloudflare secrets, not `wrangler.toml`.
- The Apple music user token is encrypted before storage with AES-GCM.
- The setup flow uses a random state value checked by the Worker before accepting a token.
- Read and write tool activity is recorded in `audit_log`; an optional `X-Poke-User-Id` request header is included when supplied.
- Playlist changes are append-oriented and deliberately exclude destructive operations.
- Losing `TOKEN_ENCRYPTION_KEY` makes the stored Apple token unreadable. Changing it requires reauthorizing Apple Music.

## Project structure

```text
src/
  index.ts            Worker routes, MCP authentication, and scheduled handler
  mcp.ts              MCP tool definitions and input validation
  apple.ts            Apple Music API client and developer-token signing
  analytics.ts        D1 collection, paged history queries, and SQL-side statistics
  timeframe.ts        Preset/custom ranges and timezone-aware calendar boundaries
  recent-history.ts   Snapshot diffing and opaque history cursor logic
  storage.ts          Token, config, and audit persistence
  setup.ts            Browser MusicKit authorization flow
  crypto.ts           ES256 signing and AES-GCM encryption
  format.ts           Compact MCP response formatting
  types.ts            Worker and Apple API types
migrations/           D1 schema migrations
test/                 Snapshot, timeframe, pagination, matching, and metadata tests
wrangler.example.toml Public Worker, D1, KV, variables, and cron template
wrangler.toml         Local deployment configuration (ignored by Git)
```

## Platform and API references

- [Create an Apple Media ID and private key](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key/)
- [Create an Apple service private key](https://developer.apple.com/help/account/keys/create-a-private-key)
- [Apple Music API: recently played tracks](https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
