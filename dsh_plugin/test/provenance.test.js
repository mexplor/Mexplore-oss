/**
 * Write-session provenance (issue #317): the engine records WHICH root chat
 * session wrote, one line per real mutation under `.provenance/<id>.jsonl`.
 *
 * What is asserted here is the engine's contract only — DSH's root walk and
 * OpenCode's live in `bundle-provenance.test.js` and their own suites. The
 * governing rules (the design's Rules/Storage/Line schema):
 *
 *   - a wrong id is worse than a missing one: with no resolver the line says
 *     `session:null` + `no-resolver`, never `agent.id`;
 *   - only real transitions log — a no-op update, an `already` supersede and an
 *     edge that was already there write nothing;
 *   - a rolled-back successor gets no line;
 *   - fail-open: a failing append cannot throw, change the result or latch a
 *     fence;
 *   - provenance is never model-visible, and the prompt goldens stay identical.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { PROVENANCE_DIR, addEdge, appendProvenance, edgeTypeOf, edgeTypes, isEdgeEntry } from '../lib/graph.js'

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-provenance-')) })
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

/** The registrant context plugin.test.js uses, trimmed to what a write needs. */
function fakeCtx({ withPrompt = false } = {}) {
  const tools = new Map()
  const sections = []
  const variables = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(names, callback) {
      if (names.includes('systemPrompt') && !withPrompt) return
      callback({
        systemPrompt: {
          section: (section) => { sections.push(section); return () => {} },
          variable: (variableName, provider) => { variables.set(variableName, provider); return () => {} },
        },
      })
    },
  }
  return { ctx, tools, sections, variables }
}

/** A fresh graph root plus the tools of one `apply`. */
async function graph(config = {}, options) {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prov-'))
  const { ctx, tools, sections, variables } = fakeCtx(options)
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, ...config })
  return { fresh, tools, sections, variables, write: tools.get('memory_write') }
}

/** A SECOND plugin instance over an existing root — another root chat session. */
function onRoot(fresh, config = {}) {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, ...config })
  return { fresh, tools, write: tools.get('memory_write') }
}

/** Every provenance line on one node, parsed; a missing file is no lines. */
async function lines(fresh, id) {
  let text
  try {
    text = await fsp.readFile(path.join(fresh, PROVENANCE_DIR, `${id}.jsonl`), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  // Readers skip a torn last line (the design's rule): a crash mid-append must
  // not make this helper throw where the engine tolerates it.
  return text.split('\n').filter((line) => line.length > 0).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** The `op` sequence on one node, in order. */
const ops = async (fresh, id) => (await lines(fresh, id)).map((line) => line.op)

/** Each line's schema shape: v1, the full field set, no stray key. */
function assertShape(line, { op, session, reason, peer, file, type }) {
  assert.equal(line.v, 1, 'every line is v1')
  assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ts is an ISO instant from the write clock')
  assert.equal(typeof line.actor, 'string')
  assert.equal(typeof line.host, 'string')
  if (op !== undefined) assert.equal(line.op, op)
  if (session === null) {
    assert.equal(line.session, null)
    assert.equal(typeof line.reason, 'string', 'reason is present exactly when session is null')
  } else if (session !== undefined) {
    assert.equal(line.session, session)
    assert.equal(line.reason, undefined, 'reason is absent when a session is recorded')
  }
  if (peer !== undefined) assert.equal(line.peer, peer)
  if (file !== undefined) assert.equal(line.file, file)
  if (type !== undefined) assert.equal(line.type, type)
  // The closed schema: nothing beyond these keys may ride a line.
  const allowed = new Set(['v', 'ts', 'op', 'actor', 'host', 'session', 'reason', 'call', 'peer', 'file', 'type'])
  for (const key of Object.keys(line)) assert.ok(allowed.has(key), `unexpected key ${key} on a provenance line`)
}

// ---------------------------------------------------------------- the resolver

test('with no resolver a memtool-shaped exec records session:null + no-resolver, never agent.id', async () => {
  const { fresh, write } = await graph()
  // The memtool/A2A/tests shape: `agent.id` exists and is NOT a root session.
  const result = await write.execute({ description: 'no resolver here', body: 'x' }, { agent: { id: 'memtool' } })
  const [line] = await lines(fresh, result.id)
  assertShape(line, { op: 'create', session: null })
  assert.equal(line.actor, 'unknown')
  assert.equal(line.host, 'unknown')
  assert.equal(line.reason, 'no-resolver')
  assert.notEqual(line.session, 'memtool', 'a per-call agent id must never be recorded as the root')
  assert.equal(JSON.stringify(await lines(fresh, result.id)).includes('memtool'), false, 'the id appears nowhere')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('exec.provenance wins over the config hook', async () => {
  const { fresh, write } = await graph({
    provenance: () => ({ actor: 'chat', host: 'opencode', session: 'from-config' }),
  })
  const result = await write.execute(
    { description: 'stamped exec', body: 'x' },
    { provenance: { actor: 'chat', host: 'dsh', session: 'session-from-exec' } },
  )
  const [line] = await lines(fresh, result.id)
  assert.equal(line.session, 'session-from-exec', 'the exec stamp is final')
  assert.equal(line.host, 'dsh')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a hook that throws records resolver-error and the write still lands', async () => {
  const { fresh, write } = await graph({ provenance: () => { throw new Error('root walk exploded') } })
  const result = await write.execute({ description: 'hook throws', body: 'the write still lands' }, {})
  assert.equal(result.created, true, 'the write is unaffected')
  const [line] = await lines(fresh, result.id)
  assertShape(line, { op: 'create', session: null })
  assert.equal(line.reason, 'resolver-error')
  assert.equal(line.actor, 'unknown')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a malformed resolver answer maps to resolver-error, never a repaired id', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 42 }) })
  const result = await write.execute({ description: 'malformed answer', body: 'x' }, {})
  const [line] = await lines(fresh, result.id)
  assert.equal(line.session, null)
  assert.equal(line.reason, 'resolver-error')

  const blank = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: '' }) })
  const second = await blank.write.execute({ description: 'empty session', body: 'x' }, {})
  const [blankLine] = await lines(blank.fresh, second.id)
  assert.equal(blankLine.session, null, 'an empty session is malformed, not a session named nothing')
  assert.equal(blankLine.reason, 'resolver-error')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(blank.fresh, { recursive: true, force: true })
})

test('the config key is validated at load like sessionKey', async () => {
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, provenance: 'nope' }), /`provenance` must be a function/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, provenance: 5 }), /`provenance` must be a function/)
  // Absent is legal: the deployment simply has no resolver.
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root }))
})

test('only FIGURE 6 values pass: closed actor/host/reason sets, and a null session owes a reason', async () => {
  const cases = [
    ['an unknown actor', { actor: 'system', host: 'dsh', session: 's' }],
    ['an unknown host', { actor: 'chat', host: 'claude-code', session: 's' }],
    ['no reason on a null session', { actor: 'chat', host: 'dsh', session: null }],
    ['a reason outside the set', { actor: 'chat', host: 'dsh', session: null, reason: 'whatever' }],
    ['a reason beside a proven session', { actor: 'chat', host: 'dsh', session: 's', reason: 'import' }],
  ]
  for (const [label, answer] of cases) {
    const { fresh, write } = await graph({ provenance: () => answer })
    const result = await write.execute({ description: label, body: 'x' }, {})
    assert.deepEqual(await ops(fresh, result.id), ['create'], `${label}: the write still lands`)
    const [line] = await lines(fresh, result.id)
    assert.equal(line.reason, 'resolver-error', `${label} is malformed`)
    assert.equal(line.session, null)
    await fsp.rm(fresh, { recursive: true, force: true })
  }
  // Every legal value round-trips unchanged.
  for (const answer of [
    { actor: 'chat', host: 'dsh', session: 'session-a' },
    { actor: 'import', host: 'dsh', session: null, reason: 'import' },
    { actor: 'unknown', host: 'unknown', session: null, reason: 'walk-failed' },
  ]) {
    const { fresh, write } = await graph({ provenance: () => answer })
    const result = await write.execute({ description: `legal ${answer.actor}`, body: 'x' }, {})
    const [line] = await lines(fresh, result.id)
    assert.equal(line.actor, answer.actor)
    assert.equal(line.host, answer.host)
    assert.equal(line.session, answer.session)
    assert.equal(line.reason, answer.reason)
    await fsp.rm(fresh, { recursive: true, force: true })
  }
})

test('a resolver that returns nothing is resolver-error, not no-resolver', async () => {
  const { fresh, write } = await graph({ provenance: () => undefined })
  const result = await write.execute({ description: 'resolver returned nothing', body: 'x' }, {})
  const [line] = await lines(fresh, result.id)
  assert.equal(line.session, null)
  assert.equal(line.reason, 'resolver-error', 'a configured resolver owes an answer')
  // Only the absent-resolver case says no-resolver.
  const bare = await graph()
  const second = await bare.write.execute({ description: 'no resolver configured', body: 'x' }, {})
  assert.equal((await lines(bare.fresh, second.id))[0].reason, 'no-resolver')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(bare.fresh, { recursive: true, force: true })
})

test('a resolver failure warns on stderr once, and the write keeps its outcome', async () => {
  for (const [label, resolver] of [
    ['throws', () => { throw new Error('walk exploded') }],
    ['answers garbage', () => ({ actor: 'chat' })],
  ]) {
    const { fresh, write } = await graph({ provenance: resolver })
    const stderr = []
    const original = process.stderr.write
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
    let result
    try {
      result = await write.execute({ description: `resolver ${label}`, body: 'x' }, {})
    } finally {
      process.stderr.write = original
    }
    assert.equal(result.created, true, 'the write lands')
    assert.equal(result.description, `resolver ${label}`, 'the result is untouched')
    const warnings = stderr.filter((line) => /could not resolve write provenance/.test(line))
    assert.equal(warnings.length, 1, `${label}: exactly one guarded warning`)
    assert.match(warnings[0], /resolver-error/, 'the warning names the fallback, never the answer')
    assert.doesNotMatch(warnings[0], /walk exploded/, 'the resolver error text is never surfaced')
    await fsp.rm(fresh, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- each op

test('create writes exactly one create line on the new id', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const result = await write.execute({ description: 'one create', body: 'x' }, { callId: 'call-1' })
  const all = await lines(fresh, result.id)
  assert.equal(all.length, 1)
  assertShape(all[0], { op: 'create', session: 'session-a' })
  assert.equal(all[0].call, 'call-1', 'the tool call id rides the line when the exec has one')
  assert.equal(all[0].peer, undefined)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('create with an inline attachment logs create then attach', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const result = await write.execute({
    description: 'a node with a detail file',
    body: 'gist',
    attach: { filename: 'detail-file.md', content: 'the bulk detail' },
  }, {})
  assert.deepEqual(await ops(fresh, result.id), ['create', 'attach'])
  const attach = (await lines(fresh, result.id))[1]
  assertShape(attach, { op: 'attach', file: 'detail-file.md' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('create with supersedes logs create/supersede on the new id and superseded-by on the old', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const old = (await write.execute({ description: 'the decision to replace', body: 'old' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  const successor = (await write.execute({ description: 'the replacement decision', body: 'new', supersedes: old }, {})).id
  // The supersede pair IS the edge's record: the design's table gives `write
  // links`/`typed_links` an `edge` line, and a `supersedes` its own two lines.
  assert.deepEqual(await ops(fresh, successor), ['create', 'supersede'])
  assertShape((await lines(fresh, successor)).at(-1), { op: 'supersede', peer: old, type: 'supersedes' })
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'])
  const [, oldLine] = await lines(fresh, old)
  assertShape(oldLine, { op: 'superseded-by', peer: successor, type: 'supersedes' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an update logs one update line, and an unchanged echo logs nothing', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const exec = {}
  const id = (await write.execute({ description: 'stable description', body: 'first body' }, exec)).id
  await write.execute({ id, body: 'a genuinely different body' }, exec)
  assert.deepEqual(await ops(fresh, id), ['create', 'update'])
  // The echo: the same body back, then the same description back.
  await write.execute({ id, body: 'a genuinely different body' }, exec)
  await write.execute({ id, description: 'stable description' }, exec)
  assert.deepEqual(await ops(fresh, id), ['create', 'update'], 'a no-op update writes no line')
  // A description-only change IS a content transition and logs.
  await write.execute({ id, description: 'a revised description' }, exec)
  assert.deepEqual(await ops(fresh, id), ['create', 'update', 'update'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a new edge logs on both endpoints; an existing edge logs nothing', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const a = (await write.execute({ description: 'first endpoint', body: 'a' }, {})).id
  const b = (await write.execute({ description: 'second endpoint', body: 'b' }, {})).id
  await write.execute({ id: a, links: [b] }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'])
  assert.deepEqual(await ops(fresh, b), ['create', 'edge'])
  const edgeOnA = (await lines(fresh, a)).at(-1)
  assertShape(edgeOnA, { op: 'edge', peer: b })
  assert.equal(edgeOnA.type, undefined, 'a plain edge carries no type')
  // Re-adding the same link is 'exists' — no transition, no line.
  await write.execute({ id: a, links: [b] }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'])
  assert.deepEqual(await ops(fresh, b), ['create', 'edge'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed edge carries its type on both endpoints', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const a = (await write.execute({ description: 'typed edge source', body: 'a' }, {})).id
  const b = (await write.execute({ description: 'typed edge target', body: 'b' }, {})).id
  await write.execute({ id: a, typed_links: [{ id: b, type: 'relates-to' }] }, {})
  assertShape((await lines(fresh, a)).at(-1), { op: 'edge', peer: b, type: 'relates-to' })
  assertShape((await lines(fresh, b)).at(-1), { op: 'edge', peer: a, type: 'relates-to' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a HALF-EDGE repair is a transition and logs; a repeat call is a no-op and does not', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const a = (await write.execute({ description: 'half-edge plain source', body: 'a' }, {})).id
  const b = (await write.execute({ description: 'half-edge plain target', body: 'b' }, {})).id
  // Break the pair down to a single half: `addEdge` reports 'exists' when it
  // completes this, which the old status check silently dropped.
  await addEdge(fresh, a, b)
  await fsp.unlink(path.join(fresh, b, '__edges__', a))
  await write.execute({ id: a, links: [b] }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'], 'the repair is a real transition')
  assert.deepEqual(await ops(fresh, b), ['create', 'edge'])
  // The pair is complete now: the same call changes nothing and writes nothing.
  await write.execute({ id: a, links: [b] }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'], 'a repeat call is a no-op')
  assert.deepEqual(await ops(fresh, b), ['create', 'edge'])

  // Same story for the symmetric type: a relates-to repair is a transition.
  const c = (await write.execute({ description: 'half-edge typed source', body: 'c' }, {})).id
  const d = (await write.execute({ description: 'half-edge typed target', body: 'd' }, {})).id
  await addEdge(fresh, c, d, { type: 'relates-to' })
  const [lo, hi] = c < d ? [c, d] : [d, c]
  await fsp.unlink(path.join(fresh, hi, '__edges__', lo))
  await write.execute({ id: c, typed_links: [{ id: d, type: 'relates-to' }] }, {})
  assert.deepEqual(await ops(fresh, c), ['create', 'edge'], 'the relates-to repair is a real transition')
  assert.deepEqual(await ops(fresh, d), ['create', 'edge'])
  await write.execute({ id: c, typed_links: [{ id: d, type: 'relates-to' }] }, {})
  assert.deepEqual(await ops(fresh, c), ['create', 'edge'], 'a repeat typed link is a no-op')
  assert.deepEqual(await ops(fresh, d), ['create', 'edge'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a read traversal that finds the edge another root just made writes NO line (BLOCKER, item 1)', async () => {
  // The deterministic interleaving, precisely the review's window: A's
  // `touchEdge` probe finds no edge, then BEFORE A's own `addEdge` inspects the
  // slot, root B lands the complete pair. A's `addEdge` therefore creates no
  // half. A before/after `isEdgeEntry` guess attributed B's edge to A; the
  // primitive's receipt cannot, because A minted nothing.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const from = (await write.execute({ description: 'the node A arrives from', body: 'a' }, {})).id
  const to = (await write.execute({ description: 'the node A reads', body: 'b' }, {})).id
  const before = { from: (await lines(fresh, from)).length, to: (await lines(fresh, to)).length }

  // Interpose on the forward slot's SECOND readlink: #1 is A's own `touchEdge`
  // probe (natural ENOENT), #2 is `addEdge`'s ensureHalf — the instant B's write
  // lands in production. B's halves are created with the ORIGINAL primitives so
  // the hook cannot recurse.
  const realReadlink = fsp.readlink
  const realSymlink = fsp.symlink
  const forward = path.join(fresh, from, '__edges__', to)
  let probes = 0
  fsp.readlink = async (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(forward)) {
      probes += 1
      if (probes === 2) {
        fsp.readlink = realReadlink
        // Root B owns this edge, in full, before A's ensureHalf looks again.
        await realSymlink(`../../${to}`, forward)
        await realSymlink(`../../${from}`, path.join(fresh, to, '__edges__', from))
      }
    }
    return realReadlink(target, ...rest)
  }
  try {
    await tools.get('memory_read').execute({ id: to, from }, {})
  } finally {
    fsp.readlink = realReadlink
    fsp.symlink = realSymlink
  }
  assert.ok(probes >= 2, 'the interleaving ran: A probed, B landed, A probed again')
  assert.equal((await lines(fresh, from)).length, before.from, 'no edge line on the from node')
  assert.equal((await lines(fresh, to)).length, before.to, 'no edge line on the read node')
  const all = [...await lines(fresh, from), ...await lines(fresh, to)]
  assert.equal(all.some((l) => l.session === 'root-a' && l.op === 'edge'), false, 'A owns no edge it did not create')
  // The edge itself is intact — B's write, not A's.
  assert.equal(await fsp.readlink(forward), `../../${to}`)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a read traversal that completes a half-edge logs it under the reader', async () => {
  // The same receipt must still credit a REAL repair, so the fix cannot pass by
  // simply logging nothing on the read path. The read's `touchEdge` probes the
  // FORWARD half, so that is the one removed: `addEdge` restores just it and
  // reports 'exists', which is exactly the status the old check dropped.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const from = (await write.execute({ description: 'repair source here', body: 'a' }, {})).id
  const to = (await write.execute({ description: 'repair target here', body: 'b' }, {})).id
  await addEdge(fresh, from, to)
  await fsp.unlink(path.join(fresh, from, '__edges__', to))
  await tools.get('memory_read').execute({ id: to, from }, {})
  assert.deepEqual(await ops(fresh, from), ['create', 'edge'], 'the repaired forward half logs on its own node')
  assert.deepEqual(await ops(fresh, to), ['create', 'edge'], 'and on the peer')
  const line = (await lines(fresh, from)).at(-1)
  assert.equal(line.session, 'root-a', 'the reader that completed the pair owns it')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a plain edge that becomes typed logs the new type on the owner under the second root (review #319.1)', async () => {
  // The receipt used to report only newly created symlink halves, so a retype
  // — which mutates only `.edge-types` — logged nothing. Repro from the review:
  // plain link first, then a typed link from a DIFFERENT root session.
  const first = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-one' }) })
  const a = (await first.write.execute({ description: 'retype edge source', body: 'a' }, {})).id
  const b = (await first.write.execute({ description: 'retype edge target', body: 'b' }, {})).id
  // A plain edge: both halves, no sidecar type, one line per endpoint.
  await first.write.execute({ id: a, links: [b] }, {})
  assert.deepEqual(await ops(first.fresh, a), ['create', 'edge'])
  assert.deepEqual(await ops(first.fresh, b), ['create', 'edge'])
  assert.equal((await lines(first.fresh, a)).at(-1).type, undefined, 'the plain edge carries no type')

  // A second root session retypes the pair. Both halves already exist, so the
  // call reports 'exists' — but the sidecar really changed.
  const second = onRoot(first.fresh, { provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-two' }) })
  // A new root session must read the node it writes (the F68 read gate).
  await second.tools.get('memory_read').execute({ id: a }, {})
  const result = await second.write.execute({ id: a, typed_links: [{ id: b, type: 'follows-from' }] }, {})
  assert.deepEqual(result.links, [{ to: b, status: 'exists' }], 'the public status string is unchanged')
  assert.equal((await edgeTypeOf(first.fresh, a, b)) ?? (await edgeTypes(first.fresh, a)).get(b), 'follows-from', 'the sidecar really changed')

  // Exactly one new line, on the side that OWNS the record, with the new type.
  const linesOnA = (await lines(first.fresh, a)).filter((l) => l.op === 'edge')
  const linesOnB = (await lines(first.fresh, b)).filter((l) => l.op === 'edge')
  assert.equal(linesOnA.length, 2, 'the retype logged on the owner')
  assertShape(linesOnA.at(-1), { op: 'edge', peer: b, session: 'root-two', type: 'follows-from' })
  assert.equal(linesOnB.length, 1, 'the peer holds no type record, so it logs nothing new')
  assert.equal(linesOnB[0].session, 'root-one')

  // Repeating the SAME typed link is a no-op: the slot already holds the value.
  await second.write.execute({ id: a, typed_links: [{ id: b, type: 'follows-from' }] }, {})
  assert.equal((await lines(first.fresh, a)).filter((l) => l.op === 'edge').length, 2, 'an identical typed link writes no line')
  assert.equal((await lines(first.fresh, b)).filter((l) => l.op === 'edge').length, 1)
  await fsp.rm(first.fresh, { recursive: true, force: true })
})

test('a symmetric retype logs on the canonical owner only, and its repeat is silent (review #319.1)', async () => {
  // `relates-to` lives on the lexicographically smaller id, so a retype from a
  // plain edge must credit THAT node and not the peer — one record, one line.
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-one' }) })
  const a = (await write.execute({ description: 'canonical retype source', body: 'a' }, {})).id
  const b = (await write.execute({ description: 'canonical retype target', body: 'b' }, {})).id
  await write.execute({ id: a, links: [b] }, {})
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const second = onRoot(fresh, { provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-two' }) })
  await second.tools.get('memory_read').execute({ id: a }, {})
  await second.write.execute({ id: a, typed_links: [{ id: b, type: 'relates-to' }] }, {})
  assert.equal((await lines(fresh, lo)).filter((l) => l.op === 'edge').length, 2, 'the canonical owner logs the retype')
  assert.equal((await lines(fresh, hi)).filter((l) => l.op === 'edge').length, 1, 'the peer does not')
  assertShape((await lines(fresh, lo)).at(-1), { op: 'edge', peer: hi, session: 'root-two', type: 'relates-to' })
  await second.write.execute({ id: a, typed_links: [{ id: b, type: 'relates-to' }] }, {})
  assert.equal((await lines(fresh, lo)).filter((l) => l.op === 'edge').length, 2, 'the repeat writes no line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a typed supersedes link records the SAME pair as the dedicated argument (review #319.2)', async () => {
  // One representation, whichever verb spells it: `supersede` on the new node
  // and `superseded-by` on the old, with NO `edge` line for that pair.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'the decision to replace', body: 'old' }, {})).id
  const newId = (await write.execute({ description: 'the replacement decision', body: 'new' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  // The typed spelling, on a node that does not yet carry the supersedes edge:
  // both halves are auto-created AND the banner lands.
  const result = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.deepEqual(result.links, [{ to: old, status: 'created' }])
  assert.deepEqual(await ops(fresh, newId), ['create', 'supersede'], 'no edge line beside the supersede pair')
  assertShape((await lines(fresh, newId)).at(-1), { op: 'supersede', peer: old, type: 'supersedes' })
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'])
  assertShape((await lines(fresh, old)).at(-1), { op: 'superseded-by', peer: newId, type: 'supersedes' })

  // The dedicated spelling logs the identical shape, so the two cannot drift.
  const other = (await write.execute({ description: 'a second decision to replace', body: 'old2' }, {})).id
  await tools.get('memory_read').execute({ id: other }, {})
  const dedicated = (await write.execute({ description: 'a second replacement', body: 'new2', supersedes: other }, {})).id
  assert.deepEqual(await ops(fresh, dedicated), ['create', 'supersede'])
  assert.deepEqual(await ops(fresh, other), ['create', 'superseded-by'])

  // A repeat typed link on an already-bannered node records NO supersede pair.
  const beforeNew = (await lines(fresh, newId)).length
  const beforeOld = (await lines(fresh, old)).length
  await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.equal((await lines(fresh, newId)).length, beforeNew, 'an already-bannered node gets no second supersede line')
  assert.equal((await lines(fresh, old)).length, beforeOld, 'and no second superseded-by')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an already-bannered typed supersedes link writes no edge line either (review 3, item 4)', async () => {
  // The reviewer's exact sequence: supersede the pair, retype its edge to
  // `follows-from`, then request the typed `supersedes` again. The banner is
  // already there, so the last call adds nothing — and the retype back to
  // `supersedes` must NOT leak out as a separate `edge` line, which is what the
  // old fallback did.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'the decision to unify', body: 'old' }, {})).id
  const newId = (await write.execute({ description: 'the unified replacement', body: 'new' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  // 1. Supersede through the typed spelling: the banner lands.
  await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.deepEqual(await ops(fresh, newId), ['create', 'supersede'])
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'])
  // 2. Retype the pair's edge to `follows-from`: the sidecar changes to a
  //    non-supersedes type, so the banner no longer matches the edge.
  await tools.get('memory_read').execute({ id: newId }, {})
  await write.execute({ id: newId, typed_links: [{ id: old, type: 'follows-from' }] }, {})
  assert.equal((await edgeTypes(fresh, newId)).get(old), 'follows-from', 'the sidecar really moved off supersedes')
  const newBefore = (await lines(fresh, newId)).length
  const oldBefore = (await lines(fresh, old)).length
  // 3. Ask for the typed supersedes AGAIN. The banner already exists, so
  //    `supersede` returns 'already' — but the follower receipt reports a real
  //    type change back to 'supersedes'. Neither may produce a line.
  const result = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.deepEqual(result.links, [{ to: old, status: 'exists' }], 'the call reports the link as already present')
  assert.equal((await lines(fresh, newId)).length, newBefore, 'no line on the new node: no supersede pair, no edge line')
  assert.equal((await lines(fresh, old)).length, oldBefore, 'and none on the old node')
  const written = [...await lines(fresh, newId), ...await lines(fresh, old)]
  assert.equal(written.filter((l) => l.op === 'supersede' || l.op === 'superseded-by').length, 2, 'exactly the original banner pair, never a second')
  // The step-2 retype WAS a real edge-type change and legitimately logged one
  // line; what must never appear is an `edge` line typed `supersedes` — that
  // pair is recorded only by the banner.
  const edgeLines = written.filter((l) => l.op === 'edge')
  assert.equal(edgeLines.length, 1, 'only the follows-from retype from step 2 is logged')
  assertShape(edgeLines[0], { op: 'edge', peer: old, type: 'follows-from' })
  assert.equal(written.some((l) => l.op === 'edge' && l.type === 'supersedes'), false, 'never an edge line for a supersedes pair')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_attach logs one attach line with the file name', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const id = (await write.execute({ description: 'attach target', body: 'x' }, {})).id
  await tools.get('memory_attach').execute({ id, filename: 'report-2025W32.md', content: 'body of the report' }, {})
  assert.deepEqual(await ops(fresh, id), ['create', 'attach'])
  assertShape((await lines(fresh, id)).at(-1), { op: 'attach', file: 'report-2025W32.md' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_read with from wires a missing edge and logs it on both ends, once', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const a = (await write.execute({ description: 'read from here', body: 'a' }, {})).id
  const b = (await write.execute({ description: 'arrive at this one', body: 'b' }, {})).id
  await tools.get('memory_read').execute({ id: b, from: a }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'])
  assert.deepEqual(await ops(fresh, b), ['create', 'edge'])
  // A second traversal over the now-existing edge is a touch, not a wire.
  await tools.get('memory_read').execute({ id: b, from: a }, {})
  assert.deepEqual(await ops(fresh, a), ['create', 'edge'], 'a traversal over an existing edge writes no line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_merge logs merge on keep and merged-into on absorb', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const keep = (await write.execute({ description: 'the node to keep', body: 'kept' }, {})).id
  const absorb = (await write.execute({ description: 'the duplicate to fold in', body: 'folded' }, {})).id
  await tools.get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {})
  assert.deepEqual(await ops(fresh, keep), ['create', 'merge'])
  assert.deepEqual(await ops(fresh, absorb), ['create', 'merged-into'])
  assertShape((await lines(fresh, keep)).at(-1), { op: 'merge', peer: absorb })
  assertShape((await lines(fresh, absorb)).at(-1), { op: 'merged-into', peer: keep })
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_restore takes an exec and logs restore', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const id = (await write.execute({ description: 'will be archived', body: 'x' }, {})).id
  // Archive it out of band — the same move maintenance makes.
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, id), path.join(fresh, '.archive', id))
  await tools.get('memory_restore').execute({ id }, { agent: { id: 'a-subagent' } })
  assert.deepEqual(await ops(fresh, id), ['create', 'restore'])
  const [line] = (await lines(fresh, id)).filter((l) => l.op === 'restore')
  assert.equal(line.session, 'session-a', 'the restore reads the resolver, not agent.id')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('markUnwrittenAttachment logs annotate for the correction it appends', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const exec = (text) => ({ agent: { session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] } } })
  const turn = 'The Demo access review covered CedarCheck and MapleCheck as vendors, and the grace period is six weeks.'
  const id = (await write.execute({ description: '周报', body: '周报完整内容存于附件 weekly.md。' }, exec(turn))).id
  // Fabricated prose: under the traceability floor, so the attach is refused
  // AND the body's promise is corrected.
  const untraceable = '# 季度营收复盘\n\n昨天的董事会确认了三项决议：一是把仓储合约续到明年三月，二是把配送半径缩到八公里，三是把客服排班改成两班制。\n'.repeat(4)
  await assert.rejects(
    () => tools.get('memory_attach').execute({ id, filename: 'weekly.md', content: untraceable }, exec(turn)),
    /not traceable/,
  )
  assert.deepEqual(await ops(fresh, id), ['create', 'annotate'])
  assertShape((await lines(fresh, id)).at(-1), { op: 'annotate', file: 'weekly.md' })
  await fsp.rm(fresh, { recursive: true, force: true })
})

// ---------------------------------------------------------------- no-ops

test('a refused write, an already-supersede and a refused attach write no lines', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const exec = (text) => ({ agent: { session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] } } })
  const turn = 'The Demo access review covered CedarCheck and MapleCheck as vendors, and the grace period is six weeks.'
  const seeded = (await write.execute({ description: 'a node that stays put', body: 'x' }, exec(turn))).id
  // A malformed call is rejected by the trusted preparation: no handler, no line.
  await assert.rejects(() => write.execute({ description: 'bad link', links: ['NOTANID'] }, exec(turn)))
  assert.deepEqual(await ops(fresh, seeded), ['create'], 'a rejected call writes no line')
  // An attach the turn does not carry: the gate refuses, nothing lands, no line.
  const untraceable = '# 季度营收复盘\n\n昨天的董事会确认了三项决议：一是把仓储合约续到明年三月，二是把配送半径缩到八公里，三是把客服排班改成两班制。\n'.repeat(4)
  await assert.rejects(
    () => tools.get('memory_attach').execute({ id: seeded, filename: 'nope.md', content: untraceable }, exec(turn)),
    /not traceable/,
  )
  assert.deepEqual(await ops(fresh, seeded), ['create'], 'a refused attach writes no line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('an already-superseded node gets no second superseded-by line', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const old = (await write.execute({ description: 'the node superseded twice', body: 'old' }, {})).id
  const first = (await write.execute({ description: 'the first successor', body: 'one', supersedes: old }, {})).id
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'])
  // A second create naming the SAME successor is an 'already' supersede: the
  // banner was there, so nothing transitioned and no line may be added.
  await write.execute({ description: 'a different node entirely', body: 'unrelated' }, {})
  const before = (await lines(fresh, old)).length
  // Re-run the supersede through a typed link, the other spelling of the same
  // mutation: the edge exists, the banner is in place, so nothing changes.
  await write.execute({ id: first, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.equal((await lines(fresh, old)).length, before, 'no superseded-by line for an already-superseded node')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a committed update keeps its line when a later typed-supersede gate rejects the call (item 3)', async () => {
  // The review's fixture, dsh_plugin/test/refusals.test.js:612-651: the id
  // update lands, then the locked typed-supersede re-check throws. The partial
  // write is RETAINED (`updateNode` already committed), so its `update` line
  // must be too — the flush now runs in an outer `finally`.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const source = (await write.execute({ description: 'locked update source', body: 'source body' }, {})).id
  const target = (await write.execute({ description: 'locked update target', body: 'target body' }, {})).id
  await tools.get('memory_read').execute({ id: source }, {})
  await tools.get('memory_read').execute({ id: target }, {})
  // A peer write lands after the existence and unlocked supersede checks:
  // those first two reads see the original; the locked re-check sees the edit.
  const targetFile = path.join(fresh, target, 'node.md')
  const original = await fsp.readFile(targetFile)
  const realReadFile = fsp.readFile
  let targeted = 0
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(targetFile)) {
      targeted += 1
      if (targeted > 2) return Buffer.from(`${original.toString('utf8')}\n- edited elsewhere\n`, 'utf8')
    }
    return realReadFile(filePath, ...rest)
  }
  let error
  try {
    await write.execute({ id: source, body: 'revised source body', typed_links: [{ id: target, type: 'supersedes' }] }, {})
  } catch (thrown) {
    error = thrown
  } finally {
    fsp.readFile = realReadFile
  }
  assert.ok(targeted > 2, 'the locked re-check ran after both pre-checks')
  assert.match(error.message, /changed since it was read — a Stale Write/)
  // The update really is retained on disk...
  assert.match(await fsp.readFile(path.join(fresh, source, 'node.md'), 'utf8'), /revised source body/)
  // ...so it must carry its line, even though the call threw.
  assert.deepEqual(await ops(fresh, source), ['create', 'update'], 'the retained update is logged despite the throw')
  // The rejected typed supersede created no edge and the target kept its body.
  assert.deepEqual(await ops(fresh, target), ['create'], 'no edge line for the rejected link')
  assert.deepEqual(Buffer.from(await fsp.readFile(targetFile)), Buffer.from(original), 'the target itself is untouched')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a successor a peer built on survives a rollback AND keeps its create line (item 3)', async () => {
  // `rollbackSuccessor` spares a successor another writer touched, so that
  // create is still in the graph — and therefore still needs its line. The
  // rollback's own `removed` answer decides, never the fact that the call threw.
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'a decision to replace', body: 'old rationale' }, {})).id
  const peer = (await write.execute({ description: 'a peer that links later', body: 'p' }, {})).id
  const oldFile = path.join(fresh, old, 'node.md')
  const realReadFile = fsp.readFile
  const successorIdSeen = new Set()
  let successorId
  // The locked banner re-check is this call's SECOND read of the old node. On
  // it, a peer links TO the just-published successor — the shape a rollback must
  // spare — and then the gate sees changed bytes and rejects.
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(oldFile)) {
      const successor = (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n) && n !== old && n !== peer)
        .find((n) => !successorIdSeen.has(n))
      if (successor !== undefined && successorId === undefined) {
        successorId = successor
        successorIdSeen.add(successor)
        await fsp.mkdir(path.join(fresh, peer, '__edges__'), { recursive: true })
        await fsp.mkdir(path.join(fresh, successor, '__edges__'), { recursive: true })
        await fsp.symlink(`../../${successor}`, path.join(fresh, peer, '__edges__', successor))
        await fsp.symlink(`../../${peer}`, path.join(fresh, successor, '__edges__', peer))
        fsp.readFile = realReadFile
        const changed = `${(await realReadFile(filePath)).toString('utf8')}\n- edited elsewhere\n`
        return Buffer.from(changed, 'utf8')
      }
    }
    return realReadFile(filePath, ...rest)
  }
  try {
    await assert.rejects(
      () => write.execute({ description: 'the would-be successor', supersedes: old }, {}),
      /Stale Write/,
    )
  } finally {
    fsp.readFile = realReadFile
  }
  assert.ok(successorId, 'the call reached the locked re-check after creating the successor')
  assert.ok(await fsp.stat(path.join(fresh, successorId)).then(() => true, () => false), 'the successor survived, because a peer built on it')
  assert.deepEqual(await ops(fresh, successorId), ['create'], 'the surviving create keeps its line')
  assert.deepEqual(await ops(fresh, old), ['create'], 'the rejected supersede bannered nothing')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a rollback drops only the successor lines: the peer half it left on disk keeps its own (item B)', async () => {
  // A create that links a peer AND carries a typed supersede: the plain link
  // lands both halves, then the typed-supersede gate rejects the call and
  // `rollbackSuccessor` removes the successor directory. The peer's reciprocal
  // symlink is in the PEER's `__edges__`, which the rollback never touches, so
  // that half is still a real (dangling) edge — and its line must survive.
  // Dropping every line whose `peer` named the successor lost it.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const peer = (await write.execute({ description: 'the peer the successor links', body: 'p' }, {})).id
  const target = (await write.execute({ description: 'the node the typed link names', body: 't' }, {})).id
  // The target is read, so the UNLOCKED typed pre-check passes; the locked
  // re-check then sees changed bytes and rejects.
  await tools.get('memory_read').execute({ id: target }, {})
  const targetFile = path.join(fresh, target, 'node.md')
  const original = await fsp.readFile(targetFile)
  const realReadFile = fsp.readFile
  let targetReads = 0
  let successorId
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(targetFile)) {
      targetReads += 1
      if (targetReads > 2) return Buffer.from(`${original.toString('utf8')}\n- edited elsewhere\n`, 'utf8')
    }
    return realReadFile(filePath, ...rest)
  }
  let error
  try {
    await write.execute({
      description: 'the successor that gets rolled back',
      body: 's',
      links: [peer],
      typed_links: [{ id: target, type: 'supersedes' }],
    }, {})
  } catch (thrown) {
    error = thrown
  } finally {
    fsp.readFile = realReadFile
  }
  assert.match(error?.message ?? '', /Stale Write/, 'the locked typed re-check rejected the call')
  // The successor is gone; the peer keeps the reciprocal half the rollback
  // never touched. That half is what the surviving line describes.
  const liveIds = (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n) && n !== peer && n !== target)
  assert.deepEqual(liveIds, [], 'the rolled-back successor is gone')
  const peerEdges = await fsp.readdir(path.join(fresh, peer, '__edges__')).catch(() => [])
  assert.equal(peerEdges.length, 1, 'the peer still holds its half')
  const survivor = peerEdges[0]
  successorId = survivor
  assert.equal(await isEdgeEntry(fresh, peer, survivor), true, 'and it still qualifies as an edge (dangling)')
  // The successor has no provenance file at all...
  assert.deepEqual(await ops(fresh, successorId), [], 'the removed successor kept no lines')
  // ...and the peer's edge line matches the half that is actually on disk.
  const peerEdgeLines = (await lines(fresh, peer)).filter((l) => l.op === 'edge')
  assert.equal(peerEdgeLines.length, 1, 'exactly one surviving peer edge line')
  assert.equal(peerEdgeLines[0].peer, survivor, 'the line names the peer of the half on disk')
  // Nothing on the peer carries an edge the sidecar disagrees with.
  assert.deepEqual(peerEdgeLines.map((l) => l.peer), peerEdges, 'the peer lines and its __edges__ agree')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a rolled-back successor writes no line at all', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const old = (await write.execute({ description: 'a decision soon unwritable', body: 'original rationale' }, {})).id
  // Make the BANNER write fail after validation, which is the path that runs
  // rollbackSuccessor: the old node's directory refuses writes.
  await fsp.chmod(path.join(fresh, old), 0o555)
  try {
    const before = new Set((await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)))
    await assert.rejects(() => write.execute({ description: 'the would-be successor', supersedes: old }, {}))
    const after = (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n))
    assert.equal(after.some((n) => !before.has(n)), false, 'no successor survives')
  } finally {
    await fsp.chmod(path.join(fresh, old), 0o755)
  }
  // The old node never got a banner, so it has no superseded-by line.
  assert.deepEqual(await ops(fresh, old), ['create'])
  // No orphan provenance file exists for a node that no longer does.
  const files = await fsp.readdir(path.join(fresh, PROVENANCE_DIR))
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, '')
    assert.ok(await fsp.stat(path.join(fresh, id)).then(() => true, () => false), `no provenance file survives for a gone node (${id})`)
  }
  // The old node's node.md is untouched, and no error escaped the rollback.
  assert.equal((await tools.get('memory_read').execute({ id: old }, {})).body, 'original rationale')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the automatic observation logs an attach when it is published, and none when unchanged (item 5)', async () => {
  // The review's regression: an update whose BODY is unchanged but whose
  // prompting turn changed overwrites observation.txt — a real mutation that
  // used to produce neither an `update` nor an `attach` line.
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  // A turn ≥ 2000 chars and ≥ 4x the gist makes the auto-capture fire.
  const turn = (label) => ({
    agent: { session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `${label} ${'σ'.repeat(2400)}` }] }] } },
  })
  const first = await write.execute({ description: 'the gist', body: 'short gist body' }, turn('turn one'))
  assert.deepEqual(await ops(fresh, first.id), ['create', 'attach'], 'the create published its observation')
  assertShape((await lines(fresh, first.id)).at(-1), { op: 'attach', file: 'observation.txt' })
  // Same body, same description, DIFFERENT turn: only the capture changes.
  await write.execute({ id: first.id, body: 'short gist body' }, turn('turn two'))
  assert.deepEqual(await ops(fresh, first.id), ['create', 'attach', 'attach'], 'the changed capture is its own attach, and the body logged no update')
  // Same body and same turn: the capture is unchanged, so nothing at all logs.
  await write.execute({ id: first.id, body: 'short gist body' }, turn('turn two'))
  assert.deepEqual(await ops(fresh, first.id), ['create', 'attach', 'attach'], 'an unchanged capture writes no line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a failed auto-capture adds no attach line', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const turn = { agent: { session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(2400) }] }] } } }
  const id = (await write.execute({ description: 'capture target', body: 'tiny' }, turn)).id
  assert.deepEqual(await ops(fresh, id), ['create', 'attach'])
  // Make the observation write fail: a directory squats on the filename.
  await fsp.rm(path.join(fresh, id, 'observation.txt'), { force: true })
  await fsp.mkdir(path.join(fresh, id, 'observation.txt'))
  const stderr = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  try {
    await write.execute({ id, body: 'a different body entirely' }, turn)
  } finally {
    process.stderr.write = original
  }
  const after = await ops(fresh, id)
  assert.equal(after.filter((op) => op === 'attach').length, 1, 'the failed capture added no attach line')
  assert.ok(after.includes('update'), 'and the landed body update still has its line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('merge → restore → merge produces no duplicate lines', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const keep = (await write.execute({ description: 'kept through two merges', body: 'kept' }, {})).id
  const absorb = (await write.execute({ description: 'folded in once', body: 'folded' }, {})).id
  await tools.get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {})
  await tools.get('memory_restore').execute({ id: absorb }, {})
  await tools.get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {})
  const keepOps = await ops(fresh, keep)
  assert.deepEqual(keepOps, ['create', 'merge', 'merge'], 'each merge is one line, never duplicated')
  const absorbOps = await ops(fresh, absorb)
  assert.deepEqual(absorbOps, ['create', 'merged-into', 'restore', 'merged-into'], 'restore is its own transition, and the second merge is one line')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// ---------------------------------------------------------------- fail-open

test('a failed append (read-only .provenance) never throws and never changes the result', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  // A file where the directory belongs: every append fails with ENOTDIR.
  await fsp.writeFile(path.join(fresh, PROVENANCE_DIR), 'not a directory')
  const stderr = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  let result
  try {
    result = await write.execute({ description: 'the write outlives its bookkeeping', body: 'x' }, {})
  } finally {
    process.stderr.write = original
  }
  assert.equal(result.created, true, 'the write lands')
  assert.match(result.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.ok(stderr.some((line) => /could not append 1 provenance line/.test(line)), 'one guarded stderr line names the failure')
  assert.equal(result.provenance, undefined, 'never in the result')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a symlinked .provenance directory is refused, not followed', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prov-outside-'))
  await fsp.symlink(outside, path.join(fresh, PROVENANCE_DIR))
  const stderr = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  let result
  try {
    result = await write.execute({ description: 'planted dir link', body: 'x' }, {})
  } finally {
    process.stderr.write = original
  }
  assert.equal(result.created, true, 'the write lands')
  assert.ok(stderr.some((line) => /refusing to append (into|through)/.test(line)), 'the refusal is reported on stderr')
  assert.deepEqual(await fsp.readdir(outside), [], 'nothing was written through the link')
  // The engine's own primitive refuses too, so a caller cannot bypass it.
  await assert.rejects(() => appendProvenance(fresh, result.id, [{ v: 1 }]), /refusing to append into a non-directory/)
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outside, { recursive: true, force: true })
})

test('a symlinked LEAF is refused by the open itself, so a swap after any inspection writes nothing outside', async () => {
  const { fresh } = await graph()
  const node = '01JC0000000000000000000001'
  await fsp.mkdir(path.join(fresh, node), { recursive: true })
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prov-leaf-'))
  const victim = path.join(outsideDir, 'victim.jsonl')
  await fsp.writeFile(victim, 'untouched\n')
  // The directory is real; only the LEAF is a link. Nothing here inspects the
  // leaf before the open, so this is exactly the "replaced between inspection
  // and use" shape the review named — O_NOFOLLOW refuses it at open time.
  await fsp.mkdir(path.join(fresh, PROVENANCE_DIR), { recursive: true })
  await fsp.symlink(victim, path.join(fresh, PROVENANCE_DIR, `${node}.jsonl`))
  await assert.rejects(
    () => appendProvenance(fresh, node, [{ v: 1, op: 'create' }]),
    /ELOOP|EMLINK|EEXIST|too many symbolic links|symbolic link/i,
  )
  assert.equal(await fsp.readFile(victim, 'utf8'), 'untouched\n', 'the link target was never appended to')
  assert.deepEqual(await fsp.readdir(outsideDir), ['victim.jsonl'], 'nothing else landed outside the graph')
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(outsideDir, { recursive: true, force: true })
})

test('a FIFO at the leaf fails fast with no reader, and the write still lands', async () => {
  // A FIFO opened O_WRONLY blocks forever with no reader — the node mutation has
  // already landed, so the tool would hang until the delegation timed out. The
  // append now opens with O_NONBLOCK and then requires a REGULAR file.
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const seeded = (await write.execute({ description: 'fifo leaf target', body: 'x' }, {})).id
  await fsp.rm(path.join(fresh, PROVENANCE_DIR, `${seeded}.jsonl`), { force: true })
  const fifo = path.join(fresh, PROVENANCE_DIR, `${seeded}.jsonl`)
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo available')
  const stderr = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true }
  let result
  const started = Date.now()
  try {
    result = await write.execute({ id: seeded, body: 'the body that must still land' }, {})
  } finally {
    process.stderr.write = original
  }
  assert.ok(Date.now() - started < 5000, 'the call did not block on the FIFO')
  assert.equal(result.created, false, 'the write lands')
  assert.ok(stderr.some((line) => /could not append 1 provenance line/.test(line)), 'the refusal is one guarded stderr line')
  // No reader means `open` itself fails fast (ENXIO on macOS/Linux); with one,
  // the descriptor check names the non-regular file. Either way the refusal is
  // deliberate, never a hang, and the reason is on stderr.
  assert.match(stderr.join(''), /ENXIO|no such device|non-regular file|ENXIO/, 'the failure names a reason')
  // The body really landed, and nothing went through the pipe.
  assert.match(await fsp.readFile(path.join(fresh, seeded, 'node.md'), 'utf8'), /the body that must still land/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a FIFO with a reader gets nothing: the descriptor check refuses before writing', async () => {
  // With a reader present the open succeeds; the fstat is what stops the block
  // from being sent down the pipe instead of stored. The reader end is held by
  // this test (O_RDONLY|O_NONBLOCK on a FIFO succeeds with no writer), so the
  // state is deterministic instead of racing a child process.
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const seeded = (await write.execute({ description: 'fifo with reader', body: 'x' }, {})).id
  const file = path.join(fresh, PROVENANCE_DIR, `${seeded}.jsonl`)
  await fsp.rm(file, { force: true })
  assert.equal(spawnSync('mkfifo', [file]).status, 0)
  const reader = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
  try {
    await assert.rejects(() => appendProvenance(fresh, seeded, [{ v: 1, op: 'update' }]), /non-regular file/)
    // Nothing was sent through the pipe: our end reads EAGAIN/zero bytes.
    const probe = Buffer.alloc(64)
    const read = await reader.read(probe, 0, probe.length, null).catch((error) => ({ bytesRead: 0, error }))
    assert.equal(read.bytesRead, 0, 'nothing was sent through the pipe')
  } finally {
    await reader.close()
  }
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a directory at the leaf is refused', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-a' }) })
  const seeded = (await write.execute({ description: 'dir leaf target', body: 'x' }, {})).id
  const leaf = path.join(fresh, PROVENANCE_DIR, `${seeded}.jsonl`)
  await fsp.rm(leaf, { force: true })
  await fsp.mkdir(leaf)
  await assert.rejects(() => appendProvenance(fresh, seeded, [{ v: 1, op: 'update' }]), /EISDIR|is a directory|non-regular file/i)
  assert.deepEqual(await fsp.readdir(leaf), [], 'nothing was written into it')
  await fsp.rm(fresh, { recursive: true, force: true })
})

// ---------------------------------------------------------------- never model-visible

test('no tool result, render or prompt carries provenance, and node.md bytes are unchanged', async () => {
  const { fresh, tools, variables } = await graph(
    { provenance: () => ({ actor: 'chat', host: 'dsh', session: 'session-secret-root' }) },
    { withPrompt: true },
  )
  const write = tools.get('memory_write')
  const created = await write.execute({ description: 'a node whose write is attributed', body: 'the gist' }, { callId: 'call-xyz' })
  const nodeBytes = await fsp.readFile(path.join(fresh, created.id, 'node.md'), 'utf8')
  // The section renders without any trace of the session, the actor or the op.
  const index = variables.get('memory_index')()
  const sectionText = variables
    ? index
    : ''
  for (const needle of ['session-secret-root', 'provenance', PROVENANCE_DIR, 'call-xyz']) {
    assert.equal(JSON.stringify(created).includes(needle), false, `the tool result must not carry ${needle}`)
    assert.equal(sectionText.includes(needle), false, `the prompt index must not carry ${needle}`)
  }
  // node.md itself is untouched by the bookkeeping (it lives outside the node).
  assert.doesNotMatch(nodeBytes, /session-secret-root/)
  assert.doesNotMatch(nodeBytes, /provenance/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

// ---------------------------------------------------------------- failure paths (#321)
//
// Each test injects ONE fault, asserts it actually fired, then asserts the lines
// match what is on disk. Every patch is path-scoped and restored in `finally`;
// nothing here adds a production seam, chmods a file, or uses `crashAt`.

/** Run `fn` with `fsp[name]` patched, restoring the original in `finally`. */
async function withPatched(method, patch, fn) {
  const real = fsp[method]
  fsp[method] = patch(real)
  try {
    return await fn()
  } finally {
    fsp[method] = real
  }
}

/** Whether a path exists, without throwing. */
const exists = (target) => fsp.stat(target).then(() => true, () => false)

test('#321/1: a read whose touchEdge throws after the wiring still logs the edge on both ends', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const from = (await write.execute({ description: 'read wiring source', body: 'a' }, {})).id
  const to = (await write.execute({ description: 'read wiring target', body: 'b' }, {})).id
  const access = path.join(fresh, '.access', `${from}.log`)
  let fired = false
  // The wiring's `touchEdge` is the FIRST append to this log — the natural miss
  // before it never gets that far. Failing the open is the exact slot where the
  // access record is written (`appendBookkeeping` opens, then writes the handle).
  await withPatched('open', (real) => async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(access)) {
      fired = true
      throw new Error('injected access append failure')
    }
    return real(file, ...rest)
  }, async () => {
    const read = await tools.get('memory_read').execute({ id: to, from }, {})
    assert.equal(read.id, to, 'the read itself still succeeds')
  })
  assert.equal(fired, true, 'the injected touch failure fired after the wiring landed')
  // The edge really is on disk, and both ends carry its line.
  assert.equal(await isEdgeEntry(fresh, from, to), true)
  assert.equal(await isEdgeEntry(fresh, to, from), true)
  assert.deepEqual(await ops(fresh, from), ['create', 'edge'], 'the from end logs the edge it landed')
  assert.deepEqual(await ops(fresh, to), ['create', 'edge'], 'and so does the read node')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/2: a plain link whose reverse half throws logs one line on the source only', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const src = (await write.execute({ description: 'link source here', body: 'a' }, {})).id
  const dst = (await write.execute({ description: 'link target here', body: 'b' }, {})).id
  const reverse = path.join(fresh, dst, '__edges__', src)
  let fired = false
  await withPatched('symlink', (real) => async (target, link, ...rest) => {
    if (path.resolve(String(link)) === path.resolve(reverse)) {
      fired = true
      throw new Error('injected reverse symlink failure')
    }
    return real(target, link, ...rest)
  }, async () => {
    const result = await write.execute({ id: src, links: [dst] }, {})
    assert.deepEqual(result.links, [{ to: dst, status: 'failed' }], 'the link reports failed')
  })
  assert.equal(fired, true, 'the reverse half really failed')
  // Only the forward half is on disk.
  assert.equal(await isEdgeEntry(fresh, src, dst), true, 'the forward half landed')
  assert.equal(await isEdgeEntry(fresh, dst, src), false, 'the reverse half did not')
  assert.deepEqual(await ops(fresh, src), ['create', 'edge'], 'one line on the source')
  assert.deepEqual(await ops(fresh, dst), ['create'], 'and nothing on the peer, which holds no half')
  assertShape((await lines(fresh, src)).at(-1), { op: 'edge', peer: dst })
  assert.equal((await lines(fresh, src)).at(-1).type, undefined, 'a half whose type may never have landed claims none')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/3: a typed link whose sidecar write throws logs untyped halves only, never a phantom type', async () => {
  const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const src = (await write.execute({ description: 'typed failure source', body: 'a' }, {})).id
  const dst = (await write.execute({ description: 'typed failure target', body: 'b' }, {})).id
  // A directed type: the pair is one symlink plus a sidecar line on the source.
  const sidecar = path.join(fresh, src, '__edges__', '.edge-types')
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    // writeAtomic stages then renames; the destination is the sidecar itself.
    if (path.resolve(String(to)) === path.resolve(sidecar)) {
      fired = true
      throw new Error('injected sidecar rename failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    const result = await write.execute({ id: src, typed_links: [{ id: dst, type: 'follows-from' }] }, {})
    assert.deepEqual(result.links, [{ to: dst, status: 'failed' }], 'the typed link reports failed')
  })
  assert.equal(fired, true, 'the sidecar write really failed')
  assert.equal(await isEdgeEntry(fresh, src, dst), true, 'the directed symlink landed')
  assert.deepEqual([...(await edgeTypes(fresh, src))], [], 'and its type never did')
  assert.deepEqual(await ops(fresh, src), ['create', 'edge'], 'one untyped line on the source')
  assertShape((await lines(fresh, src)).at(-1), { op: 'edge', peer: dst })
  assert.deepEqual(await ops(fresh, dst), ['create'], 'a directed half leaves the peer nothing to log')
  await fsp.rm(fresh, { recursive: true, force: true })

  // The SYMMETRIC spelling: both halves land, then the canonical sidecar write
  // throws. Both endpoints really hold the edge, so both log it — untyped, since
  // the sidecar write is what failed.
  const symmetric = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-b' }) })
  const a = (await symmetric.write.execute({ description: 'symmetric sidecar source', body: 'a' }, {})).id
  const b = (await symmetric.write.execute({ description: 'symmetric sidecar target', body: 'b' }, {})).id
  const owner = a < b ? a : b
  const symSidecar = path.join(symmetric.fresh, owner, '__edges__', '.edge-types')
  let symFired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(symSidecar)) {
      symFired = true
      throw new Error('injected symmetric sidecar failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    const result = await symmetric.write.execute({ id: a, typed_links: [{ id: b, type: 'relates-to' }] }, {})
    assert.deepEqual(result.links, [{ to: b, status: 'failed' }], 'the symmetric link reports failed')
  })
  assert.equal(symFired, true, 'the symmetric sidecar write really failed')
  assert.equal(await isEdgeEntry(symmetric.fresh, a, b), true)
  assert.equal(await isEdgeEntry(symmetric.fresh, b, a), true)
  assert.deepEqual([...(await edgeTypes(symmetric.fresh, owner))], [], 'no type record landed')
  assert.deepEqual(await ops(symmetric.fresh, a), ['create', 'edge'], 'the source logs its half')
  assert.deepEqual(await ops(symmetric.fresh, b), ['create', 'edge'], 'and the peer logs its own mirror half')
  for (const id of [a, b]) {
    assertShape((await lines(symmetric.fresh, id)).at(-1), { op: 'edge', peer: id === a ? b : a })
    assert.equal((await lines(symmetric.fresh, id)).at(-1).type, undefined, 'no type is claimed where none is on disk')
  }
  await fsp.rm(symmetric.fresh, { recursive: true, force: true })
})

test('#321/4: a typed supersede whose banner throws logs the successor-side edge only — no supersede pair', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'banner target that blocks', body: 'old' }, {})).id
  const newId = (await write.execute({ description: 'would-be successor', body: 'new' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  // Fail the banner's atomic rename into the OLD node's node.md, AFTER the
  // supersedes symlink has landed.
  const bannerFile = path.join(fresh, old, 'node.md')
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(bannerFile)) {
      fired = true
      throw new Error('injected banner rename failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    const result = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
    assert.deepEqual(result.links, [{ to: old, status: 'failed' }], 'the link reports failed')
  })
  assert.equal(fired, true, 'the banner write really failed')
  // The successor's directed half is on disk; the banner is not.
  assert.equal(await isEdgeEntry(fresh, newId, old), true)
  assert.doesNotMatch(await fsp.readFile(bannerFile, 'utf8'), /Superseded by/)
  assert.deepEqual(await ops(fresh, newId), ['create', 'edge'], 'the successor logs the half it landed')
  assertShape((await lines(fresh, newId)).at(-1), { op: 'edge', peer: old, type: 'supersedes' })
  assert.deepEqual(await ops(fresh, old), ['create'], 'nothing on the old node — no banner, no superseded-by')
  const all = [...await lines(fresh, newId), ...await lines(fresh, old)]
  assert.equal(all.some((l) => l.op === 'supersede' || l.op === 'superseded-by'), false, 'never a supersede op without a banner')

  // #321/14 — the retry: the same call now banners. The old node gains
  // `superseded-by`, the successor gains `supersede`, and the already-landed
  // edge half writes no duplicate line (its receipt is empty on the retry).
  await tools.get('memory_read').execute({ id: old }, {})
  const retried = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
  assert.deepEqual(retried.links, [{ to: old, status: 'exists' }], 'the edge is already there')
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'])
  assert.deepEqual(await ops(fresh, newId), ['create', 'edge', 'supersede'], 'one edge line from the failed attempt, then the pair — never a second edge')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/5: a typed supersede whose moveExtraFiles throws logs the pair only', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'move failure banner target', body: 'old' }, {})).id
  const newId = (await write.execute({ description: 'move failure successor', body: 'new' }, {})).id
  // An attachment on the OLD node is what moveExtraFiles moves to the successor.
  await tools.get('memory_attach').execute({ id: old, filename: 'moves.md', content: 'a file that moves' }, {})
  await tools.get('memory_read').execute({ id: old }, {})
  const dest = path.join(fresh, newId, 'moves.md')
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(dest)) {
      fired = true
      throw new Error('injected move failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    const result = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
    // The banner landed before the move, so the links row reports the failure
    // of the whole link — but the pair must still be recorded.
    assert.deepEqual(result.links, [{ to: old, status: 'failed' }])
  })
  assert.equal(fired, true, 'the attachment move really failed')
  // The banner is on disk (it preceded the move) and the pair alone is logged.
  assert.match(await fsp.readFile(path.join(fresh, old, 'node.md'), 'utf8'), /Superseded by/)
  assert.deepEqual(await ops(fresh, newId), ['create', 'supersede'], 'the pair, and no edge line')
  assert.deepEqual(await ops(fresh, old), ['create', 'attach', 'superseded-by'])
  assert.equal(await exists(path.join(fresh, newId)), true, 'the successor a landed banner names is still live')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/5b: a banner whose attachment move threw still protects the successor from a later gate reject', async () => {
  // The receipt guard on the typed path: the FIRST target's banner lands, then
  // its `moveExtraFiles` throws. That throw is not the end of the call — an
  // ordinary per-link failure — so a SECOND typed target then hits the
  // stale-gate reject. Only the receipt-based `bannerLanded` (set before the
  // move) can stop the rollback from orphaning a banner that is already on disk;
  // the old success-path assignment never runs on a path that threw.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const first = (await write.execute({ description: 'the target whose move throws', body: 'one' }, {})).id
  const second = (await write.execute({ description: 'the target that goes stale', body: 'two' }, {})).id
  // The first target carries a file, so its supersede has something to move —
  // and to fail on.
  await tools.get('memory_attach').execute({ id: first, filename: 'moves.md', content: 'a file that moves' }, {})
  await tools.get('memory_read').execute({ id: first }, {})
  await tools.get('memory_read').execute({ id: second }, {})
  const secondFile = path.join(fresh, second, 'node.md')
  const original = await fsp.readFile(secondFile)
  const before = new Set((await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)))
  let successorId
  let reads = 0
  let moveFired = false
  let readerRestored = false
  const realReadFile = fsp.readFile
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(secondFile) && ++reads > 2) {
      successorId ??= (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n) && !before.has(n))[0]
      return Buffer.from(`${original.toString('utf8')}\n- edited elsewhere\n`, 'utf8')
    }
    return realReadFile(filePath, ...rest)
  }
  let error
  try {
    await withPatched('rename', (real) => async (from, to, ...rest) => {
      // The first target's attachment, on its way into the successor.
      if (typeof to === 'string' && path.basename(to) === 'moves.md' && path.dirname(to) !== path.join(fresh, first)) {
        moveFired = true
        // Remove the newly minted half in the fault window. Without this, an
        // unowned edge would spare the successor even if bannerLanded broke,
        // masking the invariant this test is meant to exercise.
        await fsp.unlink(path.join(path.dirname(to), '__edges__', first))
        throw new Error('injected first-target move failure')
      }
      return real(from, to, ...rest)
    }, async () => {
      await write.execute({
        description: 'the bannered successor',
        body: 's',
        // Use valid, unambiguous arguments. The injected move failure removes
        // the first edge half so only the landed banner can spare the successor.
        typed_links: [{ id: first, type: 'supersedes' }, { id: second, type: 'supersedes' }],
      }, {}).then((value) => value, (thrown) => { error = thrown })
    })
  } finally {
    fsp.readFile = realReadFile
    readerRestored = true
  }
  assert.equal(readerRestored, true)
  assert.equal(moveFired, true, 'the first target\'s attachment move really failed')
  assert.ok(reads > 2, 'the locked re-check ran after both pre-checks on the second target')
  assert.match(error?.message ?? '', /Stale Write/, 'the second target rejected the call')
  assert.ok(successorId !== undefined, 'the successor existed when the reject arrived')
  // The successor a landed banner names was NOT unpublished, and both banner
  // lines are present — the pair from the first (thrown-move) supersede.
  // There is no plain link and no remaining edge half to protect the successor;
  // it survives because a banner on disk names it.
  assert.equal(await exists(path.join(fresh, successorId)), true, 'a successor a banner already names is not unpublished')
  assert.match(await fsp.readFile(path.join(fresh, first, 'node.md'), 'utf8'), /Superseded by/, 'and its banner is really on disk')
  assert.deepEqual(await ops(fresh, first), ['create', 'attach', 'superseded-by'], 'the old node keeps its banner line')
  assert.deepEqual(await ops(fresh, successorId), ['create', 'supersede'], 'the successor keeps the pair without an extra edge line')
  assert.equal((await lines(fresh, successorId)).some((l) => l.op === 'edge' && l.type === 'supersedes'), false, 'never an edge line for the supersede pair')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/5c: an already-bannered retype whose late-file move throws writes no line (review 1, item 1)', async () => {
  // The `already` exit is a no-op supersede with a FALLIBLE late-file move
  // after it. When that move throws, the old code saw "supersede never
  // returned" and turned the call's committed sidecar-retype receipts into
  // `edge` lines — a retype the design says logs nothing. The `already`
  // receipt (pushed before the move) is what keeps that path silent.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'already-bannered retype target', body: 'old' }, {})).id
  const newId = (await write.execute({ description: 'already-bannered successor', body: 'new', supersedes: old }, {})).id
  assert.deepEqual(await ops(fresh, old), ['create', 'superseded-by'], 'the first banner landed')
  // A LATE file on the OLD node: it would be moved by the `already` path's own
  // moveExtraFiles, which is the step this test makes throw.
  await tools.get('memory_attach').execute({ id: old, filename: 'late.md', content: 'a late file' }, {})
  // Retype the pair's edge away from `supersedes`, so asking for it again is a
  // real sidecar change the call would otherwise have a receipt for.
  await tools.get('memory_read').execute({ id: newId }, {})
  await write.execute({ id: newId, typed_links: [{ id: old, type: 'follows-from' }] }, {})
  assert.equal((await edgeTypes(fresh, newId)).get(old), 'follows-from', 'the sidecar really moved off supersedes')
  const beforeNew = (await lines(fresh, newId)).length
  const beforeOld = (await lines(fresh, old)).length
  const dest = path.join(fresh, newId, 'late.md')
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(dest)) {
      fired = true
      throw new Error('injected late-file move failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    // The link reports failed, so the throw really did reach the caller.
    const result = await write.execute({ id: newId, typed_links: [{ id: old, type: 'supersedes' }] }, {})
    assert.deepEqual(result.links, [{ to: old, status: 'failed' }], 'the already-bannered retry reports failed')
  })
  assert.equal(fired, true, 'the late-file move really failed')
  // The sidecar retype DID commit before the move threw — and still logs no
  // line, exactly as an `already` supersede must not.
  assert.equal(await isEdgeEntry(fresh, newId, old), true, 'the edge is in place')
  assert.equal((await lines(fresh, newId)).length, beforeNew, 'nothing new on the successor — no edge line, no second supersede')
  assert.equal((await lines(fresh, old)).length, beforeOld, 'and nothing on the old node')
  assert.equal((await lines(fresh, newId)).some((l) => l.op === 'edge' && l.type === 'supersedes'), false, 'never an edge line typed supersedes')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/6: a create-path supersede that banners then fails its move keeps superseded-by and drops the ghost successor', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'create-path move target', body: 'old' }, {})).id
  await tools.get('memory_attach').execute({ id: old, filename: 'carried.md', content: 'a carried file' }, {})
  await tools.get('memory_read').execute({ id: old }, {})
  const before = new Set((await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)))
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    // The successor's id is not known up front; match the moved attachment name.
    if (typeof to === 'string' && path.basename(to) === 'carried.md' && path.dirname(to) !== path.join(fresh, old)) {
      fired = true
      throw new Error('injected create-path move failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    await assert.rejects(
      () => write.execute({ description: 'the ghost successor', body: 'new', supersedes: old }, {}),
      /injected create-path move failure/,
    )
  })
  assert.equal(fired, true, 'the create-path move really failed')
  const after = (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n))
  assert.deepEqual(after.filter((n) => !before.has(n)), [], 'the rollback removed the successor')
  // The banner stayed on disk, so its line stays; nothing names the gone node.
  assert.match(await fsp.readFile(path.join(fresh, old, 'node.md'), 'utf8'), /Superseded by/)
  assert.deepEqual(await ops(fresh, old), ['create', 'attach', 'superseded-by'], 'the old node keeps the banner and its line')
  const ghost = (await fsp.readdir(path.join(fresh, PROVENANCE_DIR))).map((f) => f.replace(/\.jsonl$/, '')).filter((id) => !before.has(id))
  assert.deepEqual(ghost, [], 'no provenance file survives for the deleted successor')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/7: a create-path supersede whose banner throws leaves no lines anywhere', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'create-path banner target', body: 'old' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  const bannerFile = path.join(fresh, old, 'node.md')
  const before = new Set((await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)))
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(bannerFile)) {
      fired = true
      throw new Error('injected banner rename failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    await assert.rejects(
      () => write.execute({ description: 'the bannerless successor', body: 'new', supersedes: old }, {}),
      /injected banner rename failure/,
    )
  })
  assert.equal(fired, true, 'the banner write really failed')
  const after = (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n))
  assert.deepEqual(after.filter((n) => !before.has(n)), [], 'the rollback removed the successor')
  assert.deepEqual(await ops(fresh, old), ['create'], 'no superseded-by without a banner')
  const ghosts = (await fsp.readdir(path.join(fresh, PROVENANCE_DIR))).map((f) => f.replace(/\.jsonl$/, '')).filter((id) => !before.has(id))
  assert.deepEqual(ghosts, [], 'and no line for the deleted successor either')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/8: a directed edge toward a rolled-back successor leaves no ghost line on the peer', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const old = (await write.execute({ description: 'directed ghost target', body: 'old' }, {})).id
  const peer = (await write.execute({ description: 'directed ghost peer', body: 'p' }, {})).id
  // The read happens BEFORE the patch. Existence and unlocked supersede
  // checks are reads #1 and #2; the LOCKED re-check is #3 and rejects.
  await tools.get('memory_read').execute({ id: old }, {})
  const oldFile = path.join(fresh, old, 'node.md')
  const original = await fsp.readFile(oldFile)
  const before = new Set((await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n)))
  let successorId
  let reads = 0
  await assert.rejects(
    () => withPatched('readFile', (real) => async (filePath, ...rest) => {
      if (path.resolve(String(filePath)) === path.resolve(oldFile) && ++reads > 2) {
        successorId ??= (await fsp.readdir(fresh)).filter((n) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(n) && !before.has(n))[0]
        return Buffer.from(`${original.toString('utf8')}\n- edited elsewhere\n`, 'utf8')
      }
      return real(filePath, ...rest)
    }, () => write.execute({
      description: 'the directed successor',
      body: 's',
      typed_links: [
        // A DIRECTED link to the peer lands first, and its success fan-out
        // writes a line on the peer too — but the half itself lives only in the
        // successor's `__edges__`.
        { id: peer, type: 'follows-from' },
        { id: old, type: 'supersedes' },
      ],
    }, {})),
    /Stale Write/,
  )
  assert.ok(reads > 2, 'the locked re-check ran after both pre-checks and rejected')
  assert.ok(successorId !== undefined, 'the successor existed before the rollback')
  assert.equal(await exists(path.join(fresh, successorId)), false, 'the successor was rolled back')
  // The directed half lived only in the successor's dir, so the peer holds
  // nothing — and therefore no line on the peer may name it.
  const peerEdges = await fsp.readdir(path.join(fresh, peer, '__edges__')).catch(() => [])
  assert.deepEqual(peerEdges, [], 'the peer holds no half')
  assert.deepEqual((await lines(fresh, peer)).filter((l) => l.op === 'edge'), [], 'and no ghost edge line naming the gone successor')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/9: a lock release that throws after attach and merge still logs each line once', async () => {
  // Restore is not here: `restoreNode` takes no node lock (its own failure mode
  // is the best-effort `touchRead`, covered by #321/10), so there is no lock
  // release to fault-inject on that path.
  for (const kind of ['attach', 'merge']) {
    const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
    const one = (await write.execute({ description: `${kind} lock target one`, body: 'a' }, {})).id
    const two = (await write.execute({ description: `${kind} lock target two`, body: 'b' }, {})).id
    // Fail the release of ONE specific lock directory: the mutation before it has
    // already committed, and `withNodeLocks` rethrows the release failure.
    const lockDir = path.join(fresh, '.locks', `${kind === 'merge' ? two : one}.lock`)
    let fired = false
    await withPatched('rmdir', (real) => async (target, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(lockDir)) {
        fired = true
        throw new Error('injected lock release failure')
      }
      return real(target, ...rest)
    }, async () => {
      let error
      try {
        if (kind === 'attach') await tools.get('memory_attach').execute({ id: one, filename: 'locks.md', content: 'payload' }, {})
        else await tools.get('memory_merge').execute({ keep_id: one, absorb_id: two }, {})
      } catch (thrown) {
        error = thrown
      }
      assert.match(error?.message ?? '', /injected lock release failure/, `${kind}: the fault fired`)
    })
    assert.equal(fired, true, `${kind}: the lock release really failed`)
    if (kind === 'attach') assert.deepEqual(await ops(fresh, one), ['create', 'attach'], 'the attach is logged exactly once')
    if (kind === 'merge') {
      assert.deepEqual(await ops(fresh, one), ['create', 'merge'], 'merge on keep, once')
      assert.deepEqual(await ops(fresh, two), ['create', 'merged-into'], 'merged-into on absorb, once')
    }
    await fsp.rm(fresh, { recursive: true, force: true })
  }
})

test('#321/9b: a typed link whose lock release throws after addEdge returned keeps the success fan-out (review 2, item 1)', async () => {
  for (const type of ['follows-from', 'relates-to']) {
    const { fresh, write } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
    const src = (await write.execute({ description: `${type} lock source`, body: 'a' }, {})).id
    const dst = (await write.execute({ description: `${type} lock target`, body: 'b' }, {})).id
    const forward = path.join(fresh, src, '__edges__', dst)
    let fired = false
    // Fail a lock release only once the edge is on disk — i.e. the release of the
    // sidecar-owner lock that wrapped a completed `addEdge`.
    await withPatched('rmdir', (real) => async (target, ...rest) => {
      if (!fired && String(target).includes(`${path.sep}.locks${path.sep}`) && fs.existsSync(forward)) {
        fired = true
        await real(target, ...rest)
        throw new Error('injected lock release failure')
      }
      return real(target, ...rest)
    }, async () => {
      const result = await write.execute({ id: src, typed_links: [{ id: dst, type }] }, {})
      assert.deepEqual(result.links, [{ to: dst, status: 'failed' }], `${type}: the release failure surfaces as a failed link`)
    })
    assert.equal(fired, true, `${type}: the lock release really failed after the edge landed`)
    assert.equal(await isEdgeEntry(fresh, src, dst), true)
    for (const [id, peer] of [[src, dst], [dst, src]]) {
      assert.deepEqual(await ops(fresh, id), ['create', 'edge'], `${type}: ${id === src ? 'source' : 'peer'} logs the completed edge once`)
      assertShape((await lines(fresh, id)).at(-1), { op: 'edge', peer, type })
    }
    await fsp.rm(fresh, { recursive: true, force: true })
  }
})

test('#321/10: a restore whose touchRead throws still succeeds and writes its restore line', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const id = (await write.execute({ description: 'restore touch target', body: 'x' }, {})).id
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, id), path.join(fresh, '.archive', id))
  const access = path.join(fresh, '.access', `${id}.log`)
  let fired = false
  // `touchRead` writes through `appendBookkeeping`, which OPENS the leaf (then
  // writes the handle) — so the open is the slot this fault belongs in.
  await withPatched('open', (real) => async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(access)) {
      fired = true
      throw new Error('injected touch failure')
    }
    return real(file, ...rest)
  }, async () => {
    const result = await tools.get('memory_restore').execute({ id }, {})
    assert.deepEqual(result, { id, restored: true }, 'the restore succeeds despite the touch failure')
  })
  assert.equal(fired, true, 'the touch really failed')
  assert.equal(await exists(path.join(fresh, id)), true, 'the node is live')
  assert.deepEqual(await ops(fresh, id), ['create', 'restore'], 'and its restore line landed')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/11: a merge that fails between keep-update and absorb-banner logs merge on keep only', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const keep = (await write.execute({ description: 'partial merge keep', body: 'kept' }, {})).id
  const absorb = (await write.execute({ description: 'partial merge absorb', body: 'folded' }, {})).id
  await tools.get('memory_attach').execute({ id: absorb, filename: 'moves.md', content: 'a moving file' }, {})
  const dest = path.join(fresh, keep, 'moves.md')
  let fired = false
  // moveExtraFiles runs BEFORE absorb's banner — a rename-based fault here lands
  // between the two receipts.
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(dest)) {
      fired = true
      throw new Error('injected mid-merge failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    await assert.rejects(
      () => tools.get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {}),
      /injected mid-merge failure/,
    )
  })
  assert.equal(fired, true, 'the mid-merge fault fired')
  // Keep's note landed; absorb was never bannered.
  assert.match(await fsp.readFile(path.join(fresh, keep, 'node.md'), 'utf8'), /Merged from/)
  assert.doesNotMatch(await fsp.readFile(path.join(fresh, absorb, 'node.md'), 'utf8'), /Merged into/)
  assert.deepEqual(await ops(fresh, keep), ['create', 'merge'], 'merge on keep alone')
  assert.deepEqual(await ops(fresh, absorb), ['create', 'attach'], 'no merged-into without its banner')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/12: a merge whose archive rename throws logs merge and merged-into; absorb stays live and bannered', async () => {
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const keep = (await write.execute({ description: 'archive failure keep', body: 'kept' }, {})).id
  const absorb = (await write.execute({ description: 'archive failure absorb', body: 'folded' }, {})).id
  const archived = path.join(fresh, '.archive', absorb)
  let fired = false
  await withPatched('rename', (real) => async (from, to, ...rest) => {
    if (path.resolve(String(to)) === path.resolve(archived)) {
      fired = true
      throw new Error('injected archive rename failure')
    }
    return real(from, to, ...rest)
  }, async () => {
    await assert.rejects(
      () => tools.get('memory_merge').execute({ keep_id: keep, absorb_id: absorb }, {}),
      /injected archive rename failure/,
    )
  })
  assert.equal(fired, true, 'the archive rename really failed')
  assert.equal(await exists(path.join(fresh, absorb)), true, 'absorb is still live')
  assert.match(await fsp.readFile(path.join(fresh, absorb, 'node.md'), 'utf8'), /Merged into/, 'and bannered')
  assert.deepEqual(await ops(fresh, keep), ['create', 'merge'])
  assert.deepEqual(await ops(fresh, absorb), ['create', 'merged-into'], 'the pair is logged because both banners landed')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/13: markUnwrittenAttachment logs annotate exactly once when the post-append re-read throws', async () => {
  const exec = { agent: { session: { deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'The Demo access review covered CedarCheck and MapleCheck as vendors, and the grace period is six weeks.' }] }] } } }
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const id = (await write.execute({ description: '周报', body: '周报完整内容存于附件 weekly.md。' }, exec)).id
  const nodeFile = path.join(fresh, id, 'node.md')
  let reads = 0
  let fired = false
  const untraceable = '# 季度营收复盘\n\n昨天的董事会确认了三项决议：一是把仓储合约续到明年三月，二是把配送半径缩到八公里，三是把客服排班改成两班制。\n'.repeat(4)
  // The post-append refresh is the read AFTER the correction landed: fail it so
  // the throw happens between the append and the flush.
  await withPatched('readFile', (real) => async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(nodeFile)) {
      reads += 1
      // Reads: (1) the correction predicate, (2) the post-append hash refresh.
      if (rest.length === 0 && reads >= 2 && !fired) {
        fired = true
        throw new Error('injected post-append read failure')
      }
    }
    return real(filePath, ...rest)
  }, async () => {
    await assert.rejects(
      () => tools.get('memory_attach').execute({ id, filename: 'weekly.md', content: untraceable }, exec),
      /injected post-append read failure|not traceable/,
    )
  })
  assert.equal(fired, true, 'the post-append re-read really failed')
  assert.match(await fsp.readFile(nodeFile, 'utf8'), /未写入/, 'the correction really is on disk')
  assert.deepEqual(await ops(fresh, id), ['create', 'annotate'], 'annotate is logged exactly once')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('#321/14b: one array fed by several nested drains writes each line exactly once', async () => {
  // `recordProvenance` drains its input at entry, which is what makes handing
  // the same array over twice safe — but no current handler does that, so the
  // drain itself is not reachable from here and this test does not claim to
  // exercise it. What IS reachable, and what a double-append bug would break,
  // is the shape the drain protects: ONE array fed from several nested
  // `finally` blocks (the plain-links and typed links loops each drain their own
  // per-iteration receipt into `provenanceLines`; the supersede pair arrives
  // from its own inner `finally`), then flushed once by the handler's outer
  // `finally`. Every transition must appear exactly once.
  const { fresh, write, tools } = await graph({ provenance: () => ({ actor: 'chat', host: 'dsh', session: 'root-a' }) })
  const plain = (await write.execute({ description: 'drain check plain link', body: 'a' }, {})).id
  const typed = (await write.execute({ description: 'drain check typed link', body: 'b' }, {})).id
  const old = (await write.execute({ description: 'drain check superseded', body: 'c' }, {})).id
  await tools.get('memory_read').execute({ id: old }, {})
  const result = await write.execute({
    description: 'drain check successor',
    body: 'd',
    links: [plain],
    typed_links: [{ id: typed, type: 'relates-to' }],
    supersedes: old,
  }, {})
  const own = await lines(fresh, result.id)
  const counted = (op) => own.filter((l) => l.op === op).length
  assert.equal(counted('create'), 1, 'the create appears once')
  assert.equal(counted('supersede'), 1, 'the supersede pair appears once')
  // One edge line per distinct peer: the plain link and the typed one.
  assert.deepEqual(own.filter((l) => l.op === 'edge').map((l) => l.peer).sort(), [plain, typed].sort(), 'one edge line per peer, no duplicate')
  assert.equal((await ops(fresh, old)).filter((op) => op === 'superseded-by').length, 1, 'and the old node gets one superseded-by')
  await fsp.rm(fresh, { recursive: true, force: true })
})
