# mexplore for OpenCode

Long-term memory for your OpenCode agent. Your agent remembers decisions, preferences and outcomes across sessions and projects, and looks them up before it decides things.

mexplore runs **inside OpenCode**. There is no separate service to run. Each memory lookup or save happens in a fresh, throwaway session that is deleted when it finishes. **Memory inherits the current chat model and its provider credentials by default.** You can select an independent memory model without changing the chat model.

## Quickstart (30 seconds)

Install from Git:

```sh
opencode plugin add "git+https://github.com/mexplor/Mexplore-oss.git#release/oss-initial::path:opencode_mexplore"
```

1. Restart OpenCode and start a conversation with your usual model.
2. Memory automatically inherits that model and its provider credentials. No separate Mexplore key is needed.
3. Check it: `/mexplore test`.

To use a different model for memory only, run `/mexplore model <provider/model>` with a tool-capable model listed by OpenCode. `/mexplore reset` restores inheritance without changing your chat model.

## What happens automatically

- **Recall.** Before a decision that may depend on earlier work, the agent asks memory first.
- **Save.** When a durable decision (with its why), a preference, a correction or an outcome comes up, the agent saves it on its own. There is no approval prompt.
- **Every save is announced.** The tool result always ends with lines like:

  ```
  saved to memory: OAuth2 migration decisions, Q3 2026 (01J00000000000000000000012)
  ```

  The agent is asked to repeat these lines in its reply. If it doesn't, expand the `mexplore` tool card to see them.
- **Fresh session per call.** Every memory call starts clean, sees no earlier memory conversation, and is deleted afterwards. Your main agent never sees or resumes it. One caveat: if a single tool result ever exceeds OpenCode's inline limit (about 2,000 lines or 50 KB), OpenCode saves it to `tool-output/` in its data folder and keeps it for 7 days, even after the session is deleted. mexplore caps its results below that limit, so this only happens on hosts configured with lower limits.

## Changing the model, base URL or API key

Settings are changed inside OpenCode and stored by the host. No restart or manual configuration-file edit is required.

| You want to | Run |
|---|---|
| See the current setup | `/mexplore status`: model and where it came from, base URL, whether a key is connected, where your memory lives |
| Use another model on the custom endpoint | `/mexplore model <model-id>` |
| Set an independent memory model | `/mexplore model <provider/model>` (choose a tool-capable model already available in OpenCode) |
| Point at another OpenAI-compatible endpoint | `/mexplore base-url https://your-proxy.example.com/v1` |
| Replace the API key | `/connect` → **mexplore** → paste the new key. Keys are never typed into a command. |
| Remove the key | `opencode auth logout mexplore` |
| Check that it works | `/mexplore test`: one tiny request, then OK plus latency, or the provider's error |
| Restore the default behavior | `/mexplore reset`: inherit the current chat model again. Any optional custom-provider key is kept but does not select a model. |

Changes apply from the next memory call.

In the terminal UI, `/mexplore …` shows its reply right away in a dialog. OpenCode Desktop and the web app use the same subcommands under `/mexplore-settings …` (for example `/mexplore-settings status`), and the reply appears in the conversation after your next message.

### Optional: a separate compatible endpoint

There is no built-in endpoint or vendor model. To use the optional `mexplore` provider, explicitly configure all three:

1. `/mexplore base-url https://your-endpoint.example.com/v1`.
2. `/mexplore model <model-id>` with a real tool-capable model id served by that endpoint.
3. `/connect` → **mexplore** with that endpoint's API key, then `/mexplore test`.

Connecting a key alone does not override the chat model. Selecting a custom model without its endpoint/key is an actionable setup error, not a silent fallback to another model. An inherited or native host-provider model needs no separate Mexplore key. If OpenCode opens a chat-model picker after `/connect`, dismiss it to keep the current chat model; memory's explicit selection is independent.

## Where your memory lives

There is one graph per user, shared by every project:

```
~/.local/share/mexplore/graph        # or $XDG_DATA_HOME/mexplore/graph
```

To move it, set an environment variable before starting OpenCode:

```sh
export MEXPLORE_GRAPH_ROOT=~/Dropbox/memory
```

Each memory is a directory and each relationship is a symlink, so you can read the graph with `ls`, `cat` and `grep`. See the [repository README](../README.md) for the format.

> Keep your graph outside the source checkout.

## Token usage

Every memory call appends **one JSON line** to a monthly file, so you can see what memory work costs:

```
~/.local/state/mexplore/usage-YYYY-MM.jsonl      # or $XDG_STATE_HOME/mexplore/
```

- **What is logged**: one line per call — the call id, timestamps, latency, `read`/`manage`, the outcome, the token counts, the cost, the provider and model, and the graph it ran against. **No message text, no memory content, no keys, and no child session id.**
- **The numbers** are OpenCode's own: `input` is the *non-cached* prompt tokens, `output` excludes reasoning tokens, and the cache counters are stored separately. The total is the sum of all five.
- **Cost** is only recorded when the provider declares pricing. The optional custom-endpoint integration declares none, so those records show `null` rather than a misleading `$0`. Inherited and native host-provider models use the metadata reported by OpenCode.
- **Quality of the numbers**: a call that completed with a terminal event is marked `complete`; one that timed out, was interrupted, or whose terminal event never arrived is `partial`; a call that produced no usage at all is `unknown`. A `null` token block means "the provider reported nothing", never "free".
- **Files** are created `0600` in a `0700` directory, and the plugin refuses to write through a symlink. If logging fails, the memory call still succeeds — you get one warning line.
- **See it**: `/mexplore usage` prints calls, tokens, partial/unknown counts and cost for the last 30 days for the current graph. `/mexplore status` shows where the log is, or `off`.
- **Turn it off**: `{ "options": { "usageLog": false } }` in the plugin entry. Nothing is written and no events are subscribed.

## The usage dashboard (`/mexplore ui`)

`/mexplore ui` starts the bundled web dashboard for this graph inside the OpenCode server and prints a URL:

```
/mexplore ui          # start it; prints the URL
/mexplore ui stop     # stop it
```

- It binds **loopback only** and serves your graph plus the usage charts above.
- The URL carries a **capability token**: anyone who has it can read that graph, so don't paste it into a chat. Open it in a browser **on the machine running the OpenCode server** — if you use a remote server, the loopback port is not reachable from your laptop.
- It stays up until `/mexplore ui stop`, a plugin reload, or OpenCode exits. Starting it twice in one server reuses the same listener.
- It needs the **Bun build** of OpenCode (it starts a local web server), and a dashboard build that shipped with the plugin; both failures print a one-line reason.

## `help`

`/mexplore help` (or `/mexplore-settings help`) prints a short welcome: what mexplore does, the setup steps, where memory and the usage log live, and how to turn the log off. In the terminal UI the same text appears once, automatically, on your first session after installing.

## Options (rarely needed)

`opencode plugin add` cannot pass options. To set them, edit the plugin entry in `~/.config/opencode/opencode.jsonc` into its object form:

```jsonc
{ "plugins": [{ "package": "<the entry plugin add wrote>", "options": { "graphRoot": "~/memory", "timeoutMs": 180000 } }] }
```

| Option | Default | Meaning |
|---|---|---|
| `graphRoot` | `$MEXPLORE_GRAPH_ROOT`, else the path above | Where the graph lives |
| `timeoutMs` | `180000` | Longest time one memory call may take |
| `searchLimit`, `maxIndexEntries` | dsh_plugin defaults | Search and index tuning |
| `usageLog` | `true` | Record one JSON line per call in `~/.local/state/mexplore`. `false` turns it off completely. |
| `placeholderGuards` | `true` | Refuse a `manage` write that is only a placeholder (a new node with no `body` and no attachment, or a one-byte attachment named `x`). A node whose gist is empty but which carries a real attachment stays allowed. `false` restores the plain graph library's behaviour. |

## Optional: approve writes

By default writes are announced, not approved. To be asked before each write, add this to `opencode.jsonc`:

```jsonc
{ "permissions": [{ "action": "mexplore", "resource": "manage", "effect": "ask" }] }
```

## First-use smoke test

1. Ask: *"What do you remember about our release process?"* The agent calls `mexplore` and says memory has no record (`unknown`).
2. Say: *"We decided releases go out on Thursdays because QA signs off on Wednesdays."* The reply includes a `saved to memory: … (01M…)` line.
3. In a **new** session, ask: *"When do we release, and why?"* The agent answers from memory and cites the node.

## Troubleshooting

### Non-interactive setups (scripts, CI, `opencode run`)

Two things need a real terminal:

- **`opencode auth login mexplore`** is an interactive prompt. Connect the key **once, in the TUI**, with `/connect` → mexplore. Automation can then reuse the stored credential.
- **`opencode run` does not recognise `/mexplore` or `/mexplore-settings`.** It sends the text to the model as an ordinary prompt, so `/mexplore test` cannot be scripted. Use the TUI for it.

### Observed (not reproduced): a slow first load under `opencode run`

In one session, `opencode run --standalone` appeared to hang for about five minutes before the plugin loaded; re-running the same command with `--print-logs` worked normally. This is an **observation, not a diagnosis** — if it happens, add `--print-logs` and check that the startup line (`mexplore: graph …; model …; ready`) appears.


| Symptom | Fix |
|---|---|
| The result says the model was inherited from the current session | This is the default, not an error. Use `/mexplore model <provider/model>` only if memory should use a different model. |
| `memory model failed: …` | Run `/mexplore test`. It shows the provider error. Check the key, then `/mexplore status` for the model and base URL. |
| The memory call does nothing useful (`toolCalls: 0`) | The memory model can't call tools. Pick another one with `/mexplore model …`. |
| A timeout | The memory model is slow or hanging. Try `/mexplore test`, or raise `timeoutMs`. |
| `plugin add` fails with `An unknown git error occurred` | Use plain `"` or `'` quotes rather than curly quotes copied from a chat. |
| `plugin add` fails with a git or permission error | Check HTTPS access to GitHub and any Git URL rewrite rules. This repository does not require SSH credentials. |
| `plugin add` installed the whole repository, or the plugin won't load | Update OpenCode. This needs a release that installs git subdirectories correctly (2.2.5 works). |
| *"mexplore graph root … is not writable"* | Fix the path's permissions, or move it with `MEXPLORE_GRAPH_ROOT`. |

## Update and uninstall

```sh
opencode plugin update                    # update mexplore (and its graph tools)
opencode plugin remove '<the entry plugin add wrote>'
opencode auth logout mexplore             # remove the stored key
rm -rf ~/.local/share/mexplore/graph      # delete your memories (only if you really mean it)
```

Uninstalling never deletes your graph or your key.

## For contributors

Clone the repo and symlink the plugin directory. OpenCode discovers it on its own, so no config edit is needed:

```sh
MEXPLORE_CHECKOUT=/absolute/path/to/mexplore
(cd "$MEXPLORE_CHECKOUT/opencode_mexplore" && bun run setup --frozen-lockfile)
mkdir -p ~/.config/opencode/plugins
ln -s "$MEXPLORE_CHECKOUT/opencode_mexplore" ~/.config/opencode/plugins/mexplore
```

Restart OpenCode and start a conversation with your usual model. Memory inherits it without another key. Edits to the checkout are picked up live; update from the repository selected for your installation.

Tests:

```sh
cd opencode_mexplore
bun run setup                              # install dev tools (use this, not `bun install`)
bun test                                   # unit tests (graph adapter + plugin wiring)
MEXPLORE_IT=1 bun test test/integration    # real OpenCode binary + mock model (no real LLM calls)
```

Why use `bun run setup`: the runtime dependencies (`dsh_plugin`, `mexplore_ui`) are HTTPS Git specs for the public repository, ending in `#release/oss-initial::path:<dir>`. OpenCode's Git installer understands that selector. Bun versions checked during integration (1.3.10 and 1.4.4) could not resolve it. A full checkout already provides the sibling directories, so setup installs the development tools without resolving those Git dependencies and leaves `package.json` unchanged. The current local npm-package-arg/pacote parser also recognizes the subdirectory selector; the limitation should not be generalized to every npm version.

How it works: `src/graph/` wraps this repo's [dsh_plugin](../dsh_plugin/) graph tools, and `src/plugin/` wires them into OpenCode. Each `mexplore` call creates a child session that can see only the graph tools for its tier (read or manage), and removes the session afterwards. See [the graph architecture](../ARCHITECTURE.md).

## License

[MIT](LICENSE), Copyright (c) 2026 Mexplore contributors. Third-party dependencies retain their own licenses.
