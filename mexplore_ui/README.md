# Mexplore UI

A read-only graph explorer and usage dashboard for Mexplore.

- **Graph explorer:** browse nodes, relationships, Markdown, attachments, access history and write provenance.
- **Usage dashboard:** inspect memory-call tokens, costs and latency when usage records are available. It does not read conversation text.

Only the agent's memory tools write the graph. The UI does not create, revise or delete memories.

## OpenCode

Run `/mexplore ui` inside OpenCode (Desktop and Web: `/mexplore-settings ui`). Open the returned URL on the machine running OpenCode. `/mexplore ui stop` stops the server.

The server binds loopback only. Its URL contains a capability token: anyone holding the URL can read the graph. Do not paste it into a chat or publish it. A successful token exchange sets a per-port HttpOnly, SameSite=Strict cookie and redirects to a URL without the token.

## DeepSeek Harness

The **Mexplore** sidebar panel shows the same graph explorer without the token dashboard. It follows the active memory mode's `graphRoot` unless a separate panel root is explicitly configured. DSH authenticates the panel's data requests through its own connection.

The DSH panel is built by `dsh_plugin/scripts/build-ui.mjs`; it is not the standalone Bun server.

## Embedding in a Bun process

```ts
import { startPluginUi, uiAssetsPresent } from 'mexplore-ui/plugin'

if (!uiAssetsPresent()) throw new Error('UI assets are missing')
const ui = await startPluginUi({ graphRoot, usageDir })
// Both paths must be absolute and already exist.
// Open ui.url locally; do not publish or log its token.
await ui.stop()
```

Port 43191 is the default. If occupied, the server requests a fresh OS-assigned port; it never adopts an existing listener. The imported module has no startup side effects.

Usage JSONL records are filtered by the pinned graph root. A user with several graphs sees only the selected graph's records.

## API and read boundaries

All endpoints accept `GET`/`HEAD`; other methods return `405`.

| Endpoint | Purpose |
|---|---|
| `/api/meta` | Graph metadata, source and server time. |
| `/api/graph` | Nodes, edges, open handoffs and warnings. |
| `/api/node/:id` | Node body, frontmatter, attachments, neighbors and provenance. |
| `/api/node/:id/file/:name` | A bounded plain-text attachment response. |
| `/api/search?q=` | Case-insensitive description/body substring search. |
| `/api/usage?from=&to=&bucket=day` | Token, cost and latency aggregates. |
| `/api/runs?from=&to=&sort=&dir=&offset=&limit=` | Paginated call summaries. |
| `/api/events` | Server-sent invalidation events; clients refetch data. |

Usage/runs default to the last seven days. Explicit ISO `from`/`to` values select a different window. Usage fields remain absent when unknown; missing provider data is not treated as zero cost or zero tokens.

Graph reads are pinned to the canonical root. Node IDs, attachment names and every path component are validated; symlinked content files or parent directories are refused. Edge symlinks must have the graph's exact relative target shape. Responses include frame, MIME-sniffing and referrer protections. API requests validate Host/Origin and reject cross-site requests.

The OpenCode dashboard requires its capability cookie for the app shell and all API routes. Static build assets contain no graph data. If the usage source is unavailable, usage endpoints report that state and the graph explorer remains usable.

The API type contract is [src/shared/types.ts](src/shared/types.ts). See [the graph architecture](../ARCHITECTURE.md) for the disk format.

## Build and test

```sh
bun install --frozen-lockfile
bun run build:web
bun test
bun run typecheck
```

`dist/` is committed because Git-subdirectory installation runs no build. The freshness test rebuilds into a temporary directory and compares the result with committed assets. Install development dependencies before running it; a skipped build check is not release verification.

For the DSH panel, run `npm --prefix dsh_plugin run build:ui` from the repository root and review `client.js` and `lib/ui-server.js`.

Fixtures are synthetic and created in temporary directories. Tests run real loopback HTTP servers and do not access a user's memory graph.

## License

[MIT](LICENSE), Copyright (c) 2026 Mexplore contributors. Bundled dependency notices and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
