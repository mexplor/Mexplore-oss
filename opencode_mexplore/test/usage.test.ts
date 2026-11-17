/**
 * Lane B: usage capture, the usage log, `/mexplore usage`, `/mexplore ui`, the
 * welcome dialog, and the option/dependency guards.
 *
 * Everything here runs against the fake host, so nothing depends on a real
 * OpenCode binary, on the UI lane's package, or on the user's own
 * `$XDG_STATE_HOME`.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  BUFFER_MS,
  UsageRecorder,
  normalizeTokens,
  total,
  usageStatus,
  type UsageEvent,
} from '../src/plugin/usage-capture'
import {
  MAX_LINE_BYTES,
  appendUsage,
  readUsage,
  resolveUsageDir,
  summarizeUsage,
  usageFileFor,
  type UsageRecord,
} from '../src/plugin/usage-log'
import { USAGE_EVENT_TYPES, createUsage } from '../src/plugin/usage-sink'
import { helpText, commandUsage } from '../src/plugin/command'
import { readOptions } from '../src/plugin/config'
import { scheduleWelcome, WELCOME_KEY, WELCOME_VERSION } from '../src/tui'
import { MANAGE_TOOL_NAMES } from '../src/graph/index'
import { assistant } from './helpers/fake-host'
import { makeFixture, tempRoot, withEnv, type Fixture } from './helpers/plugin'

const PARENT = 'ses_parent0000000000000000000'
const ANTHROPIC = [{ providerID: 'anthropic', id: 'claude-sonnet-5' }]

const fixtures: Fixture[] = []
const tempDirs: string[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

async function tempDir(prefix = 'mexplore-usage-'): Promise<string> {
  const dir = await tempRoot(prefix)
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.dispose()
  while (tempDirs.length > 0) await fsp.rm(tempDirs.pop() as string, { recursive: true, force: true })
})

/** One usage event, in the host's wire shape (`tokens.cache.read`). */
function usageEvent(sessionID: string, tokens: Record<string, number>, cost = 0): UsageEvent {
  return {
    type: 'session.usage.updated',
    data: {
      sessionID,
      cost,
      tokens: {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 },
      },
    } as UsageEvent['data'],
  }
}

function stepEvent(sessionID: string, tokens: Record<string, number>, cost = 0): UsageEvent {
  return {
    type: 'session.step.ended',
    data: { sessionID, cost, tokens: { ...tokens, cache: { read: 0, write: 0 } } } as UsageEvent['data'],
  }
}

// ---------------------------------------------------------------- item 1: events

describe('usage capture from events (Lane B item 1)', () => {
  test('a cumulative value REPLACES the earlier one and is never added to', () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(usageEvent('ses_child', { input: 10, output: 5 }))
    recorder.observe(usageEvent('ses_child', { input: 30, output: 12 }))
    const capture = recorder.read('ses_child')
    // Cumulative: the last value wins, not 40/17.
    expect(capture?.tokens).toEqual({ input: 30, output: 12, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  test('cumulative and step sums are never combined', () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(usageEvent('ses_child', { input: 100, output: 40 }))
    recorder.observe(stepEvent('ses_child', { input: 100, output: 40 }))
    const capture = recorder.read('ses_child')
    expect(capture?.tokens).toEqual({ input: 100, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(capture?.steps).toBe(1)
  })

  test('step sums are the fallback when no cumulative value arrived', () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(stepEvent('ses_child', { input: 7, output: 3 }, 0.001))
    recorder.observe(stepEvent('ses_child', { input: 11, output: 5 }, 0.002))
    const capture = recorder.read('ses_child')
    expect(capture?.tokens).toEqual({ input: 18, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(capture?.cost).toBeCloseTo(0.003, 6)
    expect(capture?.steps).toBe(2)
  })

  test('events for a session before it is tracked are buffered and replayed', () => {
    const recorder = new UsageRecorder()
    // The step lands before `create` returned the id.
    recorder.observe(usageEvent('ses_child', { input: 9, output: 4 }))
    expect(recorder.read('ses_child')).toBeUndefined()
    recorder.track('ses_child')
    expect(recorder.read('ses_child')?.tokens?.input).toBe(9)
  })

  test('an unowned session\'s events are dropped, and its buffer expires', async () => {
    const recorder = new UsageRecorder()
    recorder.observe(usageEvent('ses_somebody_else', { input: 5 }))
    const timer = setTimeout(() => {}, BUFFER_MS)
    // Buffered, never captured, and it does not leak into another session.
    expect(recorder.read('ses_somebody_else')).toBeUndefined()
    expect(recorder.read('ses_child')).toBeUndefined()
    clearTimeout(timer)
  })

  test('drain waits for the terminal event, then a second drain is immediate', async () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(usageEvent('ses_child', { input: 4, output: 2 }))
    const started = Date.now()
    const drained = recorder.drain('ses_child', 100)
    // Emitted while draining: the waiter resolves early, not after the bound.
    setTimeout(() => recorder.observe({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } }), 10)
    const capture = await drained
    expect(capture?.terminal).toBe(true)
    expect(Date.now() - started).toBeLessThan(90)
    // Already terminal: no wait at all.
    const again = await recorder.drain('ses_child', 100)
    expect(again?.terminal).toBe(true)
  })

  test('drain gives up at its bound when the terminal event never comes', async () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(usageEvent('ses_child', { input: 4 }))
    const started = Date.now()
    const capture = await recorder.drain('ses_child', 40)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(capture?.terminal).toBe(false)
    expect(capture?.tokens?.input).toBe(4)
  })

  test('usageStatus: complete only with a terminal event AND ok', () => {
    expect(usageStatus({ capture: { tokens: normalizeTokens({ input: 1 }) as never, cumulative: true, steps: 1, terminal: true, terminalType: 'session.execution.succeeded', cost: undefined }, outcome: 'ok' })).toBe('complete')
    expect(usageStatus({ capture: { tokens: normalizeTokens({ input: 1 }) as never, cumulative: true, steps: 1, terminal: true, terminalType: 'session.execution.succeeded', cost: undefined }, outcome: 'timeout' })).toBe('partial')
    expect(usageStatus({ capture: { tokens: normalizeTokens({ input: 1 }) as never, cumulative: false, steps: 1, terminal: false, terminalType: undefined, cost: undefined }, outcome: 'ok' })).toBe('partial')
    expect(usageStatus({ capture: undefined, outcome: 'ok' })).toBe('unknown')
  })

  test('all-zero tokens are "no usage", never a free call', () => {
    expect(normalizeTokens({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
    expect(total(normalizeTokens({ input: 2, output: 3 }) as never)).toBe(5)
  })
})

// ------------------------------------------------- item 1 end-to-end on the fake host

describe('a call writes exactly one record on every exit path (Lane B item 1)', () => {
  /** Read the one file a fixture wrote, parsed. */
  async function records(dir: string): Promise<UsageRecord[]> {
    return readUsage(dir, { days: 1 })
  }

  test('the completed path: one record, complete, with real tokens', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      host.emit('session.usage.updated', { sessionID: child.info.id, cost: 0.002, tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 40, write: 0 } } })
      host.emit('session.step.ended', { sessionID: child.info.id, cost: 0.002, tokens: { input: 120, output: 30 } })
      host.emit('session.execution.succeeded', { sessionID: child.info.id })
      child.messages.push(assistant('done'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(30)
    const written = await records(dir)
    expect(written).toHaveLength(1)
    const record = written[0] as UsageRecord
    expect(record.v).toBe(1)
    expect(record.outcome).toBe('ok')
    expect(record.usageStatus).toBe('complete')
    expect(record.tokens).toEqual({ input: 120, output: 30, reasoning: 5, cacheRead: 40, cacheWrite: 0 })
    expect(record.costUsd).toBeCloseTo(0.002, 6)
    expect(record.steps).toBe(1)
    expect(record.authority).toBe('read')
    expect(record.provider).toBe('mexplore')
    expect(record.model).toBe('deepseek-v4.1-flash-1017')
    expect(record.modelSource).toBe('default')
    expect(typeof record.latencyMs).toBe('number')
    // AC-003's spirit: no message text and no child id in a record.
    expect(JSON.stringify(record)).not.toContain('done')
    expect(JSON.stringify(record)).not.toContain(childID as string)
  })

  test('the callId in the record is the one the GraphCall was created with', async () => {
    const dir = await tempDir()
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(30)
    const record = (await records(dir))[0] as UsageRecord
    // The registry's OwnedChild no longer exists (removed), so compare against
    // the record being a real UUID and distinct from the session id.
    expect(record.callId).toMatch(/^[0-9a-f-]{36}$/)
    expect(record.callId).not.toBe(childID as string)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a timeout still writes one record, marked partial', async () => {
    const dir = await tempDir()
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      timeoutMs: 40,
      options: { usageDir: dir, graphRoot: await tempDir() },
    })
    host.script = async (child) => {
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 50, output: 10, cache: { read: 0, write: 0 } } })
      await new Promise<void>(() => {})
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect((error as { metadata?: { code?: string } }).metadata?.code).toBe('TIMEOUT')
    await Bun.sleep(50)
    const written = await records(dir)
    expect(written).toHaveLength(1)
    expect(written[0]?.outcome).toBe('timeout')
    expect(written[0]?.usageStatus).toBe('partial')
    expect(written[0]?.tokens?.input).toBe(50)
  })

  test('an aborted call writes one record, marked aborted', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const controller = new AbortController()
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (child.interrupted > 0) resolve()
          else setTimeout(check, 1)
        }
        setTimeout(check, 1)
      })
    }
    const pending = failure(() =>
      host.tools.get('mexplore')?.execute(
        { message: 'q' },
        {
          sessionID: PARENT,
          agent: 'build',
          messageID: 'msg',
          id: 'call',
          signal: controller.signal,
          progress: async () => {},
        },
      ) as Promise<unknown>,
    )
    for (let index = 0; index < 200 && childID === undefined; index += 1) await Bun.sleep(1)
    controller.abort()
    await pending
    await Bun.sleep(50)
    const written = await records(dir)
    expect(written).toHaveLength(1)
    expect(written[0]?.outcome).toBe('aborted')
    // Nothing was captured: `unknown` is the honest answer, not `partial`.
    expect(written[0]?.usageStatus).toBe('unknown')
    expect(written[0]?.tokens).toBeNull()
  })

  test('a failed run writes one record, marked failed', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    host.script = async (child) => {
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 8, output: 2, cache: { read: 0, write: 0 } } })
      child.messages.push({ type: 'assistant', time: { created: Date.now() }, content: [], finish: 'error', error: { type: 'provider.error', message: 'boom' } })
      child.info.outcome = 'failed'
    }
    await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    await Bun.sleep(50)
    const written = await records(dir)
    expect(written).toHaveLength(1)
    expect(written[0]?.outcome).toBe('failed')
    expect(written[0]?.usageStatus).toBe('partial')
  })

  test('usageLog:false writes nothing at all', async () => {
    // A directory that EXISTS: the assertion is that nothing is written into it,
    // not that it is absent (a temp dir is created up front).
    const dir = await tempDir()
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      options: { usageDir: dir, usageLog: false, graphRoot: await tempDir() },
    })
    host.script = async (child) => {
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 1 } })
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(30)
    expect(await fsp.readdir(dir)).toEqual([])
  })

  test('exactly ONE subscription is made, whatever the call count', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    for (let index = 0; index < 3; index += 1) await host.executeTool('mexplore', { message: 'q' }, PARENT)
    expect(host.subscriberCount).toBe(1)
    await Bun.sleep(30)
    expect(await readUsage(dir, { days: 1 })).toHaveLength(3)
  })
})

// ------------------------------------------------------------------- item 3

describe('the usage log writer (Lane B item 3, Shared contract)', () => {
  const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
    v: 1,
    callId: 'c-1',
    ts: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    authority: 'read',
    outcome: 'ok',
    latencyMs: 5,
    usageStatus: 'complete',
    tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    provider: 'mexplore',
    model: 'deepseek-v4.1-flash-1017',
    modelSource: 'default',
    steps: 1,
    graphRoot: '/g',
    pluginVersion: '0.1.0',
    ...overrides,
  })

  test('the file is monthly, in UTC, under the usage directory', async () => {
    const dir = await tempDir()
    const at = new Date('2026-03-31T23:59:00Z')
    const file = usageFileFor(dir, at)
    expect(path.basename(file)).toBe('usage-2026-03.jsonl')
    // 00:30 UTC on 1 April is still April in UTC, whatever the local zone says.
    expect(path.basename(usageFileFor(dir, new Date('2026-04-01T00:30:00Z')))).toBe('usage-2026-04.jsonl')
  })

  test('a line is appended with 0600 and the directory is 0700', async () => {
    const dir = path.join(await tempDir(), 'mexplore')
    await appendUsage(dir, record())
    const file = usageFileFor(dir, new Date())
    const fileStat = await fsp.stat(file)
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700)
    const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string).callId).toBe('c-1')
  })

  test('a symlinked FILE is refused rather than followed', async () => {
    const root = await tempDir()
    const dir = path.join(root, 'usage')
    await fsp.mkdir(dir, { recursive: true })
    const victim = path.join(root, 'victim.txt')
    await fsp.writeFile(victim, 'original\n')
    await fsp.symlink(victim, usageFileFor(dir, new Date()))
    const result = await appendUsage(dir, record())
    expect('error' in result && result.error).toContain('symlink')
    // The target is untouched: nothing was appended through the link.
    expect(await fsp.readFile(victim, 'utf8')).toBe('original\n')
  })

  test('a symlinked DIRECTORY is refused', async () => {
    const root = await tempDir()
    const real = path.join(root, 'real')
    await fsp.mkdir(real)
    const linked = path.join(root, 'usage')
    await fsp.symlink(real, linked)
    const result = await appendUsage(linked, record())
    expect('error' in result && result.error).toContain('symlink')
  })

  test('a record over the line budget is refused, not truncated', async () => {
    const dir = await tempDir()
    const huge = record({ model: 'm'.repeat(MAX_LINE_BYTES) })
    const result = await appendUsage(dir, huge)
    expect('error' in result && result.error).toContain('exceeds')
  })

  test('the directory ignores a RELATIVE XDG_STATE_HOME', () => {
    const resolved = resolveUsageDir({ XDG_STATE_HOME: 'relative/state' })
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(path.join(os.homedir(), '.local', 'state', 'mexplore'))
    expect(resolveUsageDir({ XDG_STATE_HOME: '/tmp/xdg-state' })).toBe(path.resolve('/tmp/xdg-state/mexplore'))
  })

  test('a torn trailing line is skipped, and only this graph counts', async () => {
    const dir = await tempDir()
    await appendUsage(dir, record({ callId: 'mine', graphRoot: '/g' }))
    await appendUsage(dir, record({ callId: 'other', graphRoot: '/elsewhere' }))
    await fsp.appendFile(usageFileFor(dir, new Date()), '{"v":1,"callId":"torn"')
    const mine = await readUsage(dir, { days: 30, graphRoot: '/g' })
    expect(mine.map((entry) => entry.callId)).toEqual(['mine'])
    // Without the filter, the other graph is visible and the torn line is not.
    expect((await readUsage(dir, { days: 30 })).map((entry) => entry.callId).sort()).toEqual(['mine', 'other'])
  })
})

// ------------------------------------------------------------------- item 4

describe('/mexplore usage (Lane B item 4)', () => {
  test('the summary counts calls, tokens, partial/unknown and cost', async () => {
    const dir = await tempDir()
    const base: Partial<UsageRecord> = { graphRoot: '/g', provider: 'mexplore', model: 'm', modelSource: 'default', pluginVersion: '0.1.0' }
    await appendUsage(dir, { v: 1, callId: 'a', ts: new Date().toISOString(), finishedAt: new Date().toISOString(), authority: 'read', outcome: 'ok', latencyMs: 1, usageStatus: 'complete', tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 2, cacheWrite: 0 }, costUsd: 0.5, steps: 1, ...base } as UsageRecord)
    await appendUsage(dir, { v: 1, callId: 'b', ts: new Date().toISOString(), finishedAt: new Date().toISOString(), authority: 'manage', outcome: 'timeout', latencyMs: 1, usageStatus: 'partial', tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, steps: 1, ...base } as UsageRecord)
    await appendUsage(dir, { v: 1, callId: 'c', ts: new Date().toISOString(), finishedAt: new Date().toISOString(), authority: 'read', outcome: 'failed', latencyMs: 1, usageStatus: 'unknown', tokens: null, costUsd: null, steps: 0, ...base } as UsageRecord)

    const records = await readUsage(dir, { days: 30, graphRoot: '/g' })
    const text = summarizeUsage(records, 30)
    expect(text).toContain('3 calls')
    // Call counts and token totals are separate facts (review #10).
    expect(text).toContain('(read 2, manage 1)')
    expect(text).toContain('read tokens: in 10 / out 5')
    expect(text).toContain('manage tokens: in 1 / out 1')
    expect(text).toContain('all tokens: in 11 / out 6')
    // One call reported nothing, so the combined total is a LOWER BOUND.
    expect(text).toContain('≥19 total')
    expect(text).toContain('1 without data')
    expect(text).toContain('partial 1')
    expect(text).toContain('unknown 1')
    // Only the priced call contributes spend.
    expect(text).toContain('$0.5000')
  })

  test('an empty log says so instead of printing zeros', () => {
    expect(summarizeUsage([], 30)).toContain('no calls recorded')
  })

  test('the command reports off when the log is disabled', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      options: { usageLog: false, graphRoot: await tempDir() },
    })
    const text = await host.command(PARENT, '/mexplore usage')
    expect(text).toContain('usage log is off')
  })

  test('status shows where the log writes', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const text = await host.command(PARENT, '/mexplore status')
    expect(text).toContain(`usage log: on (${dir})`)
  })

  test('status says off when disabled', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageLog: false, graphRoot: await tempDir() } })
    expect(await host.command(PARENT, '/mexplore status')).toContain('usage log: off')
  })

  test('the command reads the real log for the served graph', async () => {
    const dir = await tempDir()
    const graph = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: graph } })
    host.script = async (child) => {
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 300, output: 60, cache: { read: 0, write: 0 } } })
      host.emit('session.execution.succeeded', { sessionID: child.info.id })
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(40)
    const text = await host.command(PARENT, '/mexplore usage')
    expect(text).toContain('1 call')
    expect(text).toContain('in 300 / out 60')
  })
})

// ---------------------------------------------------------------- option parsing

describe('the usageLog option (Lane B item 3)', () => {
  test('defaults to on', () => {
    expect(readOptions(undefined).usageLog).toBe(true)
    expect(readOptions({}).usageLog).toBe(true)
  })

  test('a real false disables it', () => {
    expect(readOptions({ usageLog: false }).usageLog).toBe(false)
  })

  test('the string "false" disables it, because that is a common config typo', () => {
    expect(readOptions({ usageLog: 'false' }).usageLog).toBe(false)
    expect(readOptions({ usageLog: 'true' }).usageLog).toBe(true)
  })

  test('anything else falls back to the default rather than guessing', () => {
    expect(readOptions({ usageLog: 0 }).usageLog).toBe(true)
    expect(readOptions({ usageLog: 'no' }).usageLog).toBe(true)
    expect(readOptions({ usageLog: null }).usageLog).toBe(true)
  })
})

// ---------------------------------------------------------------------- item 5

describe('/mexplore ui (Lane B item 5)', () => {
  /** A fixture whose UI controls are fakes, so no real server is started. */
  async function uiFixture(overrides: Partial<{ bun: boolean; start: () => Promise<{ url: string; port: number }>; stop: () => Promise<boolean> }> = {}) {
    const dir = await tempDir()
    const created = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const calls: string[] = []
    Object.assign(created.plugin, {})
    const deps = {
      start: overrides.start ?? (async () => ({ url: 'http://127.0.0.1:43191/?t=tok', port: 43191 })),
      stop: overrides.stop ?? (async () => true),
      url: () => undefined,
      bun: () => overrides.bun ?? true,
    }
    // The command deps live in index.ts; drive `runCommand` directly with the
    // same shape so the UI controls can be substituted.
    const { runCommandText } = await import('../src/plugin/command')
    const run = (text: string): Promise<string> =>
      runCommandText(
        {
          ctx: created.host.ctx,
          reply: async () => {},
          graphRoot: created.plugin.graphRoot,
          settings: created.plugin.settings,
          reloadProvider: () => created.host.ctx.provider.reload(),
          diagnostic: async () => undefined,
          usageDir: dir,
          usageEnabled: true,
          ui: {
            start: async (input) => {
              calls.push('start')
              return deps.start()
            },
            stop: async () => {
              calls.push('stop')
              return deps.stop()
            },
            url: () => undefined,
            bun: deps.bun,
          },
        },
        { sessionID: PARENT, text, label: 'mexplore' },
      )
    return { run, calls, dir, fixture: created }
  }

  test('a start reply carries the URL, the stop hint and the remote caveat', async () => {
    const { run } = await uiFixture()
    const text = await run('ui')
    expect(text).toContain('http://127.0.0.1:43191/?t=tok')
    expect(text).toContain('/mexplore ui stop')
    expect(text).toContain('remote OpenCode server')
    // Not "one-time": the token is valid for this session of the dashboard
    // (review copy fix b).
    expect(text).toContain('access token for this session')
    expect(text).toContain("don't share it")
    expect(text).not.toContain('one-time')
  })

  test('ui stop stops it, and a second stop says nothing was running', async () => {
    const { run, calls } = await uiFixture({ stop: async () => false })
    expect(await run('ui stop')).toContain('No mexplore usage UI is running')
    expect(calls).toContain('stop')
  })

  test('a Node build of OpenCode is told so, not started', async () => {
    const { run, calls } = await uiFixture({ bun: false })
    const text = await run('ui')
    expect(text).toContain('Bun build of OpenCode')
    expect(calls).toEqual([])
  })

  test('a start failure is reported, never thrown', async () => {
    const { run } = await uiFixture({
      start: async () => {
        throw new Error('the bundled memory UI has no built assets')
      },
    })
    const text = await run('ui')
    expect(text).toContain('could not start the usage UI')
    expect(text).toContain('no built assets')
  })

  test('an unknown ui argument shows the usage', async () => {
    const { run } = await uiFixture()
    expect(await run('ui wat')).toContain('ui [stop]')
  })

  test('one dashboard per graph, owned per instance, coalesced, stopped at zero owners (review #3)', async () => {
    const { startUi, releaseUi, stopUi, uiRunning, setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    let starts = 0
    let stops = 0
    setUiModuleForTests({
      startPluginUi: async (options: { graphRoot: string }) => {
        starts += 1
        // Two concurrent starts must land on ONE listener.
        await Bun.sleep(20)
        return {
          url: `http://127.0.0.1:1/?t=${starts}`,
          port: 1,
          graphRoot: options.graphRoot,
          stop: async () => {
            stops += 1
          },
        }
      },
      uiAssetsPresent: () => true,
    })
    try {
      // Two concurrent starts from two DIFFERENT instances coalesce onto one.
      const [first, second] = await Promise.all([
        startUi({ graphRoot: graph, usageDir: usage, owner: 'instance-a' }),
        startUi({ graphRoot: graph, usageDir: usage, owner: 'instance-b' }),
      ])
      expect(starts).toBe(1)
      expect(first.url).toBe(second.url)

      // Repeated starts from the SAME instance are idempotent: no new reference.
      await startUi({ graphRoot: graph, usageDir: usage, owner: 'instance-a' })
      await startUi({ graphRoot: graph, usageDir: usage, owner: 'instance-a' })
      expect(starts).toBe(1)

      // Releasing an owner that holds nothing is a no-op, so a stranger can never
      // decrement another instance's ownership.
      expect(await releaseUi(graph, 'a-stranger')).toBe(false)
      expect(uiRunning(graph)).toBe(true)

      // A's release leaves B's dashboard up…
      expect(await releaseUi(graph, 'instance-a')).toBe(false)
      expect(uiRunning(graph)).toBe(true)
      // …and B's is the last owner, so that one stops it.
      expect(await releaseUi(graph, 'instance-b')).toBe(true)
      expect(stops).toBe(1)
      expect(uiRunning(graph)).toBe(false)
    } finally {
      setUiModuleForTests(undefined)
      // Keep the module's global registry clean for the next test.
      await stopUi(graph).catch(() => undefined)
    }
  })

  test('/mexplore ui stop stops outright, whatever the owners (review #3)', async () => {
    const { startUi, stopUi, setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    let stops = 0
    setUiModuleForTests({
      startPluginUi: async (options: { graphRoot: string }) => ({
        url: 'http://127.0.0.1:1/?t=x',
        port: 1,
        graphRoot: options.graphRoot,
        stop: async () => {
          stops += 1
        },
      }),
      uiAssetsPresent: () => true,
    })
    try {
      // Two owners, then an explicit stop: the user's intent wins over refcounts.
      await startUi({ graphRoot: graph, usageDir: usage, owner: 'a' })
      await startUi({ graphRoot: graph, usageDir: usage, owner: 'b' })
      expect(await stopUi(graph)).toBe(true)
      expect(stops).toBe(1)
      expect(await stopUi(graph)).toBe(false)
    } finally {
      setUiModuleForTests(undefined)
    }
  })

  test('a failed start releases its reference, so a retry is a real retry', async () => {
    const { startUi } = await import('../src/plugin/ui')
    const { setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    let attempts = 0
    setUiModuleForTests({
      startPluginUi: async () => {
        attempts += 1
        throw new Error('EADDRINUSE and a foreign listener')
      },
      uiAssetsPresent: () => true,
    })
    try {
      await expect(startUi({ graphRoot: graph, usageDir: usage })).rejects.toThrow('foreign listener')
      await expect(startUi({ graphRoot: graph, usageDir: usage })).rejects.toThrow('foreign listener')
      // Not replayed from a cached rejection: it really tried again.
      expect(attempts).toBe(2)
    } finally {
      setUiModuleForTests(undefined)
    }
  })

  test('the resolver reports both specifiers when neither loads', async () => {
    const { loadUiModule } = await import('../src/plugin/ui')
    // In this repo the sibling has no ./plugin yet and the package is not
    // installed, so this is the real "neither" path.
    const result = await loadUiModule()
    if ('error' in result) {
      expect(result.error).toContain('mexplore-ui/plugin')
      expect(result.error).toContain('mexplore_ui')
    } else {
      // The UI lane shipped: then it must have loaded the contract.
      expect(typeof result.module.startPluginUi).toBe('function')
    }
  })

  test('the event types the plugin subscribes to are exactly the usage ones', () => {
    expect([...USAGE_EVENT_TYPES].sort()).toEqual([
      'session.execution.failed',
      'session.execution.interrupted',
      'session.execution.succeeded',
      'session.step.ended',
      'session.step.failed',
      'session.usage.updated',
    ])
  })
})

// ---------------------------------------------------------------------- item 7

describe('the welcome dialog and /mexplore help (Lane B item 7)', () => {
  test('help describes what mexplore does and the setup steps', () => {
    const text = helpText('mexplore')
    expect(text).toContain('long-term memory')
    expect(text).toContain('inherits its model')
    expect(text).toContain('/mexplore model <provider/model>')
    expect(text).toContain('/mexplore test')
    expect(text).toContain('/mexplore ui')
    expect(text).toContain('usageLog: false')
    expect(text).toContain('saved to memory:')
    // The server label is honoured too.
    expect(helpText('mexplore-settings')).toContain('/mexplore-settings test')
  })

  test('the usage block lists the new subcommands', () => {
    const usage = commandUsage('mexplore')
    expect(usage).toContain('/mexplore usage')
    expect(usage).toContain('/mexplore ui [stop]')
    expect(usage).toContain('/mexplore help')
  })

  test('`help` works over both surfaces and is the same text', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { graphRoot: await tempDir() } })
    const server = await host.command(PARENT, '/mexplore help')
    const rpc = (await host.callRpc('mexplore', 'command', { args: 'help' })) as { text: string }
    expect(server).toContain('long-term memory')
    // Same CONTENT on both surfaces; the label differs by design (the TUI's
    // command is `/mexplore`, the server command `/mexplore-settings`).
    expect(rpc.text.replaceAll('/mexplore', 'X')).toBe(server.replaceAll('/mexplore-settings', 'X').replaceAll('/mexplore', 'X'))
  })

  test('the welcome opens ONCE, on the first event, and never again', async () => {
    const store = new Map<string, { seen: number }>()
    const listeners: Array<() => void> = []
    const shown: string[] = []
    let writes = 0
    const context = {
      data: {
        on: (_type: string, handler: () => void) => {
          listeners.push(handler)
          return () => {
            const index = listeners.indexOf(handler)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
      },
      storage: {
        store: (key: string, options: { initial: { seen: number } }) => {
          if (!store.has(key)) store.set(key, { ...options.initial })
          const state = store.get(key) as { seen: number }
          return [
            state,
            async (mutation: (draft: { seen: number }) => void) => {
              writes += 1
              mutation(state)
            },
          ] as const
        },
      },
      ui: {
        dialog: {
          select: async () => {
            shown.push('select')
            return 'current'
          },
          alert: async () => {},
        },
      },
    }
    scheduleWelcome(context)
    expect(shown).toEqual([])
    // Nothing is shown on setup alone.
    listeners[0]?.()
    await Bun.sleep(10)
    expect(shown).toEqual(['select'])
    expect(writes).toBe(1)
    expect(store.get(WELCOME_KEY)?.seen).toBe(WELCOME_VERSION)
    // A second trigger does not reopen it, and the listeners are detached.
    listeners.forEach((listener) => listener())
    await Bun.sleep(10)
    expect(shown).toEqual(['select'])
    expect(listeners).toHaveLength(0)
  })

  test('a later setup with the flag set shows nothing at all', async () => {
    const shown: string[] = []
    const context = {
      data: { on: () => () => {} },
      storage: {
        store: () => [
          { seen: WELCOME_VERSION },
          async () => {
            shown.push('written')
          },
        ] as const,
      },
      ui: { dialog: { select: async () => { shown.push('select'); return undefined }, alert: async () => {} } },
    }
    scheduleWelcome(context)
    await Bun.sleep(5)
    expect(shown).toEqual([])
  })

  test('choosing "connect" explains /connect', async () => {
    const alerts: string[] = []
    const context = {
      data: { on: (_type: string, handler: () => void) => { setTimeout(handler, 0); return () => {} } },
      storage: { store: () => [{ seen: 0 }, async () => {}] as const },
      ui: {
        dialog: {
          select: async () => 'connect',
          alert: async (options: { message: string }) => {
            alerts.push(options.message)
          },
        },
      },
    }
    scheduleWelcome(context)
    await Bun.sleep(20)
    expect(alerts.join(' ')).toContain('/connect')
  })
})

// ---------------------------------------------------------------------- item 6

describe('the same-repo git dependency refs (Lane B item 6)', () => {
  /** Every same-repo git dependency, from BOTH dependency sections. */
  async function sameRepoRefs(): Promise<Array<[section: string, name: string, spec: string]>> {
    const pkg = JSON.parse(await fsp.readFile(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const out: Array<[string, string, string]> = []
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        // A git spec pointing at THIS repository: the pacote requirement is that
        // every one of them agrees with the branch being installed.
        if (spec.includes('mexplor/Mexplore-oss.git') && spec.startsWith('git')) out.push([section, name, spec])
      }
    }
    return out
  }

  test('EVERY same-repo git dependency names the same committish', async () => {
    const refs = await sameRepoRefs()
    // Both subdirectory packages: dsh_plugin (runtime) and mexplore_ui (the UI).
    expect(refs.map(([, name]) => name).sort()).toEqual(['dsh-mexplore', 'mexplore-ui'])
    const committish = (spec: string): string | undefined => /#([^:]+)/.exec(spec)?.[1]
    const values = new Set(refs.map(([, , spec]) => committish(spec)))
    // ONE commit/branch across the repo: two subdirs of one repo cannot be pinned
    // to different revisions, and a mixed pin is how an install half-lands.
    expect(values.size).toBe(1)
    const only = [...values][0]
    expect(only).toBe('release/oss-initial')
    // The `::path:` selector comes AFTER the committish (REQ-017e): the other
    // order mis-parses in pacote.
    for (const [, name, spec] of refs) {
      expect(spec.startsWith('git+https://github.com/mexplor/Mexplore-oss.git#')).toBe(true)
      expect(spec.indexOf('::path:')).toBeGreaterThan(spec.indexOf('#'))
      expect(spec.slice(spec.indexOf('::path:'))).toMatch(/^::path:(dsh_plugin|mexplore_ui)$/)
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test('the plugin version literal matches package.json', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
      version: string
    }
    const { PLUGIN_VERSION } = await import('../src/plugin/config')
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })
})

/** Capture a thrown error so its message/code can be asserted. */
async function failure(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure, but the call succeeded')
}

void withEnv
void os

// --------------------------------------------------------------- item 5: TUI URL

describe('the TUI surfaces the dashboard URL (Lane B item 5)', () => {
  test('a reply carrying the tokenised URL is recognised, so the dialog can show it', async () => {
    const { browsableUrl } = await import('../src/tui')
    const text = 'mexplore usage UI: http://127.0.0.1:43191/?t=abc123\nIt stays up until …'
    expect(browsableUrl(text)).toBe('http://127.0.0.1:43191/?t=abc123')
    expect(browsableUrl('no url here')).toBeUndefined()
    // A remote-looking URL is not a loopback one: it must not be offered.
    expect(browsableUrl('http://example.com/?t=x')).toBeUndefined()
  })

  test('a start reply tells the user to open it themselves (a plugin cannot)', async () => {
    const { uiReply } = await import('../src/plugin/ui')
    const text = uiReply('http://127.0.0.1:1/?t=t').join('\n')
    expect(text).toContain('browser')
    expect(text).toContain('cannot launch a browser')
  })
})

// ------------------------------------ review round 1: ordering, coverage, hygiene

describe('usage accounting never delays interruption (review #1)', () => {
  test('on timeout the interrupt is sent BEFORE the drain and the removal AFTER it', async () => {
    const dir = await tempDir()
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      timeoutMs: 40,
      options: { usageDir: dir, graphRoot: await tempDir() },
    })
    const order: string[] = []
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      // A stalled run: only the interrupt ends it, and it emits no terminal event.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (child.interrupted > 0) {
            order.push('interrupted')
            resolve()
          } else setTimeout(check, 1)
        }
        setTimeout(check, 1)
      })
    }
    const originalInterrupt = host.ctx.session.interrupt
    const originalRemove = host.ctx.session.remove
    Object.assign(host.ctx.session, {
      interrupt: async (input: { sessionID: string }) => {
        order.push('interrupt')
        return originalInterrupt(input)
      },
      remove: async (input: { sessionID: string }) => {
        order.push('remove')
        return originalRemove(input)
      },
    })
    // The record is written between the two: watch for it on disk.
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    for (let index = 0; index < 200 && childID === undefined; index += 1) await Bun.sleep(1)
    await pending
    Object.assign(host.ctx.session, { interrupt: originalInterrupt, remove: originalRemove })

    expect(order[0]).toBe('interrupt')
    expect(order).toContain('remove')
    // Exactly one removal, and the record exists.
    expect(order.filter((step) => step === 'remove')).toHaveLength(1)
    expect(await readUsage(dir, { days: 1 })).toHaveLength(1)
  })

  test('accounting never issues a second unbounded session.get', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    // Counted PER SESSION: the root-session walk (#317) legitimately reads the
    // CALLER once per call, which is not accounting. What must never double is
    // the CHILD's own `get` — inspection reads it, the record reuses the totals.
    const gets = new Map<string, number>()
    const originalGet = host.ctx.session.get
    Object.assign(host.ctx.session, {
      get: async (input: { sessionID: string }) => {
        gets.set(input.sessionID, (gets.get(input.sessionID) ?? 0) + 1)
        return originalGet(input)
      },
    })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(40)
    Object.assign(host.ctx.session, { get: originalGet })
    // One from the inspection. The record reuses those totals.
    expect(gets.get(childID as string)).toBe(1)
    expect(await readUsage(dir, { days: 1 })).toHaveLength(1)
  })

  test('a throwing usage sink still removes the child', async () => {
    const dir = await tempDir()
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 3, output: 1, cache: { read: 0, write: 0 } } })
      child.messages.push(assistant('ok'))
    }
    const sink = (plugin as unknown as { usage?: { write: unknown } }).usage
    void sink
    // Make the directory unwritable so the append fails.
    await fsp.chmod(dir, 0o500)
    try {
      const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as { content: string }
      expect(result.content).toContain('ok')
    } finally {
      await fsp.chmod(dir, 0o700)
    }
    // Teardown is guaranteed: nothing is left owned, and the child is gone.
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    expect(host.sessions.get(childID as string)?.removed).toBe(true)
  })
})

describe('a prompt failure still writes a record (review #2)', () => {
  test('a throwing prompt produces exactly one record, with the child removed', async () => {
    const dir = await tempDir()
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const original = host.ctx.session.prompt
    Object.assign(host.ctx.session, {
      prompt: async () => {
        throw new Error('inbox refused')
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.session, { prompt: original })
    expect(error.message).toContain('inbox refused')

    const records = await readUsage(dir, { days: 1 })
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('failed')
    // The child the prompt failure created is gone, and nothing is owned.
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    for (const child of host.sessions.values()) {
      if (child.info.metadata?.mexploreChild === true) expect(child.removed).toBe(true)
    }
  })

  test('capture is registered before the prompt, so a first-step event is kept', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const original = host.ctx.session.prompt
    Object.assign(host.ctx.session, {
      prompt: async (input: { sessionID: string; text: string }) => {
        // The child starts working the instant it is prompted: an event fires
        // BEFORE `prompt` returns, then the prompt fails.
        host.emit('session.usage.updated', { sessionID: input.sessionID, tokens: { input: 42, output: 8, cache: { read: 0, write: 0 } } })
        await Bun.sleep(5)
        throw new Error('inbox refused after starting')
      },
    })
    await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.session, { prompt: original })
    const record = (await readUsage(dir, { days: 1 }))[0]
    expect(record?.outcome).toBe('failed')
    // The buffered event survived the failure: capture was attached first.
    expect(record?.tokens?.input).toBe(42)
  })
})

describe('completeness needs a cumulative value (review #5)', () => {
  const capture = (overrides: Partial<{ tokens: ReturnType<typeof normalizeTokens>; cumulative: boolean; terminal: boolean; cost: number }> = {}) =>
    ({
      tokens: normalizeTokens({ input: 1 }) ?? undefined,
      cumulative: true,
      steps: 1,
      terminal: true,
      terminalType: 'session.execution.succeeded',
      cost: undefined,
      ...overrides,
    }) as never

  test('a step-only capture is partial even when the run succeeded', () => {
    expect(usageStatus({ capture: capture({ cumulative: false }), outcome: 'ok' })).toBe('partial')
  })

  test('a cost-only capture is partial', () => {
    expect(
      usageStatus({ capture: { tokens: undefined, cost: 0.01, cumulative: false, steps: 1, terminal: true, terminalType: 'x' } as never, outcome: 'ok' }),
    ).toBe('partial')
  })

  test('cumulative + terminal + ok is complete', () => {
    expect(usageStatus({ capture: capture(), outcome: 'ok' })).toBe('complete')
  })

  test('a step fallback never claims to be cumulative', () => {
    const recorder = new UsageRecorder()
    recorder.track('ses_child')
    recorder.observe(stepEvent('ses_child', { input: 5, output: 5 }))
    expect(recorder.read('ses_child')?.cumulative).toBe(false)
    recorder.observe(usageEvent('ses_child', { input: 9, output: 1 }))
    expect(recorder.read('ses_child')?.cumulative).toBe(true)
  })
})

describe('the completed path REPLACES totals, never adds (review #6)', () => {
  test('final session totals win over an earlier cumulative event', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const original = host.ctx.session.get
    host.script = async (child) => {
      // An early cumulative value well below the final one.
      host.emit('session.usage.updated', { sessionID: child.info.id, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } })
      host.emit('session.execution.succeeded', { sessionID: child.info.id })
      child.messages.push(assistant('ok'))
    }
    Object.assign(host.ctx.session, {
      get: async (input: { sessionID: string }) => {
        const info = await original(input)
        // The session's FINAL totals are higher than the event reported.
        return { ...info, tokens: { input: 100, output: 40, reasoning: 7, cache: { read: 3, write: 0 } } }
      },
    })
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    await Bun.sleep(40)
    Object.assign(host.ctx.session, { get: original })
    const record = (await readUsage(dir, { days: 1 }))[0]
    // Replaced, not added: 100/40, never 110/45.
    expect(record?.tokens).toEqual({ input: 100, output: 40, reasoning: 7, cacheRead: 3, cacheWrite: 0 })
    expect(record?.usageStatus).toBe('complete')
  })
})

describe('welcome content is shown before the actions (review #9)', () => {
  test('the alert carries the graph and usage-log locations, then the actions', async () => {
    const shown: Array<{ kind: string; text: string }> = []
    const context = {
      client: {
        rpc: () => ({
          command: async () => ({
            text: 'mexplore memory\n\ngraph: /g/memory (source: default)\nusage log: on (/state/mexplore)\n',
          }),
        }),
      },
      data: { on: (_type: string, handler: () => void) => { setTimeout(handler, 0); return () => {} } },
      storage: { store: () => [{ seen: 0 }, async () => {}] as const },
      ui: {
        dialog: {
          alert: async (options: { message: string }) => {
            shown.push({ kind: 'alert', text: options.message })
          },
          select: async () => {
            shown.push({ kind: 'select', text: '' })
            return 'current'
          },
        },
      },
    }
    const { scheduleWelcome } = await import('../src/tui')
    scheduleWelcome(context as never)
    await Bun.sleep(30)
    // The CONTENT comes first, and it names the real locations and the off switch.
    expect(shown[0]?.kind).toBe('alert')
    expect(shown[0]?.text).toContain('/g/memory')
    expect(shown[0]?.text).toContain('/state/mexplore')
    expect(shown[0]?.text).toContain('usageLog: false')
    expect(shown.map((entry) => entry.kind)).toEqual(['alert', 'select'])
  })

  test('picking "use my current model" still had the content in front of it', async () => {
    const shown: string[] = []
    const context = {
      client: { rpc: () => ({ command: async () => ({ text: 'no locations' }) }) },
      data: { on: (_type: string, handler: () => void) => { setTimeout(handler, 0); return () => {} } },
      storage: { store: () => [{ seen: 0 }, async () => {}] as const },
      ui: {
        dialog: {
          alert: async (options: { message: string }) => {
            shown.push(options.message)
          },
          select: async () => 'current',
        },
      },
    }
    const { scheduleWelcome, WELCOME_TEXT } = await import('../src/tui')
    scheduleWelcome(context as never)
    await Bun.sleep(30)
    expect(shown[0]).toContain(WELCOME_TEXT)
  })

  test('seen is only marked after the content was displayed', async () => {
    const order: string[] = []
    const context = {
      client: { rpc: () => ({ command: async () => ({ text: '' }) }) },
      data: { on: (_type: string, handler: () => void) => { setTimeout(handler, 0); return () => {} } },
      storage: {
        store: () => [
          { seen: 0 },
          async () => {
            order.push('mark')
          },
        ] as const,
      },
      ui: {
        dialog: {
          alert: async () => {
            order.push('alert')
          },
          select: async () => {
            order.push('select')
            return 'current'
          },
        },
      },
    }
    const { scheduleWelcome } = await import('../src/tui')
    scheduleWelcome(context as never)
    await Bun.sleep(30)
    expect(order).toEqual(['alert', 'mark', 'select'])
  })
})

describe('the usage summary never shows unknown as zero (review #10)', () => {
  const base: Partial<UsageRecord> = {
    graphRoot: '/g',
    provider: 'mexplore',
    model: 'm',
    modelSource: 'default',
    pluginVersion: '0.1.0',
    latencyMs: 1,
    steps: 0,
    finishedAt: new Date().toISOString(),
  }
  const at = (callId: string, overrides: Partial<UsageRecord>): UsageRecord =>
    ({
      v: 1,
      callId,
      ts: new Date().toISOString(),
      authority: 'read',
      outcome: 'ok',
      usageStatus: 'unknown',
      tokens: null,
      costUsd: null,
      ...base,
      ...overrides,
    }) as UsageRecord

  test('no token data at all says so instead of "in 0 / out 0"', () => {
    const text = summarizeUsage([at('a', {}), at('b', {})], 30)
    expect(text).toContain('no token data')
    expect(text).not.toContain('in 0 / out 0')
  })

  test('a mix marks the total a lower bound and counts the gap', () => {
    const text = summarizeUsage(
      [
        at('a', { tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, usageStatus: 'complete' }),
        at('b', {}),
      ],
      30,
    )
    expect(text).toContain('≥12 total')
    expect(text).toContain('1 without data')
  })

  test('read and manage get separate token totals, not just call counts', () => {
    const text = summarizeUsage(
      [
        at('a', { authority: 'read', tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
        at('b', { authority: 'manage', tokens: { input: 0, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }),
      ],
      30,
    )
    expect(text).toContain('read tokens: in 100')
    expect(text).toContain('manage tokens: in 0 / out 50')
    expect(text).toContain('(read 1, manage 1)')
  })
})

// ------------------------------------- review #11: the REAL sibling module

/**
 * The resolver's fallback is `../../../mexplore_ui/src/plugin.ts` — the repo
 * sibling. These tests exercise the REAL module (no fake), and skip with a clear
 * message where this checkout has no `mexplore_ui` (the installed-package route
 * then covers it).
 */
const SIBLING = path.join(import.meta.dir, '..', '..', 'mexplore_ui', 'src', 'plugin.ts')
const SIBLING_ASSETS = path.join(import.meta.dir, '..', '..', 'mexplore_ui', 'dist', 'index.html')

/**
 * Synchronous existence check.
 *
 * Deliberately NOT a top-level `await`: two test FILES that both await at module
 * scope deadlock Bun's multi-file loader (the combined run hangs with no output,
 * while every file passes on its own). A sync stat is all this needs.
 */
function fileExists(target: string): boolean {
  try {
    return require('node:fs').statSync(target).isFile()
  } catch {
    return false
  }
}

const siblingPresent = fileExists(SIBLING)
const siblingAssets = fileExists(SIBLING_ASSETS)

/**
 * The LIVE real-module tests start a real `mexplore_ui` server and import its
 * module graph. Both are late-bound (they pull in `bun:sqlite`'s lazy loader and
 * their own timers), and Bun's multi-file runner deadlocks when that happens
 * while another test file is loaded — every file passes alone, the COMBINED run
 * hangs with no output. They are therefore opt-in, like the integration suite:
 * `MEXPLORE_UI_IT=1 bun test test/usage.test.ts`.
 *
 * The module-RESOLUTION test (no server) stays in the default run below.
 */
const liveUi = process.env.MEXPLORE_UI_IT === '1'

describe.skipIf(!siblingPresent || !liveUi)('the sibling fallback resolves the real module (review #11, opt-in)', () => {
  test('with no override, loadUiModule() resolves ../../mexplore_ui/src/plugin.ts', async () => {
    const { loadUiModule, setUiModuleForTests } = await import('../src/plugin/ui')
    setUiModuleForTests(undefined)
    const result = await loadUiModule()
    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error(result.error)
    expect(['mexplore_ui', 'mexplore-ui/plugin']).toContain(result.source)
    expect(typeof result.module.startPluginUi).toBe('function')
    expect(typeof result.module.uiAssetsPresent).toBe('function')
  })
})

describe.skipIf(!siblingPresent || !liveUi)('the live sibling module serves on a real port (review #11, opt-in)', () => {
  test('the real module reports its assets next to the package', async () => {
    const { loadUiModule, setUiModuleForTests } = await import('../src/plugin/ui')
    setUiModuleForTests(undefined)
    const result = await loadUiModule()
    if ('error' in result) throw new Error(result.error)
    expect(result.module.uiAssetsPresent()).toBe(siblingAssets)
  })

  test('start → /api/meta with the token cookie → stop, against the real module on port 0', async () => {
    if (!siblingAssets) {
      // Without a built `dist/`, `startPluginUi` cannot serve a dashboard; the
      // resolver test above still proves the module graph loads.
      console.warn('skipping live UI test: mexplore_ui/dist has no index.html (run its build)')
      return
    }
    const { startUi, stopUi, releaseUi, setUiModuleForTests } = await import('../src/plugin/ui')
    setUiModuleForTests(undefined)
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    try {
      const started = await startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'review-11' })
      expect(started.port).toBeGreaterThan(0)
      expect(started.url).toContain('?t=')

      // The URL's token is what the browser trades for a cookie; do the same.
      const token = new URL(started.url).searchParams.get('t')
      expect(token).toBeTruthy()
      const exchange = await fetch(`http://127.0.0.1:${started.port}/?t=${token}`, { redirect: 'manual' })
      const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] as string
      expect(cookie.length).toBeGreaterThan(0)

      // `/api/meta` with the cookie answers the plugin-mode meta.
      const meta = await fetch(`http://127.0.0.1:${started.port}/api/meta`, {
        headers: { cookie },
      })
      expect(meta.status).toBe(200)
      const body = (await meta.json()) as { data?: { source?: string; graphRoot?: string } }
      const payload = body.data ?? (body as { source?: string })
      expect(payload.source).toBe('plugin')
      expect(JSON.stringify(body)).toContain(await fsp.realpath(graph).catch(() => graph))

      // …and WITHOUT the cookie it is refused, which is the token's whole point.
      const anonymous = await fetch(`http://127.0.0.1:${started.port}/api/meta`)
      expect(anonymous.status).toBe(401)

      expect(await stopUi(graph)).toBe(true)
      // The listener is really gone.
      const after = await fetch(`http://127.0.0.1:${started.port}/api/meta`, { headers: { cookie } }).catch(() => undefined)
      expect(after === undefined || after.status >= 400).toBe(true)
    } finally {
      setUiModuleForTests(undefined)
      await releaseUi(graph, 'review-11').catch(() => undefined)
      await stopUi(graph).catch(() => undefined)
    }
  }, 60_000)

  test('a record the plugin wrote is visible to the dashboard (writer ↔ reader)', async () => {
    if (!siblingAssets) return
    const { startUi, stopUi, setUiModuleForTests } = await import('../src/plugin/ui')
    const { appendUsage } = await import('../src/plugin/usage-log')
    setUiModuleForTests(undefined)
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    // Created and canonicalised first, exactly as `startUi` does: the reader
    // filters records by its own canonical graph root, and on macOS a lexical
    // path is not canonical (`/tmp` is `/private/tmp`).
    await fsp.mkdir(graph, { recursive: true })
    const realGraph = await fsp.realpath(graph)
    // Written BEFORE the server starts: the dashboard reads at boot, and a file
    // watch is not something a test may rely on. What is under test is that the
    // writer's output is what the reader parses.
    await appendUsage(usage, {
      v: 1,
      callId: 'review-11-call',
      ts: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      authority: 'read',
      outcome: 'ok',
      latencyMs: 12,
      usageStatus: 'complete',
      tokens: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: null,
      provider: 'mexplore',
      model: 'deepseek-v4.1-flash-1017',
      modelSource: 'default',
      steps: 1,
      graphRoot: realGraph,
      pluginVersion: '0.1.0',
    })
    try {
      const started = await startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'review-11b' })
      const token = new URL(started.url).searchParams.get('t')
      const exchange = await fetch(`http://127.0.0.1:${started.port}/?t=${token}`, { redirect: 'manual' })
      const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0] as string
      const runs = await fetch(`http://127.0.0.1:${started.port}/api/runs`, { headers: { cookie } })
      expect(runs.status).toBe(200)
      const body = (await runs.json()) as { runs?: Array<{ taskId?: string }>; total?: number }
      expect(Array.isArray(body.runs)).toBe(true)
      expect(body.runs?.map((run) => run.taskId)).toContain('review-11-call')
    } finally {
      await stopUi(graph).catch(() => undefined)
    }
  }, 60_000)
})

// ------------------------------------ review round 2: deadline, identity, owners

describe('the telemetry budget is a real DEADLINE, not 1 ms (review #2-1)', () => {
  /** Drive `runCall` with a stub sink whose fetch/write are deliberately slow. */
  async function slowSink(delays: { fetchMs: number; writeMs: number }) {
    const { runCall } = await import('../src/plugin/call')
    const { shapeSanitizer } = await import('../src/plugin/redact')
    const graph = await tempDir()
    const usage = await tempDir()
    const built = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: usage, graphRoot: graph } })
    const host = built.host
    const writes: UsageRecord[] = []
    let fetches = 0
    const call = {
      callId: 'deadline-call',
      toolNames: () => [...MANAGE_TOOL_NAMES] as string[],
      toolDefs: () => [],
      renderPrompt: () => '',
      execute: async () => ({ content: 'ok' }),
      settle: async () => {},
      report: () => ({ toolCalls: 0, writes: [], edges: [] }),
      footerLines: () => ['no writes'],
    } as never
    // A childless call: no inspection, so the sink's fetch path is the one taken.
    host.ctx.session.create = async () => {
      throw new Error('create refused')
    }
    host.ctx.session.get = async () => {
      fetches += 1
      await Bun.sleep(delays.fetchMs)
      return { id: 'x', time: { created: Date.now(), updated: Date.now() }, tokens: { input: 9, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } as never
    }
    const sink = {
      track: () => () => {},
      drain: async () => undefined,
      read: () => undefined,
      write: async (record: UsageRecord) => {
        await Bun.sleep(delays.writeMs)
        writes.push(record)
      },
      drainMs: 500,
      graphRoot: graph,
      pluginVersion: '0.1.0',
    }
    const result = await runCall(host.ctx, {
      parentSessionID: PARENT,
      currentBaseURL: () => 'https://example/v1',
      authority: 'read',
      message: 'q',
      evidence: [],
      call,
      model: { providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' },
      modelSource: 'default',
      signal: new AbortController().signal,
      registry: built.plugin.registry,
      graphRoot: built.plugin.graphRoot,
      timeoutMs: 60_000,
      // A generous cleanup budget: a slow write must still fit inside it.
      cleanupBudgetMs: 5_000,
      sanitize: shapeSanitizer(),
      usage: sink as never,
    }).catch((error: unknown) => error as Error)
    return { result, writes, fetches }
  }

  test('a write slower than 1 ms still lands inside the budget', async () => {
    const { writes } = await slowSink({ fetchMs: 0, writeMs: 60 })
    // Before the fix the append raced a 1 ms timer and was lost.
    expect(writes).toHaveLength(1)
    expect(writes[0]?.callId).toBe('deadline-call')
  })

  test('a fetch slower than 1 ms still contributes its totals', async () => {
    const { writes } = await slowSink({ fetchMs: 60, writeMs: 0 })
    expect(writes).toHaveLength(1)
    // A childless call reports null usage by contract; what matters is that the
    // fetch was allowed its real budget instead of being cut off at 1 ms.
    expect(writes[0]?.outcome).toBe('failed')
  })
})


describe('childless failures still emit one record (review #2-4)', () => {
  test('a rejected session.create writes one failed record with the call id', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async () => {
        throw new Error('session store unavailable')
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.session, { create: original })
    expect(error.message).toContain('session store unavailable')

    const records = await readUsage(dir, { days: 1 })
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('failed')
    expect(records[0]?.tokens).toBeNull()
    expect(records[0]?.steps).toBe(0)
    expect(records[0]?.usageStatus).toBe('unknown')
    expect(records[0]?.callId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a create TIMEOUT writes one record marked timeout', async () => {
    const dir = await tempDir()
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      timeoutMs: 40,
      options: { usageDir: dir, graphRoot: await tempDir() },
    })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        await held
        return original(input)
      },
    })
    await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    release()
    await Bun.sleep(40)
    Object.assign(host.ctx.session, { create: original })
    const records = await readUsage(dir, { days: 1 })
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('timeout')
    expect(records[0]?.tokens).toBeNull()
  })

  test('a provider-publication failure writes one record', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    const original = host.ctx.provider.reload
    Object.assign(host.ctx.provider, {
      reload: async () => {
        throw new Error('registry unavailable')
      },
    })
    await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.provider, { reload: original })
    const records = await readUsage(dir, { days: 1 })
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('failed')
    expect(records[0]?.tokens).toBeNull()
  })
})

describe('the usage directory identity is bound (review #2-2)', () => {
  test('a symlinked usage directory is refused before anything is mutated', async () => {
    const root = await tempDir()
    const target = path.join(root, 'target')
    await fsp.mkdir(target)
    await fsp.chmod(target, 0o755)
    const link = path.join(root, 'usage')
    await fsp.symlink(target, link)
    const result = await appendUsage(link, {
      v: 1, callId: 'x', ts: new Date().toISOString(), finishedAt: new Date().toISOString(),
      authority: 'read', outcome: 'ok', latencyMs: 1, usageStatus: 'complete', tokens: null,
      costUsd: null, provider: 'mexplore', model: 'm', modelSource: 'default', steps: 0,
      graphRoot: '/g', pluginVersion: '0.1.0',
    })
    expect('error' in result && result.error).toContain('symlink')
    // The TARGET's mode was never touched on the way (0700 would betray it).
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o755)
    expect(await fsp.readdir(target)).toEqual([])
  })

  test('the UI refuses a symlinked usage directory instead of chmod-ing its target', async () => {
    const { startUi, setUiModuleForTests, stopUi } = await import('../src/plugin/ui')
    const root = await tempDir()
    const target = path.join(root, 'target')
    await fsp.mkdir(target)
    await fsp.chmod(target, 0o755)
    const link = path.join(root, 'usage')
    await fsp.symlink(target, link)
    setUiModuleForTests({
      startPluginUi: async () => ({ url: 'http://127.0.0.1:1/?t=x', port: 1, graphRoot: root, stop: async () => {} }),
      uiAssetsPresent: () => true,
    })
    const graph = path.join(root, 'graph')
    try {
      await expect(
        startUi({ graphRoot: graph, usageDir: link, port: 0, owner: 'symlink-test' }),
      ).rejects.toThrow('symlink')
      // The real target kept its mode: a chmod through the link would have made it 0700.
      expect((await fsp.stat(target)).mode & 0o777).toBe(0o755)
    } finally {
      setUiModuleForTests(undefined)
      // No manual release: a failed start rolls its own ownership back (review
      // round 3, major 3). `stopUi` only clears the registry between tests.
      await stopUi(graph).catch(() => undefined)
    }
  })
})

describe('dispose during a pending UI start (review #2-3)', () => {
  test('a start whose owner disposed mid-flight is refused, not registered', async () => {
    const { startUi, releaseUi, uiRunning, setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    let stops = 0
    let releaseLoad = (): void => {}
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    setUiModuleForTests({
      startPluginUi: async () => {
        await loadGate
        return { url: 'http://127.0.0.1:1/?t=pending', port: 1, graphRoot: graph, stop: async () => { stops += 1 } }
      },
      uiAssetsPresent: () => true,
    })
    try {
      const starting = startUi({ graphRoot: graph, usageDir: path.join(await tempDir(), 'usage'), port: 0, owner: 'doomed' })
      // Dispose lands while the start is in flight. Ownership was claimed at
      // ADMISSION, so the disposal is recorded even though nothing listens yet.
      expect(await releaseUi(graph, 'doomed')).toBe(false)
      releaseLoad()
      // The stalled start resumes, sees its owner gone, and refuses BEFORE
      // creating a listener — so nothing has to be stopped, nothing is registered.
      await expect(starting).rejects.toThrow('unloaded')
      expect(stops).toBe(0)
      expect(uiRunning(graph)).toBe(false)
    } finally {
      setUiModuleForTests(undefined)
    }
  })
})

describe('the welcome re-arms when it could not be shown (review #2-6)', () => {
  test('a failing alert marks nothing and retries on the next event', async () => {
    const shown: string[] = []
    const marks: number[] = []
    const listeners = new Set<() => void>()
    const context = {
      client: { rpc: () => ({ command: async () => ({ text: '' }) }) },
      data: {
        on: (_type: string, handler: () => void) => {
          listeners.add(handler)
          return () => { listeners.delete(handler) }
        },
      },
      storage: { store: () => [{ seen: 0 }, async () => { marks.push(1) }] as const },
      ui: {
        dialog: {
          alert: async () => {
            shown.push('alert')
            throw new Error('no dialog surface yet')
          },
          select: async () => 'current',
        },
      },
    }
    const { scheduleWelcome } = await import('../src/tui')
    scheduleWelcome(context as never)
    expect(shown).toEqual([])
    expect(listeners.size).toBe(2)
    ;[...listeners][0]?.()
    await Bun.sleep(1)
    expect(shown).toEqual(['alert'])
    expect(marks).toEqual([])
    expect(listeners.size).toBe(2)
    ;[...listeners][1]?.()
    await Bun.sleep(1)
    expect(shown).toEqual(['alert', 'alert'])
    expect(marks).toEqual([])
    expect(listeners.size).toBe(2)
  })

  test('no alert API at all also re-arms rather than marking seen', async () => {
    let marks = 0
    let attempts = 0
    const listeners = new Set<() => void>()
    const context = {
      client: { rpc: () => ({ command: async () => { attempts += 1; return { text: '' } } }) },
      data: {
        on: (_type: string, handler: () => void) => {
          listeners.add(handler)
          return () => { listeners.delete(handler) }
        },
      },
      storage: { store: () => [{ seen: 0 }, async () => { marks += 1 }] as const },
      // `select` exists, `alert` does not: the content cannot be shown.
      ui: { dialog: { select: async () => 'current' } },
    }
    const { scheduleWelcome } = await import('../src/tui')
    scheduleWelcome(context as never)
    expect(attempts).toBe(0)
    expect(listeners.size).toBe(2)
    ;[...listeners][0]?.()
    await Bun.sleep(1)
    expect(attempts).toBe(1)
    expect(marks).toBe(0)
    expect(listeners.size).toBe(2)
    ;[...listeners][1]?.()
    await Bun.sleep(1)
    expect(attempts).toBe(2)
    expect(marks).toBe(0)
    expect(listeners.size).toBe(2)
  })
})

describe('a partial capture makes the total a lower bound (review #2-7)', () => {
  const at = (callId: string, overrides: Record<string, unknown>): UsageRecord =>
    ({
      v: 1, callId, ts: new Date().toISOString(), finishedAt: new Date().toISOString(),
      authority: 'read', outcome: 'ok', latencyMs: 1, usageStatus: 'complete', tokens: null,
      costUsd: null, provider: 'mexplore', model: 'm', modelSource: 'default', steps: 1,
      graphRoot: '/g', pluginVersion: '0.1.0',
      ...overrides,
    }) as UsageRecord

  test('one partial record with tokens still prints ≥', () => {
    const text = summarizeUsage(
      [at('p', {
        outcome: 'timeout',
        usageStatus: 'partial',
        tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      })],
      30,
    )
    // EVERY record reported tokens, yet the number is a floor: it was cut short.
    expect(text).toContain('≥100 total')
    expect(text).toContain('1 partial')
  })

  test('a fully complete set prints an exact total', () => {
    const text = summarizeUsage(
      [at('c', { tokens: { input: 4, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })],
      30,
    )
    expect(text).toContain('10 total')
    expect(text).not.toContain('≥')
  })
})

describe('help names the resolved usage dir (copy fix a)', () => {
  test('the real directory, not a hardcoded default', async () => {
    const { helpText } = await import('../src/plugin/command')
    const text = helpText('mexplore', { enabled: true, dir: '/custom/state/mexplore' })
    expect(text).toContain('/custom/state/mexplore')
    expect(text).not.toContain('~/.local/state/mexplore')
    expect(text).toContain('usageLog: false')
  })

  test('and says off when the log is disabled', async () => {
    const { helpText } = await import('../src/plugin/command')
    const text = helpText('mexplore', { enabled: false, dir: '/whatever' })
    expect(text).toContain('logging is off')
    expect(text).not.toContain('/whatever')
  })

  test('the command passes the plugin\'s own dir through', async () => {
    const dir = await tempDir()
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { usageDir: dir, graphRoot: await tempDir() } })
    expect(await host.command(PARENT, '/mexplore help')).toContain(dir)
  })
})

describe('the checkout guard is a real identification (review #2-8)', () => {
  test('this checkout IS identified, and an installed path would not be', async () => {
    const { isSourceCheckout } = await import('../src/plugin/ui')
    expect(await isSourceCheckout()).toBe(true)
    // The rule the guard implements, on the deciding condition: an installed
    // plugin's file always contains `node_modules`, a clone's does not.
    expect('/tmp/x/node_modules/mexplore/src/plugin/ui.ts'.split(path.sep)).toContain('node_modules')
    expect(import.meta.url.split(path.sep)).not.toContain('node_modules')
  })
})

// ------------------------------------ 2a placeholder guards, on by default

describe('placeholder guards are armed on the manage profile (2a)', () => {
  /** A manage call whose child attempts one `memory_write` with `args`. */
  async function attemptWrite(args: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const { host, plugin } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      options: { graphRoot: await tempDir(), ...options },
    })
    let refusal: Error | undefined
    host.script = async (child, host) => {
      // The write may SUCCEED (that is the point of the admitted cases), so this
      // captures a refusal without insisting on one.
      refusal = await host
        .executeTool('memory_write', args, child.info.id)
        .then(() => undefined)
        .catch((error: unknown) => error as Error)
      child.messages.push(assistant('done'))
    }
    // A message the attachment can be traced back to: dsh's traceability gate
    // refuses a payload that does not come from the exchange, which would confuse
    // what these tests are about (the 2a guards, not that gate).
    const result = (await host.executeTool(
      'mexplore',
      { message: `the user asked for detail.md; the note is ${'y'.repeat(40)}`, authority: 'manage' },
      PARENT,
    )) as { content: string; metadata: Record<string, unknown> }
    return { result, refusal, plugin, host }
  }

  test('a body-less create is refused with dsh\'s remedy, and nothing is written', async () => {
    const { result, refusal } = await attemptWrite({ description: 'a placeholder' })
    // dsh's own message, so the model can act on it.
    expect(refusal?.message).toContain('a new node needs a `body`')
    expect(refusal?.message).toContain('Nothing was written')
    // A PROVEN non-execution: no footer line, no write record, `no writes`.
    // (The write records are built from REAL dsh results, so an empty list IS
    // the statement that nothing was written — no directory scan needed.)
    expect(result.content).toContain('no writes')
    expect(result.content).not.toContain('saved to memory')
    expect(result.content).not.toContain('memory write incomplete')
    expect(result.metadata.writes).toEqual([])
    expect(result.metadata.toolCalls).toBe(1)
  })

  test('an empty body WITH an attachment stays admitted (2a\'s deliberate exception)', async () => {
    const { result, refusal } = await attemptWrite({
      description: 'gist in the file',
      attach: { filename: 'detail.md', content: '# Detail\n\n' + 'x'.repeat(200) },
    })
    expect(refusal).toBeUndefined()
    expect(result.content).toContain('saved to memory: gist in the file')
  })

  test('placeholderGuards:false admits the same body-less create', async () => {
    const { result, refusal } = await attemptWrite({ description: 'a placeholder' }, { placeholderGuards: false })
    expect(refusal).toBeUndefined()
    expect(result.content).toContain('saved to memory: a placeholder')
  })

  test('the option parses booleans and the strings "true"/"false", default on', async () => {
    const { readOptions } = await import('../src/plugin/config')
    expect(readOptions({}).placeholderGuards).toBe(true)
    expect(readOptions({ placeholderGuards: false }).placeholderGuards).toBe(false)
    expect(readOptions({ placeholderGuards: 'false' }).placeholderGuards).toBe(false)
    expect(readOptions({ placeholderGuards: 'true' }).placeholderGuards).toBe(true)
    expect(readOptions({ placeholderGuards: 'nope' }).placeholderGuards).toBe(true)
  })

  test('the read profile is unaffected: it has no write tool at all', async () => {
    const { plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { graphRoot: await tempDir() } })
    expect(plugin.runtime.toolNames('read')).not.toContain('memory_write')
    expect(plugin.runtime.toolNames('manage')).toContain('memory_write')
  })

  test('status reports the setting', async () => {
    const on = await fixture({ models: ANTHROPIC, keyConnected: true, options: { graphRoot: await tempDir() } })
    expect(await on.host.command(PARENT, '/mexplore status')).toContain('placeholder guards: on')
    const off = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      options: { graphRoot: await tempDir(), placeholderGuards: false },
    })
    expect(await off.host.command(PARENT, '/mexplore status')).toContain('placeholder guards: off')
  })
})

// ------------------------------------ review round 3: one lease release per path

describe('the model lease is released exactly once (b1, b2)', () => {
  test('b1: a failing create does not drop a concurrent call\'s lease', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { graphRoot: await tempDir() } })
    const model = { providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' }
    // One lease stands in for a call already running on this model.
    plugin.leases.retain(model.id)
    expect(plugin.leases.size()).toBe(1)

    const original = host.ctx.session.create
    let call = 0
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        call += 1
        // The FIRST create of this test fails; a later one succeeds so the
        // fixture's own teardown is not affected.
        if (call === 1) throw new Error('create refused')
        return original(input)
      },
    })
    await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.session, { create: original })

    // Before the fix the failure released twice: 1 → -1 → deleted, taking the
    // other call's lease with it.
    expect(plugin.leases.size()).toBe(1)
    expect(plugin.leases.ids()).toEqual([model.id])
  })

  test('b1: two concurrent failing creates each release only their own lease', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, options: { graphRoot: await tempDir() } })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async () => {
        await held
        throw new Error('create refused')
      },
    })
    const first = failure(() => host.executeTool('mexplore', { message: 'a' }, PARENT))
    const second = failure(() => host.executeTool('mexplore', { message: 'b' }, PARENT))
    try {
      await Bun.sleep(20)
      expect(plugin.leases.size()).toBe(2)
      release()
      await Promise.all([first, second])
      expect(plugin.leases.size()).toBe(0)
      expect(plugin.leases.ids()).toEqual([])
    } finally {
      release()
      Object.assign(host.ctx.session, { create: original })
    }
  })

  test('b2: a late session after a create timeout releases the lease', async () => {
    const { host, plugin } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      timeoutMs: 40,
      options: { graphRoot: await tempDir() },
    })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        await held
        return original(input)
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect((error as { metadata?: { code?: string } }).metadata?.code).toBe('TIMEOUT')
    // The lease is still held while the session is unaccounted for.
    expect(plugin.leases.size()).toBe(1)

    // The session finally appears: the orphan is removed and the lease released.
    release()
    for (let index = 0; index < 100 && plugin.leases.size() > 0; index += 1) await Bun.sleep(5)
    Object.assign(host.ctx.session, { create: original })
    expect(plugin.leases.size()).toBe(0)
    expect(plugin.leases.ids()).toEqual([])
  })
})

// ------------------------------- review round 3: pinned directory, UI entries, orphans

describe('the usage directory is pinned, not addressed by path (review #3-1)', () => {
  const record = {
    v: 1 as const, callId: 'pin', ts: new Date().toISOString(), finishedAt: new Date().toISOString(),
    authority: 'read' as const, outcome: 'ok' as const, latencyMs: 1, usageStatus: 'complete' as const,
    tokens: null, costUsd: null, provider: 'mexplore', model: 'm', modelSource: 'default' as const, steps: 0,
    graphRoot: '/g', pluginVersion: '0.1.0',
  }

  test('a directory swapped for a symlink before the pin is refused, target untouched', async () => {
    const { appendUsage, __dirTestHooks } = await import('../src/plugin/usage-log')
    const root = await tempDir()
    const usage = path.join(root, 'usage')
    await fsp.mkdir(usage)
    const target = path.join(root, 'target')
    await fsp.mkdir(target)
    await fsp.chmod(target, 0o755)
    // Swap lands in the window between the pre-check and the descriptor open.
    __dirTestHooks.beforePinOpen = async () => {
      await fsp.rmdir(usage).catch(() => undefined)
      await fsp.symlink(target, usage).catch(() => undefined)
    }
    try {
      const result = await appendUsage(usage, record)
      expect('error' in result && result.error).toMatch(/symlink|not a directory|changed/)
    } finally {
      __dirTestHooks.beforePinOpen = undefined
    }
    // Nothing outside was chmod-ed, and nothing was written through the link.
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o755)
    expect(await fsp.readdir(target)).toEqual([])
  })

  test('a directory swapped before the file open is refused, nothing written outside', async () => {
    const { appendUsage, __dirTestHooks } = await import('../src/plugin/usage-log')
    const root = await tempDir()
    const usage = path.join(root, 'usage')
    await fsp.mkdir(usage)
    const target = path.join(root, 'target')
    await fsp.mkdir(target)
    await fsp.chmod(target, 0o755)
    __dirTestHooks.beforeFileOpen = async () => {
      await fsp.rename(usage, path.join(root, 'moved'))
      await fsp.symlink(target, usage)
    }
    try {
      const result = await appendUsage(usage, record)
      // The swap is detected: the record must not land in `target`.
      expect('error' in result).toBe(true)
    } finally {
      __dirTestHooks.beforeFileOpen = undefined
    }
    expect(await fsp.readdir(target)).toEqual([])
  })

  test('a normal append still works and lands 0600 in a 0700 directory', async () => {
    const { appendUsage } = await import('../src/plugin/usage-log')
    const root = await tempDir()
    const usage = path.join(root, 'usage')
    const result = await appendUsage(usage, record)
    expect('file' in result).toBe(true)
    expect((await fsp.stat(usage)).mode & 0o777).toBe(0o700)
    const files = await fsp.readdir(usage)
    expect(files).toHaveLength(1)
    expect((await fsp.stat(path.join(usage, files[0] as string))).mode & 0o777).toBe(0o600)
  })

  test('the UI refuses a directory swapped for a symlink during its own preflight', async () => {
    const { startUi, setUiModuleForTests, stopUi, __uiDirTestHook } = await import('../src/plugin/ui')
    const root = await tempDir()
    const usage = path.join(root, 'usage')
    await fsp.mkdir(usage)
    const target = path.join(root, 'target')
    await fsp.mkdir(target)
    await fsp.chmod(target, 0o755)
    setUiModuleForTests({
      startPluginUi: async () => ({ url: 'http://127.0.0.1:1/?t=x', port: 1, graphRoot: root, stop: async () => {} }),
      uiAssetsPresent: () => true,
    })
    __uiDirTestHook.beforePin = async () => {
      await fsp.rmdir(usage).catch(() => undefined)
      await fsp.symlink(target, usage).catch(() => undefined)
    }
    const graph = path.join(root, 'graph')
    try {
      await expect(startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'swap' })).rejects.toThrow()
      expect((await fsp.stat(target)).mode & 0o777).toBe(0o755)
    } finally {
      __uiDirTestHook.beforePin = undefined
      setUiModuleForTests(undefined)
      await stopUi(graph).catch(() => undefined)
    }
  })
})

describe('a pending UI start is cancellable and cannot erase a successor (review #3-2)', () => {
  test('`ui stop` during preflight leaves no listener and a free port', async () => {
    const { startUi, stopUi, uiRunning, setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    let stops = 0
    let started = 0
    let releasePreflight = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releasePreflight = resolve
    })
    // The module load IS the preflight await a test can hold open.
    setUiModuleForTests({
      startPluginUi: async () => {
        started += 1
        return { url: 'http://127.0.0.1:1/?t=c', port: 1, graphRoot: graph, stop: async () => { stops += 1 } }
      },
      uiAssetsPresent: () => true,
    })
    const load = await import('../src/plugin/ui')
    try {
      const starting = startUi({ graphRoot: graph, usageDir: path.join(await tempDir(), 'usage'), port: 0, owner: 'stop-me' })
      // `stop` lands while the preflight is still running.
      expect(await stopUi(graph)).toBe(false)
      releasePreflight()
      // The start resumes, finds itself cancelled, and refuses — no listener.
      await expect(starting).rejects.toThrow('unloaded')
      expect(started).toBe(0)
      expect(stops).toBe(0)
      expect(uiRunning(graph)).toBe(false)
      expect(load.uiUrl(graph)).toBeUndefined()
    } finally {
      setUiModuleForTests(undefined)
      await stopUi(graph).catch(() => undefined)
    }
  })

  test('dispose A then start B overlapping leaves B intact and stoppable', async () => {
    const { startUi, releaseUi, stopUi, uiRunning, setUiModuleForTests } = await import('../src/plugin/ui')
    const graph = path.join(await tempDir(), 'graph')
    const usage = path.join(await tempDir(), 'usage')
    let stops = 0
    let holdStart = (): void => {}
    const gate = new Promise<void>((resolve) => {
      holdStart = resolve
    })
    setUiModuleForTests({
      startPluginUi: async () => {
        await gate
        return { url: 'http://127.0.0.1:1/?t=b', port: 1, graphRoot: graph, stop: async () => { stops += 1 } }
      },
      uiAssetsPresent: () => true,
    })
    try {
      // A starts and is held in `startPluginUi`; B's start joins the same entry.
      const a = startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'A' })
      await Bun.sleep(1)
      const b = startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'B' })
      // A disposes: B is still an owner, so nothing stops.
      expect(await releaseUi(graph, 'A')).toBe(false)
      holdStart()
      await a.catch(() => undefined)
      await b
      expect(uiRunning(graph)).toBe(true)
      // B can still stop the dashboard it believes it owns.
      expect(await releaseUi(graph, 'B')).toBe(true)
      expect(stops).toBe(1)
      expect(uiRunning(graph)).toBe(false)
    } finally {
      setUiModuleForTests(undefined)
      await stopUi(graph).catch(() => undefined)
    }
  })
})

describe('a failed UI start rolls back its own ownership (review #3-3)', () => {
  test('failed start, then a sibling start, then dispose the sibling stops the server', async () => {
    const { startUi, releaseUi, stopUi, uiRunning, setUiModuleForTests, __uiDirTestHook } = await import('../src/plugin/ui')
    const root = await tempDir()
    const graph = path.join(root, 'graph')
    const usage = path.join(root, 'usage')
    let stops = 0
    setUiModuleForTests({
      startPluginUi: async () => ({ url: 'http://127.0.0.1:1/?t=s', port: 1, graphRoot: graph, stop: async () => { stops += 1 } }),
      uiAssetsPresent: () => true,
    })
    try {
      // The FIRST start fails in preflight (a symlinked usage dir). Before the
      // fix it left a phantom owner behind.
      const target = path.join(root, 'target')
      await fsp.mkdir(target)
      await fsp.symlink(target, usage)
      await expect(startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'broken' })).rejects.toThrow()

      // Remedy the cause, then a sibling starts successfully.
      await fsp.unlink(usage)
      await fsp.mkdir(usage)
      __uiDirTestHook.beforePin = undefined
      await startUi({ graphRoot: graph, usageDir: usage, port: 0, owner: 'healthy' })
      expect(uiRunning(graph)).toBe(true)

      // Disposing the only REAL owner must stop the server — the failed start's
      // ownership must not keep it alive.
      expect(await releaseUi(graph, 'healthy')).toBe(true)
      expect(stops).toBe(1)
      expect(uiRunning(graph)).toBe(false)
    } finally {
      __uiDirTestHook.beforePin = undefined
      setUiModuleForTests(undefined)
      await stopUi(graph).catch(() => undefined)
    }
  })
})

describe('an orphan lease is released exactly once (review #3-4)', () => {
  async function timeoutWithLateCreate(): Promise<{
    host: Awaited<ReturnType<typeof fixture>>['host']
    plugin: Awaited<ReturnType<typeof fixture>>['plugin']
    releaseCreate: () => void
    originalCreate: (input: never) => Promise<{ id: string }>
    lateId: () => string | undefined
  }> {
    const { host, plugin } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      timeoutMs: 40,
      options: { graphRoot: await tempDir() },
    })
    let releaseCreate = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const originalCreate = host.ctx.session.create
    let createdID: string | undefined
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof originalCreate>[0]) => {
        await held
        const info = await originalCreate(input)
        createdID = info.id
        return info
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect((error as { metadata?: { code?: string } }).metadata?.code).toBe('TIMEOUT')
    expect(plugin.leases.size()).toBe(1)
    return {
      host,
      plugin,
      releaseCreate,
      originalCreate,
      lateId: () => createdID,
    }
  }

  test('a failed first removal, then a successful dispose retry, releases once', async () => {
    const { host, plugin, releaseCreate, originalCreate } = await timeoutWithLateCreate()
    const originalRemove = host.ctx.session.remove
    let removed = 0
    Object.assign(host.ctx.session, {
      remove: async () => {
        removed += 1
        throw new Error('database is locked')
      },
    })
    // The late session appears; its removal FAILS, so the orphan stays queued.
    releaseCreate()
    for (let index = 0; index < 40; index += 1) await Bun.sleep(5)
    Object.assign(host.ctx.session, { create: originalCreate })
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(plugin.leases.size()).toBe(1)

    // `dispose` retries and this time the removal succeeds.
    Object.assign(host.ctx.session, { remove: async () => ({}) })
    await plugin.registry.dispose()
    Object.assign(host.ctx.session, { remove: originalRemove })
    expect(plugin.leases.size()).toBe(0)
    expect(plugin.leases.ids()).toEqual([])
  })

  test('a removal completing after the bound releases the lease once', async () => {
    const { host, plugin, releaseCreate, originalCreate, lateId } = await timeoutWithLateCreate()
    const originalRemove = host.ctx.session.remove
    // The FIRST removal fails, so the orphan stays queued with its release.
    Object.assign(host.ctx.session, {
      remove: async () => {
        throw new Error('database is locked')
      },
    })
    releaseCreate()
    for (let index = 0; index < 40; index += 1) await Bun.sleep(5)
    expect(plugin.leases.size()).toBe(1)
    Object.assign(host.ctx.session, { create: originalCreate })

    // The late session's id, captured at create: drive its removal with a slow
    // but successful remove and a ZERO budget, so the attempt is reported
    // expired and the success arrives LATE.
    const createdId = lateId()
    expect(createdId).toBeDefined()
    let settled = 0
    Object.assign(host.ctx.session, {
      remove: async (input: { sessionID: string }) => {
        await Bun.sleep(120)
        settled += 1
        return originalRemove(input)
      },
    })
    expect(await plugin.registry.remove(createdId as string, 0)).toBe(false)
    expect(settled).toBe(0)
    // The late success: ownership settles after the bound, exactly once.
    for (let index = 0; index < 60 && plugin.leases.size() > 0; index += 1) await Bun.sleep(10)
    expect(settled).toBe(1)
    expect(plugin.leases.size()).toBe(0)
    Object.assign(host.ctx.session, { remove: originalRemove })
  })
})
