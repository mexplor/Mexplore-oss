# mexplore integration tests

Real-`opencode`-binary tests: a headless `opencode serve` process loads this
plugin, a mock OpenAI-compatible provider answers its model requests, and every
assertion is read from the session history or from what the provider was
actually sent.

## Running

```sh
MEXPLORE_IT=1 bun test test/integration          # everything
MEXPLORE_IT=1 bun test test/integration/mexplore.it.test.ts
```

Without `MEXPLORE_IT=1` every suite here is skipped, so plain `bun test` stays
fast and needs no binary.

Requirements:

- the `opencode` binary — `~/.opencode/bin/opencode`, or `$OPENCODE_BIN` (currently verified with 2.3.0)
- nothing else: no network, no provider key, no `~/.config/opencode` access

## What you get

| file | what it is |
|---|---|
| `harness.ts` | `startOpencode({pluginDir, pluginOptions, mockPort})` → `{url, auth, api, apiData, newSession, run, messages, sessions, childSessions, stop, logs, root}` |
| `mock-provider.ts` | `startMock(handler)` → `{port, requests, stop}`; the handler returns `{text}`, `{toolCalls:[{name,args}]}` or `{httpError}` |
| `mexplore.it.test.ts` | the acceptance scenarios |
| `harness.it.test.ts` | smoke test that the harness itself works |

Isolation is total: each `startOpencode` call makes its own temp root with its
own `XDG_*` dirs, its own `opencode.json`, its own workspace, its own server
port. The graph root is a temp directory passed as the `graphRoot` plugin
option, so no test touches a real memory graph.

## Driving the mock

Answer by **request kind**, never by request count — OpenCode sends a
title/helper request first, and every turn is two requests:

| request | how to recognize it |
|---|---|
| parent | `toolNames` includes `mexplore` |
| child (memory agent) | `toolNames` includes `memory_search` |
| title/helper | `toolNames` is empty |
| follow-up of any turn | `isToolFollowup(req)`: a tool result follows the latest assistant tool call; a host reminder can appear after it |

A stateless handler keyed on those three facts is what every scenario uses.

Facts worth knowing before writing a scenario:

- **`httpError: 400`** for failure paths. A `500` makes OpenCode retry for about
  80 s.
- **The child's tier decides its tools** — a `read` call gets
  `memory_search`/`memory_read`/`memory_read_file`; a `manage` call adds
  `memory_write`/`memory_attach` and nothing else (no shell, no fs, no
  subagent).
- **Commands reply out of band.** `POST /api/session/:id/command
  {name:"mexplore", text:"…"}` returns `204`; its synthetic reply only appears in
  `GET /api/session/:id/message` after the next prompt. Assert the effect (a
  changed model, route or setting) rather than the reply text.
- **The key endpoint** is `POST /api/integration/mexplore/connect/key
  {key:"sk-test-…"}`. The key must never come back out: check it is absent from
  session JSON and from `oc.logs()`.
- **Child sessions are temporary.** They carry `metadata.mexploreChild = true`
  while they exist; `oc.childSessions()` lists the survivors, so "the child was
  removed" is polled, not asserted once.

## Reading results

`GET /api/session/:id/message` returns `{data:[…]}` newest-first;
`oc.messages(id)` reverses it. Tool calls sit in `assistant.content[]` as
`{type:"tool", name, state}`, and `state.status` is `completed` or `error` with
`state.content` / `state.error` respectively. `mexplore`'s `state.content`
holds the child's answer plus the REQ-012 footer (`saved to memory: …`,
`no writes`) and the REQ-005 note when the parent's model was used.

## Known limitations

- A synthetic command reply is not visible until the next prompt (host
  behaviour, tracked as SP-3).
- Each scenario starts its own server and graph, so the suite costs a few
  seconds per test rather than one shared boot.
