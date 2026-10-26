# Operations and limits

## What history means

The collector observes Apple's recently played window, up to 30 tracks, every two minutes. Apple does not supply exact play timestamps here. `observedAt` values are estimates, and repeated plays, late upstream updates, downtime, or more than 30 changes between polls can make coverage incomplete. It cannot reconstruct unobserved activity or infer exactly which songs were skipped.

Use `apple_music_replay_summary` for Apple's official latest eligible year Replay data. Use the D1 history tools for the ledger observed since collection began. A gap between song timestamps does not establish collector downtime. A full new window without overlap flags possible coverage loss, not a known number of missing plays. `skipped_count` refers to duplicate event inserts, not skipped songs.

Listening events and distinct raw payload versions have no automatic retention cutoff. That policy is bounded by finite database storage. Future identical raw payloads are deduplicated by hash; this does not remove their separate listening events.

## Collection health

Call `apple_music_analytics_status` to inspect the latest successful poll, expected interval, recent durable attempts, overlap/failure diagnostics, and active cooldown. Confirm actual scheduled runs rather than relying on the cron configuration alone.

The 180-second fenced lease prevents two writers from advancing history simultaneously. Snapshot changes and event inserts commit in one D1 transaction; failed or stale writers cannot silently advance the snapshot. An unexpectedly empty Apple window does not erase a previous nonempty snapshot.

Manual refresh and Cron share the same lease. `busy` and `cooldown` are intentional deferrals that do not contact Apple or advance history. Their temporary run IDs are not persisted collector rows. Apple 429 responses persist a shared cooldown based on `Retry-After`, with a minimum minute and a default five minutes. Respect that retry time rather than repeatedly forcing refreshes.

## Cost and maintenance

One two-minute cron produces up to **720 ticks/day**. Collection uses D1 and Apple, not KV. OAuth client registration, grants, token handling, revocation, and garbage collection use KV.

Standalone Cloudflare claims a durable maintenance lease once per day, then:

- Runs the OAuth library's bounded expired-data cleanup (normally two KV list scans before pagination).
- Deletes audit rows older than `AUDIT_RETENTION_DAYS`, default 90.
- Prunes operational ingestion diagnostics older than 30 days through an indexed predicate.
- Deletes expired catalog-cache rows using an expiry index.

Maintenance is outside each collection pass. This avoids thousands of KV scans or repeated full diagnostic-table scans. If maintenance fails, it does not retry on every tick; inspect the logs and repair the cause. The durable maintenance gate remains held for its full day.

Successful catalog searches are cached for 24 hours on Cloudflare when `CATALOG_RESOLVER` is bound. Developer JWTs are reused while unexpired, and storefront/user-token reads are memoized within a request. Catalog resolution splits large batches into private RPC calls of at most ten inputs, preserving each original input index. Keep the service binding in your configuration: an unbounded sequence of name lookups is not safe within a single free-tier invocation's request budget.

Cloudflare's documented Workers Free limits include 100,000 requests/day, 10 ms CPU per invocation, and 50 external subrequests per invocation. D1 Free includes 5 million rows read/day, 100,000 rows written/day, and a 500 MB per-database limit. KV Free includes 100,000 reads/day and 1,000 each of writes, deletes, and lists/day. These allowances are account-wide where applicable and can be used by other applications. Limits may change; check the current sources below. Index maintenance and scans affect D1 row accounting.

Small deployments can fit free allowances, but free service is not unlimited and burst flexibility is not a guarantee. Heavy or cold MCP calls may exceed the nominal CPU target. Measure real invocation outcomes, CPU, database rows, KV operations, and storage growth for your own workload. Do not enable paid services or disable useful warnings just to hide a failing check. Cloudflare quota emails about daily KV operations do not necessarily mean storage is full.

Migration imports/exports and validation scans add one-time usage. Preserve all listening data and required historical evidence; estimate import/index writes before a large migration. The `migration_archive` table can hold checksummed compressed diagnostic snapshots. It is not populated automatically for an ordinary fresh installation. Multiple archive snapshots may overlap, so summed archive row counts are not unique record counts.

## Playlist write outcomes

GETs use bounded timeouts/retries for transient failures. POST writes have a longer timeout and **one attempt**. A dropped connection cannot prove whether Apple accepted a write. Inspect `writeOutcome`, `doNotRetry`, `verifiedAdded`, and `pendingVerification`; do not treat unknown or propagation-pending results as confirmed failure and blindly repeat them.

For an append, resolution completes before mutation; `allowPartial=false` blocks the entire append if any match is unresolved or ambiguous. Readback checks the resulting playlist. If the verification read itself fails, a successful write can remain pending rather than being mislabeled as rejected. Creation can return an unknown outcome with no playlist ID, requiring library inspection before another create.

## Routes

| Route | Access / purpose |
| --- | --- |
| `/` | Minimal public descriptor; does not reveal the capability. |
| `/mcp` | Streamable HTTP with OAuth, raw shared bearer, or derived capability bearer. |
| `/mcp/<CAPABILITY_TOKEN>` | Streamable HTTP; the complete private URL grants access. |
| `/sse` | Legacy route name using the same POST transport; raw `MCP_API_KEY` required. |
| `/authorize` | OAuth owner approval with CSRF checks and `OAUTH_CONSENT_TOKEN`. |
| `/oauth/register`, `/oauth/token` | OAuth registration, exchange, refresh. |
| `/setup`, `/auth/apple/token` | Session-protected Apple Music authorization. |

MCP bodies are bounded to 1 MiB, and a 2,048-element tool-input budget rejects excessive object keys/array elements before schema validation while allowing the full 100-track workflow. Stateful SSE sessions are not required, and GET/DELETE at an authorized MCP route return 405. Cross-origin browser requests are rejected. Setup uses a signed ten-minute HttpOnly/SameSite session and one-time browser-bound authorization state. Client audit attribution is derived from authenticated server context, not a caller-supplied identity header.

The current lockfile has no known production-dependency audit findings. Development-only Drizzle Kit dependencies still include a legacy esbuild loader flagged for a development-server advisory; that loader is not part of the deployed Worker. Do not apply an automatic forced downgrade of Drizzle Kit to clear the warning without testing schema tooling. Check `npm audit --omit=dev` and `npm audit` separately when updating dependencies.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP Unauthorized | Exact `/mcp` URL and bearer key, or full capability URL. Check whether `POKE_MCP_API_KEY` overrides capability derivation. Restart an expired OAuth flow. |
| Client vault still gets 401 | Put its stored credential in a bearer header; a URL-path surrogate may not be substituted. Do not use the whole endpoint URL as a key. |
| HTTP Not Acceptable | Send `Accept: application/json, text/event-stream`. |
| Browser visit shows 405 | Expected for a POST-only MCP route; use an actual MCP client. |
| No/old history | Inspect real collector runs, cooldowns, cron propagation, and the selected authoritative database. No historical backfill is available. |
| Apple Music disconnected/401 | Reauthorize through `/setup`; verify server signing secrets without printing them. |
| Large song batch fails | Apply every migration and retain the private `CatalogResolver` service binding matching the Worker name. Check Apple cooldowns and client timeouts. |
| Write timed out | Read the library/playlist and saved outcome before considering another write. Never blindly replay a create or append. |
| Sites plugin has stale data | Confirm proxy environment revision is deployed, owner checks remain enabled, and `CLOUDFLARE_MCP_URL` targets the canonical Worker. |

Useful commands:

```sh
npm test
npm run typecheck
npx wrangler d1 migrations list apple-music-mcp --remote
npx wrangler secret list
npx wrangler deploy --dry-run
npx wrangler tail
```

Tail/debug tools can display sensitive URLs or payloads even when invocation logging is disabled. Keep diagnostic output private and redact it before posting an issue. Never paste real token values into example commands.

## Backups and migration

Keep database exports, original encryption material, OAuth KV state/expirations, saved deployment versions, and private configuration outside Git. An ignored `work/` directory is available for local artifacts. For example, with your own database name:

```sh
mkdir -p work/backups
npx wrangler d1 export apple-music-mcp --remote --output work/backups/database.sql
```

Protect backups with restrictive filesystem permissions and suitable encrypted storage. Restore privately to check integrity; verify complete row content, stable IDs, raw payload hashes, token metadata, and sequence state, not just counts. Keep source schema migration bookkeeping separate from a destination platform's migration registry.

During a move, prepare/import the destination while the source remains authoritative. Pause source collection briefly for a final delta, verify the latest state, then enable the destination's single collector. After cutover, rollback must first transfer all new destination data back. Pointing a Worker at a stale backup or enabling two independent collectors can lose or duplicate observations. Do not delete the former environment during initial acceptance.

The Sites entrypoint has separate migration/service controls. Keep import access disabled after a move; the public repository must not contain actual exports or account-specific migration receipts. See [Sites migration](sites-migration.md) and [proxy mode](clients.md#optional-owner-private-sites-proxy).

## Sources

- [Workers limits and CPU burst behavior](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing and row accounting](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)
- [Apple recently played tracks](https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks)
