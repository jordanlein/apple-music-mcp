# Two-minute collection on Sites with a Cloudflare timer

Sites must be the authoritative database before enabling this bridge. Follow the
[private Site and migration checklist](sites-migration.md), reconcile every
source row, preserve validation rows and protected backups, and keep one active
collector. Sites native scheduled tasks cannot provide a two-minute cadence.

## Configure the forwarding Worker

Use an existing verified Cloudflare timer when migrating an existing deployment.
The repository's `src/index.ts` selects forwarding when either bridge binding
is present; both must be valid. Without them it remains a standalone Cloudflare
collector. Its MCP fetch handler is retained, but explicit refreshes through
legacy clients still write to the source database. Reconnect clients to Sites
for current history.

Configure the ignored `wrangler.toml` with your own existing bindings:

```toml
[triggers]
crons = ["*/2 * * * *"]

[vars]
COLLECTOR_POLL_INTERVAL_SECONDS = "120"
SITE_COLLECTOR_URL = "https://YOUR_SITE.chatgpt.site/internal/collect"
```

Merge these values into existing sections rather than creating duplicate TOML
sections. Retain other required vars and original DB/KV bindings. Set the bridge
secret interactively:

```sh
npx wrangler secret put SITE_SERVICE_TOKEN
```

It must match Sites' supported service access credential and the destination's
`SITE_SERVICE_ACCESS_TOKEN`. Configure the authoritative Site itself with
`COLLECTOR_POLL_INTERVAL_SECONDS=120`, `SITE_COLLECTOR_ACTIVE=true`, and
`SITE_MIGRATION_ENABLED=false` after reconciliation.

The forwarding helper validates HTTPS, the `.chatgpt.site` host suffix and exact
`/internal/collect` path, with no query, credentials or custom port. Each tick
sends one POST with both platform and application bearer headers and a 60-second
request timeout. A successful response confirms a run ID and a bounded fetched
count; `busy` and `cooldown` are valid deferred outcomes. The timer logs these
as `sites_collector_deferred`; their temporary run IDs have no corresponding
`collector_runs` row and do not indicate a successful poll. Incomplete
configuration fails instead of silently collecting into the source database.

## Deploy and verify

```sh
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run
npm run deploy
```

The Site must already run the lease/cooldown code and its matching database
migration. Never enable a faster timer against an older destination that lacks
those protections. Preserve the original Cloudflare deployment version and
bindings for rollback.

For a cutover that must preserve the deployed fetch module byte-for-byte,
`withSitesScheduled` in `src/sites-trigger.ts` can wrap the saved deployment
module and forward fetch calls unchanged. Supply that original module privately
and preserve every original binding. Do not commit a production deployment
bundle, credentials or backups. Normal source deployment builds `src/index.ts`;
the wrapper is an alternative for retaining an existing published module.

Observe actual scheduled events in Cloudflare logs and corresponding
`collector_runs` in Sites. A configured cron, manual request or public diagnostic
response does not prove the timer runs. Verify at least two automatic invocations
near two minutes apart, inspect deferrals/errors, and confirm new observations
reach Sites. Cron updates may take time to propagate. No additional public
HTTP diagnostic URL is required for the timer.

## Cost and limits

`*/2 * * * *` produces up to 720 ticks per day. The forwarding handler performs
zero scheduled KV operations. Legacy MCP/OAuth client traffic can still use KV.
Standalone Cloudflare uses an hourly maintenance lease: the usual two OAuth KV
list scans per cleanup are about 48 per day rather than 1,440 at a two-minute
cleanup cadence. Additional KV pages and legacy client traffic can add usage.

Cloudflare's Free allowance includes 1,000 KV list requests daily, resetting at
00:00 UTC. Other account usage can still trigger notifications. Faster Sites
collection consumes hosting requests, database work and diagnostic storage.
Apple's numeric developer-token ceiling is not published; the collector honors
actual `429` responses with a persisted cooldown instead of immediate retries.

See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), and
[Apple rate-limit documentation](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens).

## Roll back safely

Pause Sites collection, preserve and reconcile destination changes, then deploy
the retained original Worker version and its scheduled handler. Restoring only a
cron cannot restore a handler that now forwards to Sites. Recheck source schema
and intended polling interval before enabling collection. Keep one authoritative
collector throughout and verify real scheduled runs after rollback.
