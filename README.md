# Mexplore

Persistent memory for **DeepSeek Harness (DSH)** and **OpenCode**, stored as a filesystem graph. A memory is a directory containing Markdown and attachments; relationships are symlinks. Both plugins use the same graph engine and on-disk format.

**Topics:** `memory` · `opencode` · `opencode-plugin` · `deepseek` · `deepseek-harness` · `persistent-memory` · `memory-plugin`

## Install / 安装

### DeepSeek Harness

In **Plugins → Add plugin**, paste the address below. Leave **Registry** on **Official npm registry**, then choose **Install → Enable now**.

在 **Plugins → Add plugin** 粘贴以下地址，**Registry** 保持 **Official npm registry**，然后点 **Install → Enable now**。

```text
github:mexplor/Mexplore-oss#release/oss-initial&path:/dsh_plugin
```

Enable exactly one memory mode: **Memory tools (direct)** is the default; **Memory agent** delegates memory work to a separate agent. The read-only **Mexplore** sidebar panel follows the active mode's graph.

记忆工具和记忆代理只开一个。默认是 **Memory tools (direct)**；选择 **Memory agent** 后由单独的代理负责记忆。侧边栏的只读 **Mexplore** 面板会跟随当前模式使用的图。

### OpenCode

Requires OpenCode V2 with Git-subdirectory installation support (verified with 2.3.0).

```sh
opencode plugin add "git+https://github.com/mexplor/Mexplore-oss.git#release/oss-initial::path:opencode_mexplore"
```

Restart OpenCode, start a conversation with your usual model, then run `/mexplore test`. Memory inherits the chat model and its provider credentials. `/mexplore model <provider/model>` selects a separate memory model; `/mexplore reset` restores inheritance. Desktop and Web use `/mexplore-settings` instead of `/mexplore` for these commands.

重启 OpenCode，用平时的模型开始聊天，再运行 `/mexplore test`。记忆默认继承聊天模型和凭据，不需要另接 key。`/mexplore model <provider/model>` 只修改记忆模型，`/mexplore reset` 恢复继承；Desktop 和 Web 中请把命令前缀换成 `/mexplore-settings`。

### Try it / 试用

Ask the agent to remember a decision and its reason. In a new conversation, ask it to recall that decision. Open **Mexplore** (DSH) or `/mexplore ui` (OpenCode) to inspect the saved node and attachments.

让代理记住一项决定及其原因，再开一个新会话询问这项决定。DSH 中点 **Mexplore**，OpenCode 中运行 `/mexplore ui`，即可查看保存的节点和附件。

## Plugins

| Directory | Purpose |
|---|---|
| [`dsh_plugin/`](dsh_plugin/) | The `dsh-mexplore` bundle: direct memory tools, a dedicated memory agent, history import and a read-only graph panel. |
| [`opencode_mexplore/`](opencode_mexplore/) | The `mexplore` OpenCode V2 plugin. Each memory request runs in a temporary child session with graph tools only. |

Both plugins build on shared source in this repository: [`mexplore_graph/`](mexplore_graph/) (graph engine), [`mexplore_import/`](mexplore_import/) (history import) and [`mexplore_ui/`](mexplore_ui/) (read-only graph explorer and usage dashboard).

## Build and test

Prerequisites: Node.js 22 or newer, npm, and Bun 1.3.10 or newer. The real-process OpenCode integration tests also need an OpenCode V2 executable; the current integration suite is verified against OpenCode 2.3.0.

From the repository root:

```sh
# DSH plugin; npm ci uses the committed lockfile.
npm --prefix dsh_plugin ci
npm --prefix dsh_plugin test

# OpenCode plugin: plain bun install does not understand the
# same-repository ::path: Git dependencies.
(cd opencode_mexplore && bun run setup --frozen-lockfile)
(cd opencode_mexplore && bun test && bun run typecheck)

# Graph explorer and dashboard.
(cd mexplore_ui && bun install --frozen-lockfile)
(cd mexplore_ui && bun test && bun run typecheck)

# Shared source and generated-copy checks.
node scripts/sync-vendored.mjs --check
node scripts/check-versions.mjs
node --test mexplore_import/test/*.test.js
```

Build the DSH panel with `npm --prefix dsh_plugin run build:ui`. Build the OpenCode UI assets with `(cd mexplore_ui && bun run build:web)`. Both sets of generated assets are committed because installing a Git subdirectory must not require a build step.

Do not edit `dsh_plugin/lib/{graph,index,tool}.js` or `dsh_plugin/lib/import/` directly. Edit `mexplore_graph/src/` or `mexplore_import/src/`, then run `node scripts/sync-vendored.mjs` and review the resulting changes.

### OpenCode integration tests

The harness starts an isolated OpenCode server, uses a local mock model provider and stores its graph and XDG state in temporary directories. It needs no provider key or paid model requests.

```sh
(cd opencode_mexplore && \
  OPENCODE_BIN="$(command -v opencode)" MEXPLORE_IT=1 \
  bun test test/integration)
```

See [the integration-test guide](opencode_mexplore/test/integration/README.md) for isolation and assertions. A mock-provider test proves host integration, not real-model answer quality.

## Memory and permissions

- DSH defaults to `~/.dsh/memory-graph`; OpenCode defaults to `~/.local/share/mexplore/graph`.
- DSH offers direct tools or a dedicated memory agent; enable one mode, not both. Its graph panel is read-only.
- Graph writes are plugin operations. DSH's chat access mode does **not** by itself prevent memory writes; to approve each write, use the memory agent mode and set `approveWrites: true` on `memory-graph-agent`.
- OpenCode inherits the current chat model and its provider credentials by default. `/mexplore model <provider/model>` selects a separate memory model; `/mexplore reset` restores inheritance. The optional custom-endpoint provider needs an explicit endpoint, model and key.
- Store memory graphs, history exports and credentials outside the source tree.

## Further reading

- [DSH plugin reference](dsh_plugin/README.md)
- [OpenCode plugin reference](opencode_mexplore/README.md)
- [Graph explorer reference](mexplore_ui/README.md)
- [Graph architecture and terminology](ARCHITECTURE.md)
- [Graph maintenance](docs/maintain-agent.md)

## License

[MIT](LICENSE), Copyright (c) 2026 Mexplore contributors. Third-party dependencies retain their own licenses.
