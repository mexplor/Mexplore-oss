/**
 * End-to-end acceptance scenarios for the `mexplore` plugin, driven through a
 * real `opencode serve` process and a mock OpenAI-compatible provider.
 *
 * Every scenario is self-contained: its own mock, its own OpenCode instance
 * (with its own XDG dirs and config) and its own temp graph root, so one failure
 * cannot leak state into the next. Skipped unless `MEXPLORE_IT=1`, because it
 * needs a real `opencode` binary (see `harness.ts`).
 *
 * The mock answers by REQUEST KIND, never by request count — OpenCode sends a
 * title/helper request first, and every turn is two requests:
 *
 *   - a parent request advertises `mexplore` (the plugin's tool);
 *   - a child request advertises `memory_search` (the graph tier);
 *   - a title/helper request advertises no tools at all;
 *   - a tool result after the latest assistant tool call marks its follow-up;
 *     a host reminder can follow that result (OpenCode 2.3).
 */
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { isToolFollowup, startMock, type Mock, type RecordedRequest } from "./mock-provider"
import { startOpencode, type Opencode } from "./harness"
import { USAGE_BRIEF } from "../../src/plugin/prompt"

const enabled = process.env.MEXPLORE_IT === "1"
const pluginDir = path.resolve(import.meta.dir, "..", "..")

/** The two tiers, as the plugin advertises them (src/graph/index.ts). */
const READ_TOOLS = ["memory_search", "memory_read", "memory_read_file"]
const MANAGE_TOOLS = [...READ_TOOLS, "memory_write", "memory_attach"]

/** Static text of the rendered dsh `memory:graph` section (never a slot value). */
const MEMORY_PROMPT_MARK = "You have a memory graph on this machine that outlives this session"

/** The note a call prints when it inherits the current session's model. */
const INHERITED_MODEL_NOTE = "inherited from the current OpenCode session; no memory model override configured"

const MOCK_MODEL = { providerID: "mock", id: "mock-model" }

const PARENT_DONE = "parent done"
const CHILD_READ_ANSWER = "unknown"

type Env = { tmp: string; graph: string; mock?: Mock; oc?: Opencode }

/** One isolated trio: temp dir, mock provider, OpenCode server. */
async function setup(handler: Parameters<typeof startMock>[0]): Promise<Env> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mexplore-it-"))
  const graph = path.join(tmp, "graph")
  const mock = startMock(handler)
  const oc = await startOpencode({ pluginDir, pluginOptions: { graphRoot: graph }, mockPort: mock.port })
  return { tmp, graph, mock, oc }
}

async function teardown(env: Env | undefined): Promise<void> {
  if (env === undefined) return
  await env.oc?.stop().catch(() => {})
  await env.mock?.stop().catch(() => {})
  await fsp.rm(env.tmp, { recursive: true, force: true }).catch(() => {})
}

// ------------------------------------------------------------------ request kinds

function roles(req: RecordedRequest): string[] {
  return (req.messages as { role?: string }[]).map((message) => message.role ?? "")
}

function isParent(req: RecordedRequest): boolean {
  return req.toolNames.includes("mexplore")
}

function isChild(req: RecordedRequest): boolean {
  return req.toolNames.includes("memory_search")
}

function parents(mock: Mock): RecordedRequest[] {
  return mock.requests.filter(isParent)
}

function children(mock: Mock): RecordedRequest[] {
  return mock.requests.filter(isChild)
}

/** The child requests that are a child's FIRST request (system + user only). */
function childOpeners(mock: Mock): RecordedRequest[] {
  return children(mock).filter((req) => {
    const list = roles(req)
    return list.length === 2 && list[0] === "system" && list[1] === "user"
  })
}

function userText(req: RecordedRequest): string {
  const user = (req.messages as { role?: string; content?: unknown }[]).find((m) => m.role === "user")
  if (user === undefined) return ""
  if (typeof user.content === "string") return user.content
  if (Array.isArray(user.content)) {
    return user.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
  }
  return ""
}

// --------------------------------------------------------------- session output

function toolParts(messages: any[]): any[] {
  return messages
    .filter((message) => message?.type === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part: any) => part?.type === "tool")
}

function mexploreParts(messages: any[]): any[] {
  return toolParts(messages).filter((part: any) => part.name === "mexplore")
}

/** The text a tool part shows the model, whichever state it ended in. */
function toolResultText(part: any): string {
  const content = part?.state?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("\n")
  }
  return ""
}

function lastToolPartText(messages: any[]): string {
  const parts = mexploreParts(messages)
  const last = parts.at(-1)
  return last === undefined ? "" : toolResultText(last)
}

/** Poll `check` until it returns true, or `ms` elapses. Returns the wait spent. */
/** A free loopback port, for "an endpoint that answers nothing". */
async function freePortNear(_avoid: number): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no") })
  const port = probe.port ?? 0
  await probe.stop(true)
  return port
}

async function pollUntil(check: () => Promise<boolean>, ms: number, stepMs = 100): Promise<number> {
  const started = Date.now()
  for (;;) {
    if (await check()) return Date.now() - started
    if (Date.now() - started > ms) return -1
    await Bun.sleep(stepMs)
  }
}

async function noChildSession(oc: Opencode): Promise<boolean> {
  return (await oc.childSessions()).length === 0
}

/** At least one node directory carrying a `node.md` exists under the graph root. */
async function nodeDirs(graph: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(graph)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    try {
      const stat = await fsp.stat(path.join(graph, entry))
      if (!stat.isDirectory()) continue
      await fsp.access(path.join(graph, entry, "node.md"))
      found.push(entry)
    } catch {
      // not a node dir
    }
  }
  return found
}

describe.skipIf(!enabled)("mexplore integration", () => {
  const opened: Env[] = []
  afterEach(async () => {
    while (opened.length > 0) await teardown(opened.pop())
  })

  async function start(handler: Parameters<typeof startMock>[0]): Promise<Env> {
    const env = await setup(handler)
    opened.push(env)
    return env
  }

  // AC-018 / AC-004 / AC-014 ------------------------------------------------
  test("AC-018/004/014: the parent gets mexplore and the brief, never a memory_* tool", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const sent = parents(env.mock!)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    const first = sent[0]!
    const followUp = sent.at(-1)!

    for (const [label, req] of [
      ["first", first],
      ["follow-up", followUp],
    ] as const) {
      // AC-018/AC-004: edit/read/shell/… may come and go, but the plugin's tool
      // is offered and no graph tool is.
      expect(req.toolNames).toContain("mexplore")
      expect(req.toolNames.filter((name) => name.startsWith("memory_"))).toEqual([])
      // AC-014: the brief is appended exactly once — not per hook run.
      expect(req.system.split(USAGE_BRIEF).length - 1).toBe(1)
      // Write guidance lives only in the child's prompt.
      expect(req.system).not.toContain("memory_write")
      expect(req.toolNames).not.toContain("memory_write")
    }

    // A title/helper request advertises no tools and no brief.
    const helpers = env.mock!.requests.filter((req) => !isParent(req) && !isChild(req))
    for (const req of helpers) {
      expect(req.toolNames).toEqual([])
      expect(req.system).not.toContain(USAGE_BRIEF)
    }
  }, 90_000)

  // AC-001-like (manage) -----------------------------------------------------
  test("manage call: five tools, the memory prompt, one node written, no child left behind", async () => {
    const message = "Remember: releases ship Thursdays because QA signs off Wednesdays"
    const description = "Release day: Thursday (QA signs off Wednesday)"
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return {
          toolCalls: [
            {
              name: "mexplore",
              args: {
                message,
                authority: "manage",
                evidence: [{ role: "user", content: message }],
              },
            },
          ],
        }
      }
      if (isChild(req)) {
        if (isToolFollowup(req)) return { text: "Saved the release cadence." }
        return {
          toolCalls: [
            {
              name: "memory_write",
              args: {
                description,
                body: "Releases ship Thursdays because QA signs off on Wednesdays.",
              },
            },
          ],
        }
      }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const sent = children(env.mock!)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    const childFirst = sent[0]!

    // The child is shaped to its tier: exactly the manage set, nothing else.
    expect([...childFirst.toolNames].sort()).toEqual([...MANAGE_TOOLS].sort())
    // …and reads the dsh memory prompt, not the agent's own.
    expect(childFirst.system).toContain(MEMORY_PROMPT_MARK)

    // The parent's tool part carries the footer line built from the REAL write.
    const messages = await oc.messages(session)
    const result = lastToolPartText(messages)
    expect(result).toContain("saved to memory: Release day")

    // The write landed on disk.
    const dirs = await nodeDirs(env.graph)
    expect(dirs.length).toBeGreaterThan(0)

    // AC-003: the child session is removed, not left in the session list.
    const waited = await pollUntil(() => noChildSession(oc), 10_000)
    expect(waited).toBeGreaterThanOrEqual(0)
  }, 90_000)

  // AC-005 (read) ------------------------------------------------------------
  test("AC-005: a read call's child gets exactly the three read tools", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return {
          toolCalls: [
            { name: "mexplore", args: { message: "what is the release day?", authority: "read" } },
          ],
        }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const childFirst = children(env.mock!)[0]
    expect(childFirst).toBeDefined()
    expect([...childFirst!.toolNames].sort()).toEqual([...READ_TOOLS].sort())
  }, 90_000)

  // AC-002: one child per call, no transcript carried over --------------------
  test("AC-002: the second call's child starts empty and never sees the first request", async () => {
    const firstMessage = "what did we decide about the zebra migration window?"
    const secondMessage = "what did we decide about the plum harvest rotation?"
    const calls = [firstMessage, secondMessage]
    let turn = 0
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        // Each parent turn issues exactly one memory call.
        return { toolCalls: [{ name: "mexplore", args: { message: calls[turn] ?? firstMessage } }] }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()

    turn = 0
    await oc.run(session, "first")
    turn = 1
    await oc.run(session, "second")

    const openers = childOpeners(env.mock!)
    expect(openers.length).toBeGreaterThanOrEqual(2)
    const firstChild = openers[0]!
    const secondChild = openers.at(-1)!

    // The first child got the first request…
    expect(userText(firstChild)).toContain("zebra migration")
    // …the second is a fresh session: system + user, and no trace of the first.
    expect(roles(secondChild)).toEqual(["system", "user"])
    const serialized = JSON.stringify(secondChild.messages)
    expect(serialized).not.toContain(firstMessage)
    expect(serialized).not.toContain("zebra migration")
    expect(userText(secondChild)).toContain("plum harvest")
  }, 90_000)

  // AC-020: a failing memory model is a tool error, not a silent empty answer
  test("AC-020: a child provider 400 surfaces as `memory model failed` on the tool part", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { httpError: 400 }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const messages = await oc.messages(session)
    const part = mexploreParts(messages).at(-1)
    expect(part).toBeDefined()
    expect(part!.state.status).toBe("error")
    expect(JSON.stringify(part!.state)).toContain("memory model failed")
    expect(await noChildSession(oc)).toBe(true)
  }, 90_000)

  // AC-007: no key → parent fallback, and the result says so ------------------
  test("AC-007: without a key the child runs on the parent's model and the result notes /connect", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const childFirst = children(env.mock!)[0]
    expect(childFirst).toBeDefined()
    expect(childFirst!.model).toBe("mock-model")

    const result = lastToolPartText(await oc.messages(session))
    expect(result).toContain(INHERITED_MODEL_NOTE)
  }, 90_000)

  // AC-024 / AC-025: the provider route, and the key never escaping ----------
  test("AC-024/025: base-url + key route the child to deepseek, and the key never leaks", async () => {
    const key = "sk-test-abc123"
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()

    const baseURL = `http://127.0.0.1:${env.mock!.port}/v1`
    const configured = await oc.api("POST", `/api/session/${session}/command`, {
      name: "mexplore-settings",
      text: `base-url ${baseURL}`,
    })
    expect(configured.status).toBeLessThan(400)
    const selected = await oc.api("POST", `/api/session/${session}/command`, {
      name: "mexplore-settings",
      text: "model custom-memory-model",
    })
    expect(selected.status).toBeLessThan(400)
    const connected = await oc.api("POST", "/api/integration/mexplore/connect/key", { key })
    expect(connected.status).toBeLessThan(400)
    // The command queue is serial, but the provider transform is replayed
    // asynchronously — let both land before the turn that reads them.
    await Bun.sleep(300)

    await oc.run(session, "go")

    const childFirst = children(env.mock!)[0]
    expect(childFirst).toBeDefined()
    // An explicit endpoint/model/key selects the custom memory provider.
    expect(childFirst!.model).toBe("custom-memory-model")
    // …and the memory provider carries the connected key.
    expect(childFirst!.authorization).toBe(`Bearer ${key}`)

    // AC-025 / SEC-006: the key is in no session message and in no log line.
    const messages = await oc.api("GET", `/api/session/${session}/message`)
    expect(JSON.stringify(messages.body)).not.toContain(key)
    const allSessions = await oc.sessions()
    expect(JSON.stringify(allSessions)).not.toContain(key)
    expect(oc.logs.join("\n")).not.toContain(key)
  }, 90_000)

  // AC-024: a change applies to the NEXT call, even while one is running ------
  test("AC-024: a base-url change reaches the next call while a slow child still runs", async () => {
    const key = "sk-overlap-abc123"
    let childNumber = 0
    let firstChildCompleted = false
    // TWO endpoints. A goes to the first, B must go to the second: a positive
    // signal, not merely the absence of one.
    const second = startMock(() => ({ text: CHILD_READ_ANSWER }))
    const env = await start(async (req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        childNumber += 1
        return { toolCalls: [{ name: "mexplore", args: { message: `question ${childNumber}` } }] }
      }
      if (isChild(req)) {
        // The first call's child stalls, so the second can start alongside it.
        if (childNumber === 1) {
          await Bun.sleep(2500)
          firstChildCompleted = true
        }
        return { text: CHILD_READ_ANSWER }
      }
      return { text: "helper" }
    })
    try {
      const oc = env.oc!
      const session = await oc.newSession()

      const firstURL = `http://127.0.0.1:${env.mock!.port}/v1`
      const secondURL = `http://127.0.0.1:${second.port}/v1`
      await oc.api("POST", `/api/session/${session}/command`, {
        name: "mexplore-settings",
        text: `base-url ${firstURL}`,
      })
      await oc.api("POST", `/api/session/${session}/command`, {
        name: "mexplore-settings",
        text: "model custom-memory-model",
      })
      await oc.api("POST", "/api/integration/mexplore/connect/key", { key })
      await Bun.sleep(300)

      // Start call A, which stalls inside its child on the FIRST endpoint.
      await oc.api("POST", `/api/session/${session}/prompt`, { text: "first" })
      const started = await pollUntil(async () => children(env.mock!).length > 0, 15_000)
      expect(started).toBeGreaterThanOrEqual(0)

      // Use another parent session: hosts may serialize turns within one
      // session. Settings are shared, so this still overlaps two memory calls.
      const secondSession = await oc.newSession()
      const changed = await oc.api("POST", `/api/session/${secondSession}/command`, {
        name: "mexplore-settings",
        text: `base-url ${secondURL}`,
      })
      expect(changed.status).toBeLessThan(400)
      await Bun.sleep(300)

      await oc.api("POST", `/api/session/${secondSession}/prompt`, { text: "second" })
      const arrived = await pollUntil(async () => children(second).length > 0, 20_000)
      // B reached the NEW endpoint while A was still on the old one.
      expect(arrived).toBeGreaterThanOrEqual(0)
      expect(firstChildCompleted).toBe(false)
      expect(children(second)[0]?.authorization).toBe(`Bearer ${key}`)

      // A's own requests all stayed on the FIRST endpoint (the hook pins them).
      const firstPort = env.mock!.port
      for (const req of children(env.mock!)) expect(req.port).toBe(firstPort)
      for (const req of children(second)) expect(req.port).toBe(second.port)
    } finally {
      await second.stop().catch(() => {})
    }
  }, 120_000)

  test("host inheritance, an independent memory override, and reset work with a connected optional key", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "recall release notes" } }] }
      }
      if (isChild(req)) return { text: CHILD_READ_ANSWER }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    // The host loads plugins lazily. Exercise memory before using the plugin's
    // integration route; an HTTP-ready server alone does not register it yet.
    await oc.run(session, "warm up memory using the current model")
    expect(children(env.mock!).at(-1)?.model).toBe("mock-model")
    const connected = await oc.api("POST", "/api/integration/mexplore/connect/key", { key: "sk-test-optional-unused" })
    expect(connected.status).toBeLessThan(400)
    await Bun.sleep(300)

    await oc.run(session, "inherit the current model")
    expect(children(env.mock!).at(-1)?.model).toBe("mock-model")
    expect(lastToolPartText(await oc.messages(session))).toContain(INHERITED_MODEL_NOTE)

    const selected = await oc.api("POST", `/api/session/${session}/command`, {
      name: "mexplore-settings",
      text: "model mock/memory-model",
    })
    expect(selected.status).toBeLessThan(400)
    await Bun.sleep(300)
    await oc.run(session, "use the independent memory model")
    expect(children(env.mock!).at(-1)?.model).toBe("memory-model")

    const reset = await oc.api("POST", `/api/session/${session}/command`, {
      name: "mexplore-settings",
      text: "reset",
    })
    expect(reset.status).toBeLessThan(400)
    await Bun.sleep(300)
    await oc.run(session, "inherit again")
    expect(children(env.mock!).at(-1)?.model).toBe("mock-model")
    expect(env.mock!.requests.filter(isParent).every((req) => req.model === "mock-model")).toBe(true)
    expect(oc.logs.join("\n")).not.toContain("nicebuild.click")
  }, 90_000)

  // AC-006: interrupt tears the child down -----------------------------------
  test("AC-006: interrupting the parent removes the running child within 15 s", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: PARENT_DONE }
        return { toolCalls: [{ name: "mexplore", args: { message: "slow read" } }] }
      }
      // The child stalls long enough to be interrupted mid-run.
      return new Promise((resolve) => {
        setTimeout(() => resolve({ text: "late answer" }), 6000)
      })
    })
    const oc = env.oc!
    const session = await oc.newSession()

    // Deliberately NOT awaiting the turn: the interrupt has to land mid-run.
    await oc.api("POST", `/api/session/${session}/prompt`, { text: "go" })
    await Bun.sleep(2000)

    const running = await oc.childSessions()
    expect(running.length).toBeGreaterThan(0)

    const interrupted = await oc.api("POST", `/api/session/${session}/interrupt`)
    expect(interrupted.status).toBeLessThan(400)

    const waited = await pollUntil(() => noChildSession(oc), 15_000)
    expect(waited).toBeGreaterThanOrEqual(0)
    expect((await oc.childSessions()).length).toBe(0)
  }, 90_000)
})
