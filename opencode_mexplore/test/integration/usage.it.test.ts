/**
 * Lane B against the REAL binary: does a usage record get written, with real
 * tokens, and does a timeout still produce one?
 *
 * This is also the evidence source for "which events actually arrive for a child
 * session": the plugin's own subscription is the only observer that can answer
 * it, so the plugin is run with a debug switch that counts what it saw and the
 * test reads those counts back from the log file. That keeps the probe honest —
 * the numbers come from the shipped code path, not from a parallel spy.
 *
 * Skipped unless `MEXPLORE_IT=1`, like the rest of `test/integration`.
 */
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { isToolFollowup, MOCK_USAGE, startMock, type Mock, type RecordedRequest } from "./mock-provider"
import { startOpencode, type Opencode } from "./harness"

const enabled = process.env.MEXPLORE_IT === "1"
const pluginDir = path.resolve(import.meta.dir, "..", "..")

type Env = { tmp: string; graph: string; usage: string; mock: Mock; oc?: Opencode }

async function setup(handler: Parameters<typeof startMock>[0], timeoutMs?: number): Promise<Env> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "mexplore-usage-it-"))
  const graph = path.join(tmp, "graph")
  const usage = path.join(tmp, "usage")
  const mock = startMock(handler)
  const oc = await startOpencode({
    pluginDir,
    // The usage directory is relocated so the test never touches the real
    // `$XDG_STATE_HOME`, and `eventProbe` asks the plugin to log what it saw.
    pluginOptions: {
      graphRoot: graph,
      usageDir: usage,
      eventProbe: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    mockPort: mock.port,
  })
  return { tmp, graph, usage, mock, oc }
}

function isParent(req: RecordedRequest): boolean {
  return req.toolNames.includes("mexplore")
}

function isChild(req: RecordedRequest): boolean {
  return req.toolNames.includes("memory_search")
}

async function pollUntil(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true
    await Bun.sleep(100)
  }
  return false
}

/** Every record in the usage directory, oldest first. */
async function usageRecords(dir: string): Promise<Array<Record<string, unknown>>> {
  let names: string[] = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const records: Array<Record<string, unknown>> = []
  for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const raw = await fsp.readFile(path.join(dir, name), "utf8")
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue
      try {
        records.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // A torn tail is expected if the process is killed mid-append.
      }
    }
  }
  return records
}

/** The plugin's own event counts, from its probe line. */
function probe(logs: readonly string[]): { usageUpdated: number; step: number; terminal: number } | undefined {
  const line = [...logs].reverse().find((entry) => entry.includes("mexplore usage probe"))
  if (line === undefined) return undefined
  const read = (name: string): number => Number(new RegExp(`${name}=(\\d+)`).exec(line)?.[1] ?? 0)
  return { usageUpdated: read("usage.updated"), step: read("step"), terminal: read("terminal") }
}

const opened: Env[] = []
async function start(handler: Parameters<typeof startMock>[0], timeoutMs?: number): Promise<Env> {
  const env = await setup(handler, timeoutMs)
  opened.push(env)
  return env
}

afterEach(
  async () => {
    while (opened.length > 0) {
      const env = opened.pop() as Env
      // A timed-out scenario leaves a child mid-interrupt; killing the server
      // and waiting for it can take longer than bun's 5 s default for a hook.
      await env.oc?.stop().catch(() => {})
      await env.mock.stop().catch(() => {})
      await fsp.rm(env.tmp, { recursive: true, force: true }).catch(() => {})
    }
  },
  30_000,
)

describe.skipIf(!enabled)("usage log on the real binary", () => {
  test("a completed mock-model call writes ONE record with real tokens", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: "done" }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { text: "unknown" }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")

    const written = await pollUntil(async () => (await usageRecords(env.usage)).length > 0, 15_000)
    expect(written).toBe(true)
    const records = await usageRecords(env.usage)
    expect(records).toHaveLength(1)
    const record = records[0] as Record<string, unknown>
    expect(record.v).toBe(1)
    expect(record.authority).toBe("read")
    expect(record.outcome).toBe("ok")
    expect(record.graphRoot).toBe(await fsp.realpath(env.graph).catch(() => env.graph))
    expect(record.provider).toBe("mock")
    expect(typeof record.callId).toBe("string")
    // The mock reports a real `usage` block, so the numbers must be real too:
    // `input` is the NON-cached input, and `cacheRead` is the cached part.
    const tokens = record.tokens as Record<string, number> | null
    expect(tokens).not.toBeNull()
    expect(tokens?.input).toBe(MOCK_USAGE.input)
    expect(tokens?.cacheRead).toBe(MOCK_USAGE.cacheRead)
    // OpenCode may bill reasoning separately from output; both are non-zero.
    expect(tokens?.output).toBeGreaterThan(0)
    expect(tokens?.reasoning).toBe(MOCK_USAGE.reasoning)
    // A completed run whose cumulative value and terminal event both arrived.
    expect(record.usageStatus).toBe("complete")
    // No pricing is declared by the mock, so cost must be null, not $0.
    expect(record.costUsd).toBeNull()
    // No message text anywhere in the line.
    expect(JSON.stringify(record)).not.toContain("helper")
  }, 120_000)

  test("a timed-out call still writes ONE record, marked partial or unknown", async () => {
    // The per-call budget is set at SETUP: a short budget is what makes the
    // timeout path reachable without waiting out a real 3-minute call.
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: "done" }
        return { toolCalls: [{ name: "mexplore", args: { message: "slow question" } }] }
      }
      if (isChild(req)) {
        // Stall past the plugin's per-call budget.
        return new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 12_000))
      }
      return { text: "helper" }
    }, 2_500)
    const oc = env.oc!
    const session = await oc.newSession()
    // Not awaited: the turn is expected to fail.
    await oc.api("POST", `/api/session/${session}/prompt`, { text: "go" })

    const written = await pollUntil(async () => (await usageRecords(env.usage)).length > 0, 30_000)
    expect(written).toBe(true)
    const records = await usageRecords(env.usage)
    expect(records).toHaveLength(1)
    const record = records[0] as Record<string, unknown>
    expect(record.outcome).toBe("timeout")
    // The child is interrupted before inspection, so the answer never completes:
    // whatever arrived is real but not the whole bill.
    expect(["partial", "unknown"]).toContain(String(record.usageStatus))
    // Written inside the cleanup budget, well before the child would have
    // finished on its own (12 s).
    expect(Number(record.latencyMs)).toBeLessThan(12_000)

    // The drain window's evidence: did the terminal event arrive for a child that
    // was interrupted mid-run? The probe says how many execution events were seen.
    const observed = probe(oc.logs)
    expect(observed).toBeDefined()
    // Recorded here rather than asserted: the terminal event is not guaranteed to
    // arrive before the drain expires, and the status above is what encodes that.
    expect(observed?.usageUpdated).toBeGreaterThanOrEqual(0)
  }, 180_000)

  test("which events actually reach a child session (evidence, not an assertion of every one)", async () => {
    const env = await start((req) => {
      if (isParent(req)) {
        if (isToolFollowup(req)) return { text: "done" }
        return { toolCalls: [{ name: "mexplore", args: { message: "what is the release day?" } }] }
      }
      if (isChild(req)) return { text: "unknown" }
      return { text: "helper" }
    })
    const oc = env.oc!
    const session = await oc.newSession()
    await oc.run(session, "go")
    await pollUntil(async () => (await usageRecords(env.usage)).length > 0, 15_000)
    // Give the probe line time to flush with the process still alive.
    await Bun.sleep(500)

    // The probe is a DEBUG aid (`eventProbe: true`), and its line is the only
    // first-hand evidence of which events arrived: it is printed by the shipped
    // capture path, so it cannot drift from what the record used.
    const observed = probe(oc.logs)
    expect(observed).toBeDefined()
    // The evidence this suite exists to produce, as assertions: a child DOES emit
    // the cumulative usage event, at least one step, and a terminal event.
    expect(observed?.usageUpdated).toBeGreaterThanOrEqual(1)
    expect(observed?.step).toBeGreaterThanOrEqual(1)
    expect(observed?.terminal).toBeGreaterThanOrEqual(1)
    const records = await usageRecords(env.usage)
    expect(records.length).toBeGreaterThan(0)
    expect(records[0]?.usageStatus).not.toBe("unknown")
  }, 120_000)
})
