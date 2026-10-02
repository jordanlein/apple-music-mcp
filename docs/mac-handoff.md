# Mac update and migration handoff

For the subsequent local cutover and reusable timer configuration, see
[five-minute Sites collection](sites-timer-bridge.md). The remaining-work list
below records the original remote handoff; deployment-specific completion
evidence belongs in the protected local migration checkpoint.

This handoff describes the changes prepared on October 2, 2026. The GitHub
`main` branch is the source to update from once the accompanying pull request
is merged. Your Mac checkout has not been inspected from this cloud executor;
it may still contain the older implementation.

## What changed

| Files | Change |
| --- | --- |
| `migrations/0006_collector_diagnostics.sql` | Adds `collector_runs`; preserves existing listening history. |
| `src/analytics.ts` | Records poll attempts, failures, interval, overlap, initial snapshots, duplicates and possible coverage loss. Reads the full 30-track window. Commits history and snapshot together; preserves the last nonempty snapshot after an empty response. Labels generated timestamps as estimates. |
| `src/collector-diagnostics.ts` | Classifies failures without recording upstream bodies or sensitive exception messages. |
| `src/index.ts`, `src/mcp.ts` | Marks scheduled polls and exposes diagnostics through MCP; clarifies that legacy `skipped_count` means duplicate inserts. |
| `src/types.ts` | Separates shared environment bindings from Cloudflare OAuth bindings. |
| `src/sites.ts`, `src/sites-access.ts` | Adds a stateless Sites MCP entrypoint and owner authorization through Sites identity headers plus `SITE_OWNER_EMAIL`. Sites handles OAuth. |
| `test/collector.test.ts`, `test/sites-access.test.ts`, `test/sites-mcp.test.ts` | Covers collection failures and rollback, overlap and empty responses, owner access, and independent stateless MCP requests. |
| `.openai/hosting.example.json`, `.gitignore`, documentation | Adds a hosting manifest template, excludes the actual local manifest and signing keys, and documents migration and update steps. |

Validation: 51 tests, TypeScript checking, a Cloudflare dry-run build and a Sites
Worker bundle build passed. No song-skip classifier has been implemented.
The current ledger interpolates observation timestamps; closely spaced rows
cannot establish skips. Genuine transitions or playback positions would be
needed to evaluate reliable per-song estimates.

## What is already live

The logging fixes and migration 0006 are already applied to the existing
Cloudflare Worker `apple-music-mcp`. Its existing D1 database, OAuth KV,
secret bindings and five-minute cron were preserved. Scheduled polls were
verified after deployment. Pulling this code updates your checkout; it does
not require redeploying production or creating another database.

The two forgotten setup/connection passcodes were reset with your authorization.
They are separate from `TOKEN_ENCRYPTION_KEY`. Their replacement values are in
the protected file `/workspace/private/apple-music-access.txt`, outside Git.

## Update your Mac without losing local work

In Terminal, enter the existing repository directory, then inspect it:

```sh
git remote -v
git status --short
git branch --show-current
git log -1 --oneline
```

The origin should identify `CONTRIBUTOR/apple-music-mcp`. If you have local edits,
commit them on your current branch or stash them before switching. For a stash:

```sh
git stash push -u -m "Mac changes before tracker update"
```

This saves tracked and untracked files; ignored files are not included. Keep
your `wrangler.toml`, `.dev.vars`, `.openai/hosting.json`, local `.wrangler`
state, backups and signing key separately. Never commit their secrets.

After the PR is merged:

```sh
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
npm ci
npm test
npm run typecheck
```

Use Node.js 22.18 or newer. If your checkout has no local `main`, create it with
`git switch --track origin/main`. If the pull reports divergent history, stop
and reconcile your commits instead of resetting or deleting them. Review saved
edits with `git stash show -p`; use `git stash apply` to restore them while
retaining the stash until conflicts and checks are resolved.

Your old `wrangler.toml` remains local and may contain account-specific bindings.
Compare it with `wrangler.example.toml`; retain production database and KV IDs.
Cloudflare uses `src/index.ts`; Sites must use `src/sites.ts`. A normal
`npm run deploy` remains a Cloudflare deployment, not a Sites publication.

## Continue the Sites migration locally

Use the existing private, unpublished Sites project:

```text
REPLACE_WITH_EXISTING_SITE_PROJECT_ID
```

Create the ignored `.openai/hosting.json` from the tracked example and replace
its placeholder with this ID. Keep `d1` as `DB`, `r2` as `null`, and the `mcp`
capability. Do not register a duplicate project.

The Apple team and key identifiers you supplied are already configured in Sites.
Your signing key is still on your Mac. Check its existence without printing it:

```sh
test -f "$HOME/Downloads/AuthKey_YOUR_APPLE_KEY_ID.p8" && echo "Signing key found"
```

Configure `APPLE_PRIVATE_KEY`, the original `TOKEN_ENCRYPTION_KEY`,
`SETUP_TOKEN` (the reset setup passcode), and `SITE_OWNER_EMAIL` through Sites' private environment controls. The owner email
must match the account Sites authenticates. Cloudflare cannot return existing
secret values. The original encryption key is necessary to decrypt the backed-up
Apple user token; changing the setup or connection passcode does not supply it.
If that key is unavailable, authorize a fresh Apple connection on the destination
while preserving the archived token ciphertext and all listening history.

The supported publication workflow requires the Sites plugin's bundled
`scripts/site-workflow.mjs`. It was unavailable in this cloud executor. From a
Codex session running locally on your Mac with Sites installed, have the agent
read the Sites MCP and hosting skills, locate the installed helper, and run the
supported workflow against this existing project. Repository credentials belong
in the workflow's private input, not a committed file or shell command. The
worker entrypoint alone does not configure a Sites background schedule.

Remaining migration work, in order:

1. Transfer the protected backup to your Mac and verify/restore it. Import
   schema and complete application rows into the destination DB, preserving IDs,
   event keys, raw payloads, resource versions, auth ciphertext and metadata.
   Establish the destination schema/import workflow; it has not been implemented
   or executed here. Do not seed a blank DB and call that a completed migration.
2. Configure secrets and owner authorization. Publish the tested source with the
   supported Sites workflow. Verify Apple authorization/decryption, MCP
   initialization, all tools, and read-only history queries.
3. Establish and observe an actual five-minute background collector. A Worker
   `scheduled` export does not prove that Sites invokes it.
4. Reconcile all changes since the baseline backup, including new events,
   diagnostics, audit rows, token/config updates and resource versions. Compare
   complete row content and counts. Keep one authoritative collector during
   cutover, then confirm new events arrive at the destination.
5. Reconnect MCP clients to the published Sites endpoint and Sites OAuth. Retain
   the old Cloudflare deployment, D1 and KV for rollback until the destination
   is verified. Do not delete the source to finish the migration.

## Files that must stay outside GitHub

The downloadable baseline archive is
`/workspace/private/apple-music-tracker-backup-2026-10-02.tar.gz`.
Its SHA-256 is
`a9bb360c239315b2dcd6b3613eb29df121f99e98e75218b369e477e53a5565f4`.
It contains a verified SQLite restore, checked backup pages, schema, sequence
state and the OAuth KV backup. The baseline had 4,360 listening events; Cloudflare
continued collecting afterward, so a final delta is still required. It is a
live collection backup, not a frozen cross-table snapshot. Worker secret values
are not included.

Transfer the archive and `/workspace/private/apple-music-access.txt` separately
to protected local storage. Keep the `.p8` file and encryption key private too.
These cloud paths do not exist automatically on your Mac after `git pull`.

For detailed evidence and limitations, see [Sites migration](sites-migration.md).
