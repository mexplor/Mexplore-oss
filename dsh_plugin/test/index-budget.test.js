/**
 * #263 W2.2: the index growth policy (`indexBudget`).
 *
 * The rendered `memory_index` section is re-sent on every call of every run, so
 * its size is a per-run multiplier rather than a one-off. These tests pin the
 * policy: the tier boundaries, that rank order survives tiering, that the footer
 * counts what was actually omitted, that open work state is never dropped, that
 * a budgeted render composes with `indexSnapshot: 'run'` and `promptProfile`,
 * that an id outside the tiers is still readable, and — the hard requirement —
 * that leaving the flag off is byte-identical.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'
import { INDEX_BUDGET, clipDescription, createNode, indexLines, indexLinesSync } from '../lib/graph.js'

let root
before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-')) })
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

let seq = 0
/**
 * Create `count` nodes whose descriptions are long enough that clipping is
 * observable, newest last. `now` advances by a second per node so the newest-id
 * tie-break is deterministic instead of decided by a random suffix.
 *
 * The filler length is calibrated against the real graph the policy was tuned
 * on (test_1: 58 nodes, median description 371 characters, p90 476), so the
 * fixture's tier arithmetic resembles the measured one instead of a corpus of
 * one-line notes where nothing would need clipping.
 */
async function seed(dir, count, { prefix = 'node', type } = {}) {
  const ids = []
  const base = Date.parse('2026-09-01T00:00:00Z')
  for (let i = 0; i < count; i++) {
    seq += 1
    ids.push(await createNode(dir, {
      description: `${prefix} ${i}: ${'filler word '.repeat(30)}item ${i}`,
      body: `body ${i}`,
      now: base + seq * 1000,
      ...(type === undefined ? {} : { type }),
    }))
  }
  return ids
}

/**
 * The index section of a rendered `memory_index` block: the leading run of index
 * rows — a row, the indented work-state group, or the reach footer — up to the
 * first line that belongs to a block riding AFTER the index. Those trailing
 * blocks (duplicate pairs, the orphan census) are exactly what the read profile
 * removes, so slicing here is what keeps a composition test from comparing two
 * different blocks.
 */
const INDEX_LINE = /^(… |  |[0-9A-HJKMNP-TV-Z]{26} — )/
const indexPart = (rendered) => {
  const lines = rendered.split('\n')
  const end = lines.findIndex((line) => !INDEX_LINE.test(line))
  return (end === -1 ? lines : lines.slice(0, end)).join('\n')
}

/** The id half of an index line (`<id> — …`, optionally indented). */
const idOf = (line) => line.trim().slice(0, 26)

test('a budgeted index renders three tiers in one rank order, with a footer', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-tiers-'))
  await seed(fresh, 60)
  const plain = await indexLines(fresh, 200)
  const tiered = await indexLines(fresh, 200, undefined, undefined, true)
  const plainRows = plain.filter((line) => !line.startsWith('…'))
  const footer = tiered.at(-1)
  assert.match(footer, /more nodes; call memory_search to reach them\.$/, 'the section ends with the reach pointer')
  const rows = tiered.filter((line) => !line.startsWith('…'))
  // 15 full + 25 clipped = 40 rendered rows; the remaining 20 are counted only.
  assert.equal(rows.length, INDEX_BUDGET.tier1 + INDEX_BUDGET.tier2)
  assert.match(footer, new RegExp(`… ${60 - rows.length} more nodes`), 'the footer counts the omitted nodes')
  // Tier 1 keeps the description verbatim; tier 2 is clipped.
  for (let i = 0; i < INDEX_BUDGET.tier1; i++) {
    assert.equal(rows[i], plainRows[i], `tier 1 row ${i} is the untiered line, verbatim`)
  }
  for (let i = INDEX_BUDGET.tier1; i < rows.length; i++) {
    const description = rows[i].slice(29)
    assert.ok(description.length <= INDEX_BUDGET.clipChars + 1, `tier 2 row ${i} is clipped (${description.length} chars)`)
    assert.ok(description.endsWith('…'), `tier 2 row ${i} is marked as clipped`)
    assert.equal(rows[i], `${plainRows[i].slice(0, 26)} — ${description}`, `tier 2 row ${i} keeps its full rank line's id`)
  }
  // The whole point: rank order survives tiering, in order, with no re-sort and
  // no row promoted out of tier 2 into tier 1.
  assert.deepEqual(rows.map(idOf), plainRows.slice(0, rows.length).map(idOf), 'rank order is preserved across the tier boundary')
  assert.ok(tiered.join('\n').length < plain.join('\n').length * 0.5, 'the section is less than half its untiered size')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a graph inside the tiers renders no footer, and the tiers are the untiered rows', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-small-'))
  await seed(fresh, INDEX_BUDGET.tier1 + INDEX_BUDGET.tier2)
  const plain = await indexLines(fresh, 200)
  const tiered = await indexLines(fresh, 200, undefined, undefined, true)
  assert.ok(!tiered.some((line) => line.startsWith('…')), 'no footer when nothing is omitted')
  assert.equal(tiered.length, plain.length, 'one row per node, none added')
  // Tier 1 is byte-identical to the untiered line. Tier 2 is the SAME row with a
  // clipped description — so it is compared on its id and its prefix, not on
  // equality: the untiered line keeps the full description and legitimately
  // differs from a clipped one. Asserting equality there would be asserting
  // that clipping does nothing.
  assert.deepEqual(tiered.slice(0, INDEX_BUDGET.tier1), plain.slice(0, INDEX_BUDGET.tier1))
  for (let i = INDEX_BUDGET.tier1; i < plain.length; i++) {
    assert.equal(idOf(tiered[i]), idOf(plain[i]), `tier 2 row ${i} is the same node in the same rank slot`)
    assert.ok(plain[i].startsWith(tiered[i].slice(0, -1)), `tier 2 row ${i} is a clipped prefix of the untiered line`)
    assert.ok(tiered[i].length < plain[i].length, `tier 2 row ${i} really is shorter`)
  }
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the footer counts rows the outer maxIndexEntries cap removed too', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-cap-'))
  await seed(fresh, 60)
  // The cap admits 50 rows; the tiers render 40 of those. The footer must say 20
  // — 10 the cap removed plus 10 the tiers removed — not 10. Counting only the
  // tiers' own omissions would understate what the section hides.
  const tiered = await indexLines(fresh, 50, undefined, undefined, true)
  assert.match(tiered.at(-1), /… 20 more nodes; call memory_search to reach them\./)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the footer reads correctly at one omitted node, and disappears at none', async () => {
  // The footer is the section's only explanation of what it hid, so a template
  // artifact (`1 more nodes`) is a real defect on the one graph size where a
  // reader is most likely to check the arithmetic.
  const exact = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-exact-'))
  await seed(exact, INDEX_BUDGET.tier1 + INDEX_BUDGET.tier2)
  const atLimit = await indexLines(exact, 200, undefined, undefined, true)
  assert.ok(!atLimit.some((line) => line.startsWith('…')), 'nothing omitted ⇒ no footer at all')
  await createNode(exact, { description: 'one node past the tiers' })
  const one = await indexLines(exact, 200, undefined, undefined, true)
  assert.equal(one.at(-1), '… 1 more node; call memory_search to reach them.')
  await fsp.rm(exact, { recursive: true, force: true })
})

test('an empty graph renders no rows and no footer, budgeted or not', async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-empty-'))
  assert.deepEqual(await indexLines(empty, 200, undefined, undefined, true), [])
  assert.deepEqual(await indexLines(empty, 200), [])
  // A budget of zero rows is legal and says only what is hidden — not a crash,
  // and not a silent empty section with no explanation.
  await seed(empty, 3)
  assert.deepEqual(await indexLines(empty, 200, undefined, undefined, { tier1: 0, tier2: 0, clipChars: 80 }), [
    '… 3 more nodes; call memory_search to reach them.',
  ])
  await fsp.rm(empty, { recursive: true, force: true })
})

test('an open thread outside the tiers is retained; a handoff is the banner\'s job, not a duplicate row', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-workstate-'))
  // The work-state rows are the OLDEST, so they rank last and fall outside both
  // tiers — a retention group that only fires on rank would prove nothing.
  // The thread's description is deliberately LONGER than `clipChars`: a short one
  // would make the "retained row is clipped" assertion below vacuous, since an
  // unclipped render would also satisfy a length bound (codex review).
  const threadDescription = `pending: the replay harness still needs isolation verified — ${'detail '.repeat(20)}end`
  assert.ok(threadDescription.length > INDEX_BUDGET.clipChars * 2, 'the fixture must actually need clipping')
  await createNode(fresh, { description: threadDescription, type: 'thread', now: Date.parse('2026-01-01T00:00:00Z') })
  await createNode(fresh, { description: 'pending: an open handoff the banner already shows', type: 'handoff', now: Date.parse('2026-01-02T00:00:00Z') })
  await seed(fresh, 50)
  const plain = await indexLines(fresh, 200)
  const tiered = await indexLines(fresh, 200, undefined, undefined, true)
  const text = tiered.join('\n')
  const threadId = plain.find((line) => line.includes('replay harness still needs')).slice(0, 26)
  const handoffId = plain.find((line) => line.includes('an open handoff the banner already shows')).slice(0, 26)
  assert.ok(text.includes('Open work state below the cut'), 'the retention group renders its own heading')
  assert.ok(text.includes(threadId), 'the open thread outside the tiers is still shown')
  assert.ok(!text.includes(handoffId), 'the handoff is not duplicated into the index — its banner is uncapped')
  // The retained row is clipped like tier 2, not rendered in full. The bound
  // below only discriminates because the fixture description is long.
  const retained = tiered.find((line) => line.includes(threadId))
  assert.ok(retained.trim().length < 26 + 3 + threadDescription.length, 'the retained row is NOT the full description')
  assert.ok(retained.trim().length <= 26 + 3 + INDEX_BUDGET.clipChars + 1, 'the retained row is clipped to the tier-2 budget')
  // And the footer counts it as shown, not omitted.
  const shown = tiered.filter((line) => !line.startsWith('…') && !line.startsWith('Open work state')).length
  assert.match(tiered.at(-1), new RegExp(`… ${50 + 2 - shown} more nodes`))
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('EVERY open thread is retained, not a fixed number of them (review blocker)', async () => {
  // A slot count would drop exactly the open threads the guarantee exists for —
  // the codex review reproduced it with the fourth thread. Retention is bounded
  // by the graph's work-state discipline, not by a constant.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-workstate-all-'))
  const threads = []
  for (let i = 0; i < 8; i++) {
    threads.push(await createNode(fresh, {
      description: `pending item ${i}: still owed`,
      type: 'thread',
      now: Date.parse('2026-01-01T00:00:00Z') + i * 1000,
    }))
  }
  await seed(fresh, 50)
  const tiered = await indexLines(fresh, 200, undefined, undefined, true)
  const text = tiered.join('\n')
  for (const id of threads) assert.ok(text.includes(id), `open thread ${id} survives the budget`)
  assert.equal(tiered.filter((line) => line.startsWith('  ')).length, threads.length, 'all of them, in the group')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('retention reaches past maxIndexEntries, so an outer cap cannot hide an open thread (review blocker)', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-workstate-cap-'))
  // The thread is the OLDEST, so it ranks last and sits outside a 40-row cap.
  const thread = await createNode(fresh, {
    description: 'pending: the only open thread, ranked last',
    type: 'thread',
    now: Date.parse('2026-01-01T00:00:00Z'),
  })
  await seed(fresh, 50)
  const tiered = await indexLines(fresh, 40, undefined, undefined, true)
  const text = tiered.join('\n')
  assert.ok(text.includes(thread), 'the thread is retained even though the cap excluded it')
  // And the footer still counts it as SHOWN, not omitted: 51 nodes, the cap
  // admits 40 rows (all rendered, since tier1+tier2 = 40), plus the 1 retained
  // thread = 41 shown, so 10 remain hidden.
  assert.match(tiered.at(-1), /… 10 more nodes; call memory_search to reach them\./)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a SUPERSEDED thread is history, not retained work state (review major)', async () => {
  const { supersede } = await import('../lib/graph.js')
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-workstate-superseded-'))
  // Three superseded threads rank below the tiers. They must not consume
  // retention (there is no cap to consume any more, but they must also not be
  // presented under "still current"), and the one live thread must still show.
  for (let i = 0; i < 3; i++) {
    const old = await createNode(fresh, {
      description: `retired thread ${i}`,
      type: 'thread',
      now: Date.parse('2026-01-01T00:00:00Z') + i * 1000,
    })
    const successor = await createNode(fresh, {
      description: `successor of retired thread ${i}`,
      type: 'journal',
      now: Date.parse('2026-02-01T00:00:00Z') + i * 1000,
    })
    await supersede(fresh, old, successor)
  }
  const live = await createNode(fresh, { description: 'the one genuinely open thread', type: 'thread', now: Date.parse('2026-01-05T00:00:00Z') })
  await seed(fresh, 50)
  const tiered = await indexLines(fresh, 200, undefined, undefined, true)
  const group = tiered.slice(tiered.findIndex((line) => line.startsWith('Open work state')))
  assert.ok(group.some((line) => line.includes(live)), 'the live thread is in the retention group')
  assert.equal(group.filter((line) => line.startsWith('  ')).length, 1, 'the superseded threads are NOT retained as open work')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('clipDescription cuts at a word boundary, never mid-surrogate, and leaves short text alone', () => {
  assert.equal(clipDescription('short', 80), 'short')
  assert.equal(clipDescription('a'.repeat(80), 80), 'a'.repeat(80), 'exactly at the limit is not clipped')
  const clipped = clipDescription('alpha beta gamma delta epsilon zeta eta theta iota kappa', 30)
  assert.ok(clipped.endsWith('…'))
  assert.ok(!clipped.slice(0, -1).endsWith(' '), 'the cut backtracks to the word boundary, no trailing space')
  assert.ok('alpha beta gamma delta epsilon zeta eta theta iota kappa'.startsWith(clipped.slice(0, -1)))
  // The boundary is honoured wherever it falls, not only past the halfway point:
  // a short first word followed by one very long token must still cut at the
  // space (codex review — the earlier half-limit floor cut inside the token).
  assert.equal(clipDescription(`alpha ${'b'.repeat(90)}`, 80), 'alpha…')
  // A single long token has NO boundary to find; the character cut is the answer.
  assert.equal(clipDescription('x'.repeat(50), 20), `${'x'.repeat(20)}…`)
  // A surrogate pair straddling the cut is dropped rather than split: `😀` is
  // two code units, so a limit landing between them must not emit half of it.
  const emoji = `${'a'.repeat(10)}😀 tail`
  const cut = clipDescription(emoji, 11)
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), 'no lone high surrogate survives the clip')
  assert.equal(cut, `${'a'.repeat(10)}…`)
  // The invariant the tier-2 contract actually depends on: the clip never emits
  // MORE than the budget, and never a lone surrogate, for any input.
  for (const text of ['word '.repeat(40), 'x'.repeat(200), `${'😀'.repeat(60)}`, 'a b c d e f g h i j k l m n o p']) {
    for (const limit of [1, 2, 5, 20, 79, 80]) {
      const out = clipDescription(text, limit)
      if (text.length <= limit) continue
      assert.ok(out.length <= limit + 1, `${JSON.stringify(text.slice(0, 12))}@${limit} stayed within budget (${out.length})`)
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), `${JSON.stringify(text.slice(0, 12))}@${limit} kept pairs whole`)
    }
  }
})

test('a supersede marker survives tiering — the marker is never clipped', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-supersede-'))
  const old = await createNode(fresh, { description: `retired decision ${'detail '.repeat(20)}`, now: Date.parse('2026-01-01T00:00:00Z') })
  const replacement = await createNode(fresh, { description: 'the decision that replaced it', now: Date.parse('2026-02-01T00:00:00Z') })
  const { supersede } = await import('../lib/graph.js')
  await supersede(fresh, old, replacement)
  const tiered = await indexLines(fresh, 200, undefined, undefined, { tier1: 1, tier2: 1, clipChars: 20 })
  const oldRow = tiered.find((line) => line.startsWith(old))
  assert.ok(oldRow, 'the superseded node is rendered in tier 2')
  assert.match(oldRow, new RegExp(`\\[superseded by ${replacement}\\]$`), 'the marker is appended whole, past the clip')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('indexBudget config: absent is the default, only true/false or a valid override object is accepted', () => {
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root }))
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: true }))
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { tier1: 5 } }))
  // `false` is the same explicit-off idiom every other boolean knob here uses,
  // so a direct caller can disable it the way it enables the rest.
  assert.doesNotThrow(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: false }))
  for (const value of ['on', 1, null, []]) {
    assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: value }), /`indexBudget` must be true or an object/, `${JSON.stringify(value)} must be refused`)
  }
  // An override key the policy does not define is a typo, not a knob — including
  // an INHERITED object name, which `key in` would have accepted.
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { tier3: 1 } }), /`indexBudget.tier3` is not a policy constant/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { toString: 1 } }), /`indexBudget.toString` is not a policy constant/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { constructor: 1 } }), /`indexBudget.constructor` is not a policy constant/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { tier1: -1 } }), /`indexBudget.tier1` must be a non-negative integer/)
  assert.throws(() => apply(fakeCtx().ctx, { graphRoot: root, indexBudget: { tier1: 1.5 } }), /`indexBudget.tier1` must be a non-negative integer/)
})

test('the flag off renders byte-identically — async and sync, and no budget key reaches the untiered path', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-parity-'))
  await seed(fresh, 45)
  const expected = await indexLines(fresh, 200)
  // The plugin's own default path, driven end to end. The `memory_index` variable
  // also carries the duplicate/orphan blocks that ride after the index, so the
  // comparison is on the index section itself — that is the surface this lever
  // touches, and the trailing blocks have their own tests.
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0 })
  const rendered = variables.get('memory_index')()
  // EXACT equality against an independently rendered index, not `startsWith`: a
  // prefix check would pass if the budget leaked an extra footer or a row onto
  // the end of the untiered render (codex review).
  assert.equal(indexPart(rendered), expected.join('\n'), 'the flag-off prompt carries the untiered index byte for byte')
  assert.deepEqual(indexLinesSync(fresh, 200), expected, 'the sync index agrees with the async one')
  // And with the flag on it does NOT.
  const on = fakeCtx()
  apply(on.ctx, { graphRoot: fresh, indexCacheMs: 0, indexBudget: true })
  const budgeted = on.variables.get('memory_index')()
  assert.notEqual(indexPart(budgeted), indexPart(rendered), 'the budgeted render is not the untiered one')
  assert.ok(budgeted.length < rendered.length, 'and it is shorter on this fixture')
  // Explicit `false` is the same bytes as absent: off is off however it is spelled.
  const off = fakeCtx()
  apply(off.ctx, { graphRoot: fresh, indexCacheMs: 0, indexBudget: false })
  assert.equal(off.variables.get('memory_index')(), rendered, 'explicit false is byte-identical to absent')
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a budgeted render composes with indexSnapshot: run — the budgeted bytes freeze', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-snapshot-'))
  const read = await createNode(fresh, { description: 'node the run reads first', now: Date.parse('2026-01-01T00:00:00Z') })
  await seed(fresh, 50)
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 1, indexSnapshot: 'run', indexBudget: true })
  await new Promise((resolve) => setImmediate(resolve))
  const index = () => variables.get('memory_index')()
  const first = index()
  assert.match(first, /more nodes; call memory_search/, 'the frozen text is the BUDGETED render, not the untiered one')
  // A direct read re-ranks the node to the top; under the snapshot it must stay
  // where the run started, and it must still be the tiered shape.
  for (let i = 0; i < 4; i++) await tools.get('memory_read').execute({ id: read }, {})
  assert.equal(index(), first, 'the budgeted render is what gets frozen')
  const real = Date.now
  const base = real()
  Date.now = () => base + 120_000
  try {
    assert.equal(index(), first, 'still frozen past the TTL')
  } finally {
    Date.now = real
  }
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a budgeted render composes with promptProfile: read — the profile keeps the tiered index', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-profile-'))
  await seed(fresh, 50)
  const { ctx, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, promptProfile: 'read', indexBudget: true })
  const index = variables.get('memory_index')()
  assert.match(index, /more nodes; call memory_search/, 'the read profile still renders the tiered index')
  assert.doesNotMatch(index, /Open work state below the cut/)
  // The two levers are orthogonal: the read profile removes the orphan/duplicate
  // blocks that ride AFTER the index, while the budget shapes the index itself —
  // so the index section is identical across profiles.
  const full = fakeCtx()
  apply(full.ctx, { graphRoot: fresh, indexCacheMs: 0, indexBudget: true })
  assert.deepEqual(indexPart(index), indexPart(full.variables.get('memory_index')()), 'the index section is identical across profiles')
  // And the read profile really did its own job, so this is a composition test
  // rather than two identical renders.
  assert.doesNotMatch(index, /unlinked memories have no edges/)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('the growth bound covers the tiers only: a thread-heavy graph renders LARGER (documented trade)', async () => {
  // This is not a bug — it is the price of the never-drop guarantee, and the docs
  // state it. Pinning it means a future change cannot quietly turn "sometimes
  // bigger" into "always bigger", or into a silent cap that drops threads again.
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-threadheavy-'))
  for (let i = 0; i < 600; i++) {
    await createNode(fresh, {
      description: `thread ${i} ${'detail '.repeat(30)}end`,
      type: 'thread',
      now: Date.parse('2026-01-01T00:00:00Z') + i * 1000,
    })
  }
  const plain = (await indexLines(fresh, 200)).join('\n')
  const tiered = (await indexLines(fresh, 200, undefined, undefined, true)).join('\n')
  assert.ok(tiered.length > plain.length, 'uncapped retention can exceed the untiered size — documented, deliberate')
  // But every thread is still there: the guarantee outranks the saving.
  const tieredIds = new Set(tiered.split('\n').filter((line) => INDEX_LINE.test(line)).map(idOf))
  const plainIds = plain.split('\n').filter((line) => INDEX_LINE.test(line)).map(idOf)
  // The untiered render is capped at 200, so the budgeted one can show MORE
  // nodes than the untiered one — retention is not bounded by maxIndexEntries.
  assert.ok(tieredIds.size > plainIds.length, `retention showed ${tieredIds.size} rows against the cap's ${plainIds.length}`)
  await fsp.rm(fresh, { recursive: true, force: true })
})

test('a read over an id in the OMITTED tier still works', async () => {
  const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-budget-omitted-'))
  const ids = await seed(fresh, 50)
  const { ctx, tools, variables } = fakeCtx()
  apply(ctx, { graphRoot: fresh, indexCacheMs: 0, indexBudget: true })
  const rendered = variables.get('memory_index')()
  // The LAST seeded node ranks last (oldest id ordering aside, the newest-first
  // tie-break puts it first, so prove the omission by id presence instead).
  const omittedId = ids.find((id) => !rendered.includes(id))
  assert.ok(omittedId, 'some node really is outside every tier')
  const read = await tools.get('memory_read').execute({ id: omittedId }, {})
  assert.equal(read.description.startsWith('node '), true, 'memory_read does not depend on the index')
  // The omission is documented in the prompt itself: the footer names the route.
  assert.match(rendered, /call memory_search to reach them/)
  // And search reaches the omitted node BY ITS OWN WORDS — the assertion names
  // the id, so a search returning only visible nodes cannot satisfy it.
  const omittedDescription = read.description
  const needle = omittedDescription.match(/item (\d+)$/)?.[1]
  assert.ok(needle !== undefined, 'the fixture description carries its own ordinal')
  const found = await tools.get('memory_search').execute({ query: `node ${needle} item ${needle}` }, {})
  assert.ok(found.matches.some((match) => match.id === omittedId), 'the omitted node itself comes back from search')
  await fsp.rm(fresh, { recursive: true, force: true })
})
