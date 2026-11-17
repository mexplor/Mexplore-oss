/**
 * #263 W3-lite: the run-stable index snapshot (`indexSnapshot: 'run'`).
 *
 * The rendered `memory_index` / `memory_handoffs` prompt text is normally
 * re-evaluated behind `indexCacheMs`, and even a read-authority run perturbs
 * the graph: `memory_read` appends access lines, and a traversal read can wire
 * a missing edge — ranking counts both, so this run's own reads re-rank the
 * index (graph.js rankIndex). That re-render rewrites the system prompt at a
 * step boundary and breaks the provider's prefix cache, so the run opts into
 * freezing those two DISPLAYED strings. These tests pin the freeze, its
 * boundaries, and that the default (no `indexSnapshot`) is byte-for-byte
 * today's behavior.
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
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-')) })
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

/** Yield once, for the async warm-up paths that only need pending work drained. */
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

const firstLine = (text) => text.split('\n')[0].slice(0, 26)

test('indexSnapshot config: absent is the default, a wrong value fails loud', () => {
  // Absent stays absent — the legacy shape, which the wrapper relies on.
  const silent = fakeCtx()
  assert.doesNotThrow(() => apply(silent.ctx, { graphRoot: root }))
  const opted = fakeCtx()
  assert.doesNotThrow(() => apply(opted.ctx, { graphRoot: root, indexSnapshot: 'run' }))
  // `'off'` is not a synonym for absent: a deployment that wants today's
  // behavior simply omits the field, so a typo cannot look deliberate.
  for (const value of ['off', true, 1, null]) {
    const { ctx } = fakeCtx()
    assert.throws(
      () => apply(ctx, { graphRoot: root, indexSnapshot: value }),
      /`indexSnapshot` must be 'run' when present/,
      `${JSON.stringify(value)} must be refused at load`,
    )
  }
})

test('with indexSnapshot: run, two assemblies past the TTL with a read between them are byte-identical', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-freeze-'))
  const read = await createNode(fresh, { description: 'node the run reads first' })
  const other = await createNode(fresh, { description: 'node the run has not read', body: 'x'.repeat(40) })
  // A tiny TTL so the second assembly is unambiguously past it.
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const handoffs = () => variables.get('memory_handoffs')()

  const firstIndex = index()
  const firstHandoffs = handoffs()
  // The read that re-ranks: a direct read of `other` re-ranks it above the
  // newest-first tie-break, so an unsnapshotted render WOULD reorder.
  await tools.get('memory_read').execute({ id: other }, {})
  await tools.get('memory_read').execute({ id: other }, {})
  const reordered = await atTimeOffset(60_000, async () => index())
  assert.equal(reordered, firstIndex, 'the prompt index is byte-identical past the TTL')
  assert.equal(await atTimeOffset(60_000, async () => handoffs()), firstHandoffs)

  // The handoff banner is frozen too. Open one OUT OF BAND (another process's
  // write — a read run has no write tool here, and a write through the plugin
  // would legitimately drop the snapshot), then assemble again: the banner must
  // still be the run's opening bytes.
  await createNode(fresh, { description: 'a handoff another process opened mid-run', type: 'handoff' })
  assert.equal(await atTimeOffset(60_000, async () => handoffs()), firstHandoffs, 'the banner is frozen with the index')
  assert.equal(await atTimeOffset(60_000, async () => index()), firstIndex)

  // Proof the freeze is doing something: the same graph and the same TTL
  // WITHOUT the snapshot reorders on exactly those reads.
  const live = fakeCtx()
  apply(live.ctx, { graphRoot: fresh, indexCacheMs: 1 })
  await settle()
  const liveFirst = live.variables.get('memory_index')()
  for (let i = 0; i < 4; i++) await live.tools.get('memory_read').execute({ id: read }, {})
  const liveSecond = await atTimeOffset(60_000, async () => live.variables.get('memory_index')())
  assert.notEqual(liveSecond, liveFirst, 'without the snapshot the index re-ranks (the behavior #263 fixes)')
  assert.equal(firstLine(liveSecond), read, 'the freshly-read node now leads')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('with indexSnapshot: run, memory_search between assemblies does not change the render', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-search-'))
  await createNode(fresh, { description: 'a fact about lighthouses' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const before = index()
  // memory_search calls refreshIndex(); with the snapshot the tool-side cache
  // may change, but the prompt string must not.
  await tools.get('memory_search').execute({ query: 'lighthouses' }, {})
  assert.equal(await atTimeOffset(60_000, async () => index()), before)
  // And a later assembly that renders a DIFFERENT graph state still serves the
  // frozen text: the snapshot is per instance, not a TTL refresh.
  await createNode(fresh, { description: 'a fact added by another process mid-run' })
  assert.equal(await atTimeOffset(60_000, async () => index()), before, 'the run keeps the prompt it started with')
  // The tool result itself stays live — search sees the new node.
  const found = await tools.get('memory_search').execute({ query: 'mid-run' }, {})
  assert.ok(found.matches.some((m) => m.description.includes('mid-run')), 'tools stay live; only the prompt string is frozen')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('memory_today is still evaluated every assembly under the snapshot (startTurn keeps running)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-today-'))
  // Seeded OUT OF BAND, so no plugin write lands between the two turn-4 steps
  // and the freeze assertion below is about the assembly, not about the
  // mutation-drop path (which has its own tests).
  const nodeId = await createNode(fresh, { description: 'the loading dock gate code', body: 'Gate code 4417; spare key in the side-door lockbox.' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const write = tools.get('memory_write')
  // A real assembly evaluates the whole section, not one variable: render all
  // three, in section order, so the snapshot is genuinely populated before any
  // same-turn/next-turn guard check is read.
  const indexVar = variables.get('memory_index')
  const handoffsVar = variables.get('memory_handoffs')
  const todayVar = variables.get('memory_today')
  const assemble = (turn) => {
    const context = { agent: { phase: { turn } }, scope: {}, signal: undefined }
    const rendered = [indexVar(context), handoffsVar(context), todayVar(context)]
    assert.ok(rendered.every((value) => typeof value === 'string'), 'every variable answered')
    return rendered
  }

  // Turn 4, step 1: assemble, then the model reads the node it may revise.
  const step1 = assemble(4)
  assert.match(step1[0], /the loading dock gate code/, 'the index really rendered the graph')
  await tools.get('memory_read').execute({ id: nodeId }, {})
  // Turn 4, step 2 — the same turn re-assembles. The index and banner are
  // frozen, but the read still vouches for the write that follows it: the
  // guard's reset is keyed on the TURN, never on the render.
  const step2 = assemble(4)
  assert.equal(step2[0], step1[0], 'the index is frozen across the step boundary')
  assert.equal(step2[1], step1[1], 'the banner is frozen across the step boundary')
  const informed = await write.execute({ id: nodeId, body: 'Gate code 4417. Spare key: side-door lockbox; facilities rotates it quarterly.' }, {})
  assert.equal(informed.blind_rewrite, undefined, 'a step boundary is not a turn boundary')

  // Turn 5 assembles and the guard resets, exactly as without the snapshot —
  // which is only observable because `memory_today` really ran.
  assemble(5)
  const blind = await write.execute({ id: nodeId, body: 'Facilities handles access now; ask them.' }, {})
  assert.ok(blind.blind_rewrite > 0, 'memory_today still evaluates per assembly, so the turn reset still fires')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a successful standalone memory_attach drops the snapshot — both routes', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-attach-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-attach-src-'))
  const nodeId = await createNode(fresh, { description: 'a node that will collect two attachments' })
  const { ctx, tools, variables } = fakeCtx()
  // A generous TTL on purpose: the drop must work by INVALIDATING the caches,
  // not by waiting for them to expire. A test that forces expiry would pass
  // even with the MAJOR 2 bug (drop the snapshot, keep the fresh cache).
  apply(ctx, { graphRoot: fresh, indexCacheMs: 60_000, indexSnapshot: 'run', attachFromPathRoots: [loose] })
  await settle()
  const index = () => variables.get('memory_index')()
  const handoffs = () => variables.get('memory_handoffs')()
  const attach = tools.get('memory_attach')

  // Populate BOTH rendered strings before each route — the banner is frozen
  // from the same holder, so a route that only dropped the index would leave
  // the handoff text stuck on the pre-attach view.
  const assemble = () => ({ index: index(), handoffs: handoffs() })

  // The index lines carry no file count, so the published attachment does not
  // change an index byte by itself. An out-of-band node written between the
  // attach and the next assembly is the probe: it is invisible while a
  // snapshot holds, and visible the moment the snapshot is genuinely gone.
  for (const [route, writeFile] of [
    ['content', async () => {}],
    ['from_path', async () => fsp.writeFile(path.join(loose, 'notes.md'), 'loose notes copied in\n')],
  ]) {
    const marker = `a node written after the ${route} attach`
    const before = assemble()
    await writeFile()
    const result = route === 'content'
      ? await attach.execute({ id: nodeId, filename: 'runbook.md', content: 'the ship steps, in full' }, {})
      : await attach.execute({ id: nodeId, from_path: path.join(loose, 'notes.md') }, {})
    assert.equal(result.status, 'created')
    // Probe the drop IMMEDIATELY, well inside the TTL: no forced expiry here.
    // A HANDOFF probe, so the banner changes as well as the index — one
    // out-of-band mutation that both frozen strings must reflect.
    await createNode(fresh, { description: marker, type: 'handoff' })
    const fresh2 = assemble()
    assert.match(fresh2.index, new RegExp(marker), `${route}: the next assembly saw the new graph`)
    assert.notEqual(fresh2.index, before.index, `${route}: the index re-rendered rather than re-capturing cached bytes`)
    assert.notEqual(fresh2.handoffs, before.handoffs, `${route}: the banner re-rendered too`)
    // And those fresh bytes are what freezes from here on.
    const afterFreeze = await atTimeOffset(120_000, async () => assemble())
    assert.equal(afterFreeze.index, fresh2.index, `${route}: the fresh render is now the frozen one`)
    assert.equal(afterFreeze.handoffs, fresh2.handoffs, `${route}: the banner too`)
  }
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

test('a refused mutation leaves both frozen strings intact — all four tools', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-refuse-'))
  const loose = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-refuse-src-'))
  const nodeId = await createNode(fresh, { description: 'a node that will refuse every operation' })
  const archiveId = await createNode(fresh, { description: 'an archived node that refuses a re-restore' })
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, archiveId), path.join(fresh, '.archive', archiveId))
  await fsp.writeFile(path.join(loose, 'secret.md'), 'a loose file the deployment will not allow\n')
  const { ctx, tools, variables } = fakeCtx()
  // A generous TTL, so a wrongful cache reset would be the only way the probe
  // below could show — waiting for expiry must not be able to explain a pass.
  apply(ctx, {
    graphRoot: fresh,
    indexCacheMs: 60_000,
    indexSnapshot: 'run',
    attachFromPathRoots: [loose],
  })
  await settle()
  const assemble = () => ({ index: variables.get('memory_index')(), handoffs: variables.get('memory_handoffs')() })
  const before = assemble()
  assert.match(before.index, /a node that will refuse every operation/, 'the snapshot really rendered the graph')

  // Each tool refuses for its OWN reason, so this is four genuine rejection
  // paths rather than one refusal tested four times.
  const refusals = [
    ['memory_write (unread update)', () => tools.get('memory_write').execute({ id: nodeId, body: 'a rewrite from a node never read' }, {}), /memory_read/i],
    // An attach to an id that does not exist fails before publication.
    ['memory_attach (missing node)', () => tools.get('memory_attach').execute({ id: '01J00000000000000000000013', filename: 'x.md', content: 'text' }, {}), /does not exist|no such/i],
    ['memory_restore (not archived)', () => tools.get('memory_restore').execute({ id: nodeId }, {}), /not archived/],
    ['memory_merge (unknown absorb id)', () => tools.get('memory_merge').execute({ keep_id: nodeId, absorb_id: '01J00000000000000000000013' }, {}), /does not exist/],
  ]

  for (const [label, call, pattern] of refusals) {
    // The probe: a handoff written out of band now. If the refusal wrongly
    // expired the TTL caches, the next assembly would show it.
    const marker = `probe after refused ${label}`
    const markerId = await createNode(fresh, { description: marker, type: 'handoff' })
    await assert.rejects(call, pattern, label)
    const after = assemble()
    assert.equal(after.index, before.index, `${label}: a refusal must not re-render the index`)
    assert.equal(after.handoffs, before.handoffs, `${label}: a refusal must not re-render the banner`)
    assert.doesNotMatch(after.index, new RegExp(marker), `${label}: the probe stayed invisible`)
    assert.doesNotMatch(after.handoffs, new RegExp(marker), `${label}: the banner probe stayed invisible`)
    // And it is genuinely frozen, not merely inside the TTL.
    const later = await atTimeOffset(120_000, async () => assemble())
    assert.equal(later.index, before.index, `${label}: still frozen past the TTL`)
    assert.equal(later.handoffs, before.handoffs, `${label}: banner still frozen past the TTL`)
    // Retire the probe OUT OF BAND and re-freeze, so the next arm compares
    // like with like against a clean baseline.
    await fsp.rename(path.join(fresh, markerId), path.join(fresh, '.archive', markerId))
    const reseed = fakeCtx()
    apply(reseed.ctx, { graphRoot: fresh, indexCacheMs: 60_000, indexSnapshot: 'run', attachFromPathRoots: [loose] })
    before.index = reseed.variables.get('memory_index')()
    before.handoffs = reseed.variables.get('memory_handoffs')()
  }
  await fsp.rm(fresh, { recursive: true, force: true })
  await fsp.rm(loose, { recursive: true, force: true })
})

test('a successful restore refreshes the snapshot', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-restore-'))
  const goneId = await createNode(fresh, { description: 'archived deploy runbook' })
  // Archive it the way graph-maintain --apply does: mv into .archive/.
  await fsp.mkdir(path.join(fresh, '.archive'), { recursive: true })
  await fsp.rename(path.join(fresh, goneId), path.join(fresh, '.archive', goneId))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const frozen = index()
  assert.doesNotMatch(frozen, /archived deploy runbook/, 'an archived node is out of the index')
  await tools.get('memory_restore').execute({ id: goneId }, {})
  const afterRestore = index()
  assert.notEqual(afterRestore, frozen, 'a successful restore re-renders')
  assert.match(afterRestore, /archived deploy runbook/, 'the restored node is back in the index')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a successful merge refreshes the snapshot', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-merge-'))
  const keepId = await createNode(fresh, { description: 'the Oslo contract renewal terms' })
  const absorbId = await createNode(fresh, { description: 'duplicate Oslo contract renewal record' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const frozen = index()
  assert.match(frozen, /duplicate Oslo contract renewal record/)
  await tools.get('memory_merge').execute({ keep_id: keepId, absorb_id: absorbId }, {})
  const afterMerge = index()
  assert.notEqual(afterMerge, frozen, 'a successful merge re-renders')
  assert.doesNotMatch(afterMerge, /duplicate Oslo contract renewal record/, 'the absorbed node is out of the index')
  assert.match(afterMerge, /the Oslo contract renewal terms/, 'the kept node survives')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the F68 stale-version gate still reads live state while the banner is frozen', async () => {
  // MINOR 2's sharpest half: the snapshot freezes what the model SEES, never
  // what the guards CHECK. A node revised by another process mid-run must still
  // fail the version gate on an update, even though the displayed banner and
  // index still show the run's opening view.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-f68-'))
  const nodeId = await createNode(fresh, { description: 'the deploy runbook', body: 'original body text' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const frozen = index()
  // This Session reads the current body, so the read gate passes.
  await tools.get('memory_read').execute({ id: nodeId }, {})
  // Another process rewrites the node behind this run's back. The body lives
  // after the frontmatter, so replace it wholesale.
  const nodeFile = path.join(fresh, nodeId, 'node.md')
  const original = await fsp.readFile(nodeFile, 'utf8')
  assert.match(original, /original body text/, 'the fixture has a body to replace')
  await fsp.writeFile(nodeFile, original.replace('original body text', 'another process rewrote this body'))
  // The update is refused by the LIVE version check, not accepted blind.
  await assert.rejects(
    () => tools.get('memory_write').execute({ id: nodeId, body: 'retyping what the stale read showed' }, {}),
    /changed since it was read/,
  )
  assert.equal(await atTimeOffset(60_000, async () => index()), frozen, 'nothing landed, so nothing re-rendered')
  // And the refusal was real: the other process's text is what is on disk.
  const onDisk = await fsp.readFile(path.join(fresh, nodeId, 'node.md'), 'utf8')
  assert.match(onDisk, /another process rewrote this body/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the F61 close-out scan sees an external handoff live while the banner stays frozen', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-f61-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const handoffs = () => variables.get('memory_handoffs')()
  const frozen = handoffs()
  // Another process opens a handoff that tracks a pending item mid-run.
  await createNode(fresh, {
    description: 'pending: the replay harness still needs the isolate.yml step',
    type: 'handoff',
    body: 'Worker 01HQ0000000000000000000000 is still owed the isolate.yml run.',
  })
  // The DISPLAYED banner is frozen — the model sees the run's opening view.
  assert.equal(await atTimeOffset(60_000, async () => handoffs()), frozen, 'the banner did not splice')
  // But the close-out sweep reads work state LIVE, so a write that delivers the
  // pending item still draws `stale_pending` — the snapshot never blinds a
  // guard.
  const delivered = await tools.get('memory_write').execute({
    description: 'the replay harness isolate.yml step landed and was verified',
    body: 'Worker 01HQ0000000000000000000000 finished; the isolate.yml step is verified end to end.',
  }, {})
  assert.ok(Array.isArray(delivered.stale_pending), 'the live work-state scan still saw the external handoff')
  assert.match(delivered.stale_pending[0].line, /isolate\.yml/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a successful mutation drops the snapshot, so the next assembly re-renders', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-write-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const handoffs = () => variables.get('memory_handoffs')()
  const write = tools.get('memory_write')
  // Unrelated to a read run's shape — but the defensive half: if a content
  // mutation lands while the snapshot is on, the prompt must not keep claiming
  // the old graph. This is the ONLY drop path; access bookkeeping and edge
  // wiring have their own tests above and must not re-render.
  await write.execute({ description: 'first fact before the snapshot', type: 'journal' }, {})
  const frozen = index()
  const frozenHandoffs = handoffs()
  await write.execute({ description: 'a handoff opened mid-run', type: 'handoff' }, {})
  const afterWrite = index()
  assert.notEqual(afterWrite, frozen, 'the write dropped the snapshot and the index re-rendered')
  assert.match(afterWrite, /a handoff opened mid-run/)
  assert.notEqual(handoffs(), frozenHandoffs, 'the banner was re-rendered too')
  assert.match(handoffs(), /a handoff opened mid-run/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a traversal read that wires a missing edge does not change the snapshot', async () => {
  // Review on #263: read authority is NOT filesystem-pure, and this is
  // the sharpest case — `memory_read` with `from` on a pair with no edge WIRES
  // the edge (index.js ~4375-4400). That is a real graph change, but it is
  // discovery, not content, so it must not re-render the displayed index.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-traverse-'))
  const from = await createNode(fresh, { description: 'the node the run starts at' })
  const to = await createNode(fresh, { description: 'the node reached by following a guess' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const handoffs = () => variables.get('memory_handoffs')()
  const first = index()
  const firstHandoffs = handoffs()
  // No edge exists between them yet, so this read both logs the traversal AND
  // creates the edge.
  await tools.get('memory_read').execute({ id: to, from }, {})
  // The edge really landed — otherwise the assertion below would be vacuous.
  const edgesDir = path.join(fresh, to, '__edges__')
  const peers = await fsp.readdir(edgesDir).catch(() => [])
  assert.ok(peers.includes(from), 'the traversal read wired the missing edge')
  // The degree weight now scores both nodes differently, so an unsnapshotted
  // render would change.
  assert.equal(await atTimeOffset(60_000, async () => index()), first, 'edge wiring is discovery, not content — the prompt holds')
  assert.equal(await atTimeOffset(60_000, async () => handoffs()), firstHandoffs)
  // The live view does move: a fresh instance over the same graph renders the
  // wired edge's effect, which is what proves the assertion above is not just
  // "the index never changes".
  const live = fakeCtx()
  apply(live.ctx, { graphRoot: fresh, indexCacheMs: 1 })
  await settle()
  assert.notEqual(live.variables.get('memory_index')(), first, 'the graph did change; only the snapshot ignored it')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('access bookkeeping alone never drops the snapshot', async () => {
  // Same review, the quieter half: touchRead appends to `.access/`, which
  // re-ranks the index. It is bookkeeping, so the snapshot must survive it —
  // otherwise the lever would be defeated by the very calls it exists for.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-access-'))
  const a = await createNode(fresh, { description: 'first node' })
  await createNode(fresh, { description: 'second node' })
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run' })
  await settle()
  const index = () => variables.get('memory_index')()
  const first = index()
  for (let i = 0; i < 5; i++) await tools.get('memory_read').execute({ id: a }, {})
  const log = path.join(fresh, '.access', `${a}.log`)
  assert.ok((await fsp.readFile(log, 'utf8')).trim().length > 0, 'the reads really logged')
  assert.equal(await atTimeOffset(60_000, async () => index()), first, 'access lines do not re-render the prompt')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('default (no indexSnapshot) keeps today\'s TTL-driven re-render', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-snapshot-default-'))
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1 })
  await settle()
  const index = () => variables.get('memory_index')()
  const before = index()
  await tools.get('memory_write').execute({ description: 'a fact another step stored' }, {})
  assert.match(index(), /a fact another step stored/, 'the default keeps re-rendering')
  assert.notEqual(index(), before)
  await fsp.rm(fresh, { recursive: true, force: true })
})
