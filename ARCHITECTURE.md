# Memory Graph Architecture

Mexplore stores long-term agent memory in ordinary directories and files. There is no database or embedding index in the graph engine. Both host plugins use the same graph engine and disk format.

## Terms and layout

- A **node** is one memory: a directory with an opaque, immutable 26-character ULID.
- An **attachment** is a file stored beside the node's Markdown body, carrying full documents, tables or other detail.
- An **edge** is a symlink connecting two node directories.
- A **handoff** is a node describing unfinished work. Open handoffs are pinned in the memory index.
- A **session** is the calling agent's identity, used to track reads, writes and permissions.

```text
<graphRoot>/
  MAP.md                         # regenerable memory index
  .access/<id>.log               # append-only read/traversal history
  .provenance/<id>.jsonl          # write provenance
  .advisories                    # write-time findings
  .archive/                      # archived nodes, recoverable by restore
  <node-id>/
    node.md                      # description, dates, type and body
    meeting-notes.md              # an attachment
    __edges__/
      <peer-id> -> ../../<peer-id>
      .edge-types                # optional relationship types
```

Node IDs are validated before they become paths. Every node lives directly under the graph root; relationships, not directory nesting, represent structure. The root is chosen by the host integration.

## Node format

```markdown
---
description: OAuth2 migration decision and its rationale
created: 2026-08-18
updated: 2026-08-24
type: decision
---

The decision, its reasons, and the identifiers needed to find its details.
See oauth2-migration-notes.md for the full report.
```

`description` is the discovery surface and is capped at 500 characters on write. `created` is required; `updated` and `type` are optional. Supported types are `identity`, `preference`, `decision`, `gotcha`, `journal`, `thread`, `trivia` and `handoff`. Unknown frontmatter keys survive updates.

The body keeps the gist and retrieval keys: names, identifiers, dates, conclusions and attachment filenames. Attachments retain the full detail. Splitting the two is not permission to truncate the attached document.

Framework-owned names include `node.md`, `__edges__`, `MAP.md`, access/provenance files, and recovery snapshots. They cannot be repurposed as attachments.

## Relationships

A plain relationship is one logical edge stored as two symlinks, one at each endpoint. `relates-to` is also symmetric. `supersedes` and `follows-from` remain directed.

Every edge target is exactly `../../<target-id>`. Targets must already exist and be valid node directories. A write naming a missing target is refused before any part of the write lands. Conflicting spellings of the same relationship in one write are also refused.

Types live in `__edges__/.edge-types`. Directed types are recorded on the source; a symmetric `relates-to` type has one canonical home, the lexicographically smaller node ID. Readers tolerate half-edges left by older graphs or interrupted writes; `graph-maintain --apply` completes them.

## Shared writers

Two writer surfaces implement this contract:

- `memory_fs/bin/`: shell-facing helpers for file-tool agents and operators.
- `mexplore_graph/src/`: the graph engine and model tools, copied into `dsh_plugin/lib/` for self-contained installation.

`dsh_plugin/test/interop.test.js` checks that each writer can read and extend the other's output. `scripts/sync-vendored.mjs --check` checks generated-copy parity. Edit shared source, not generated copies.

| Helper | Purpose |
|---|---|
| `node-new "description" [type]` | Stage and atomically publish a new node. |
| `edge-add <source> <target> [type]` | Create a valid relationship; plain edges are symmetric. |
| `touch-edge <source> <target>` | Record a traversal in the source's access log. |
| `graph-maintain` | Regenerate the index and report integrity/maintenance findings. `--apply` enables repairs and archival. |
| `provenance <id>` | Show write provenance without changing the graph. |

Set `GRAPH_ROOT` explicitly when invoking helpers. Back up a graph before applying maintenance.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `memory_search` | Search descriptions, bodies and attachment text; report matched and unmatched terms. |
| `memory_read` | Read a node, attachment list and related nodes. `from` records a traversal and can connect the two nodes. |
| `memory_read_file` | Read an attachment in bounded, UTF-8-safe pages. |
| `memory_write` | Create/revise a node, add links, supersede an older decision, or attach content in the same call. |
| `memory_attach` | Store supplied content or copy an allowed file from disk. |
| `memory_restore` | Restore an archived node. |
| `memory_merge` | Combine a genuine duplicate with a keeper while preserving its content and provenance. |

Descriptions, bodies and attachments have separate search weights (3, 1 and 0.5). Search is lexical, not semantic. Queries with no shared vocabulary can miss a relevant node. The memory index and the language model provide an additional discovery path, not a guarantee of recall.

Attachment search has a per-node budget of 256 KiB and at most 20 files. Budgets are shared fairly, with head/tail windows for files exceeding their share. A matching attachment returns an excerpt and offset; `memory_read_file` can retrieve the remaining pages. The index bounds rendered context, not whole-graph scanning cost.

## Reads, ranking and provenance

Read authority does not mean every operation is filesystem-pure: node reads append access history, and a traversal can create an edge. These effects are discovery bookkeeping, not permission to revise memory content.

Strength is computed rather than stored: traversal count, direct reads, recency and edge degree contribute to rank. Superseded memories are marked and ranked lower. `MAP.md` is derived and can always be regenerated; it is not the authoritative memory store.

Writes record their host, actor and originating chat/import session in `.provenance/<id>.jsonl`. Access history and write provenance are separate records. Neither substitutes for reading the memory itself.

## Write protection and recovery

- New nodes and rewritten files are staged and published with atomic renames.
- Per-node locking and session-scoped read/version checks protect concurrent writes. A stale writer must re-read and reconcile rather than silently overwrite another writer.
- Body replacement without a prior full read produces an advisory. Recovery snapshots retain the prior body.
- Replacing an attachment with different bytes requires having read every page or having written those bytes in the session. The read record is tied to the file, not merely its name.
- `memory_attach from_path` copies; it never moves or deletes the source. The source must be a regular file under configured allowed roots, outside hidden/credential/system paths, and within the size limit. A descriptor is checked after opening to resist path replacement.
- A changed decision uses `supersedes`: a successor, a typed link and a dated banner preserve the older record.
- Advisory findings are returned to the caller and appended to `.advisories`. Most are guidance, not proof of factual truth. The agent still needs evidence for what it writes.

The reserved `observation.txt` attachment is an automatic source capture and cannot be written directly by an agent.

## Host integration

DSH offers direct memory tools or a separate memory agent; enable one mode. Its agent uses the host's subagent service and graph-only presets. The sidebar panel follows the active graph and serves read-only routes through DSH's authenticated connection.

OpenCode creates a temporary child session for each memory call, exposes only that call's graph tools, and deletes the session afterwards. It inherits the chat model and credentials unless an independent memory model is selected. Reset restores inheritance; active custom-model calls retain their admitted model and endpoint.

The graph explorer and usage dashboard never mutate graph content. OpenCode's dashboard binds loopback and requires a capability token exchanged for an HttpOnly cookie. Do not share that URL.

## Maintenance and limits

`graph-maintain` reports by default. Applying maintenance can repair half-edges, remove invalid entries and archive eligible nodes. Archival moves content into `.archive/`; it is not silent deletion. An edge with no recorded use is not treated as proven stale.

Semantic maintenance is an explicit agent operation, described in [the maintenance guide](docs/maintain-agent.md). The plugin emits a backlog notice rather than scheduling an autonomous LLM job.

Whole-graph discovery scans grow with the graph. Index rendering limits do not eliminate that cost. Very large attachments are only partly searched, directed incoming edges require separate traversal, and symlink support is required. Windows is not a supported target.
