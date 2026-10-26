# Connect MCP clients

Deploy your own Cloudflare Worker and authorize Apple Music using the [README](../README.md#part-2-deploy-to-cloudflare). These examples contain placeholders only. Each client must support remote Streamable HTTP MCP, and every approved client receives all 14 tools for the one connected account.

## Standard bearer connection

Use your own origin plus `/mcp`, with `Authorization: Bearer <MCP_API_KEY>`. Clients may call the field API key, token, or custom headers. If a client offers OAuth by default, explicitly choose bearer/API-key mode when using this option. A valid connection should initialize, discover 14 tools, and call `apple_music_status` successfully.

The SHA-256 capability token is also accepted as a bearer value at `/mcp`; it grants the same access as its URL. This is useful for credential vaults that replace secret placeholders in headers but cannot replace them in URL paths. Do not hash an already-derived capability token again.

## Private capability URL

Run the local helper:

```sh
node scripts/mcp-connection.mjs https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
```

Enter the exact configured `POKE_MCP_API_KEY` override, or `MCP_API_KEY` if no override exists. The helper writes `work/mcp-connection.json`, excluded by Git. Add its complete `url` to the client with auth type **None**. The long path is the credential; a public root URL is not a substitute. It is not advertised by `/`.

Use explicit bearer mode if the client insists on OAuth discovery for the same host. Keep the entire URL out of public recipes, issue reports, screenshots, analytics, access logs, and source code. The example Worker configuration disables invocation URL logging; review any additional logging or proxies you enable.

To invalidate the capability, rotate its source key and update the relevant clients together. Rotating `MCP_API_KEY` also changes clients that use that raw bearer key. If `POKE_MCP_API_KEY` is configured, it controls capability derivation instead; changing only `MCP_API_KEY` does not rotate that capability. Do not rotate the token encryption key as a connection reset.

## Poke

Poke distinguishes a **Kitchen integration template** from a **personal connected integration**. Testing or saving a template alone does not connect the personal assistant.

For a template, use the complete capability URL with auth type None and run its connection test. Confirm that it discovers 14 tools. For the personal account, use Poke's supported remote MCP connection flow, or its documented CLI:

```sh
npx poke@latest login
npx poke@latest mcp add --help
```

The CLI supports `mcp add <url> --name <name>` and an optional API-key field. Supply your own `/mcp` URL and bearer key through the client's secure credential flow when possible. Avoid pasting real credentials into shell commands/history. If a CLI response says OAuth is required for a capability URL, use explicit bearer credentials or the web OAuth flow.

Open your personal Integrations page, inspect the saved Apple Music entry, and refresh discovery. Check the tool list there, then ask the assistant for a read-only status check. Verify the new connection before disconnecting a superseded entry. Do not publish a recipe containing a private capability URL or shared owner credentials.

## Custom connector clients, including Muse

Use a client's built-in **custom remote MCP** flow where available. For a generated custom connector client:

- Store the credential in the client's secret vault/secure form.
- POST JSON-RPC to your `/mcp` URL with `Authorization: Bearer <stored credential>`.
- Send `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- Use the raw `MCP_API_KEY`, or the derived capability token when that is the existing shared credential. Do not send the whole URL as an API key.
- Preserve MCP request IDs, negotiate the protocol, and read results and errors accurately.
- Discover all 14 tools and verify `apple_music_status` and `apple_music_analytics_status` before reporting success.

A vault placeholder appearing in a path is not necessarily substituted with the real secret. Prefer header authentication when the vault supports only header substitution. Respect any direct owner authorization the receiving client requires. Never present yourself as the owner when acting on their behalf.

A successful status test verifies the connection; it does not mean every possible future playlist write is guaranteed. Do not test writes against someone's library without their authorization.

## Optional owner-private Sites proxy

A thin private Site can retain an existing Sites-created ChatGPT/Codex plugin while Cloudflare owns the database and collector. External clients then connect directly to Cloudflare.

1. Complete the Cloudflare migration and verify its data, Apple authorization, tools, and two-minute collector first.
2. In the existing private Site's production environment, set `CLOUDFLARE_MCP_URL` as a **secret** containing your complete Cloudflare capability URL. This implementation accepts HTTPS `workers.dev` targets.
3. Keep the Site owner identity and private access controls in place. Set `SITE_COLLECTOR_ACTIVE=false` and `SITE_MIGRATION_ENABLED=false`; remove the old Cloudflare-to-Sites forwarding mode from the canonical Worker's configuration.
4. Build/publish the tested `src/sites.ts` entrypoint through the Sites plugin's supported workflow. Apply the new environment revision by deploying a saved version. `npm run deploy` is only for the Cloudflare Worker.
5. Verify the installed Site plugin reports the same fresh event count and latest Cloudflare poll as a direct client.

Owner authentication remains enforced by Sites and the application. The proxy forwards only JSON-RPC and required protocol headers, strips visitor/platform credentials, refuses redirects, and does not retry writes. Proxy mode disables the Site's scheduled collector even if its collector flag is accidentally enabled. The browser setup page redirects to Cloudflare, where the setup passcode is still required.

Retain the paused Site database and private exports for rollback. Before switching back to a previous database, reconcile every newer event and snapshot from the current authority. Re-enabling a stale collector is not a safe rollback.
