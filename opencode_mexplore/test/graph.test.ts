/**
 * Lane A1 — the graph adapter: loading, profiles, tiers, the write fence, the
 * footer, the cap, and per-call isolation.
 *
 * Every test gets its own graph root, so nothing here depends on the repo's own
 * memory or on another test's leftovers.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BODY_OFFSET_DESCRIPTION,
  BODY_VIEW_CHARS,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_LINES,
  MANAGE_TOOL_NAMES,
  READ_TOOL_NAMES,
  WRITE_FENCE_CODE,
  capContent,
  knownPartialMutation,
  loadGraph,
  precheckArguments,
  type GraphRuntime,
  type GraphCall,
} from '../src/graph/index'
import { loadDshModules } from '../src/graph/load'
import { seedLinkTarget, withFailedEdge } from './helpers/partial-write'

let root: string
let runtime: GraphRuntime

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mexplore-graph-'))
  runtime = await loadGraph({ graphRoot: root })
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

/** A call with no evidence — the common case in these tests. */
function call(authority: 'read' | 'manage', callId = `call-${Math.random().toString(36).slice(2)}`): GraphCall {
  return runtime.createCall({ callId, authority, message: 'a test request', evidence: [] })
}

/**
 * A payload dsh's F88 traceability gate scores at ~0% against these tests'
 * caller messages: long enough to judge (>600 bytes, >8 distinct tokens) and
 * carrying none of their vocabulary, so it is exactly the "invented attachment"
 * the gate exists to refuse.
 */
const INVENTED = '# 季度复盘\n\n' + '董事会确认了仓储合约与配送半径的安排，客服排班改为两班制。\n'.repeat(12)

/** The id of the nth write this call recorded. */
function writtenId(target: GraphCall, index = 0): string {
  const id = target.report().writes[index]?.nodeId
  if (id === undefined) throw new Error(`no write #${index} recorded`)
  return id
}

// ---------------------------------------------------------------- the loader

describe('loading dsh_plugin (REQ-006)', () => {
  test('the tool module is the same instance index.js uses', async () => {
    const dsh = await loadDshModules()
    // A definition built by `apply` is only trusted by `tool.js` when both come
    // from one module instance — that is what the fence's precheck depends on.
    let definition: unknown
    const ctx = {
      tools: { register: (registered: unknown) => { definition = registered; return () => {} } },
      inject: () => {},
    }
    dsh.plugin.apply(ctx, { graphRoot: root, attachFromPath: false, expectWrite: false })
    expect(dsh.tool.trustedPreparationFor(definition)).toBeFunction()
    expect(dsh.source).toBe('repo')
  })

  test('both profiles load, with the expected tool sets per tier (AC-005)', () => {
    expect(runtime.toolNames('read')).toEqual([...READ_TOOL_NAMES])
    expect(runtime.toolNames('manage')).toEqual([...MANAGE_TOOL_NAMES])
  })

  test('merge and restore are never exposed at any tier (SEC-001)', async () => {
    for (const authority of ['read', 'manage'] as const) {
      const names = runtime.toolNames(authority)
      expect(names).not.toContain('memory_merge')
      expect(names).not.toContain('memory_restore')
      expect(runtime.toolDefs(authority).map((def) => def.name)).toEqual(names)
    }
  })

  test('memory_attach is advertised without from_path, and with the restricted note (SEC-001)', () => {
    const attach = runtime.toolDefs('manage').find((def) => def.name === 'memory_attach')
    expect(attach).toBeDefined()
    const properties = (attach?.input as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).sort()).toEqual(['content', 'filename', 'id'])
    expect(attach?.description).toContain('`from_path` is rejected')
  })

  test('the advertised schema is a copy, never the live definition object', () => {
    const first = runtime.toolDefs('manage').find((def) => def.name === 'memory_attach')
    const properties = (first?.input as { properties: Record<string, unknown> }).properties
    properties.injected = { type: 'string' }
    const second = runtime.toolDefs('manage').find((def) => def.name === 'memory_attach')
    expect(Object.keys((second?.input as { properties: object }).properties)).not.toContain('injected')
  })

  test('the read prompt differs from the manage prompt, and neither leaks a slot (REQ-009)', () => {
    const read = runtime.renderPrompt('read')
    const manage = runtime.renderPrompt('manage')
    expect(read).not.toContain('{{')
    expect(manage).not.toContain('{{')
    // The read profile drops the write-only surface entirely, so it must be
    // both different and smaller.
    expect(read).not.toBe(manage)
    expect(read.length).toBeLessThan(manage.length)
    expect(manage).toContain('memory_write')
    expect(read).toContain('memory_search')
  })

  test('the prompt is rendered fresh per call: a new node appears in the index', async () => {
    const before = runtime.renderPrompt('manage')
    await call('manage').execute('memory_write', { description: 'a freshly indexed fact', body: 'body' })
    const after = runtime.renderPrompt('manage')
    expect(after).toContain('a freshly indexed fact')
    expect(after).not.toBe(before)
  })

  test('per-profile descriptions: a read tool never names a write tool it cannot call', () => {
    const readTool = runtime.toolDefs('read').find((def) => def.name === 'memory_read_file')
    const manageTool = runtime.toolDefs('manage').find((def) => def.name === 'memory_read_file')
    expect(readTool?.description).not.toBe(manageTool?.description)
    expect(readTool?.description).toContain('the write side moved')
    expect(manageTool?.description).toContain('memory_attach moved')
  })

  test('a GraphCall advertises and renders from its own authority', () => {
    const read = call('read')
    const manage = call('manage')
    expect(read.toolNames()).toEqual(runtime.toolNames('read'))
    expect(manage.toolDefs().map((def) => def.name)).toEqual(runtime.toolNames('manage'))
    expect(read.renderPrompt()).toBe(runtime.renderPrompt('read'))
    expect(manage.renderPrompt()).toBe(runtime.renderPrompt('manage'))
  })
})

// -------------------------------------------------------------------- tiers
describe('authority tiers (AC-019)', () => {
  test('a read call refuses a write, with a fixed tier error', async () => {
    const read = call('read')
    const refused = await read.execute('memory_write', { description: 'd', body: 'b' }).catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as { code?: string }).code).toBe('TIER_REFUSED')
    expect((refused as Error).message).toContain('not available to a read call')
    // The refusal ran, but wrote nothing.
    expect(read.footerLines()).toEqual(['no writes'])
    expect(await fsp.readdir(root)).not.toContain('01')
  })

  test('a read call can read', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'readable fact', body: 'body' })
    const result = await call('read').execute('memory_search', { query: 'readable' })
    expect(result.content).toContain('readable fact')
  })
})

// ------------------------------------------------------------------- writes

describe('writes and the footer (REQ-012, AC-016)', () => {
  test('a manage call writes a node and announces it', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'bananas are yellow', body: 'The user said so.' })
    const id = writtenId(manage)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(manage.footerLines()).toEqual([`saved to memory: bananas are yellow (${id})`])
    expect(manage.report().writes).toEqual([
      { tool: 'memory_write', nodeId: id, description: 'bananas are yellow', status: 'ok' },
    ])
  })

  test('no writes at all is the literal line `no writes`', async () => {
    const read = call('read')
    await read.execute('memory_search', { query: '' })
    expect(read.footerLines()).toEqual(['no writes'])
    expect(read.report().writes).toEqual([])
  })

  test('a description-less write falls back to the body prefix', async () => {
    // `description` is required when creating, so this exercises the attach
    // route: it carries no description, and its filename is the handle.
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'carrier', body: 'body' })
    const id = writtenId(manage)
    await manage.execute('memory_attach', { id, filename: 'meeting-notes.md', content: 'notes' })
    expect(manage.footerLines()[1]).toBe(`saved to memory: meeting-notes.md (${id})`)
  })

  test('the footer never reflects prose: a failed write says incomplete', async () => {
    const manage = runtime.createCall({ callId: 'failed-write', authority: 'manage', message: 'please file this', evidence: [] })
    // An untraceable invented attachment: the handler throws after its own
    // pre-write checks, and no audited code covers it, so it is a FAILED write.
    const invented = INVENTED
    const failed = await manage
      .execute('memory_write', { description: 'invented', body: 'gist', attach: { filename: 'invented.md', content: invented } })
      .catch((error: Error) => error)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain('not traceable')
    const lines = manage.footerLines()
    expect(lines.every((line) => !line.startsWith('saved to memory:'))).toBe(true)
    expect(lines[0]).toBe('memory write incomplete: invented')
    expect(manage.report().writes).toEqual([
      { tool: 'memory_write', description: 'invented', status: 'failed' },
    ])
  })

  test('a nonexistent update target is an audited refusal: no failed write, no latch', async () => {
    // `update_target_missing` is provably pre-mutation, so it is neither a
    // footer line nor a latch — the model may retry against a real node.
    const manage = call('manage')
    const refused = await manage
      .execute('memory_write', { id: '01BRQ8Z8Z8Z8Z8Z8Z8Z8Z8Z8Z8', body: 'x' })
      .catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(manage.report().writes).toEqual([])
    expect(manage.footerLines()).toEqual(['no writes'])
    await manage.execute('memory_write', { description: 'still open', body: 'b' })
    expect(manage.footerLines()[0]).toStartWith('saved to memory: still open')
  })

  test('every call is counted, reads included', async () => {
    const manage = call('manage')
    await manage.execute('memory_search', { query: '' })
    await manage.execute('memory_write', { description: 'counted', body: 'b' })
    expect(manage.report().toolCalls).toBe(2)
  })
})

// ----------------------------------------------------------------- from_path

describe('from_path is unreachable (SEC-001, AC-010)', () => {
  test('an injected from_path is rejected before dsh reads anything', async () => {
    const source = path.join(root, 'secret.txt')
    await fsp.writeFile(source, 'do not read me')
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'carrier', body: 'body' })
    const id = writtenId(manage)

    const refused = await manage
      .execute('memory_attach', { id, from_path: source })
      .catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as { code?: string }).code).toBe('FROM_PATH_REFUSED')
    expect((refused as Error).message).toContain('from_path is not permitted')
    // Nothing landed, and the fence did NOT latch (a proven non-execution).
    expect(manage.footerLines().filter((line) => line.startsWith('saved to memory:'))).toHaveLength(1)
    const files = await fsp.readdir(path.join(root, id))
    expect(files.filter((name) => name !== 'node.md' && name !== '__edges__')).toEqual([])
  })

  test('dsh itself also refuses from_path (attachFromPath:false)', async () => {
    // Belt and braces: even if the adapter's own rejection were bypassed, the
    // dsh instance it applied writes nothing from disk.
    const dsh = await loadDshModules()
    const definitions = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    dsh.plugin.apply(
      {
        tools: { register: (def: { name: string }) => { definitions.set(def.name, def as never); return () => {} } },
        inject: () => {},
      },
      { graphRoot: root, attachFromPath: false, expectWrite: false, promptProfile: 'manage' },
    )
    const write = definitions.get('memory_write') as never as { execute: (a: unknown, e: unknown) => Promise<{ id: string }> }
    const created = await write.execute({ description: 'carrier', body: 'b' }, {})
    const attach = definitions.get('memory_attach') as never as { execute: (a: unknown, e: unknown) => Promise<unknown> }
    const refused = await attach
      .execute({ id: created.id, from_path: path.join(root, 'nowhere.txt') }, { agent: { id: 'direct' } })
      .catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(String((refused as Error).message)).toContain('`from_path` is disabled in this deployment')
  })
})

// -------------------------------------------------------------------- fence

describe('the write fence (REQ-011, AC-008)', () => {
  test('a partial write latches: the result is reported, later writes refuse', async () => {
    const manage = call('manage')
    // The peer exists, so preparation and the existence guard both pass.
    // The real symlink syscall fails only after createNode publishes the body.
    const peer = await seedLinkTarget(runtime)
    await withFailedEdge(peer, () => manage.execute('memory_write', {
      description: 'partially linked', body: 'b', links: [peer],
    }))
    expect(manage.report().writes[0]?.status).toBe('incomplete')
    expect(manage.footerLines()[0]).toStartWith('memory write incomplete: partially linked')

    const refused = await manage
      .execute('memory_write', { description: 'second write', body: 'b' })
      .catch((error: Error) => error)
    expect((refused as { code?: string }).code).toBe(WRITE_FENCE_CODE)
    expect((refused as Error).message).toContain('Do not retry')
    // The refusal is not recorded as another write.
    expect(manage.report().writes).toHaveLength(1)
  })

  test('missing link targets do not latch or record a partial write, so a corrected write succeeds', async () => {
    const manage = call('manage')
    const missing = '01AAAAAAAAAAAAAAAAAAAAAAAA'
    for (const shape of [{ links: [missing] }, { typed_links: [{ id: missing, type: 'follows-from' }] }]) {
      await expect(manage.execute('memory_write', { description: 'must not land', body: 'fact', ...shape })).rejects.toThrow(/cannot link/)
      expect(manage.report().writes).toHaveLength(0)
      expect(manage.footerLines()).toEqual(['no writes'])
    }
    await manage.execute('memory_write', { description: 'corrected write', body: 'fact' })
    expect(manage.report().writes).toHaveLength(1)
    expect(manage.footerLines()[0]).toStartWith('saved to memory: corrected write')
  })

  test('reads still work with the fence latched', async () => {
    const manage = call('manage')
    const peer = await seedLinkTarget(runtime)
    await withFailedEdge(peer, () => manage.execute('memory_write', { description: 'anchored', body: 'b', links: [peer] }))
    const read = await manage.execute('memory_search', { query: 'anchored' })
    expect(read.content).toContain('anchored')
  })

  test('an update_unread audited refusal does NOT latch: read, then retry succeeds', async () => {
    // Created in one call, updated from another: creating a node marks it seen
    // for its own call, so the unread state needs two.
    const creator = call('manage', 'unread-creator')
    await creator.execute('memory_write', { description: 'to update', body: 'first' })
    const id = writtenId(creator)

    const manage = call('manage', 'unread-updater')
    const refused = await manage.execute('memory_write', { id, body: 'second' }).catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('has not been read this session')
    expect((refused as { code?: string }).code).toBeUndefined()
    // An audited pre-mutation refusal is not a footer line and does not latch.
    expect(manage.report().writes).toEqual([])

    await manage.execute('memory_read', { id })
    const retried = await manage.execute('memory_write', { id, body: 'second' })
    expect(retried.content).toStartWith('Updated')
    expect(manage.footerLines()).toHaveLength(1)
    expect(manage.footerLines()[0]).toStartWith('saved to memory: to update (')
  })

  test('a schema rejection does NOT latch and is never recorded as a write', async () => {
    const manage = call('manage')
    const refused = await manage.execute('memory_write', { body: 'no description' }).catch((error: Error) => error)
    expect((refused as Error).message).toStartWith('invalid arguments:')
    expect(manage.report().writes).toEqual([])
    // The fence is still open: a valid write lands.
    await manage.execute('memory_write', { description: 'valid after all', body: 'b' })
    expect(manage.footerLines()[0]).toStartWith('saved to memory: valid after all')
  })

  test('the schema rejection restates the declared properties without from_path', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'carrier', body: 'b' })
    const id = writtenId(manage)
    const refused = await manage
      .execute('memory_attach', { id, filename: 'x.md', content: 'c', bogus: 1 })
      .catch((error: Error) => error)
    const message = (refused as Error).message
    expect(message).toContain('bogus is not a declared property')
    expect(message).not.toContain('from_path')
  })

  test('an execution throw latches', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'carrier', body: 'b' })
    const id = writtenId(manage)
    // A real handler-path failure: untraceable invented attachment (its own
    // throw is NOT an audited refusal code).
    const invented = INVENTED
    const refused = await manage
      .execute('memory_write', { id, attach: { filename: 'invented.md', content: invented } })
      .catch((error: Error) => error)
    expect((refused as Error).message).toContain('not traceable')
    expect(manage.footerLines().some((line) => line.startsWith('memory write incomplete:'))).toBe(true)

    const after = await manage
      .execute('memory_write', { description: 'another', body: 'b' })
      .catch((error: Error) => error)
    expect((after as { code?: string }).code).toBe(WRITE_FENCE_CODE)
  })
})

// -------------------------------------------------------------- serialization

describe('write serialization (REQ-011)', () => {
  test('two concurrent writes do not overlap', async () => {
    const manage = call('manage')
    // Instrument the definition itself: two overlapping dsh writes show up as
    // two in-flight executions at once, whichever queue is (not) in place.
    const write = runtime.definitions('manage').get('memory_write')!
    const execute = write.execute.bind(write)
    let active = 0
    let maxActive = 0
    let observed = 0
    write.execute = async (args: unknown, exec: unknown) => {
      active += 1
      observed += 1
      maxActive = Math.max(maxActive, active)
      try {
        // Yield repeatedly, so an unserialized pair would certainly overlap.
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        return await execute(args, exec)
      } finally {
        active -= 1
      }
    }
    try {
      await Promise.all([
        manage.execute('memory_write', { description: 'concurrent one', body: 'a' }),
        manage.execute('memory_write', { description: 'concurrent two', body: 'b' }),
      ])
    } finally {
      write.execute = execute
    }
    expect(observed).toBe(2)
    expect(maxActive).toBe(1)
    expect(manage.report().writes.map((record) => record.description)).toEqual(['concurrent one', 'concurrent two'])
  })

  test('reads are never serialized behind writes', async () => {
    const manage = call('manage')
    const write = runtime.definitions('manage').get('memory_write')!
    const execute = write.execute.bind(write)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    write.execute = async (args: unknown, exec: unknown) => {
      await gate
      return execute(args, exec)
    }
    try {
      const pending = manage.execute('memory_write', { description: 'slow write', body: 'a' })
      // The read must not wait for the blocked write.
      const read = await manage.execute('memory_search', { query: '' })
      expect(read.content).toBeString()
      release()
      await pending
    } finally {
      write.execute = execute
    }
  })

  test('settle() awaits every in-flight execute', async () => {
    const manage = call('manage')
    const pending = manage.execute('memory_write', { description: 'late', body: 'a' })
    // Not awaited by the test — settle must be what surfaces it.
    await manage.settle()
    expect(manage.report().writes).toHaveLength(1)
    await pending
  })

  test('settle() never throws on a failing write still in flight', async () => {
    const manage = call('manage')
    const pending = manage
      .execute('memory_write', { id: '01BRQ8Z8Z8Z8Z8Z8Z8Z8Z8Z8Z8', body: 'x' })
      .catch((error: Error) => error)
    await manage.settle()
    expect(await pending).toBeInstanceOf(Error)
  })
})

// ------------------------------------------------------------- graph root

describe('the graph root', () => {
  test('a leading ~ expands and the path is resolved, as in dsh', async () => {
    // No reads are issued, so nothing in $HOME is touched: only the resolution
    // is under test, and it must agree with the directory dsh writes to.
    const homeRuntime = await loadGraph({ graphRoot: '~' })
    expect(homeRuntime.graphRoot).toBe(path.resolve(os.homedir()))
    const nested = await loadGraph({ graphRoot: '~/mexplore-test-graph' })
    expect(nested.graphRoot).toBe(path.join(os.homedir(), 'mexplore-test-graph'))
  })

  test('a missing graphRoot fails loud at load', async () => {
    const failed = await loadGraph({ graphRoot: '' }).catch((error: Error) => error)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain('`graphRoot` is required')
  })
})

// ---------------------------------------------------------------------- cap

describe('result cap (SEC-004, AC-023)', () => {
  test('a huge attachment read is capped, under both host limits, with a resume offset', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'holds a big transcript', body: 'gist' })
    const id = writtenId(manage)
    const huge = Array.from({ length: 3_000 }, (_, index) => `line ${index} of the transcript, padded for length`).join('\n')
    // The payload itself must be traceable, so the caller message carries it.
    const traced = runtime.createCall({ callId: 'big', authority: 'manage', message: huge, evidence: [] })
    await traced.execute('memory_attach', { id, filename: 'transcript.md', content: huge })

    const page = await traced.execute('memory_read_file', { id, file: 'transcript.md' })
    expect(page.metadata?.truncated).toBe(true)
    const lines = page.content.split('\n').length
    expect(lines).toBeLessThanOrEqual(MAX_CONTENT_LINES)
    expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)
    expect(page.content).toContain('offset:')
    expect(page.content).toContain('memory_read_file')
    // The offset names a byte the file really has, past the page that was cut.
    const offset = Number(/offset: (\d+)/.exec(page.content)?.[1])
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(Buffer.byteLength(huge, 'utf8'))

    // And it continues from there.
    const next = await traced.execute('memory_read_file', { id, file: 'transcript.md', offset })
    expect(next.content).not.toBe(page.content)
  })

  test('a small result is untouched', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'small', body: 'one line' })
    const id = writtenId(manage)
    const page = await manage.execute('memory_read', { id })
    expect(page.metadata?.truncated).toBe(false)
    expect(page.content).not.toContain('truncated by mexplore')
  })

  test('the cap itself holds at both boundaries', () => {
    const lineCount = capContent(Array.from({ length: MAX_CONTENT_LINES + 50 }, (_, i) => `l${i}`).join('\n'))
    expect(lineCount.truncated).toBe(true)
    expect(lineCount.content.split('\n').length).toBeLessThanOrEqual(MAX_CONTENT_LINES)

    const byteCount = capContent('x'.repeat(MAX_CONTENT_BYTES + 10))
    expect(byteCount.truncated).toBe(true)
    expect(Buffer.byteLength(byteCount.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)

    const exact = capContent('small')
    expect(exact).toEqual({ content: 'small', truncated: false })
  })

  // ---- review Major 1: truncation must not credit bytes the child never saw
  test('a truncated page does not authorize replacing that attachment (Major 1)', async () => {
    // 48 KB is under one dsh page (50,000 bytes) but over this adapter's cap
    // once the header and the tail line ride along.
    const payload = ('x'.repeat(99) + '\n').repeat(480)
    expect(Buffer.byteLength(payload, 'utf8')).toBe(48_000)
    const traced = runtime.createCall({ callId: 'major-1', authority: 'manage', message: payload, evidence: [] })
    const stored = await traced.execute('memory_write', {
      description: 'a 48 KB attachment',
      body: 'gist',
      attach: { filename: 'forty-eight.md', content: payload },
    })
    expect(stored.content).toContain('forty-eight.md')
    const id = writtenId(traced)

    const page = await traced.execute('memory_read_file', { id, file: 'forty-eight.md' })
    expect(page.metadata?.truncated).toBe(true)
    expect(page.content).toContain('bytes remain')

    // dsh itself believes the whole page landed; the adapter must not.
    const refused = await traced
      .execute('memory_attach', { id, filename: 'forty-eight.md', content: 'a replacement' })
      .catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as { code?: string }).code).toBe('UNDELIVERED_OVERWRITE')
    expect((refused as Error).message).toContain('only partly read')
    // A proven non-execution: nothing landed, and the fence is still open.
    expect(traced.footerLines().filter((line) => line.startsWith('saved to memory:'))).toHaveLength(1)

    // Page the rest in — then the replacement is allowed.
    const offset = Number(/offset: (\d+)/.exec(page.content.split('\n').slice(-1)[0] ?? '')?.[1])
    const rest = await traced.execute('memory_read_file', { id, file: 'forty-eight.md', offset })
    expect(rest.metadata?.truncated).toBe(false)
    const replaced = await traced.execute('memory_attach', { id, filename: 'forty-eight.md', content: payload })
    expect(replaced.content).toContain('forty-eight.md')
  })

  test('a page the adapter delivered whole still authorizes the replacement', async () => {
    const manage = call('manage')
    await manage.execute('memory_write', { description: 'small attachment', body: 'gist' })
    const id = writtenId(manage)
    await manage.execute('memory_attach', { id, filename: 'small.md', content: 'first version' })
    const page = await manage.execute('memory_read_file', { id, file: 'small.md' })
    expect(page.metadata?.truncated).toBe(false)
    const replaced = await manage.execute('memory_attach', { id, filename: 'small.md', content: 'second version' })
    expect(replaced.content).toContain('small.md')
  })

  test('an inline attach on memory_write is gated the same way (Major 1)', async () => {
    const payload = ('y'.repeat(99) + '\n').repeat(480)
    const traced = runtime.createCall({ callId: 'major-1-inline', authority: 'manage', message: payload, evidence: [] })
    await traced.execute('memory_write', {
      description: 'inline 48 KB',
      body: 'gist',
      attach: { filename: 'inline.md', content: payload },
    })
    const id = writtenId(traced)
    const page = await traced.execute('memory_read_file', { id, file: 'inline.md' })
    expect(page.metadata?.truncated).toBe(true)
    const refused = await traced
      .execute('memory_write', { id, body: 'gist', attach: { filename: 'inline.md', content: 'replacement' } })
      .catch((error: Error) => error)
    expect((refused as { code?: string }).code).toBe('UNDELIVERED_OVERWRITE')
  })

  // ---- review pass 2, Major 1: the guard reads PREPARED args, not raw input
  test('a serialized inline attach is guarded identically (pass 2, Major 1)', async () => {
    const payload = ('w'.repeat(99) + '\n').repeat(480)
    const traced = runtime.createCall({ callId: 'major-1-serialized', authority: 'manage', message: payload, evidence: [] })
    await traced.execute('memory_write', {
      description: 'serialized inline',
      body: 'gist',
      attach: { filename: 'serialized.md', content: payload },
    })
    const id = writtenId(traced)
    const page = await traced.execute('memory_read_file', { id, file: 'serialized.md' })
    expect(page.metadata?.truncated).toBe(true)

    // The shape dsh's own `coerce` repairs (F78): the payload arrives as a JSON
    // STRING. A guard reading the raw argument would see no `filename` at all.
    const refused = await traced
      .execute('memory_write', {
        id,
        body: 'gist',
        attach: JSON.stringify({ filename: 'serialized.md', content: 'replacement' }),
      })
      .catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as { code?: string }).code).toBe('UNDELIVERED_OVERWRITE')
    expect((refused as Error).message).toContain('serialized.md')
    // Nothing landed, and the fence is still open.
    expect(traced.footerLines().filter((line) => line.startsWith('saved to memory:'))).toHaveLength(1)

    // A serialized attach under a DIFFERENT name is not a replacement at all.
    const fresh = await traced.execute('memory_write', {
      id,
      body: 'gist',
      attach: JSON.stringify({ filename: 'a-new-name.md', content: 'brand new file' }),
    })
    expect(fresh.content).toContain('a-new-name.md')

    // Once the tail is delivered, the serialized replacement is allowed.
    const offset = Number(/offset: (\d+)/.exec(page.content.split('\n').slice(-1)[0] ?? '')?.[1])
    await traced.execute('memory_read_file', { id, file: 'serialized.md', offset })
    const allowed = await traced.execute('memory_write', {
      id,
      body: 'gist',
      attach: JSON.stringify({ filename: 'serialized.md', content: payload }),
    })
    expect(allowed.content).toContain('serialized.md')
  })

  // ---- review pass 2, Major 2: coverage is bound to the FILE, not its name
  test('coverage follows the file identity, not the spelling (pass 2, Major 2)', async () => {
    const payload = ('v'.repeat(99) + '\n').repeat(480)
    const traced = runtime.createCall({ callId: 'major-2-case', authority: 'manage', message: payload, evidence: [] })
    await traced.execute('memory_write', {
      description: 'mixed-case name',
      body: 'gist',
      attach: { filename: 'Report.md', content: payload },
    })
    const id = writtenId(traced)
    const page = await traced.execute('memory_read_file', { id, file: 'Report.md' })
    expect(page.metadata?.truncated).toBe(true)

    // On a case-insensitive filesystem `report.md` IS that file; dsh credits its
    // full page, so the adapter must still refuse. On a case-sensitive one this
    // is a different (nonexistent) file and dsh itself refuses, which is also
    // safe — so the assertion is "refused either way", never "guarded by name".
    const variant = await traced
      .execute('memory_attach', { id, filename: 'report.md', content: 'replacement' })
      .catch((error: Error) => error)
    expect(variant).toBeInstanceOf(Error)

    const sameName = await traced
      .execute('memory_attach', { id, filename: 'Report.md', content: 'replacement' })
      .catch((error: Error) => error)
    expect((sameName as { code?: string }).code).toBe('UNDELIVERED_OVERWRITE')
  })

  test('a replaced file is a new version: old coverage does not vouch for it (pass 2, Major 2)', async () => {
    const payload = ('u'.repeat(99) + '\n').repeat(480)
    const traced = runtime.createCall({ callId: 'major-2-version', authority: 'manage', message: payload, evidence: [] })
    await traced.execute('memory_write', {
      description: 'versioned',
      body: 'gist',
      attach: { filename: 'versioned.md', content: payload },
    })
    const id = writtenId(traced)
    // Page the whole file, so the coverage record covers it end to end.
    let offset: number | undefined
    for (let page = 0; page < 4; page += 1) {
      const result = await traced.execute('memory_read_file', {
        id,
        file: 'versioned.md',
        ...(offset === undefined ? {} : { offset }),
      })
      const next = /offset: (\d+)/.exec(result.content.split('\n').slice(-1)[0] ?? '')
      if (next === null) break
      offset = Number(next[1])
    }
    // Replace it with SAME-SIZED, different content: a new inode, a new version.
    const replacement = ('t'.repeat(99) + '\n').repeat(480)
    await traced.execute('memory_attach', { id, filename: 'versioned.md', content: replacement })

    // The read of the REPLACEMENT starts its own record; a truncated page of it
    // must be the only thing that can authorize replacing it.
    const fresh = runtime.createCall({ callId: 'major-2-version-b', authority: 'manage', message: replacement, evidence: [] })
    const page = await fresh.execute('memory_read_file', { id, file: 'versioned.md' })
    expect(page.metadata?.truncated).toBe(true)
    const refused = await fresh
      .execute('memory_attach', { id, filename: 'versioned.md', content: replacement })
      .catch((error: Error) => error)
    expect((refused as { code?: string }).code).toBe('UNDELIVERED_OVERWRITE')
    // The refusal names the NEW file's size, so the old tail was not inherited.
    expect((refused as Error).message).toContain('bytes 0–')
  })

  // ---- review Major 7: every page must make progress
  test('a one-line 60 KB attachment pages to the end (Major 7)', async () => {
    const oneLine = 'y'.repeat(60_000)
    const traced = runtime.createCall({ callId: 'major-7', authority: 'manage', message: oneLine, evidence: [] })
    await traced.execute('memory_write', {
      description: 'a minified payload',
      body: 'gist',
      attach: { filename: 'minified.json', content: oneLine },
    })
    const id = writtenId(traced)

    let offset: number | undefined
    let delivered = 0
    let pages = 0
    for (; pages < 8; pages += 1) {
      const page = await traced.execute('memory_read_file', {
        id,
        file: 'minified.json',
        ...(offset === undefined ? {} : { offset }),
      })
      expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)
      // Progress is the point: a page that delivered nothing would repeat.
      expect(page.content.length).toBeGreaterThan(0)
      const next = /offset: (\d+)/.exec(page.content.split('\n').slice(-1)[0] ?? '')
      if (next === null) {
        delivered += 1
        break
      }
      const resume = Number(next[1])
      if (offset !== undefined) expect(resume).toBeGreaterThan(offset)
      offset = resume
    }
    expect(delivered).toBe(1)
    expect(pages).toBeGreaterThan(0)
    // The final page ends at the end of the file, so a replacement is allowed.
    const replaced = await traced.execute('memory_attach', { id, filename: 'minified.json', content: oneLine })
    expect(replaced.content).toContain('minified.json')
  })

  test('an oversized single line keeps a UTF-8-safe prefix (>60 KB, no split code point)', () => {
    const oneLine = '汉'.repeat(30_000) // 90,000 bytes, one line, 3-byte code points
    const capped = capContent(oneLine)
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(capped.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)
    // No replacement character: the cut never split a code point.
    expect(capped.content).not.toContain('\uFFFD')
    const body = capped.content.split('\n')[0] as string
    expect(body.length).toBeGreaterThan(10_000)
    expect(oneLine.startsWith(body)).toBe(true)
  })

  // ---- review Minor 10: the note must describe the body actually delivered
  test('a long filename still yields a usable offset and a within-limit page (Minor 10)', async () => {
    // dsh caps attachment names at 200 bytes, so this is the longest legal name.
    const longName = `${'a'.repeat(190)}.md`
    const payload = ('z'.repeat(99) + '\n').repeat(480)
    const traced = runtime.createCall({ callId: 'minor-10', authority: 'manage', message: payload, evidence: [] })
    await traced.execute('memory_write', {
      description: 'long name',
      body: 'gist',
      attach: { filename: longName, content: payload },
    })
    const id = writtenId(traced)
    const page = await traced.execute('memory_read_file', { id, file: longName })
    expect(page.metadata?.truncated).toBe(true)
    expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)
    // The page still carries content, not just a note.
    expect(page.content.split('\n').length).toBeGreaterThan(1)
    const offset = Number(/offset: (\d+)/.exec(page.content.split('\n').slice(-1)[0] ?? '')?.[1])
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(Buffer.byteLength(payload, 'utf8'))

    // The note's offset describes the DELIVERED prefix: the body (header plus
    // content) minus the header is exactly the byte count it names, so no
    // content is skipped and none is repeated.
    const deliveredLines = page.content.slice(0, page.content.lastIndexOf('\n…[output truncated'))
    const contentBytes = Buffer.byteLength(deliveredLines, 'utf8') - Buffer.byteLength(
      `${longName} on ${id} (${payload.length} bytes):\n\n`,
      'utf8',
    )
    expect(offset).toBe(contentBytes)

    const next = await traced.execute('memory_read_file', { id, file: longName, offset })
    // The page continues exactly where the previous one stopped: the file bytes
    // from `offset` are the bytes this page returned — no gap, no repeat.
    expect(next.metadata?.truncated).toBe(false)
    const rest = Buffer.from(payload, 'utf8').subarray(offset).toString('utf8')
    expect(rest).toContain('zzz')
    expect(next.content.endsWith(rest)).toBe(true)
  })
})

// ------------------------------------------------------- node body paging

describe('node body paging (review-2 Major 10)', () => {
  /** Store a node with `body` from a manage call, and return its id. */
  async function store(body: string): Promise<string> {
    const manage = runtime.createCall({
      callId: `store-${Math.random().toString(36).slice(2)}`,
      authority: 'manage',
      message: 'x',
      evidence: [],
    })
    await manage.execute('memory_write', { description: 'body-carrier', body })
    return writtenId(manage)
  }

  /** The slice one page serves, and the character range its heading states. */
  function pageSlice(page: { content: string }): { start: number; end: number; slice: string } {
    // Two headings exist: a content page (`body chars A–B of M`) and the explicit
    // end-of-body page (`body: char M of M — end of body`).
    const range = /body chars (\d+)–(\d+) of (\d+):\n\n/.exec(page.content)
    if (range !== null) {
      const tail = page.content.lastIndexOf('\n\n…[')
      return {
        start: Number(range[1]),
        end: Number(range[2]) + 1,
        slice: page.content.slice(page.content.indexOf('\n\n') + 2, tail),
      }
    }
    const done = /body: char (\d+) of (\d+) — end of body/.exec(page.content)
    if (done !== null) {
      const total = Number(done[1])
      return { start: total, end: total, slice: '' }
    }
    throw new Error(`no page heading in ${JSON.stringify(page.content.slice(0, 160))}`)
  }

  /** The exact `body_offset` a cut-off view names. */
  function hintOffset(content: string): number {
    const hint = /…\[body cut at char (\d+) of (\d+) — call memory_read again with id=(\S+) and body_offset=(\d+)\]/.exec(
      content,
    )
    if (hint === null) throw new Error(`no body hint in ${JSON.stringify(content.slice(-200))}`)
    return Number(hint[4])
  }

  /** A body of unique lines, so a delivered prefix can be located exactly. */
  function uniqueBody(chars: number): string {
    const lines: string[] = []
    let at = 0
    for (let index = 0; at < chars; index += 1) {
      const line = `${index.toString(36).padStart(4, '0')}:${String(index * 7919).padStart(9, '0')}`
      lines.push(line)
      at += line.length + 1
    }
    return lines.join('\n').slice(0, chars)
  }

  test('body_offset is advertised on memory_read at both tiers, and is not a dsh argument', () => {
    for (const authority of ['read', 'manage'] as const) {
      const read = runtime.toolDefs(authority).find((def) => def.name === 'memory_read')
      const properties = (read?.input as { properties: Record<string, { type?: string; description?: string }> })
        .properties
      expect(Object.keys(properties)).toContain('body_offset')
      expect(properties.body_offset?.type).toBe('integer')
      expect(properties.body_offset?.description).toBe(BODY_OFFSET_DESCRIPTION)
      expect(properties.body_offset?.description).toContain('continue a cut-off node body')
    }
    // It is THIS runtime's parameter: dsh's definition never declares it, so a
    // non-continuation read must strip it (dsh rejects undeclared properties).
    const dshRead = runtime.definitions('manage').get('memory_read')!
    expect(Object.keys((dshRead.parameters as { properties: object }).properties)).not.toContain('body_offset')
  })

  test('a 120,000-char body pages to the end and concatenates exactly', async () => {
    const body = uniqueBody(120_000)
    const id = await store(body)
    const read = call('read')

    // Page 1 is the ordinary view, and its hint is the accurate one — not dsh's
    // "read node.md … under the graph root", which this child cannot follow.
    const view = await read.execute('memory_read', { id })
    expect(view.content).not.toContain('read node.md inside node')
    expect(view.content).toContain(`of ${body.length} — call memory_read again with id=${id} and body_offset=`)
    const first = hintOffset(view.content)

    // The hint's number is exactly what the view delivered: the prefix is
    // present in full and the next stretch is not there at all.
    expect(view.content).toContain(body.slice(0, first))
    expect(view.content).not.toContain(body.slice(0, first + 20))

    // Page from the top, then follow every hint to the end.
    let assembled = ''
    let offset = 0
    let pages = 0
    for (; pages < 12; pages += 1) {
      const page = await read.execute('memory_read', { id, body_offset: offset })
      const { start, end, slice } = pageSlice(page)
      expect(start).toBe(offset)
      expect(end).toBeGreaterThan(start)
      expect(slice).toBe(body.slice(start, end))
      assembled += slice
      if (page.metadata?.bodyDone === true) {
        expect(end).toBe(body.length)
        break
      }
      const next = /body_offset=(\d+)/.exec(page.content)
      expect(next).not.toBeNull()
      offset = Number(next?.[1])
      expect(offset).toBe(end)
    }
    expect(pages).toBeLessThan(12)
    expect(assembled).toBe(body)
    // The view's own hint is a real continuation point, not a stale number.
    expect(pageSlice(await read.execute('memory_read', { id, body_offset: first })).start).toBe(first)
  })

  test('a 30,000-char CJK body gets the accurate hint and page 2 continues with no gap', async () => {
    // Under dsh's 50,000-CHAR cut, far over this adapter's 45,000-BYTE cap.
    const body = '汉'.repeat(30_000)
    expect(body.length).toBeLessThan(BODY_VIEW_CHARS)
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_CONTENT_BYTES)
    const id = await store(body)
    const read = call('read')

    const view = await read.execute('memory_read', { id })
    expect(view.metadata?.truncated).toBe(true)
    // Neither wrong hint survives: not `offset` (a memory_read_file argument)
    // and not the filesystem remedy.
    expect(view.content).not.toContain('memory_read_file')
    expect(view.content).not.toContain('read node.md inside node')
    const offset = hintOffset(view.content)
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(body.length)
    // The delivered prefix is exactly the hint's length — no gap, no overlap.
    expect(view.content).toContain('汉'.repeat(offset))

    const page = await read.execute('memory_read', { id, body_offset: offset })
    const { start, end, slice } = pageSlice(page)
    expect(start).toBe(offset)
    expect(end).toBeGreaterThan(start)
    expect(body.slice(start, end)).toBe(slice)
    // Page 2 is content, never permission: no write was recorded.
    expect(read.report().writes).toEqual([])
  })

  test('an invalid body_offset is a clear error', async () => {
    const id = await store('a body')
    const read = call('read')
    const cases: Array<[unknown, string]> = [
      [-1, 'must not be negative'],
      [9_999, 'past the end'],
      [1.5, 'must be an integer'],
      ['7', 'must be an integer'],
    ]
    for (const [bad, expected] of cases) {
      const refused = await read.execute('memory_read', { id, body_offset: bad }).catch((error: Error) => error)
      expect(refused).toBeInstanceOf(Error)
      expect((refused as { code?: string }).code).toBe('INVALID_BODY_OFFSET')
      expect((refused as Error).message).toContain(expected)
    }
    // The exact end is allowed, and answers with an explicit end-of-body page.
    const end = await read.execute('memory_read', { id, body_offset: 'a body'.length })
    expect(end.content).toContain('end of body')
    expect(end.metadata?.bodyDone).toBe(true)
  })

  test('path-traversal ids are rejected for body paging', async () => {
    const read = call('read')
    for (const bad of ['../../../etc/passwd', '..', 'not-a-ulid']) {
      const refused = await read.execute('memory_read', { id: bad, body_offset: 0 }).catch((error: Error) => error)
      expect(refused).toBeInstanceOf(Error)
      // dsh's own assertId is the guard: a ULID pattern, which no traversal
      // path can satisfy.
      expect((refused as Error).message).toMatch(/invalid/)
    }
    // Nothing was created, and no file outside the root was read.
    expect(await fsp.readdir(root)).toEqual([])
  })

  test('the read tier can page', async () => {
    const body = 'y'.repeat(120_000)
    const id = await store(body)
    const read = call('read', 'read-tier-pager')
    const view = await read.execute('memory_read', { id })
    const offset = hintOffset(view.content)
    const page = await read.execute('memory_read', { id, body_offset: offset })
    const { start, end, slice } = pageSlice(page)
    expect(start).toBe(offset)
    expect(slice).toBe('y'.repeat(end - start))
    expect(page.metadata?.bodyDone).not.toBe(true)
    // Paging counts as a tool call, and writes nothing.
    expect(read.report().toolCalls).toBe(2)
    expect(read.report().writes).toEqual([])
    expect(read.footerLines()).toEqual(['no writes'])
  })

  test('every page makes progress for a body that is one enormous line', async () => {
    const body = 'z'.repeat(300_000)
    const id = await store(body)
    const read = call('read')
    let offset = 0
    let pages = 0
    for (; pages < 20; pages += 1) {
      const page = await read.execute('memory_read', { id, body_offset: offset })
      const { start, end } = pageSlice(page)
      expect(start).toBe(offset)
      expect(end).toBeGreaterThan(offset)
      expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(MAX_CONTENT_BYTES)
      if (page.metadata?.bodyDone === true) break
      offset = end
    }
    expect(pages).toBeLessThan(20)
    expect(offset).toBeGreaterThan(0)
  })

  test('a page never splits a surrogate pair', async () => {
    // 4-byte code points: a boundary through the pair would corrupt one.
    const body = '😀'.repeat(60_000)
    const id = await store(body)
    const read = call('read')
    let offset = 0
    let assembled = ''
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await read.execute('memory_read', { id, body_offset: offset })
      const { start, end, slice } = pageSlice(page)
      expect(slice).not.toContain('\uFFFD')
      expect(body.slice(start, end)).toBe(slice)
      assembled += slice
      if (page.metadata?.bodyDone === true) break
      offset = end
    }
    expect(assembled).toBe(body)
  })

  test('a short body is untouched: no hint, no extra read', async () => {
    const id = await store('a short body')
    const page = await call('read').execute('memory_read', { id })
    expect(page.content).not.toContain('body_offset')
    expect(page.content).not.toContain('body cut')
    expect(page.content).not.toContain('read node.md inside node')
    expect(page.metadata?.truncated).toBe(false)
  })
})


// ---------------------------------------------------------------- isolation

describe('per-call state (REQ-010)', () => {
  test('a read in one call does not authorize an update in another', async () => {
    const first = call('manage', 'call-a')
    await first.execute('memory_write', { description: 'shared node', body: 'original' })
    const id = writtenId(first)
    await first.execute('memory_read', { id })

    const second = call('manage', 'call-b')
    const refused = await second.execute('memory_write', { id, body: 'from call b' }).catch((error: Error) => error)
    expect((refused as Error).message).toContain('has not been read this session')
    expect(second.report().writes.every((record) => record.status !== 'ok')).toBe(true)
  })

  test('the fence is per call: a latched call does not block a fresh one', async () => {
    const first = call('manage', 'fenced')
    const peer = await seedLinkTarget(runtime)
    await withFailedEdge(peer, () => first.execute('memory_write', { description: 'partial', body: 'b', links: [peer] }))
    const second = call('manage', 'fresh')
    await second.execute('memory_write', { description: 'clean write', body: 'b' })
    expect(second.footerLines()[0]).toStartWith('saved to memory: clean write')
  })

  test('two calls get separate reports', async () => {
    const a = call('manage', 'report-a')
    const b = call('manage', 'report-b')
    await a.execute('memory_write', { description: 'only a', body: 'b' })
    expect(a.report().writes).toHaveLength(1)
    expect(b.report().writes).toHaveLength(0)
    expect(b.report().toolCalls).toBe(0)
  })
})

// ------------------------------------------------------------------ history

describe('the trusted history (REQ-010)', () => {
  test('the caller message is the prompting turn: an attach that quotes it is traceable', async () => {
    const material = '# Quarterly review\n\n' +
      'The board confirmed the warehouse contract and the delivery radius plan for the region.\n'.repeat(12)
    const manage = runtime.createCall({ callId: 'traceable', authority: 'manage', message: material, evidence: [] })
    const result = await manage.execute('memory_write', {
      description: 'quarterly review gist',
      body: 'See the attached review.',
      attach: { filename: 'quarterly-review.md', content: material },
    })
    expect(result.content).toContain('quarterly-review.md')
    const id = writtenId(manage)
    expect(await fsp.readFile(path.join(root, id, 'quarterly-review.md'), 'utf8')).toBe(material)
  })

  test('evidence is part of the history too', async () => {
    const past = 'Earlier turn: the delivery radius for the region is forty kilometres.\n'.repeat(12)
    const content = '# Radius notes\n\n' + past
    const manage = runtime.createCall({
      callId: 'evidence-call',
      authority: 'manage',
      message: 'save that',
      evidence: [{ sourceId: 'turn-1', role: 'assistant', content: past, complete: true }],
    })
    const result = await manage.execute('memory_write', {
      description: 'radius notes',
      body: 'Attached.',
      attach: { filename: 'radius.md', content },
    })
    expect(result.content).toContain('radius.md')
  })

  test('the child\'s own messages never vouch for it: content absent from history is refused', async () => {
    const invented = INVENTED
    const manage = runtime.createCall({ callId: 'invented', authority: 'manage', message: 'store the report', evidence: [] })
    const refused = await manage
      .execute('memory_write', {
        description: 'invented report',
        body: 'gist',
        attach: { filename: 'invented.md', content: invented },
      })
      .catch((error: Error) => error)
    expect((refused as Error).message).toContain('not traceable')
  })
})

// ------------------------------------------------------------ the classifiers

describe('the fence classifiers, unit-tested (REQ-011)', () => {
  test('knownPartialMutation sees exactly the two documented surfaces', () => {
    expect(knownPartialMutation({ attach_failed: 'ENOSPC' })).toBe(true)
    expect(knownPartialMutation({ links: [{ to: 'x', status: 'failed' }] })).toBe(true)
    expect(knownPartialMutation({ links: [{ to: 'x', status: 'created' }, { to: 'y', status: 'exists' }] })).toBe(false)
    expect(knownPartialMutation({ attach_failed: '' })).toBe(false)
    expect(knownPartialMutation({})).toBe(false)
    expect(knownPartialMutation(undefined)).toBe(false)
    expect(knownPartialMutation([])).toBe(false)
  })

  test('precheckArguments reports rejected / admitted / unknown without running the tool', async () => {
    const dsh = await loadDshModules()
    const definitions = runtime.definitions('manage')
    const write = definitions.get('memory_write')!

    const rejected = precheckArguments(write, { body: 'no description' }, dsh.tool)
    expect(rejected.kind).toBe('rejected')
    expect((rejected as { violations: string[] }).violations.length).toBeGreaterThan(0)
    const admitted = precheckArguments(write, { description: 'd', body: 'b' }, dsh.tool)
    expect(admitted.kind).toBe('admitted')
    // A hand-made definition is not one `defineTool` built: nothing is proven,
    // so the ordinary execute path runs (and dsh latches on its own terms).
    expect(precheckArguments({ name: 'fake', parameters: {} }, {}, dsh.tool).kind).toBe('unknown')
    // The proof is bound to the EXACT object: a copy proves nothing.
    expect(precheckArguments({ ...write }, { description: 'd', body: 'b' }, dsh.tool).kind).toBe('unknown')
  })
})
