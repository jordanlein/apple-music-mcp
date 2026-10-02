# Update an existing local checkout

This is a reusable update checklist. Deployment IDs, credentials, owner identity,
backups and live verification evidence belong in a protected local checkpoint,
not this repository.

## Preserve local work and configuration

Review `git status --short` and save intentional edits before updating. Keep
untracked local deployment configuration, `.dev.vars`, `.openai/hosting.json`,
`.wrangler/state`, backups and signing keys separately. Never reset a checkout to
discard unexplained changes.

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
npm ci
npm test
npm run typecheck
```

Use Node.js 22.18 or newer. If there is no local `main`, use
`git switch --track origin/main`. If history diverges, reconcile your commits
instead of resetting. A saved stash should be restored with `git stash apply`
and retained until conflicts and verification are complete.

Compare the ignored `wrangler.toml` with `wrangler.example.toml`, retaining your
own database and KV bindings. Duplicate editor copies of the README are ignored;
do not stage them as a substitute for the tracked README.

## Choose the deployment to update

- **Standalone Cloudflare:** `src/index.ts`, D1 migrations in `migrations/`,
  Worker secrets, and `npm run deploy`. Follow the [Cloudflare instructions](../README.md#part-2-deploy-to-cloudflare).
- **Private Sites:** `src/sites.ts`, Sites Drizzle schema/migrations, private
  hosting environment and the installed Sites workflow helper. Follow the
  [Sites instructions](sites-migration.md). `npm run deploy` does not publish a Site.
- **Sites collection timer:** a Cloudflare Worker forwards to Sites. Follow the
  [timer bridge instructions](sites-timer-bridge.md); do not accidentally enable
  a second collector writing to the retired source database.

## Upgrade to two-minute collection

1. Back up the authoritative database, sequence state and existing OAuth KV.
   Verify a restore and retain the original encryption key and rollback version.
2. Apply `0007_collector_control.sql` before deploying code that uses leases and
   cooldowns. On Sites, apply the matching generated schema migration through
   its supported workflow; Cloudflare migration CLI commands target Cloudflare.
3. Set `COLLECTOR_POLL_INTERVAL_SECONDS` to `120` in the authoritative collector.
   Set the Cloudflare timer to `*/2 * * * *`. Preserve unrelated Worker bindings.
4. Run tests and TypeScript checks. For Sites, run `npm run build` and verify
   `dist/server/index.js`; for Cloudflare, run `npx wrangler deploy --dry-run`.
   Publish the exact tested source with your deployment's supported workflow.
5. Verify Apple authorization, MCP initialization, tool discovery and read-only
   status/history queries. Observe two real automatic collector runs near two
   minutes apart, with no unexplained failures or simultaneous writers.
6. Confirm a manual refresh during a collection returns `busy`, and a rate-limit
   cooldown is visible in status. Check those behaviors using automated fixtures
   rather than deliberately exhausting Apple's live allowance.

The lease prevents concurrent history updates; it does not make Apple an exact
playback event source. Preserve the documented 30-track window, estimated
timestamps and no-backfill limitations.

## Keep deployment evidence private

Record live worker/site version IDs, actual run IDs, row comparisons, backup
checksums and private backup locations locally. Keep credentials out of commands,
shell history, logs, archives, Git commits and documentation. Public examples
must contain placeholders. A clean current tree does not remove identifiers
from older Git commits; review reachable history and commit metadata separately.
