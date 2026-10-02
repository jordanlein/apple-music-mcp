# Deploy privately on Sites or migrate from Cloudflare

The Site exposes the same Apple Music tools through stateless `POST /mcp` and
Sites-managed authentication. Use `src/sites.ts`, not the standalone Cloudflare
OAuth entrypoint. The database schema is in `db/schema.ts`; generated Sites
migrations and their journal are in `drizzle/`, configured by `drizzle.config.ts`. Cloudflare schema migrations remain in `migrations/`.

## Prepare the private Site

1. Install the Sites plugin in the local Codex environment. Follow its current
   MCP, hosting and persistence skills; those provide the supported project,
   storage and publication operations.
2. Create a private project, or select your existing project. Copy
   `.openai/hosting.example.json` to ignored `.openai/hosting.json`, set your own
   project ID, and retain logical `DB` storage and the `mcp` capability.
3. Use Node.js 22.18 or newer, run `npm ci`, `npm test`, and
   `npm run typecheck`, and `npm run build`. The build bundles `src/sites.ts`
   into the required `dist/server/index.js` artifact. Configure the generated
   Drizzle migrations through the supported storage workflow before executing
   new code. For a new Site, apply the complete initial schema; for an existing
   Site, retain its migration journal and apply only pending schema changes.
   Do not replay the initial table-creation migration onto a populated database.
4. Prepare source and its deployment archive with the plugin's bundled
   `scripts/site-workflow.mjs` helper. Obtain repository credentials through
   the plugin and pass them through the helper's private input. Publish the
   exact prepared version privately with the supported hosting tools. Keep
   account configuration, credentials, logs and database exports out of the
   source archive. A Cloudflare `npm run deploy` is a different deployment.

Schema publication does not import an existing user's rows. Follow the migration
checklist below when moving a populated database.

## Configure private environment values

| Name | Purpose |
| --- | --- |
| `APPLE_TEAM_ID` | Your Apple Developer team identifier. |
| `APPLE_KEY_ID` | Your Media Services signing key identifier. |
| `APPLE_PRIVATE_KEY` | Complete private `.p8` contents. |
| `TOKEN_ENCRYPTION_KEY` | Original key for migrated encrypted Apple authorization, or a new key for a new installation. |
| `SETUP_TOKEN` | Distinct random passcode for protected browser setup. |
| `SITE_OWNER_EMAIL` | Owner email matching Sites' verified account identity. |
| `SITE_SERVICE_ACCESS_TOKEN` | Private server-to-server credential accepted by both Sites hosting and the application. |
| `SITE_COLLECTOR_ACTIVE` | Set `false` while preparing/importing; set `true` after final reconciliation. |
| `SITE_MIGRATION_ENABLED` | Set `true` only during controlled import; set `false` afterward. |
| `COLLECTOR_POLL_INTERVAL_SECONDS` | `120` for two-minute collection. |
| `APPLE_STOREFRONT` | Optional catalog storefront, for example `us`. |
| `APPLE_DEVELOPER_TOKEN_TTL_SECONDS` | Optional developer-token lifetime, normally `3600`. |
| `AUDIT_RETENTION_DAYS` | Audit retention setting, normally `90`; Sites requires separate audit maintenance to enforce it. |

The two-minute bridge invokes collection only; it does not run standalone
Cloudflare OAuth or audit cleanup. Sites audit retention needs separately
configured maintenance. The ingest diagnostic table prunes its older entries
within collection, while observed history remains indefinite.

Use private hosting controls for every credential and owner identifier. Keep
`SITE_SERVICE_ACCESS_TOKEN` aligned with the hosting platform's supported service
access credential; a random application-only bearer value does not bypass the
platform's access checks. Rotate the bridge and destination values together.

Browser and MCP routes require Sites-verified user identity and the configured
owner. Never expose this entrypoint on a host that accepts caller-spoofed Sites
identity headers. Sharing a Site does not grant a visitor the owner's Apple
Music connection. Sites handles MCP authentication; do not copy Cloudflare OAuth
KV grants into the Site's runtime or fake authenticated-user headers.

For a new installation, open the private `/setup` page, enter `SETUP_TOKEN`, and
complete Apple Music authorization. For migration, preserve the original token
ciphertext and encryption key. Resetting setup or MCP credentials does not
replace the encryption key; if unavailable, reconnect Apple Music while keeping
all archived history and the encrypted token backup.

## Service routes

All service routes require POST, reject browser `Origin` headers, and require
application bearer authentication in addition to platform service access.

| Route | Purpose |
| --- | --- |
| `/internal/check` | Verify Apple token decryption, a bounded Apple read and database status. |
| `/internal/collect` | Collect up to 30 tracks when `SITE_COLLECTOR_ACTIVE=true`; otherwise return 409. |
| `/internal/migration` | Allowlisted import/page/digest/sequence operations while `SITE_MIGRATION_ENABLED=true`; otherwise return 404. |

The timer sends both `Authorization: Bearer <SERVICE_TOKEN>` and
`OAI-Sites-Authorization: Bearer <SERVICE_TOKEN>`. These are service credentials;
they do not authenticate a human MCP client.

## Migrate without losing data

1. Preserve the source database schema, complete application rows, raw Apple
   resource versions, event keys/IDs, auth ciphertext, configuration, diagnostics,
   audit rows and autoincrement state. Export OAuth KV separately, preserving
   values and expirations. Keep all backups in protected local storage, verify
   their checksums, and restore the SQL backup to check SQLite integrity.
2. Keep the source collector active while preparing the private Site. Apply
   schema migrations and import the baseline with the destination collector
   paused. Runtime lease/cooldown rows are operational state, not historical
   events; initialize them safely rather than replaying a stale lease owner.
3. Import only supported tables/columns in batches of at most 50 rows and
   512 KB. The service upserts by primary key. Before reusing it for a final
   delta, preserve destination records created during validation. Resolve
   diagnostic integer-ID collisions by retaining those destination records at
   new IDs while restoring every source record's original ID and content.
4. Compare complete canonical row content and counts for every historical
   table, preserving original event IDs, hashes, raw JSON and token metadata.
   Restore sequence state to at least the highest retained ID. Counts alone
   do not prove equality. Treat a live baseline as provisional: collection and
   manual operations may have added source rows afterward.
5. Verify MCP initialization, tool discovery, owner access denial for other
   visitors, Apple authorization/decryption and read-only history queries.
   Use playlist dry runs to verify write planning without changing the library.
6. Briefly stop source collection, export its final consistent snapshot and
   reconcile every change since baseline. Keep both sides backed up. Do not
   let source and destination collect independently during the transition.
7. Enable destination collection, disable migration access, and enable the
   [Cloudflare timer bridge](sites-timer-bridge.md). Sites native scheduled
   tasks allow at most one run per hour, so they cannot supply this two-minute
   cadence. A `scheduled` export alone does not create a background schedule.
8. Observe actual automatic runs and new observations in the destination,
   then reconnect clients through the Site's plugin connection. Retain the
   original database, KV and immutable Worker version for rollback.

Record all deployment-specific evidence in a private checkpoint. This public
checklist makes no claim about any particular account's migration state.

## Verify operation and client compatibility

Call `apple_music_status` and `apple_music_analytics_status` through the connected
plugin. Confirm credentials, connection, database coverage, configured interval,
recent attempts, lease state and any rate-limit cooldown. Correlate timer logs
with stored run IDs and verify at least two automatic runs near two minutes
apart. Confirm newly observed events arrive without running a second collector.

The supported Sites plugin connection is documented for ChatGPT/Codex. MCP is
provider-neutral, but a private Site's platform authentication must be supported
by an external harness before its URL is usable there. Do not treat service
migration credentials as a generic MCP login. External provider compatibility
is not established by this repository; test each client's actual authorization
and read-only MCP flow. Standalone Cloudflare separately supports a static
bearer key and MCP OAuth for compatible clients.

## Limits and interpretation

Apple exposes at most 30 recently played tracks and no exact play timestamps.
Faster polling improves freshness and narrows observation bounds, but upstream
delay, ordering changes and repeated plays remain ambiguous. Polling cannot
recover missing history, guarantee complete plays, or identify individual skips.
`skipped_count` means duplicate event inserts, not skipped songs. A full window
with no overlap signals possible coverage loss, not a known missing-play count.

The shared 180-second lease and fenced history transaction prevent overlapping
requests from advancing the snapshot incorrectly. Apple `429` replies persist
`Retry-After` as a shared cooldown, defaulting to five minutes and at least one
minute, with no immediate retry. Collection can intentionally defer while busy
or cooling down. A `busy` or `cooldown` response returns a temporary run ID and
retry time but does not create a `collector_runs` row, contact Apple, or advance
the history snapshot. The forwarding timer logs these as `sites_collector_deferred`;
its returned run ID cannot be looked up in the stored collector table. Inspect
these outcomes separately from successful empty polls.

See [Apple's recent tracks endpoint](https://developer.apple.com/documentation/applemusicapi/get-v1-me-recent-played-tracks),
[Apple developer tokens and rate limiting](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens),
and [Sites plugin hosting](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites).
