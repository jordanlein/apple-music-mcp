# Apple Music tracker: logging and Sites migration

Sites supports private MCP servers with a stateless `POST /mcp` endpoint and
platform-managed OAuth. That establishes MCP hosting support; it does not by
itself establish support for this collector's five-minute background schedule.

## Findings from production on October 2, 2026

- The Worker is `poke-apple-music-mcp`, with one D1 database and one OAuth KV
  namespace. The database held 4,360 listening events and 444 archived resource
  versions when inspected.
- Its Cron Trigger is `*/5 * * * *`. Most complete recent UTC days have 288
  successful polls. September 4 in Mountain Time contains a roughly 280-minute
  gap between recorded successful polls; September 16 in Mountain Time contains
  two roughly 30-minute gaps.
- The original ingest table records successful polls only. It cannot explain
  missing attempts, distinguish a failed poll from an unscheduled invocation,
  or establish whether any listening occurred during a gap.
- `observed_at` values are synthesized within a polling interval. Their spacing
  cannot establish rapid skips or the exact time a song played.
- `skipped_count` counts duplicate event inserts, not skipped songs. A full feed
  with no overlap indicates possible loss of coverage, not a measured number of
  missing plays. Empty polls and polls without new tracks are different.

## Logging changes

These logging changes were deployed to the existing Cloudflare Worker on
October 2, 2026. The database binding, secret bindings and five-minute Cron
Trigger were preserved. The module SHA-256 is
`f786e96bad49be18db8d0861ca52ce221b509313c9708fe37f1ba4e4f038d8b3`.
The first verified scheduled run finished successfully at 2:15 a.m. Mountain
Time on October 2. It fetched 30 tracks with 30 overlapping prior items and
zero new or duplicate events; the measured polling interval was 302,681 ms.
Only the changed application functions, tool descriptions and scheduled-call
source were replaced in the existing published module; its dependency bundle,
OAuth handling and other routes were retained. The previous Worker version
`e59d497e-599d-472a-bd17-d53fd3de16b0` remains available for rollback.

Validation passed 51 tests, TypeScript checking, a Cloudflare dry-run build and
a Sites Worker bundle build. The Sites tests exercise initialization and tool
discovery across separate stateless requests and deny other visitors access.

Migration `0006_collector_diagnostics.sql` adds `collector_runs` without modifying
existing listening events. Every attempted poll records its source and status.
Completed reads record polling bounds, overlap, initial-snapshot status and
possible coverage loss. Errors retain a safe category and Apple HTTP status;
upstream response bodies and exception messages are not persisted.

History and snapshot updates use one transactional D1 batch. An event insert
failure cannot advance the snapshot and strand the unrecorded events. An empty
response preserves a preceding nonempty snapshot to avoid treating its returning
tracks as entirely new. All collector calls read the full configured 30-track
window, regardless of a client's requested display limit.

The status tool exposes these diagnostics. Track responses explicitly label
their timestamps as estimates. Legacy diagnostic details cannot be reconstructed.
A process killed while collecting can leave a `running` record; storage outages
fall back to a structured Worker error log. These changes improve diagnosis;
they cannot recover tracks Apple no longer exposes.

## Destination prepared

`src/sites.ts` is the Sites entrypoint. It uses an explicitly stateless HTTP
transport, Sites-authenticated identity headers and `SITE_OWNER_EMAIL` to
authorize the account owner. Keep this entrypoint exclusively behind Sites
dispatch; an independent host would not authenticate those identity headers.
Discovery contains no private library content. Sharing the Site does not grant
another visitor access to the owner's Apple connection.

Sites handles MCP OAuth; do not install the old Cloudflare OAuth provider into
the Site. Preserve the original KV data separately, including client metadata,
expirations and grants if present. Existing clients must reconnect to the new
OAuth resource; old origin-bound authorizations do not become Sites grants.

## Preserve data before cutover

The protected backup directory is outside the repository:
`/workspace/private/apple-music-backup`. It stores the original schema,
autoincrement state, complete application rows, raw payloads and per-page
checksums. `restore.py` validates every page and reconstructs a SQLite database
whose table counts and integrity can be checked before import.

The captured baseline was restored successfully and matched all expected
counts: 4,360 events, 444 resource versions, one encrypted Apple token, two
configuration rows, two analytics-state rows, 156 audit rows, 8,703 retained
ingest runs and five original migration records. The OAuth KV backup contains
one client record; its checksum and entry count were verified. The downloadable
archive is `/workspace/private/apple-music-tracker-backup-2026-10-02.tar.gz`.

This is a live collection backup, not a frozen, cross-table transaction. Its
captured row bounds identify the baseline. Collection continues on Cloudflare;
export and reconcile changes after that baseline before cutover. The separately
generated Cloudflare SQL export is a consistent database snapshot. Neither
backup contains Worker secret values, which Cloudflare's API does not return.

Required runtime values include the original `APPLE_PRIVATE_KEY`,
`APPLE_TEAM_ID`, `APPLE_KEY_ID` and `TOKEN_ENCRYPTION_KEY`. Retain the encryption
key to read the existing encrypted Apple user token. Resetting setup or MCP
passcodes does not replace that encryption key. Configure secrets through Sites,
never in Git, a deployment archive, a schedule prompt or browser code.

A private Site has been registered and remains unpublished. The Apple team and
key identifiers have been configured there; the signing key and encryption key
have not. Continue with that existing Site rather than registering another. See
the [Mac handoff](mac-handoff.md) for the project ID and remaining steps.

Use the supported Sites workflow with the existing private Site, declare logical
`DB` storage and the `mcp` capability, import application data separately from
schema migrations, and publish the exact tested source. Import must preserve
event IDs, event keys, raw JSON, resource hashes, token ciphertext and metadata.
Compare complete row content and counts, not merely whether the endpoint loads.

Verify Apple token decryption, MCP initialization, tool discovery, read-only tool
calls and actual five-minute collection before redirecting clients. Establish a
supported background collection mechanism; exporting `scheduled` alone is
insufficient. Reconcile final changes while keeping one authoritative collector,
then verify that new events continue to arrive. Retain the source deployment,
database and KV backup for rollback until the destination is proven complete.

The Sites publishing helpers referenced by the installed skill were unavailable
in this executor when preparation began. No Site publication or cutover should
be represented as completed until the supported workflow and schedule succeed.

## Skip estimates

Song duration and real elapsed listening time can reveal a batch that could not
have been fully played. For example, 30 distinct three-minute tracks appearing
over five minutes imply incomplete plays only if the feed is fresh, ordered,
contains genuine transitions and has bounded reporting delay. A startup import,
reordered list, replay ambiguity, seeking, crossfade or delayed Apple update can
produce the same pattern. Counts alone cannot identify the skipped songs.

Do not train or score individual skips using this ledger's generated timestamps:
that would manufacture evidence from the timestamp interpolation algorithm.
For useful per-song estimates, collect genuine track transitions and playback
position or duration listened, retain uncertainty and compare predictions with
known skip events. Measure precision, recall and abstention on real listening
sessions before claiming a low error rate. Polling alone may miss entire short
plays even when the collector is functioning normally.
