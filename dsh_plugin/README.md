# Mexplore for DeepSeek Harness

Persistent memory stored as a filesystem graph: Markdown nodes, attachments and symlink relationships. The bundle offers direct tools, a dedicated memory agent, conversation-history import and a read-only graph panel.

## Install / 安装

### English

1. Open **Plugins → Add plugin** and paste:

   ```text
   github:mexplor/Mexplore-oss#release/oss-initial&path:/dsh_plugin
   ```

2. Leave **Registry** on **Official npm registry**, choose **Install**, then **Enable now**.
3. Enable exactly one memory mode. **Memory tools (direct)** is the shipped default. For a separate memory agent, turn it off and turn **Memory agent** on.
4. Open **Mexplore** in the sidebar to inspect saved memories. The graph starts empty and is created on the first save.

### 中文

1. 打开 **Plugins → Add plugin**，粘贴上面的 GitHub 地址。
2. **Registry** 保持 **Official npm registry**，点 **Install → Enable now**。
3. 记忆模式只开一个。默认开启 **Memory tools (direct)**；想让独立代理负责记忆，就关掉它，再打开 **Memory agent**。
4. 在侧边栏点 **Mexplore** 查看保存的记忆。图一开始是空的，首次保存时才创建。

默认目录为 `~/.dsh/memory-graph`。卸载插件不会删除记忆图。

## Choose a memory mode

| Switch | Default | Behavior |
|---|---|---|
| `memory-graph-direct` — Memory tools (direct) | on | The main agent gets graph tools and a 30-line memory index. |
| `memory-graph-agent` — Memory agent | off | The main agent delegates to a separate graph-only agent through `memory_agent`. Replies include checked citations. |
| `memory-graph-ui` — Mexplore panel | on | Read-only browser for the active memory mode's graph. |

The two memory modes are alternatives. `memory_agent` refuses calls while direct tools are enabled. The panel is independent and never writes the graph.

**DSH's chat access mode does not block memory writes.** The graph lives outside the workspace sandbox. Use memory-agent mode with `approveWrites: true` if each manage call needs approval.

## First use

1. Say: “Remember for the long term: we release on Thursdays because QA signs off on Wednesdays.”
2. Check that a memory was saved; the response should identify its node.
3. Open a new conversation and ask: “When do we release, and why? Check long-term memory.”
4. Open the sidebar panel to inspect the saved body, relationships and attachments.

Store durable decisions, preferences, corrections, outcomes and unfinished work, not passing remarks. Back up the graph like any other directory. Only memory tools or the provided helpers should write it; hand-made directories in `__edges__` are not relationships.

## Use an existing graph / 使用已有的图

Back up the profile's `cordis.patch.yml` before editing it. For Desktop this is `~/.dsh/profiles/desktop/cordis.patch.yml`. An override replaces that row's whole `config`.

```yaml
- id: memory-graph-agent
  config:
    graphRoot: ~/notes/memory
    maxIndexEntries: 30
    approveWrites: true
    timeoutMs: 300000
```

The panel follows the enabled mode's graph automatically. Set its own `graphRoot` only to deliberately show a different graph. Restart DSH after editing the profile file.

修改前备份配置。面板会自动跟随当前记忆模式的 `graphRoot`，不用另设路径。只想试用已有图、不想改动原图时，先复制整张图，再把路径指向副本；修改配置后重启 DSH。

Do not import into a graph while another session is writing to it.

### Model selection

The memory agent inherits the caller's model by default. To select another model, add the host's model reference to the memory-agent row:

```yaml
model: { provider: your-provider, model: your-model }
```

Use a provider/model already available in DSH. Model selection changes latency, token cost and answer quality; it does not change the disk format.

## Import conversation history

Enable **Memory agent**, disable **Memory tools (direct)**, open a new chat and say “import my history” / 「导入历史」.

The agent scans local Claude Code history and asks for four confirmations: **scope, privacy, mode, and start**. Changing the scope or plan requires renewed confirmation.

- Keys, tokens, ID numbers, phone numbers and card numbers are redacted automatically. Health details, names, financial information and other personal content are not guaranteed to be removed. Review the selected material.
- Import into an empty or small graph (at most 20 existing nodes by default). Use a new graph directory for larger imports.
- Imports run in batches with whole-graph snapshots. A failed batch is rolled back and retried once; another failure stops for review.
- A rollback that would discard other sessions' writes lists the affected work and requires confirmation. The replaced graph is kept as a backup.
- Import state and conversation units live beside the graph in `<graphRoot>.history-import/`. Treat that directory and its backups as sensitive.
- With `approveWrites` enabled, the start confirmation must approve the import's writes as a group.

逐段导入按时间顺序处理每段对话；按天合并导入把同一天的少量对话原样交给记忆代理，不先做摘要。代理会展示时间和费用估算，再按确认的模式执行。导入不是自动脱敏的保证，开始前请检查范围和隐私说明。

| Tool | Purpose |
|---|---|
| `history_scan` | List projects, months, exclusions and a redaction preview. |
| `history_estimate` | Estimate time, delegations and cost for the available modes. |
| `history_confirm` | Record a user confirmation bound to the displayed digest. |
| `history_plan` | Show the import plan before writing. |
| `history_import_batch` | Snapshot and import the next batch. |
| `history_status` | Report progress and the active plan. |
| `history_rollback` | Restore a snapshot with safeguards for other sessions' writes. |
| `history_report` | Report imported work, rollbacks and maintenance guidance. |

Direct mode exposes only `history_import_help`, which explains how to switch modes and imports nothing.

## Graph tools and safeguards

The graph layer exposes `memory_search`, `memory_read`, `memory_read_file`, `memory_write`, `memory_attach`, `memory_restore` and `memory_merge`. The separate memory agent gets only the subset allowed by its read/manage authority and cannot run shell or arbitrary file tools.

Search is lexical. Read the node and attachments before revising them. Changed decisions should supersede the old memory, not erase it. Stale concurrent writes and unread attachment overwrites are refused. An uncertain or partial write fences later writes in that delegation until the agent reports the outcome.

The sidebar graph is read-only. Its data requests pass DSH's own authenticated connection. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the disk contract and [the maintenance guide](../docs/maintain-agent.md) for repair and maintenance procedures.

## Configuration reference

The memory-agent row accepts `graphRoot`, `maxIndexEntries`, `model`, `approveWrites`, `timeoutMs` and a `plugin` object for additional graph settings. Unknown row fields are refused.

| Core setting | Purpose |
|---|---|
| `graphRoot` | Graph directory; a leading `~` expands. |
| `maxIndexEntries`, `searchLimit`, `indexCacheMs` | Rendered index size, result count and cache lifetime. |
| `maintenanceBacklog` | Advisory depth that triggers a maintenance notice; 0 disables the notice. |
| `attachTraceMin` | Minimum attachment/source token overlap; 0 disables that check. |
| `attachFromPath`, `attachFromPathRoots` | Whether direct tools may copy files from allowed roots. The memory-agent wrapper does not expose this route. |
| `promptProfile` | `full`, `read` or `manage` prompt surface; not a permission grant. |
| `expectWrite`, `turnId`, `contextDate` | Write-exit diagnostics and optional caller-supplied event date. |
| `batchWrites`, `handsOffRule`, `appendWrites` | Optional write/prompt policies; leave defaults unless needed. |
| `indexSnapshot`, `promptSnapshot` | Optional per-instance prompt freezing (`run`); use only with a fresh instance per run. |
| `indexBudget` | Optional tiered index rendering (`true` or `tier1`/`tier2`/`clipChars` overrides). |

Do not use per-instance frozen prompts in a long-lived multi-conversation instance. Live graph tools remain authoritative when a rendered index is stale.

## Update and troubleshoot

GitHub installs have no in-place **Update** button. Uninstall, add the same GitHub address again, then enable the plugin. The memory graph is not removed. Back up profile settings before changing the installation.

| Symptom | Check |
|---|---|
| GitHub cannot be reached | Check HTTPS connectivity and Git URL rewrite rules, then retry. |
| Another dependency returns 404 | Use **Official npm registry**, not a custom registry. |
| `memory_agent` says direct tools are enabled | Turn off `memory-graph-direct`. |
| Panel shows a different graph | Remove an unintended panel `graphRoot` override. |
| Graph does not exist yet | Save the first memory, or verify the configured root. |
| `edge entry is not a symlink` | Back up the graph and inspect it with `graph-maintain`; do not repair it with ad-hoc writes. |

## Development

```sh
npm ci
npm test
npm run test:release
npm run build:ui
```

The release suite runs all test files without a date-based skip. Build assets are committed because installation from a Git subdirectory does not run a build.

Edit `../mexplore_graph/src/` and `../mexplore_import/src/` for shared graph/import changes, then run `node ../scripts/sync-vendored.mjs`. Do not edit their generated copies in `lib/` directly.

## License

[MIT](LICENSE), Copyright (c) 2026 Mexplore contributors. Bundled dependency notices and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
