/**
 * Write-session provenance, OpenCode lane (#317): which ROOT chat a graph write
 * belongs to.
 *
 * Three layers, because the value crosses three:
 *
 *   1. `rootSessionOf` — the ancestry walk, and everything that makes it give up
 *      (`walk-failed`) rather than guess;
 *   2. the graph contract — `origin` → `GraphCall` → `exec.provenance`, while
 *      `sessionId`/`agent.id` stay the per-call authorization key;
 *   3. the wiring — one walk per call, the caller's root in the exec, and the
 *      root nowhere the model can see it.
 *
 * The engine's own consumer (`dsh_plugin`) is another lane's; these tests pin
 * what THIS host adapter hands it.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadGraph, type GraphRuntime } from '../src/graph/index'
import { makeExec } from '../src/graph/history'
import { ROOT_WALK_BOUND_MS, ROOT_WALK_MAX_HOPS, rootSessionOf } from '../src/index'
import { RootSessionCache } from '../src/plugin/hooks'
import { TUI_COMMAND_SESSION } from '../src/plugin/command'
import type { HostContext, HostSessionInfo } from '../src/plugin/host'
import type { DshToolDefinition } from '../src/graph/load'
import { assistant } from './helpers/fake-host'
import { makeFixture, type Fixture } from './helpers/plugin'

const PARENT = 'ses_parent0000000000000000000'
const OTHER_ROOT = 'ses_parent0000000000000000001'
const SUB = 'ses_sub000000000000000000001'
const SUB2 = 'ses_sub000000000000000000002'
const MISSING = 'ses_gone000000000000000000002'

/** A model list with one usable OpenCode model, like the other fixtures use. */
const ANTHROPIC = [{ providerID: 'anthropic', id: 'claude-sonnet-5' }]

const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.dispose()
})

/** A host session record, as `session.get` reports it. */
function session(id: string, parentID?: string): HostSessionInfo {
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    time: { created: 0, updated: 0 },
  }
}

/** The narrowest context `rootSessionOf` reads: a scriptable `session.get`. */
function stubCtx(get: (input: { sessionID: string }) => Promise<HostSessionInfo>): HostContext {
  return { session: { get } } as unknown as HostContext
}

/** A `session.get` over a fixed table, throwing a 404 for anything absent. */
function table(sessions: HostSessionInfo[], calls: string[] = []): (input: { sessionID: string }) => Promise<HostSessionInfo> {
  const byID = new Map(sessions.map((info) => [info.id, info]))
  return async ({ sessionID }) => {
    calls.push(sessionID)
    const found = byID.get(sessionID)
    if (found === undefined) throw Object.assign(new Error(`Session ${sessionID} not found`), { _tag: 'Session.NotFoundError' })
    return found
  }
}

/** Every exec the plugin's graph tools were handed, in order. */
function captureExecs(runtime: GraphRuntime): Array<{ agent: { id: string }; sessionId: string; callId?: string; provenance?: unknown }> {
  const seen: Array<{ agent: { id: string }; sessionId: string; callId?: string; provenance?: unknown }> = []
  for (const authority of ['read', 'manage'] as const) {
    const definitions = runtime.definitions(authority)
    for (const name of ['memory_search', 'memory_write']) {
      const original = definitions.get(name)
      if (original === undefined) continue
      const spy: DshToolDefinition = {
        ...original,
        execute: async (args: unknown, exec: unknown) => {
          seen.push(exec as { agent: { id: string }; sessionId: string; callId?: string; provenance?: unknown })
          return original.execute(args, exec)
        },
      }
      definitions.set(name, spy)
    }
  }
  return seen
}

// ---------------------------------------------------------- the ancestry walk

describe('rootSessionOf (#317)', () => {
  test('a root caller is its own root (a fork too: it has no parentID)', async () => {
    const calls: string[] = []
    const origin = await rootSessionOf(stubCtx(table([session(PARENT)], calls)), PARENT)
    expect(origin).toEqual({ session: PARENT })
    expect(calls).toEqual([PARENT])
  })

  test('a depth-2 subagent resolves the top-level chat, not its caller', async () => {
    const calls: string[] = []
    const ctx = stubCtx(table([session(SUB, SUB2), session(SUB2, PARENT), session(PARENT)], calls))
    expect(await rootSessionOf(ctx, SUB)).toEqual({ session: PARENT })
    expect(calls).toEqual([SUB, SUB2, PARENT])
  })

  test(`${ROOT_WALK_MAX_HOPS} hops resolve; ${ROOT_WALK_MAX_HOPS + 1} are walk-failed`, async () => {
    // ids[0].parent = ids[1], …, ids[n-1] is the root.
    const chain = (count: number): HostSessionInfo[] =>
      Array.from({ length: count }, (_, index) =>
        index === count - 1 ? session(`ses_deep${index}`) : session(`ses_deep${index}`, `ses_deep${index + 1}`),
      )
    // 1 caller + 8 parents = 8 hops.
    expect(await rootSessionOf(stubCtx(table(chain(ROOT_WALK_MAX_HOPS + 1))), 'ses_deep0')).toEqual({
      session: `ses_deep${ROOT_WALK_MAX_HOPS}`,
    })
    // One more parent is past the cap.
    expect(await rootSessionOf(stubCtx(table(chain(ROOT_WALK_MAX_HOPS + 2))), 'ses_deep0')).toEqual({
      session: null,
      reason: 'walk-failed',
    })
  })

  test('a 404 partway up is walk-failed, not the last session that answered', async () => {
    const ctx = stubCtx(table([session(SUB, MISSING)]))
    expect(await rootSessionOf(ctx, SUB)).toEqual({ session: null, reason: 'walk-failed' })
  })

  test('a cycle is walk-failed', async () => {
    const ctx = stubCtx(table([session(SUB, SUB2), session(SUB2, SUB)]))
    expect(await rootSessionOf(ctx, SUB)).toEqual({ session: null, reason: 'walk-failed' })
  })

  test('an id that is not the one requested is walk-failed', async () => {
    const ctx = stubCtx(async ({ sessionID }) => ({
      ...session(sessionID, PARENT),
      id: 'ses_impostor000000000000000000',
    }))
    expect(await rootSessionOf(ctx, SUB)).toEqual({ session: null, reason: 'walk-failed' })
  })

  test('a timeout is walk-failed', async () => {
    const ctx = stubCtx(() => new Promise<HostSessionInfo>(() => {}))
    expect(await rootSessionOf(ctx, SUB, undefined, { boundMs: 25 })).toEqual({ session: null, reason: 'walk-failed' })
  })

  test('the default bound is short (a walk is never a call budget)', () => {
    expect(ROOT_WALK_BOUND_MS).toBeLessThanOrEqual(2_000)
  })

  test(`the TUI command session is walk-failed without a host call`, async () => {
    let called = 0
    const ctx = stubCtx(async () => {
      called += 1
      throw new Error('should not be reached')
    })
    expect(await rootSessionOf(ctx, TUI_COMMAND_SESSION)).toEqual({ session: null, reason: 'walk-failed' })
    expect(called).toBe(0)
  })

  test('a proven root is cached per caller, and the cache holds only successes', async () => {
    const calls: string[] = []
    const cache = new RootSessionCache()
    const ctx = stubCtx(table([session(SUB, PARENT), session(PARENT)], calls))
    expect(await rootSessionOf(ctx, SUB, cache)).toEqual({ session: PARENT })
    expect(await rootSessionOf(ctx, SUB, cache)).toEqual({ session: PARENT })
    // One walk served both calls.
    expect(calls).toEqual([SUB, PARENT])
  })

  test('a failure is NOT cached: the next call retries and succeeds', async () => {
    const cache = new RootSessionCache()
    let fail = true
    let calls = 0
    const working = table([session(SUB, PARENT), session(PARENT)])
    const ctx = stubCtx(async (input) => {
      calls += 1
      if (fail) throw new Error('host hiccup')
      return working(input)
    })
    expect(await rootSessionOf(ctx, SUB, cache)).toEqual({ session: null, reason: 'walk-failed' })
    fail = false
    expect(await rootSessionOf(ctx, SUB, cache)).toEqual({ session: PARENT })
    expect(calls).toBeGreaterThan(1)
  })
})

// ----------------------------------------------------------- the graph contract

let root: string
let runtime: GraphRuntime

async function withRuntime(body: () => Promise<void>): Promise<void> {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mexplore-provenance-'))
  runtime = await loadGraph({ graphRoot: root })
  try {
    await body()
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

describe('the exec contract (#317)', () => {
  test('a proven root is stamped as exec.provenance, never as the authorization key', () =>
    withRuntime(async () => {
      const seen = captureExecs(runtime)
      const call = runtime.createCall({
        callId: 'call-root',
        authority: 'manage',
        message: 'a test request',
        evidence: [],
        origin: { session: PARENT },
      })
      await call.execute('memory_search', { query: 'anything' })
      expect(seen).toHaveLength(1)
      const exec = seen[0] as NonNullable<(typeof seen)[0]>
      expect(exec.provenance).toEqual({ actor: 'chat', host: 'opencode', session: PARENT })
      // Rule 3: the per-call authorization keys are untouched by provenance.
      expect(exec.agent.id).toBe('call-root')
      expect(exec.sessionId).toBe('call-root')
    }))

  test('walk-failed travels with its reason', () =>
    withRuntime(async () => {
      const seen = captureExecs(runtime)
      const call = runtime.createCall({
        callId: 'call-failed',
        authority: 'read',
        message: 'a test request',
        evidence: [],
        origin: { session: null, reason: 'walk-failed' },
      })
      await call.execute('memory_search', { query: 'anything' })
      expect(seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'walk-failed' })
    }))

  test('a call created without an origin declares no resolver, never a guess', () =>
    withRuntime(async () => {
      const seen = captureExecs(runtime)
      await runtime
        .createCall({ callId: 'call-bare', authority: 'read', message: 'a test request', evidence: [] })
        .execute('memory_search', { query: 'anything' })
      expect(seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'no-resolver' })
    }))

  test('makeExec keeps callId on both authorization keys and puts the root only in provenance', () => {
    const exec = makeExec('call-1', () => [], { session: PARENT })
    expect(exec.sessionId).toBe('call-1')
    expect(exec.agent.id).toBe('call-1')
    expect(exec.provenance).toEqual({ actor: 'chat', host: 'opencode', session: PARENT })
    // A proven session carries no reason at all.
    expect(exec.provenance !== undefined && 'reason' in exec.provenance).toBe(false)
  })

  test('makeExec stamps the call id where the engine reads it for provenance', () => {
    // `call` on a provenance line (#317 item 2). Attribution only: `agent.id`
    // and `sessionId` are unchanged by it.
    const exec = makeExec('call-7', () => [], { session: PARENT })
    expect(exec.callId).toBe('call-7')
    expect(exec.agent.id).toBe('call-7')
    expect(exec.sessionId).toBe('call-7')
  })
})

// ------------------------------------------------------------------ the wiring

/** Run one memory call from `sessionID` and hand back every exec it produced. */
async function callFrom(
  target: Fixture,
  sessionID: string,
  seen: Array<{ agent: { id: string }; sessionId: string; callId?: string; provenance?: unknown }>,
  authority: 'read' | 'manage' = 'read',
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  target.host.script = async (child, host) => {
    await host.executeTool('memory_search', { query: 'a question' }, child.info.id)
    child.messages.push(assistant('found nothing'))
  }
  return (await target.host.executeTool('mexplore', { message: 'a question', authority }, sessionID)) as {
    content: string
    metadata: Record<string, unknown>
  }
}

describe('the OpenCode wiring (#317)', () => {
  /** A fixture whose host knows these caller sessions (they are not children). */
  async function wired(sessions: HostSessionInfo[]): Promise<{
    target: Fixture
    seen: Array<{ agent: { id: string }; sessionId: string; callId?: string; provenance?: unknown }>
  }> {
    const target = await fixture({ models: ANTHROPIC, keyConnected: true, existing: sessions })
    return { target, seen: captureExecs(target.plugin.runtime) }
  }

  test('a root caller records itself', async () => {
    const { target, seen } = await wired([session(PARENT)])
    const result = await callFrom(target, PARENT, seen)
    expect(seen.map((exec) => exec.provenance)).toEqual([
      { actor: 'chat', host: 'opencode', session: PARENT },
    ])
    expect(result.content).toContain('no writes')
  })

  test('a depth-2 subagent records the root, not its caller', async () => {
    const { target, seen } = await wired([session(SUB, SUB2), session(SUB2, PARENT), session(PARENT)])
    await callFrom(target, SUB, seen)
    expect(seen.map((exec) => exec.provenance)).toEqual([
      { actor: 'chat', host: 'opencode', session: PARENT },
    ])
  })

  test('a 404 partway, a cycle, an id mismatch or a timeout each record walk-failed', async () => {
    // 404: the caller's parent does not exist.
    const missing = await wired([session(SUB, MISSING)])
    await callFrom(missing.target, SUB, missing.seen)
    expect(missing.seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'walk-failed' })

    // Cycle.
    const cycle = await wired([session(SUB, SUB2), session(SUB2, SUB)])
    await callFrom(cycle.target, SUB, cycle.seen)
    expect(cycle.seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'walk-failed' })

    // An id mismatch: the host answers for a different session than asked.
    const mismatch = await wired([session(SUB, PARENT), session(PARENT)])
    const get = mismatch.target.host.ctx.session.get
    mismatch.target.host.ctx.session.get = async (input) => {
      const info = await get(input)
      return input.sessionID === PARENT ? { ...info, id: 'ses_impostor000000000000000000' } : info
    }
    await callFrom(mismatch.target, SUB, mismatch.seen)
    expect(mismatch.seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'walk-failed' })

    // A timeout on the caller's own lookup.
    const stalled = await wired([session(PARENT)])
    const original = stalled.target.host.ctx.session.get
    stalled.target.host.ctx.session.get = async (input) =>
      input.sessionID === PARENT && stalled.seen.length === 0
        ? new Promise<HostSessionInfo>(() => {})
        : original(input)
    const started = Date.now()
    await callFrom(stalled.target, PARENT, stalled.seen)
    expect(stalled.seen[0]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: null, reason: 'walk-failed' })
    // Bounded: it did not wait on the caller's own timeoutMs.
    expect(Date.now() - started).toBeLessThan(ROOT_WALK_BOUND_MS + 2_000)
  })

  test('after a failed walk the next call retries and records the root', async () => {
    const { target, seen } = await wired([session(SUB, PARENT), session(PARENT)])
    const original = target.host.ctx.session.get
    let failOnce = true
    target.host.ctx.session.get = async (input) => {
      if (failOnce && input.sessionID === SUB) {
        failOnce = false
        throw new Error('host hiccup')
      }
      return original(input)
    }
    await callFrom(target, SUB, seen)
    expect(seen[0]?.provenance).toMatchObject({ session: null, reason: 'walk-failed' })
    await callFrom(target, SUB, seen)
    expect(seen[1]?.provenance).toEqual({ actor: 'chat', host: 'opencode', session: PARENT })
  })

  test('two concurrent calls from different roots record their own roots', async () => {
    const { target, seen } = await wired([session(PARENT), session(OTHER_ROOT)])
    target.host.script = async (child, host) => {
      await host.executeTool('memory_search', { query: 'a question' }, child.info.id)
      child.messages.push(assistant('nothing'))
    }
    await Promise.all([
      target.host.executeTool('mexplore', { message: 'one', authority: 'read' }, PARENT),
      target.host.executeTool('mexplore', { message: 'two', authority: 'read' }, OTHER_ROOT),
    ])
    const sessions = seen.map((exec) => (exec.provenance as { session: string | null }).session).sort()
    expect(sessions).toEqual([OTHER_ROOT, PARENT].sort())
  })

  test('two calls from one root share it but keep separate authorization', async () => {
    const { target, seen } = await wired([session(SUB, PARENT), session(PARENT)])
    target.host.script = async (child, host) => {
      await host.executeTool('memory_search', { query: 'a question' }, child.info.id)
      child.messages.push(assistant('nothing'))
    }
    await Promise.all([
      target.host.executeTool('mexplore', { message: 'one', authority: 'read' }, SUB),
      target.host.executeTool('mexplore', { message: 'two', authority: 'read' }, SUB),
    ])
    expect(seen).toHaveLength(2)
    for (const exec of seen) {
      expect((exec.provenance as { session: string | null }).session).toBe(PARENT)
      // NEVER the root: the per-call key is the call id, and the two differ.
      expect(exec.agent.id).toBe(exec.sessionId)
      expect(exec.agent.id).not.toBe(PARENT)
    }
    expect(seen[0]?.agent.id).not.toBe(seen[1]?.agent.id)
  })

  test('the tool result never carries the root id', async () => {
    const { target, seen } = await wired([session(SUB, PARENT), session(PARENT)])
    target.host.script = async (child, host) => {
      await host.executeTool('memory_write', { description: 'a note', body: 'the body' }, child.info.id)
      child.messages.push(assistant('saved it'))
    }
    const result = (await target.host.executeTool(
      'mexplore',
      { message: 'save a note', authority: 'manage' },
      SUB,
    )) as { content: string; metadata: Record<string, unknown> }
    // The write really happened through the proven-root path…
    expect(result.content).toContain('saved to memory: a note')
    expect(seen.some((exec) => (exec.provenance as { session?: string | null }).session === PARENT)).toBe(true)
    // …and neither the text nor the metadata names the root (REQ-003, rule 5).
    expect(result.content).not.toContain(PARENT)
    expect(JSON.stringify(result.metadata)).not.toContain(PARENT)
    expect(result.content).not.toContain('provenance')
  })

  test('the written provenance line carries this call id in `call` (#317 item 2)', async () => {
    const { target, seen } = await wired([session(PARENT)])
    target.host.script = async (child, host) => {
      await host.executeTool('memory_write', { description: 'a call-id note', body: 'the body' }, child.info.id)
      child.messages.push(assistant('saved it'))
    }
    const result = (await target.host.executeTool(
      'mexplore',
      { message: 'save a note', authority: 'manage' },
      PARENT,
    )) as { content: string }
    expect(result.content).toContain('saved to memory: a call-id note')

    // One node, one line, and the line names the host-side call id the exec
    // carried — never the root, and never a fabricated id.
    const written = seen.filter((exec) => exec.agent.id !== undefined)
    expect(written.length).toBeGreaterThan(0)
    const dir = path.join(target.root, '.provenance')
    const files = (await fsp.readdir(dir)).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const lines = (await fsp.readFile(path.join(dir, files[0] as string), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(1)
    const line = lines[0] as Record<string, unknown>
    expect(line.op).toBe('create')
    expect(line.actor).toBe('chat')
    expect(line.host).toBe('opencode')
    expect(line.session).toBe(PARENT)
    // The exec's own callId, copied verbatim — the same value as agent.id.
    const exec = written[0] as { agent: { id: string }; callId?: string }
    expect(exec.callId).toBe(exec.agent.id)
    expect(line.call).toBe(exec.callId)
  })
})
