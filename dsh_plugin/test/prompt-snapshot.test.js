/**
 * #263 (wave 3, lever 1): the run-stable MANAGE prompt (`promptSnapshot: 'run'`).
 *
 * W3-lite's `indexSnapshot: 'run'` freezes the two graph-derived variables for a
 * READ run and drops them on a successful write. At manage authority that drop
 * is the whole problem: the run's job is to change the graph, so it re-splices
 * its own system prompt after nearly every write, and because the system message
 * heads the request, each splice invalidates the provider's cached prefix for
 * the entire tool history behind it.
 *
 * `promptSnapshot: 'run'` freezes EVERY prompt variable that can change mid-run
 * and never drops. These tests pin that across writes that create, revise, link
 * and attach; pin that the tools stay live; and pin that the default (no
 * `promptSnapshot`) is byte-for-byte today's behaviour.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { createNode } from '../lib/graph.js'

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-')) })
after(async () => { await fsp.rm(root, { recursive: true, force: true }) })

/** The plugin's registry double, recording the prompt variable providers. */
function fakeCtx() {
  const tools = new Map()
  const variables = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(_names, callback) {
      callback({
        systemPrompt: {
          section: () => () => {},
          variable: (name, provider) => { variables.set(name, provider); return () => {} },
        },
      })
    },
  }
  return { ctx, tools, variables }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Run `fn` with `Date.now` shifted forward — no real waiting, no timers. */
async function atTimeOffset(offsetMs, fn) {
  const real = Date.now
  const base = real()
  Date.now = () => base + offsetMs
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

/**
 * One full assembly, in the section's own order, over every variable that can
 * change mid-run. Returns the whole rendered prompt as one string — which is
 * what the provider's prefix cache actually sees.
 */
function assemble(variables, context = { agent: { phase: { turn: 1 } }, scope: {}, signal: undefined }) {
  const names = [
    'memory_learn_bullet',
    'memory_batch_writes',
    'memory_unknown_rule',
    'memory_write_guidance',
    'memory_identifiers',
    'memory_link_bullets',
    'memory_type_bullet',
    'memory_supersede_bullets',
    'memory_today',
    'memory_context_date',
    'memory_date_rules',
    'memory_calendar',
    'memory_dates_separator',
    'memory_handoffs',
    'memory_index',
  ]
  return names.map((name) => {
    const provider = variables.get(name)
    assert.ok(provider !== undefined, `${name} is registered`)
    const value = provider(context)
    assert.equal(typeof value, 'string', `${name} answered with a string`)
    return value
  }).join('\n')
}

/** A manage run's full surface, wired the way the A2A wrapper wires it. */
function manageRun(graphRoot, extra = {}) {
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot, indexCacheMs: 0, promptProfile: 'manage', promptSnapshot: 'run', ...extra })
  return { tools, variables }
}

/** The control arm: the same manage surface with the flag OFF. */
function manageRunUnfrozen(graphRoot) {
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot, indexCacheMs: 0, promptProfile: 'manage' })
  return { tools, variables }
}

test('promptSnapshot config: absent is the default, a wrong value fails loud', async () => {
  // Absent stays absent — the legacy shape, which the wrapper relies on.
  const silent = fakeCtx()
  assert.doesNotThrow(() => apply(silent.ctx, { graphRoot: root }))
  const opted = fakeCtx()
  assert.doesNotThrow(() => apply(opted.ctx, { graphRoot: root, promptSnapshot: 'run' }))
  // 'off' is not a synonym for absent, exactly like `indexSnapshot`.
  for (const value of ['off', true, 1, null, 'full']) {
    const { ctx } = fakeCtx()
    assert.throws(
      () => apply(ctx, { graphRoot: root, promptSnapshot: value }),
      /`promptSnapshot` must be 'run' when present/,
      `${JSON.stringify(value)} must be refused at load`,
    )
  }
})

test('every system message is byte-identical across create, revise, link and attach', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-stable-'))
  // A handoff and an unlinked node, so the banner, the orphan census and the
  // index all have something to render — and something to change.
  const handoff = await createNode(fresh, { description: 'pending: the report the user is owed', type: 'handoff' })
  await createNode(fresh, { description: 'an island with no edges at all' })
  const { tools, variables } = manageRun(fresh)
  await settle()
  const write = tools.get('memory_write')
  const attach = tools.get('memory_attach')

  // Step 1: the run's opening prompt.
  const first = assemble(variables)
  assert.match(first, /pending: the report the user is owed/, 'the banner rendered')
  assert.match(first, /an island with no edges at all/, 'the index rendered')

  // Step 2: a CREATE — new index membership, and one MORE orphan (a fresh node
  // has no edges until a later step links it).
  const created = await write.execute({ description: 'a fact this run just stored', body: 'the body' }, {})
  assert.equal(assemble(variables), first, 'a create does not re-splice the prompt')

  // Step 3: a REVISE — the index's own description line changes.
  await write.execute({ id: created.id, description: 'a fact this run just stored, reworded', body: 'the body' }, {})
  assert.equal(assemble(variables), first, 'a description revision does not re-splice the prompt')

  // Step 4: a LINK — degree changes, so rank changes.
  await write.execute({ id: created.id, links: [handoff] }, {})
  assert.equal(assemble(variables), first, 'a link does not re-splice the prompt')

  // Step 5: an ATTACH — the standalone route, which has its own drop path.
  await attach.execute({ id: created.id, filename: 'runbook.md', content: 'the ship steps, in full' }, {})
  assert.equal(assemble(variables), first, 'an attach does not re-splice the prompt')

  // And the freeze is not a TTL accident: a large clock jump changes nothing,
  // including the runtime date and the calendar strip built from it.
  assert.equal(await atTimeOffset(7 * 24 * 3600_000, async () => assemble(variables)), first, 'the prompt holds across a week of wall clock')

  // A HANDOFF created mid-run would otherwise move the banner above the index.
  await createNode(fresh, { description: 'a handoff another process opened mid-run', type: 'handoff' })
  assert.equal(assemble(variables), first, 'the banner is frozen too')

  // Proof the assertions above are not vacuous: the SAME graph and the SAME
  // writes without the flag re-splice the prompt at every one of them.
  const live = manageRunUnfrozen(fresh)
  const liveFirst = assemble(live.variables)
  await live.tools.get('memory_write').execute({ description: 'a fact the control run stored' }, {})
  assert.notEqual(assemble(live.variables), liveFirst, 'without the flag the prompt re-splices (the behaviour #263 fixes)')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the tools stay live: similar sees this run\'s create, read sees the revised body', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-live-'))
  await createNode(fresh, { description: 'the deploy target is the staging box' })
  const { tools, variables } = manageRun(fresh)
  await settle()
  const write = tools.get('memory_write')
  const search = tools.get('memory_search')
  const read = tools.get('memory_read')
  const first = assemble(variables)

  // A create inside this run, then a near-duplicate: the `similar` advisory is a
  // TOOL result, so it must see the node the prompt's frozen index does not.
  const created = await write.execute({ description: 'the deploy target is the staging box in Frankfurt', body: 'v1' }, {})
  const dup = await write.execute({ description: 'the deploy target is the staging box in Frankfurt, again' }, {})
  assert.ok(dup.similar.some((m) => m.id === created.id), '`similar` sees the node this run created')
  assert.ok(!first.includes('Frankfurt'), 'the frozen prompt never mentioned it')

  // A revise, then a read: the body is the LIVE one.
  await write.execute({ id: created.id, body: 'v2 — the live body' }, {})
  const view = await read.execute({ id: created.id }, {})
  assert.match(JSON.stringify(view), /v2 — the live body/, '`memory_read` returns the revised body')

  // And search reads the graph as it is now, not the prompt's opening view.
  const found = await search.execute({ query: 'Frankfurt' }, {})
  assert.ok(found.matches.some((m) => m.id === created.id), '`memory_search` sees current state')

  // The prompt itself never moved.
  assert.equal(assemble(variables), first)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the zero-write notice and the duplicate block are frozen with the rest', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-blocks-'))
  // Both blocks are dotfile-driven: they can change with NO write through the
  // plugin, so they are exactly what a per-render freeze has to cover.
  const { tools, variables } = manageRun(fresh)
  await settle()
  const first = assemble(variables)
  assert.ok(!first.includes('exited without writing anything'), 'no notice on a clean graph')

  const stamp = new Date().toISOString()
  await fsp.writeFile(path.join(fresh, '.zero-write-turns'), `${stamp} 1234\n`)
  const a = await createNode(fresh, { description: 'first duplicate candidate' })
  const b = await createNode(fresh, { description: 'second duplicate candidate' })
  await fsp.writeFile(path.join(fresh, '.duplicates'), `${a} ${b}\n`)
  assert.equal(assemble(variables), first, 'a new zero-write notice and duplicate block do not re-splice the prompt')

  // The control: the same dotfiles DO change an unfrozen render.
  const live = manageRunUnfrozen(fresh)
  assert.match(assemble(live.variables), /exited without writing anything/, 'the notice is real — the flag is what hides it')
  // Sanity: the graph is untouched by the probes.
  assert.deepEqual((await fsp.readdir(fresh)).filter((name) => name.startsWith('.')).sort(), ['.duplicates', '.zero-write-turns'])
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the F62 blind-rewrite guard still fires per assembly under the freeze', async () => {
  // MINOR (review): the other tests always assemble at turn 1, so moving
  // `startTurn` INSIDE the frozen thunk would leave them all green while the
  // guard silently stopped seeing turn boundaries. The side effect is not the
  // prompt text, and freezing it would let one turn's reads vouch for the next
  // turn's rewrite — the exact hole F62 exists to close.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-turn-'))
  const nodeId = await createNode(fresh, { description: 'the dock gate code', body: 'Gate code 4417.' })
  const { tools, variables } = manageRun(fresh)
  await settle()
  const write = tools.get('memory_write')
  const assembleAt = (turn) => assemble(variables, { agent: { phase: { turn } }, scope: {}, signal: undefined })

  // Turn 4, step 1: assemble, then read the node this turn may revise.
  const step1 = assembleAt(4)
  await tools.get('memory_read').execute({ id: nodeId }, {})
  // Turn 4, step 2: the same turn re-assembles. The prompt is frozen; the read
  // still vouches for the write that follows it.
  assert.equal(assembleAt(4), step1)
  const informed = await write.execute({ id: nodeId, body: 'Gate code 4417. Spare key in the lockbox.' }, {})
  assert.equal(informed.blind_rewrite, undefined, 'a step boundary is not a turn boundary')

  // Turn 5 assembles: the guard resets, even though the prompt bytes did not
  // move. This is only observable if `memory_today` really ran per assembly.
  assert.equal(assembleAt(5), step1, 'the prompt is frozen across the turn boundary too')
  const blind = await write.execute({ id: nodeId, body: 'Facilities handles access now; ask them.' }, {})
  assert.ok(blind.blind_rewrite > 0, 'memory_today still evaluates per assembly, so the turn reset still fires')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('promptSnapshot and indexSnapshot are independent levers', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-both-'))
  // `indexSnapshot` alone must NOT survive a write at manage — that is its
  // documented contract, and this lever exists because it is the wrong one here.
  const indexOnly = fakeCtx()
  apply(indexOnly.ctx, { graphRoot: fresh, indexCacheMs: 0, indexSnapshot: 'run' })
  const first = indexOnly.variables.get('memory_index')()
  await indexOnly.tools.get('memory_write').execute({ description: 'a fact that drops an indexSnapshot' }, {})
  assert.notEqual(indexOnly.variables.get('memory_index')(), first, 'indexSnapshot still drops on a write (unchanged)')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the default (no promptSnapshot) keeps today\'s TTL-driven re-render', async () => {
  // Mount the bare plugin without a snapshot key to verify the default
  // TTL-driven behavior independently of any host's authority policy.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-prompt-snapshot-default-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  await settle()
  const before = assemble(variables)
  // Seeded out of band, since no write tool is exercised here.
  await createNode(fresh, { description: 'a fact another process stored' })
  assert.match(assemble(variables), /a fact another process stored/, 'the default keeps re-rendering')
  assert.notEqual(assemble(variables), before)
  await fsp.rm(fresh, { recursive: true, force: true })
})
