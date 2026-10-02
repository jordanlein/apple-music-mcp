# Five-minute collection after migrating to Sites

Sites must be the authoritative database before enabling this bridge. Complete
the final source export and compare every imported row, including IDs, payloads,
auth ciphertext, resource versions and diagnostics. Preserve destination rows
created during validation rather than overwriting colliding diagnostic IDs.
Keep protected backups, the source database and OAuth KV for rollback.

Sites' native scheduled tasks permit one run per hour. To retain five-minute
collection, the existing Cloudflare Worker can forward its established timer to
the private Sites collector. Configure both of these Worker bindings:

| Binding | Value |
| --- | --- |
| `SITE_COLLECTOR_URL` | `https://YOUR_SITE.chatgpt.site/internal/collect` |
| `SITE_SERVICE_TOKEN` | Private secret matching Sites' service access credential |

The destination must implement an authenticated collector route that returns a
run ID and fetched count between 0 and 30. It should fail with 409 while paused.
The Sites application must validate the service credential independently of
the platform's access check. Browser and MCP owner authorization stays enabled.

With either bridge binding present, `src/index.ts` replaces the scheduled
Cloudflare collection and cleanup with the Sites request. Both bindings must be
valid; incomplete configuration fails rather than collecting in the wrong
database. Its existing MCP fetch handler and bindings remain available.
Without bridge bindings, normal Cloudflare collection is unchanged.

For a cutover that must preserve the deployed fetch module exactly,
`withSitesScheduled` in `src/sites-trigger.ts` wraps that module and forwards
fetch calls unchanged. Supply the saved deployment module separately, preserving
all original bindings. Never commit live credentials, backups or a deployment
bundle containing account configuration. Retain the immutable original version
for rollback.

Keep the existing five-minute cron and observe actual automatic runs in both
Cloudflare logs and Sites `collector_runs`. Configuration and an HTTP diagnostic
alone do not prove the timer runs. Verify new observations reach Sites, disable
the temporary migration route, and reconnect clients to Sites' `/mcp` endpoint.
An explicit refresh through a legacy Cloudflare MCP client would still write to
the retired source ledger.

The forwarding handler performs no KV operations. Replacing the old scheduled
OAuth cleanup removes its two KV list requests per poll, or 576 list requests
per full day. Legacy MCP traffic can still use OAuth KV. Cloudflare's Free plan
includes 1,000 list requests daily, resetting at 00:00 UTC; other account usage
can still trigger warnings. See [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

To roll back, pause Sites collection, preserve and reconcile all destination
changes, then deploy the retained original Worker version with its scheduled
handler. Restoring only a cron cannot restore a handler that now forwards to
Sites. Keep one authoritative collector throughout the transition.
