/**
 * History import: parity of the JS port with the Python reference (goldens from
 * scripts/history-golden.py on synthetic sessions), estimate / M1 / mode prompt, the job's gates and
 * digests, batches with snapshot + rollback + rerun, foreign-write detection, unknown rule, restart,
 * lock, and the bundle row. No model, no network.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as agent from '../lib/bundle/agent.js'
import * as history from '../lib/bundle/history.js'
import { SETTINGS_SERVICE } from '../lib/bundle/state.js'
import { clip, convert, cpLen, iso } from '../lib/history/convert.js'
import { estimate, m1Plan } from '../lib/history/estimate.js'
import { attributeChanges, classify, cloneTree, emptyTouch, HistoryJob, manifest, writeHooks } from '../lib/history/job.js'
import { loadEnvFiles, MAX_REDACT_INPUT, Redactor } from '../lib/history/redact.js'
import { itemRequest } from '../lib/history/request.js'
import { projectLabel } from '../lib/history/scope.js'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(pkgDir, 'test', 'fixtures', 'history')
const golden = JSON.parse(fs.readFileSync(path.join(fixtures, 'golden.json'), 'utf8'))
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `hist-${p}-`))
const strip = ({ _closed_at, _start_ts, ...rest }) => rest

// ---------------------------------------------------------------- parity with the Python reference

test('convert: same units as the Python reference on the synthetic sessions (ids, text, fields, order)', () => {
  const { units, counts } = convert({ ...golden.config, projectsDir: path.join(fixtures, 'projects'), envFiles: [path.join(fixtures, 'synthetic.env')] }, golden.now_epoch)
  assert.equal(units.length, golden.units.length)
  units.forEach((u, i) => assert.deepEqual(strip(u), golden.units[i], `unit ${i}`))
  for (const [k, v] of Object.entries(golden.counts)) {
    if (k === 'bad_json_lines') continue // Python also counts blank lines; counts only, never units
    assert.equal(counts[k], v, k)
  }
})

test('redaction: same output and counts as the Python reference', () => {
  const [names, values] = loadEnvFiles([path.join(fixtures, 'synthetic.env')])
  const r = new Redactor(names, values)
  for (const c of golden.redaction) {
    const [out, found] = r.redact(c.input)
    assert.equal(out, c.output, c.input)
    assert.deepEqual(found, c.counts, c.input)
  }
})

test('code points and times follow Python', () => {
  assert.equal(cpLen('a😀b'), 3)
  assert.equal(clip('😀😀😀', 2), '😀😀 …[truncated]')
  assert.equal(clip('abc [REDACTED:x] def', 14), 'abc  …[truncated]')
  assert.equal(iso(Date.parse('2026-06-01T01:00:00.000Z') / 1000), '2026-06-01T09:00:00+08:00')
  assert.equal(iso(Date.parse('2026-06-01T01:00:00.744Z') / 1000), '2026-06-01T09:00:00.744000+08:00')
})

// ---------------------------------------------------------------- estimate, M1, request

function fakeUnit(id, day, hour, turns = 1, chars = 100) {
  const lines = [`Conversation dated ${day} (Claude Code session s-${id} in /Users/x/Code/repo, part 1 of that session)`]
  for (let t = 0; t < turns; t++) lines.push(`USER: q${t} ${'q'.repeat(chars)}`, `ASSISTANT: a${t} ${'a'.repeat(chars)}`)
  return { schema: 'mexplor-unit-v1', unit_id: id, session_id: `s-${id}`, day, started_at: `${day}T${String(hour).padStart(2, '0')}:00:00+08:00`, ended_at: `${day}T${String(hour).padStart(2, '0')}:30:00+08:00`, turn_ids: Array.from({ length: turns }, (_, i) => `${id}-t${i}`), text: lines.join('\n') }
}

test('M1: same day, at most 6 units, evidence cap; estimate asks at >= 2 h and recommends M1', () => {
  const units = [...Array.from({ length: 8 }, (_, i) => fakeUnit(`u-a${i}`, '2026-06-01', 8 + i)), fakeUnit('u-b0', '2026-06-02', 9)]
  assert.deepEqual(m1Plan(units).map((b) => b.length), [6, 2, 1])
  const many = Array.from({ length: 4 }, (_, i) => fakeUnit(`u-m${i}`, '2026-06-03', 8 + i, 10))
  assert.deepEqual(m1Plan(many, { maxUnitsPerBatch: 6, maxEvidence: 50, budgetBytes: 60000 }).map((b) => b.length), [2, 2])
  const small = estimate(units)
  assert.equal(small.modePrompt.ask, false)
  assert.equal(small.modes.full_replay.delegations, 9)
  const big = estimate(Array.from({ length: 200 }, (_, i) => fakeUnit(`u-z${String(i).padStart(3, '0')}`, `2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, 8, 2, 2000)))
  assert.equal(big.modePrompt.ask, true)
  assert.equal(big.modePrompt.recommended, 'm1')
  assert.ok(big.modes.m1.wallH < big.modes.full_replay.wallH)
  assert.equal(big.modePrompt.recommendedName.zh, '按天合并导入')
  assert.equal(big.modePrompt.names.full_replay.en, 'one conversation segment at a time')
  assert.equal(small.modePrompt.defaultModeName.zh, '逐段导入')
})

test('mode prompt: the user-facing strings never say "M1" or "full replay"', () => {
  const big = estimate(Array.from({ length: 200 }, (_, i) => fakeUnit(`u-z${String(i).padStart(3, '0')}`, `2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, 8, 2, 2000)))
  const small = estimate([fakeUnit('u-1', '2026-06-01', 9)])
  const texts = (o) => Object.values(o).flatMap((v) => (typeof v === 'string' ? [v] : texts(v)))
  const userFacing = [big.modePrompt.tradeoff, ...texts(big.modePrompt.names), ...texts(big.modePrompt.recommendedName), ...texts(small.modePrompt.defaultModeName)]
  assert.equal(userFacing.length, 13)
  for (const t of userFacing) {
    assert.doesNotMatch(t, /\bM1\b/i)
    assert.doesNotMatch(t, /full[ _]replay/i)
  }
  assert.match(big.modePrompt.tradeoff, /25%/)
  assert.match(big.modePrompt.tradeoff, /35%/)
  assert.match(big.modePrompt.tradeoff, /按天合并导入/)
})

test('request: importer v2 wording, one evidence entry per message, batch ranges', () => {
  const one = itemRequest([fakeUnit('u-1', '2026-06-01', 9)])
  assert.match(one.message, /^Here is my latest conversation with the user, for memory upkeep\. Conversation on 2026-06-01 from 09:00 to 09:30 \(UTC\+8\) in the repo project\./)
  assert.doesNotMatch(one.message, /session|part|evidence|import/i)
  assert.match(one.message, /Do not record other people's personal information/)
  assert.deepEqual(one.evidence.map((e) => [e.role, e.sourceId, e.date]), [['user', 'u-1-t0:user', '2026-06-01'], ['assistant', 'u-1-t0:assistant', '2026-06-01']])
  const two = itemRequest([fakeUnit('u-1', '2026-06-01', 9), fakeUnit('u-2', '2026-06-01', 10)])
  assert.match(two.message, /\(1\) Conversation on 2026-06-01 from 09:00 to 09:30 \(UTC\+8\) in the repo project: entries 1-2; \(2\) .*: entries 3-4\./)
  assert.throws(() => itemRequest([fakeUnit('u-1', '2026-06-01', 9), fakeUnit('u-2', '2026-06-02', 9)]), /spans several days/)
})

test('scope labels roll worktrees up and flag private names', () => {
  const home = os.homedir().replace(/[^A-Za-z0-9]/g, '-')
  assert.equal(projectLabel(home, '--claude-worktrees-'), '~')
  assert.equal(projectLabel(`${home}-Code-repo--claude-worktrees-x`, '--claude-worktrees-'), '~-Code-repo')
  assert.equal(projectLabel('-private-tmp', '--claude-worktrees-', ['name:^-private-']), '[flagged] name:^-private-')
})

// ---------------------------------------------------------------- job: gates, batches, rollback

let idSeq = 0
const nextId = () => `01JA${String(++idSeq).padStart(22, '0')}`

function writeNode(graph, id, text) {
  fs.mkdirSync(path.join(graph, id), { recursive: true })
  fs.writeFileSync(path.join(graph, id, 'node.md'), `---\ndescription: ${text}\ncreated: 2026-11-06\n---\n${text}\n`)
}

function link(graph, a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    fs.mkdirSync(path.join(graph, x, '__edges__'), { recursive: true })
    fs.symlinkSync(`../../${y}`, path.join(graph, x, '__edges__', y))
  }
}

/**
 * A fake memory agent: per item index a list of behaviours (one per attempt). Default: create one node.
 * {update: id} rewrites an existing node; {linkTo: id} also links the new node; 'throw' | 'fence' |
 * 'unknown' | 'nowrite'; {before: fn} runs first (e.g. a foreign write); {during: fn} runs after the write.
 */
function fakeWriter(graph, script = {}) {
  const calls = []
  const fn = async (req, { contextDate, index, onRecord, signal }) => {
    calls.push({ index, contextDate, evidence: req.evidence.length })
    const b = script[index]?.shift?.() ?? 'ok'
    const spec = typeof b === 'object' ? b : { kind: b }
    spec.before?.()
    const record = { calls: [], fence: { latched: false } }
    onRecord?.('child', record)
    const writes = []
    if (spec.kind !== 'nowrite') {
      const id = spec.update ?? nextId()
      // like agent-tools.js executeRecorded: observers right before and right after the write
      record.hooks?.beforeWrite({ tool: 'memory_write', args: spec.update ? { id } : {} })
      if (spec.update) fs.appendFileSync(path.join(graph, id, 'node.md'), `updated ${contextDate}\n`)
      else writeNode(graph, id, `imported ${contextDate}`)
      if (spec.linkTo) link(graph, id, spec.linkTo)
      record.hooks?.afterWrite({ tool: 'memory_write', args: spec.update ? { id } : {}, result: { id, created: !spec.update, links: spec.linkTo ? [{ to: spec.linkTo, status: 'created' }] : [] } })
      const w = { tool: 'memory_write', landed: true, id, created: !spec.update, links: spec.linkTo ? [spec.linkTo] : [], supersededId: null }
      writes.push(w)
      record.calls.push({ tool: 'memory_write', outcome: { kind: 'result', result: { id, created: !spec.update, links: (w.links).map((to) => ({ to })) } } })
    }
    await spec.during?.()
    if (signal?.aborted) {
      const e = new Error('aborted')
      e.record = { childId: 'c', writes, fenceLatched: false, stopReason: 'error' }
      throw e
    }
    const rec = { childId: 'c', writes, fenceLatched: spec.kind === 'fence', maintenanceDue: null }
    if (spec.kind === 'throw') {
      const e = new Error('memory agent did not finish within 300000 ms and was stopped')
      e.record = { ...rec, stopReason: 'timeout' }
      throw e
    }
    return { text: 'ok', record: { ...rec, stopReason: 'completed', structured: spec.kind !== 'unknown' && spec.kind !== 'nowrite', unknown: false } }
  }
  fn.calls = calls
  return fn
}

const PRE = '01JZZZZZZZZZZZZZZZZZZZZZZZ'

function setupJob(nUnits = 6, extra = {}, jobOpts = {}) {
  const projects = tmp('proj')
  const dir = path.join(projects, '-Users-x-Code-repo')
  fs.mkdirSync(dir, { recursive: true })
  const lines = []
  for (let i = 0; i < nUnits; i++) {
    const day = `2026-06-${String(1 + i).padStart(2, '0')}`
    const ts = (h, m) => new Date(Date.parse(`${day}T${h}:${m}:00+08:00`)).toISOString()
    lines.push({ type: 'user', uuid: `u${i}`, timestamp: ts('09', '00'), sessionId: `s${i}`, cwd: '/Users/x/Code/repo', message: { role: 'user', content: `question ${i} ${'w '.repeat(200)}` } })
    lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: ts('09', '05'), sessionId: `s${i}`, cwd: '/Users/x/Code/repo', message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } })
  }
  fs.writeFileSync(path.join(dir, 'all.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const graph = path.join(tmp('graph'), 'g')
  fs.mkdirSync(graph)
  writeNode(graph, PRE, 'pre-existing memory')
  const config = { projectsDir: projects, now: '2026-07-01T00:00:00+08:00', batchSize: 2, inflightPersistMs: 10, ...extra }
  const job = new HistoryJob({ graphRoot: graph, config, ...jobOpts })
  return { job, graph, config }
}

function confirmAll(job, startChoice) {
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'all of it' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'ok' })
  job.estimate()
  const plan = job.plan()
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go', ...(startChoice ? { choice: startChoice } : {}) })
  return plan
}

const liveNodes = (graph) => fs.readdirSync(graph).filter((d) => /^[0-9A-Z]{26}$/.test(d)).sort()

test('gates: each needs the digest the user saw; a new scan invalidates them; plan and start are bound', async () => {
  const { job } = setupJob(3)
  const s = job.scan({})
  assert.equal(s.unitIds.length, 3)
  assert.throws(() => job.plan(), /not confirmed scope/)
  assert.throws(() => job.confirm({ gate: 'scope', digest: 'nope', userSaid: 'x' }), /out of date/)
  assert.throws(() => job.confirm({ gate: 'scope', digest: s.digest, userSaid: ' ' }), /userSaid/)
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'yes' })
  assert.throws(() => job.plan(), /not confirmed privacy/)
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'yes' })
  const plan = job.plan()
  await assert.rejects(job.runBatch(fakeWriter('/nonexistent')), /not confirmed start/)
  assert.throws(() => job.confirm({ gate: 'start', digest: 'x', userSaid: 'go' }), /out of date/)
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  const s2 = job.scan({ throughDay: '2026-06-02' })
  assert.notEqual(s2.digest, s.digest)
  assert.throws(() => job.plan(), /not confirmed scope/)
  job.confirm({ gate: 'scope', digest: s2.digest, userSaid: 'two days' })
  job.confirm({ gate: 'privacy', digest: s2.digest, userSaid: 'ok' })
  job.plan()
  const pf = path.join(job.dir, 'plan.json')
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'))
  p.items.pop()
  fs.writeFileSync(pf, JSON.stringify(p))
  assert.throws(() => job.loadPlan(), /changed after it was written/)
})

test('H4 approveWrites: gate 4 must approve all writes of the import; the plan says so', async () => {
  const { job, graph } = setupJob(2, {}, { approveWrites: true })
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'y' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'y' })
  const plan = job.plan()
  assert.match(plan.writeApproval, /approves? all|approve all/i)
  assert.throws(() => job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' }), /approve all memory writes/)
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'yes, approve all writes', choice: 'approve_all_writes' })
  const r = await job.runBatch(fakeWriter(graph))
  assert.equal(r.done, true)
  // the setting changing after the plan invalidates it
  const other = new HistoryJob({ graphRoot: graph, config: job.config, approveWrites: false })
  fs.rmSync(path.join(job.dir, 'cursor.json'))
  await assert.rejects(other.runBatch(fakeWriter(graph)), /approveWrites setting changed/)
})

test('mode gate is required when the estimate asks', () => {
  const { job } = setupJob(3, { modePrompt: { askModeThresholdHours: 0 } })
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'y' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'y' })
  const e = job.estimate()
  assert.equal(e.modePrompt.ask, true)
  assert.throws(() => job.plan(), /not confirmed mode/)
  assert.throws(() => job.confirm({ gate: 'mode', digest: e.digest, choice: 'fast', userSaid: 'y' }), /full_replay or m1/)
  job.confirm({ gate: 'mode', digest: e.digest, choice: 'm1', userSaid: 'M1 please' })
  assert.equal(job.plan().mode, 'm1')
})

test('batches: backup before import, snapshot per batch, cursor resumes across calls, contextDate = unit day', async () => {
  const { job, graph } = setupJob(5)
  confirmAll(job)
  const w = fakeWriter(graph)
  assert.equal((await job.runBatch(w)).progress.done, 2)
  assert.ok(fs.existsSync(path.join(job.dir, 'backups', 'before-import', PRE, 'node.md')))
  assert.equal((await new HistoryJob({ graphRoot: graph, config: job.config }).runBatch(w)).progress.done, 4)
  const r3 = await job.runBatch(w)
  assert.equal(r3.done, true)
  assert.deepEqual(w.calls.map((c) => c.contextDate), ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'])
  assert.ok(!fs.existsSync(path.join(job.dir, 'lock')))
})

test('a problem rolls back and reruns once; a second problem stops (rerun_unclean); skip drops only the failing item (H2)', async () => {
  const { job, graph } = setupJob(4, { batchSize: 3 })
  confirmAll(job)
  const before = liveNodes(graph)
  const w = fakeWriter(graph, { 1: ['throw', 'fence'] })
  const r = await job.runBatch(w)
  assert.equal(r.stop.reason, 'rerun_unclean')
  assert.equal(r.stop.startItem, 0)
  assert.deepEqual(liveNodes(graph), before, 'graph is back at its state before the batch')
  assert.equal(job.cursor().rollbacks.length, 2)
  for (const rb of job.cursor().rollbacks) assert.ok(fs.existsSync(rb.backup), 'every replaced tree is kept')
  const res = job.confirm({ gate: 'resume', digest: r.stop.id, choice: 'skip', userSaid: 'skip that one' })
  assert.match(res.note, /resumes at item 1/)
  const r2 = await job.runBatch(fakeWriter(graph))
  const r3 = r2.done ? r2 : await job.runBatch(fakeWriter(graph))
  assert.equal(r3.done, true)
  const rep = job.report()
  assert.equal(rep.delegations.imported + rep.delegations.skipped, 4, 'every item is imported or listed as skipped')
  assert.deepEqual(rep.skippedItems.map((s) => s.item), [2])
  assert.equal(rep.modeName.zh, '逐段导入', 'the report names the mode for the user')
  assert.equal(job.status().plan.modeName.en, 'one conversation segment at a time')
  assert.equal(liveNodes(graph).length, before.length + 3)
})

test('C1: a foreign update to a node the import touched, a foreign edge into an import node, and a foreign node are all foreign', () => {
  const graph = path.join(tmp('attr'), 'g')
  writeNode(graph, PRE, 'pre-existing')
  const snap = path.join(tmp('attr-snap'), 'graph')
  cloneTree(graph, snap)
  const before = manifest(snap)
  // the import creates N (linked to PRE) and updates PRE, through the write hooks
  const touch = emptyTouch()
  const hooks = writeHooks(touch, graph, before)
  const N = nextId()
  hooks.beforeWrite({ tool: 'memory_write', args: {} })
  writeNode(graph, N, 'imported')
  link(graph, N, PRE)
  hooks.afterWrite({ tool: 'memory_write', args: {}, result: { id: N, created: true, links: [{ to: PRE, status: 'created' }] } })
  hooks.beforeWrite({ tool: 'memory_write', args: { id: PRE } })
  fs.appendFileSync(path.join(graph, PRE, 'node.md'), 'import update\n')
  hooks.afterWrite({ tool: 'memory_write', args: { id: PRE }, result: { id: PRE, created: false, links: [] } })
  assert.deepEqual(attributeChanges(before, manifest(graph), touch).foreignNodes, [])
  // another session then edits PRE again, links its own node F to the import's N, and adds G
  fs.appendFileSync(path.join(graph, PRE, 'node.md'), 'foreign update\n')
  const F = nextId()
  writeNode(graph, F, 'foreign')
  link(graph, F, N)
  const d = attributeChanges(before, manifest(graph), touch)
  assert.deepEqual(d.foreignNodes.sort(), [PRE, F, N].sort(), 'PRE content changed after the import, F is new, N got a foreign edge')
  assert.ok(d.foreign.includes(`${N}/__edges__/${F}`))
  fs.mkdirSync(path.join(graph, '.access'), { recursive: true })
  fs.writeFileSync(path.join(graph, '.access', `${N}.log`), 'x\n')
  assert.ok(!attributeChanges(before, manifest(graph), touch).foreign.some((p) => p.startsWith('.access')))
})

test('H1 (re-review): foreign edits DURING a delegation to a created and an updated node, and a foreign edit BEFORE the import’s write, are foreign', async () => {
  const { job, graph } = setupJob(1)
  confirmAll(job)
  const N = nextId()
  // one delegation: creates N and updates PRE (through the write hooks), then — before it ends — another
  // session appends to PRE and to N and attaches a file to N; then the delegation fails
  const w = async (req, { onRecord }) => {
    const record = { calls: [], fence: { latched: false } }
    onRecord('child', record)
    record.hooks.beforeWrite({ tool: 'memory_write', args: {} })
    writeNode(graph, N, 'imported')
    record.hooks.afterWrite({ tool: 'memory_write', args: {}, result: { id: N, created: true, links: [] } })
    record.hooks.beforeWrite({ tool: 'memory_write', args: { id: PRE } })
    fs.appendFileSync(path.join(graph, PRE, 'node.md'), 'import update\n')
    record.hooks.afterWrite({ tool: 'memory_write', args: { id: PRE }, result: { id: PRE, created: false, links: [] } })
    fs.appendFileSync(path.join(graph, PRE, 'node.md'), 'foreign edit while the delegation ran\n')
    fs.appendFileSync(path.join(graph, N, 'node.md'), 'foreign append\n')
    fs.writeFileSync(path.join(graph, N, 'foreign-attachment.md'), 'x')
    const e = new Error('memory agent did not finish within 300000 ms and was stopped')
    e.record = { childId: 'c', writes: [{ landed: true, id: N, created: true, links: [] }, { landed: true, id: PRE, created: false, links: [] }], fenceLatched: false, stopReason: 'timeout' }
    throw e
  }
  const r = await job.runBatch(w)
  assert.equal(r.stop.reason, 'foreign_writes')
  assert.deepEqual(r.stop.foreign.map((f) => f.id).sort(), [N, PRE].sort(), 'both the created and the updated node were edited by someone else')
  assert.ok(fs.readFileSync(path.join(graph, N, 'node.md'), 'utf8').includes('foreign append'), 'nothing was rolled back silently')

  // a foreign edit BEFORE the import's first write to an existing node: the import then writes on top of it
  const { job: j2, graph: g2 } = setupJob(1)
  confirmAll(j2)
  const r2 = await j2.runBatch(fakeWriter(g2, { 0: [{ kind: 'throw', update: PRE, before: () => fs.appendFileSync(path.join(g2, PRE, 'node.md'), 'edited by another session first\n') }] }))
  assert.equal(r2.stop.reason, 'foreign_writes')
  assert.deepEqual(r2.stop.foreign.map((f) => f.id), [PRE])
  assert.ok(j2.cursor().batches.at(-1).touch.foreignTouched.includes(PRE))
})

test('C1(b): the snapshot manifest comes from the copy, so a write landing right after the clone is foreign', async () => {
  const { job, graph } = setupJob(2)
  confirmAll(job)
  const F = nextId()
  const r = await job.runBatch(fakeWriter(graph, { 0: [{ kind: 'throw', before: () => writeNode(graph, F, 'landed between snapshot and manifest') }] }))
  assert.equal(r.stop.reason, 'foreign_writes')
  assert.deepEqual(r.stop.foreign.map((f) => f.id), [F])
  const snapManifest = JSON.parse(fs.readFileSync(path.join(job.cursor().batches.at(-1).snapshot, 'manifest.json'), 'utf8'))
  assert.ok(!Object.keys(snapManifest).some((p) => p.startsWith(F)))
})

test('foreign writes: rollback needs confirmForeign, keeps the replaced tree; "continue" skips the failed item and keeps its partial writes (M2)', async () => {
  const { job, graph } = setupJob(4)
  confirmAll(job)
  await job.runBatch(fakeWriter(graph))
  const F = nextId()
  const r = await job.runBatch(fakeWriter(graph, { 2: [{ kind: 'throw', during: () => writeNode(graph, F, 'written by another session') }] }))
  assert.equal(r.stop.reason, 'foreign_writes')
  assert.equal(r.stop.foreign[0].description, 'written by another session')
  assert.equal((await job.rollback({})).refused, true)
  const done = await job.rollback({ confirmForeign: true })
  assert.equal(done.rolledBack, true)
  assert.ok(!fs.existsSync(path.join(graph, F)))
  assert.ok(fs.existsSync(path.join(done.backup, F, 'node.md')), 'the replaced tree itself is the backup')

  const { job: j2, graph: g2 } = setupJob(4)
  confirmAll(j2)
  const F2 = nextId()
  const rr = await j2.runBatch(fakeWriter(g2, { 1: [{ kind: 'throw', during: () => writeNode(g2, F2, 'other session') }] }))
  assert.equal(rr.stop.reason, 'foreign_writes')
  const partial = liveNodes(g2)
  const res = j2.confirm({ gate: 'resume', digest: rr.stop.id, choice: 'continue', userSaid: 'keep it' })
  assert.match(res.note, /item 2 is skipped and its partial writes stay/)
  assert.equal(j2.cursor().next, 2)
  let out = await j2.runBatch(fakeWriter(g2))
  while (!out.done) out = await j2.runBatch(fakeWriter(g2))
  for (const id of partial) assert.ok(fs.existsSync(path.join(g2, id)))
  assert.deepEqual(j2.report().skippedItems.map((s) => s.item), [2])
})

test('C1(c): a rollback keeps the live bookkeeping (append-only union) and never touches .locks', async () => {
  const { job, graph } = setupJob(2)
  fs.mkdirSync(path.join(graph, '.locks', 'held-before.lock'), { recursive: true })
  fs.mkdirSync(path.join(graph, '.access'), { recursive: true })
  fs.writeFileSync(path.join(graph, '.access', `${PRE}.log`), 'old\n')
  fs.writeFileSync(path.join(graph, '.access', 'only-in-snapshot.log'), 's\n')
  confirmAll(job)
  const r = await job.runBatch(fakeWriter(graph, { 0: [{ kind: 'throw', during: () => {
    fs.appendFileSync(path.join(graph, '.access', `${PRE}.log`), 'new\n')
    fs.rmSync(path.join(graph, '.access', 'only-in-snapshot.log'))
    fs.writeFileSync(path.join(graph, '.advisories'), 'finding\n')
    fs.rmSync(path.join(graph, '.locks', 'held-before.lock'), { recursive: true })
    fs.mkdirSync(path.join(graph, '.locks', 'held-now.lock'))
  } }] }))
  assert.ok(!r.stopped || r.stop.reason !== 'foreign_writes')
  assert.equal(fs.readFileSync(path.join(graph, '.access', `${PRE}.log`), 'utf8'), 'old\nnew\n')
  assert.equal(fs.readFileSync(path.join(graph, '.advisories'), 'utf8'), 'finding\n')
  assert.deepEqual(fs.readdirSync(path.join(graph, '.locks')), ['held-now.lock'], 'live locks moved over, snapshot locks not restored')
})

for (const phase of ['staged', 'moved', 'swapped']) {
  test(`H1: a crash at rollback phase "${phase}" is finished or undone on the next call, losing nothing`, async () => {
    const { job, graph, config } = setupJob(3)
    confirmAll(job)
    const before = manifest(graph)
    const crashing = new HistoryJob({ graphRoot: graph, config, hooks: { crashAt: phase } })
    await assert.rejects(crashing.runBatch(fakeWriter(graph, { 0: ['throw'] })), new RegExp(`simulated crash at ${phase}`))
    assert.ok(job.cursor().rollbackInProgress)
    assert.ok(fs.existsSync(graph) || phase === 'moved')
    const r = await job.runBatch(fakeWriter(graph))
    assert.ok(!job.cursor().rollbackInProgress, 'recovered')
    assert.ok(r.progress.done >= 1)
    if (phase !== 'staged') assert.ok(fs.readdirSync(path.join(job.dir, 'backups')).some((d) => d.startsWith('rolled-back-')))
    assert.ok(fs.existsSync(path.join(graph, PRE, 'node.md')))
    assert.ok(Object.keys(before).every((p) => p.startsWith('.') || fs.existsSync(path.join(graph, p))))
    assert.equal(fs.readdirSync(path.dirname(graph)).filter((n) => n.includes('rollback-staging')).length, 0)
  })
}

test('H1: the graph root recreated by a concurrent writer during the swap aborts the rollback and keeps both trees', async () => {
  const { job, graph, config } = setupJob(2)
  confirmAll(job)
  const X = nextId()
  const racer = new HistoryJob({ graphRoot: graph, config, hooks: { onPhase: (p) => { if (p === 'moved') writeNode(graph, X, 'written into a recreated root') } } })
  const imported = liveNodes(graph)
  const r = await racer.runBatch(fakeWriter(graph, { 0: ['throw'] }))
  assert.equal(r.stop.reason, 'rollback_aborted')
  assert.ok(fs.existsSync(path.join(r.stop.recreated, X, 'node.md')), 'the racing write is kept')
  assert.ok(fs.existsSync(path.join(graph, PRE, 'node.md')), 'the original graph is back in place')
  assert.ok(liveNodes(graph).length >= imported.length)
})

test('H3: rollback takes the same lock; the lock is created with its owner atomically; a dead owner is taken over', async () => {
  const { job, graph } = setupJob(2)
  confirmAll(job)
  await job.runBatch(fakeWriter(graph))
  fs.mkdirSync(path.join(job.dir, 'lock'), { recursive: true })
  fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: process.ppid }))
  await assert.rejects(job.rollback({}), /another process/)
  await assert.rejects(job.runBatch(fakeWriter(graph)), /another process/)
  fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: 999999 }))
  job.lock()
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, 'lock', 'owner.json'), 'utf8')).pid, process.pid)
  job.unlock()
  assert.ok(!fs.existsSync(path.join(job.dir, 'lock')))
})

test('M5: re-import after done skips what was imported', async () => {
  const { job, graph } = setupJob(3, { batchSize: 5 })
  confirmAll(job)
  assert.equal((await job.runBatch(fakeWriter(graph))).done, true)
  const s = job.scan({})
  assert.equal(s.unitIds.length, 0)
  assert.equal(s.alreadyImported, 3)
  assert.equal(fs.readdirSync(path.join(job.dir, 'history')).length, 1)
})

test('M6: rolling back to before the import clears the start confirmation', async () => {
  const { job, graph } = setupJob(2)
  confirmAll(job)
  await job.runBatch(fakeWriter(graph))
  const r = await job.rollback({ to: 'before_import' })
  assert.equal(r.rolledBack, true)
  assert.deepEqual(liveNodes(graph), [PRE])
  await assert.rejects(job.runBatch(fakeWriter(graph)), /not confirmed start/)
})

test('cancel: an aborted signal stops cleanly with one rollback', async () => {
  const { job, graph } = setupJob(3, { batchSize: 3 })
  confirmAll(job)
  const before = liveNodes(graph)
  const ctrl = new AbortController()
  const r = await job.runBatch(fakeWriter(graph, { 1: [{ kind: 'ok', during: () => ctrl.abort() }] }), { signal: ctrl.signal })
  assert.equal(r.stop.reason, 'cancelled')
  assert.equal(job.cursor().rollbacks.length, 1)
  assert.deepEqual(liveNodes(graph), before)
})

test('M1: a supersede counts the superseded node as touched; write hashes are persisted as they happen', async () => {
  const graph = path.join(tmp('sup'), 'g')
  writeNode(graph, PRE, 'old decision')
  const before = manifest(graph)
  const t = emptyTouch()
  const hooks = writeHooks(t, graph, before)
  const N = nextId()
  hooks.beforeWrite({ tool: 'memory_write', args: { supersedes: PRE } })
  writeNode(graph, N, 'new decision')
  fs.appendFileSync(path.join(graph, PRE, 'node.md'), `Superseded by ${N}\n`)
  link(graph, N, PRE)
  hooks.afterWrite({ tool: 'memory_write', args: { supersedes: PRE }, result: { id: N, created: true, links: [], superseded: { id: PRE } } })
  assert.ok(t.hashes[PRE] && t.hashes[N] && t.links.includes(`${N}|${PRE}`))
  assert.deepEqual(attributeChanges(before, manifest(graph), t).foreignNodes, [])

  const { job, graph: g } = setupJob(1)
  confirmAll(job)
  let seen = null
  await job.runBatch(fakeWriter(g, { 0: [{ kind: 'ok', during: () => { seen = JSON.parse(fs.readFileSync(path.join(job.dir, 'cursor.json'), 'utf8')).batches.at(-1).touch } }] }))
  assert.equal(seen.created.length, 1)
  assert.ok(seen.hashes[seen.created[0]], 'the created node’s hash is on disk before the delegation ends')
})

test('unknown replies pass; >= 3 and > 10% in a month stop; continue acknowledges the month', async () => {
  const { job, graph } = setupJob(4, { batchSize: 4 })
  confirmAll(job)
  const r = await job.runBatch(fakeWriter(graph, { 0: ['unknown'] }))
  assert.equal(r.done, true)
  assert.equal(r.progress.unknowns, 1)
  const { job: j2, graph: g2 } = setupJob(4, { batchSize: 4 })
  confirmAll(j2)
  const r2 = await j2.runBatch(fakeWriter(g2, { 0: ['unknown'], 1: ['unknown'], 2: ['unknown'] }))
  assert.equal(r2.stop.reason, 'unknown_rate')
  j2.confirm({ gate: 'resume', digest: r2.stop.id, choice: 'continue', userSaid: 'fine' })
  assert.equal(j2.cursor().stop, null)
})

test('classification', () => {
  assert.equal(classify(new Error('memory agent did not finish within 1 ms'), null).reason, 'timed out')
  assert.equal(classify(null, { stopReason: 'completed', fenceLatched: true, writes: [] }).kind, 'problem')
  assert.equal(classify(null, { stopReason: 'completed', fenceLatched: false, structured: false, writes: [] }).kind, 'problem')
  assert.equal(classify(null, { stopReason: 'completed', fenceLatched: false, structured: false, writes: [{ landed: true }] }).kind, 'unknown')
  assert.equal(classify(null, { stopReason: 'completed', fenceLatched: false, structured: true, writes: [] }).kind, 'ok')
})

test('M3: redaction stays linear on adversarial input (100K chars under 50 ms each) and bounds input', () => {
  const r = new Redactor()
  for (const s of ['a.'.repeat(50000) + '://x', 'a'.repeat(100000), '"' + '\\!'.repeat(50000), "'" + '\\&'.repeat(50000), 'password=' + 'x'.repeat(100000), 'mysql ' + 'a '.repeat(50000), 'mysql '.repeat(17000), 'mysql ' + 'a -x '.repeat(20000)]) {
    const t0 = performance.now()
    r.redact(s)
    assert.ok(performance.now() - t0 < 50, `${s.slice(0, 12)}… took ${Math.round(performance.now() - t0)} ms`)
  }
  assert.equal(cpLen(r.redact('x'.repeat(MAX_REDACT_INPUT + 10))[0]), MAX_REDACT_INPUT)
})

// ---------------------------------------------------------------- the bundle row

function rowCtx(settings) {
  const tools = new Map()
  const listeners = new Map()
  const sections = []
  const ctx = {
    [SETTINGS_SERVICE]: settings,
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    effect: (fn) => fn(),
    on: (n, fn) => listeners.set(n, fn),
    inject: (_names, cb) => cb({ systemPrompt: { section: (s) => sections.push(s) } }),
    get: () => undefined,
  }
  return { ctx, tools, listeners, sections }
}

test('row: needs the memory agent switch, registers the tools and the guide; by default the gates have no approval card, only a foreign-discarding rollback does', async () => {
  assert.throws(() => history.apply(rowCtx(undefined).ctx, {}), /memory agent switch/)
  const graph = path.join(tmp('rowgraph'), 'g')
  const { ctx, tools, listeners, sections } = rowCtx(agent.resolveAgentConfig({ graphRoot: graph }))
  history.apply(ctx, { projectsDir: path.join(fixtures, 'projects'), now: '2026-06-09T00:10:00+08:00' })
  assert.deepEqual([...tools.keys()].sort(), [...history.TOOLS].sort())
  assert.equal(sections[0].name, 'memory:history-import')
  for (const s of ['导入会直接写进你正在用的记忆图', 'Gate 1', 'Gate 2', 'Gate 3', 'Gate 4', 'history_import_batch', 'foreign_writes', 'Memory agent', 'known formats', 'approve_all_writes', 'rerun_unclean']) assert.ok(sections[0].text.includes(s), s)
  for (const s of ['逐段导入', '按天合并导入', 'batched by day', 'one conversation segment at a time', 'Never say the internal ids']) assert.ok(sections[0].text.includes(s), s)
  const ask = listeners.get('tools/pre-execute')
  for (const gate of ['scope', 'privacy', 'mode', 'start', 'resume']) {
    assert.equal(ask({ name: 'history_confirm', arguments: { gate, userSaid: 'yes' } }, () => 'next'), 'next', `no card for gate ${gate}`)
  }
  assert.equal(ask({ name: 'history_rollback', arguments: {} }, () => 'next'), 'next', 'a plain rollback is confirmed in the chat')
  assert.equal(ask({ name: 'history_rollback', arguments: { to: 'before_import' } }, () => 'next'), 'next')
  const foreign = ask({ name: 'history_rollback', arguments: { confirmForeign: true } }, () => 'next')
  assert.equal(foreign.kind, 'ask', 'discarding other sessions\' writes keeps its card')
  assert.match(foreign.displayReason.en, /other sessions/)
  assert.match(foreign.displayReason.zh, /其它会话/)
  assert.equal(ask({ name: 'history_scan', arguments: {} }, () => 'next'), 'next')
  const scanOut = JSON.parse((await tools.get('history_scan').execute({}, {})).text)
  assert.ok(scanOut.units > 0 && scanOut.digest)
  assert.ok(!JSON.stringify(scanOut).includes('Plan the deploy'), 'no conversation text in tool output')
  const err = JSON.parse((await tools.get('history_plan').execute({}, {})).text)
  assert.equal(err.error, 'confirmation_missing')
})

test('row: askOnConfirm true is the opt-in for a card on every gate and every rollback', () => {
  const graph = path.join(tmp('rowoptin'), 'g')
  const { ctx, listeners } = rowCtx(agent.resolveAgentConfig({ graphRoot: graph }))
  history.apply(ctx, { projectsDir: path.join(fixtures, 'projects'), askOnConfirm: true })
  const ask = listeners.get('tools/pre-execute')
  for (const gate of ['scope', 'privacy', 'mode', 'resume']) {
    const r = ask({ name: 'history_confirm', arguments: { gate, userSaid: 'yes' } }, () => 'next')
    assert.equal(r.kind, 'ask', gate)
    assert.match(r.displayReason.zh, new RegExp(gate))
  }
  const start = ask({ name: 'history_confirm', arguments: { gate: 'start', userSaid: 'go' } }, () => 'next')
  assert.equal(start.kind, 'ask')
  assert.doesNotMatch(start.displayReason.en, /ALL writes/, 'without approveWrites the start card does not approve all writes')
  assert.equal(ask({ name: 'history_rollback', arguments: {} }, () => 'next').kind, 'ask')
  assert.equal(ask({ name: 'history_rollback', arguments: { confirmForeign: true } }, () => 'next').kind, 'ask')
  assert.equal(ask({ name: 'history_scan', arguments: {} }, () => 'next'), 'next')
})

test('precondition: 0 or <= 20 existing nodes are allowed (listed for gate 1); 21 refuse with graph_too_large at scan, plan and first batch', async () => {
  const { job, graph } = setupJob(2)
  fs.rmSync(path.join(graph, PRE), { recursive: true })
  assert.deepEqual(job.scan({}).existingNodes, [])
  for (let i = 0; i < 20; i++) writeNode(graph, nextId(), `existing ${i}`)
  const s20 = job.scan({})
  assert.equal(s20.existingNodes.length, 20)
  assert.equal(s20.existingNodes[0].description, 'existing 0')
  job.confirm({ gate: 'scope', digest: s20.digest, userSaid: 'ok' })
  job.confirm({ gate: 'privacy', digest: s20.digest, userSaid: 'ok' })
  const plan = job.plan()
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  writeNode(graph, nextId(), 'the 21st')
  assert.throws(() => job.plan(), (e) => e.code === 'graph_too_large' && /20/.test(e.message) && /新的空目录/.test(e.message) && /new empty directory/.test(e.message))
  await assert.rejects(job.runBatch(fakeWriter(graph)), (e) => e.code === 'graph_too_large')
  assert.throws(() => job.scan({}), (e) => e.code === 'graph_too_large')
})

test('M5 in this version: after done, a new scan hits the precondition once the graph is no longer small; imported unit ids are kept', async () => {
  const { job, graph } = setupJob(3, { batchSize: 5, maxExistingNodes: 2 })
  confirmAll(job)
  assert.equal((await job.runBatch(fakeWriter(graph))).done, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, 'imported.json'), 'utf8')).unitIds.length, 3)
  assert.throws(() => job.scan({}), (e) => e.code === 'graph_too_large')
})

test('approveWrites: the start gate always shows the "approves ALL writes" card, whatever askOnConfirm says; its text comes from the plan', async () => {
  const { job } = setupJob(2, {}, { approveWrites: true })
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'y' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'y' })
  const plan = job.plan()
  assert.throws(() => job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' }), (e) => e.code === 'needs_write_approval')
  assert.equal(job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'approve all', choice: 'approve_all_writes' }).recorded.choice, 'approve_all_writes')

  const graph = path.join(tmp('rowapprove'), 'g')
  const settings = agent.resolveAgentConfig({ graphRoot: graph, approveWrites: true })
  const { ctx, tools, listeners } = rowCtx(settings)
  history.apply(ctx, { projectsDir: path.join(fixtures, 'projects'), now: '2026-06-09T00:10:00+08:00' })
  const scanOut = JSON.parse((await tools.get('history_scan').execute({}, {})).text)
  const j = new HistoryJob({ graphRoot: graph, config: { projectsDir: path.join(fixtures, 'projects') }, approveWrites: true })
  j.confirm({ gate: 'scope', digest: scanOut.digest, userSaid: 'y' })
  j.confirm({ gate: 'privacy', digest: scanOut.digest, userSaid: 'y' })
  const p = j.plan()
  const ask = listeners.get('tools/pre-execute')({ name: 'history_confirm', arguments: { gate: 'start', userSaid: 'the agent says anything' } }, () => 'next')
  assert.equal(ask.kind, 'ask')
  assert.match(ask.displayReason.en, new RegExp(`ALL writes of its ${p.delegations} memory-agent delegations into ${graph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(ask.displayReason.zh, /全部写入/)
  assert.doesNotMatch(ask.displayReason.en, /the agent says anything/)
  assert.equal(listeners.get('tools/pre-execute')({ name: 'history_confirm', arguments: { gate: 'scope', userSaid: 'y' } }, () => 'next'), 'next', 'only the start gate gets the card')
  const off = rowCtx(settings)
  history.apply(off.ctx, { projectsDir: path.join(fixtures, 'projects'), askOnConfirm: false })
  assert.equal(off.listeners.get('tools/pre-execute')({ name: 'history_confirm', arguments: { gate: 'start', userSaid: 'go' } }, () => 'next').kind, 'ask', 'askOnConfirm false does not remove it')
})

test('M2 (re-review): "stop" records the imported items so a re-import skips them', async () => {
  const { job, graph } = setupJob(3, { batchSize: 3 })
  confirmAll(job)
  const r = await job.runBatch(fakeWriter(graph, { 2: ['throw', 'throw'] }))
  assert.equal(r.stop.reason, 'rerun_unclean')
  job.confirm({ gate: 'resume', digest: r.stop.id, choice: 'stop', userSaid: 'stop here' })
  // the graph was rolled back to the batch start, so nothing of this batch is kept; import one batch first
  const { job: j2, graph: g2 } = setupJob(3, { batchSize: 2 })
  confirmAll(j2)
  await j2.runBatch(fakeWriter(g2))
  const r2 = await j2.runBatch(fakeWriter(g2, { 2: ['throw', 'throw'] }))
  j2.confirm({ gate: 'resume', digest: r2.stop.id, choice: 'stop', userSaid: 'stop' })
  const ids = JSON.parse(fs.readFileSync(path.join(j2.dir, 'imported.json'), 'utf8')).unitIds
  assert.equal(ids.length, 2)
  const s = j2.scan({})
  assert.equal(s.alreadyImported, 2)
  assert.equal(s.unitIds.length, 1)
})

test('LOW: onRecord runs inside try, so a throwing observer never leaks the delegation record', async () => {
  const subagents = { resolveMaxDepth: () => 1, async startActivation() { throw new Error('unreachable') } }
  const ctx = { get: (n) => ({ subagents })[n] }
  const { state } = await import('../lib/bundle/state.js')
  await assert.rejects(agent.delegate(ctx, agent.resolveAgentConfig({ graphRoot: tmp('or') }), { message: 'm', authority: 'manage', evidence: [] }, { agent: { id: 'p' } }, { onRecord: () => { throw new Error('observer broke') } }), /observer broke/)
  assert.equal(state.delegations.size, 0)
})

test('LOW: competing lock takeovers — the loser re-reads the owner and backs off', () => {
  const { job, config, graph } = setupJob(1)
  fs.mkdirSync(job.dir, { recursive: true })
  fs.mkdirSync(path.join(job.dir, 'lock'))
  fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: 999999, nonce: 'dead' }))
  const loser = new HistoryJob({ graphRoot: graph, config, hooks: { afterLock: () => fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: process.ppid, nonce: 'winner' })) } })
  assert.throws(() => loser.lock(), (e) => e.code === 'busy' && /at the same moment/.test(e.message))
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.dir, 'lock', 'owner.json'), 'utf8')).nonce, 'winner')
  loser.unlock()
  assert.ok(fs.existsSync(path.join(job.dir, 'lock')), 'the loser does not remove the winner’s lock')
})

test('LOW: a crash between saving the cursor and moving the replaced tree is finished by recovery', async () => {
  const { job, graph, config } = setupJob(2)
  confirmAll(job)
  const crashing = new HistoryJob({ graphRoot: graph, config, hooks: { crashAt: 'cursor_saved' } })
  await assert.rejects(crashing.runBatch(fakeWriter(graph, { 0: ['throw'] })), /cursor_saved/)
  assert.ok(job.cursor().pendingBackup)
  await job.runBatch(fakeWriter(graph))
  assert.ok(!job.cursor().pendingBackup)
  assert.ok(fs.readdirSync(path.join(job.dir, 'backups')).some((d) => d.startsWith('rolled-back-')))
  assert.equal(fs.readdirSync(path.dirname(graph)).filter((n) => n.includes('rollback-replaced')).length, 0)
})

for (const choice of ['use_restored', 'keep_current']) {
  test(`LOW: an interrupted rollback whose graph folder was recreated keeps every tree and asks (${choice})`, async () => {
    const { job, graph, config } = setupJob(2)
    confirmAll(job)
    const crashing = new HistoryJob({ graphRoot: graph, config, hooks: { crashAt: 'moved' } })
    await assert.rejects(crashing.runBatch(fakeWriter(graph, { 0: ['throw'] })), /moved/)
    const R = nextId()
    writeNode(graph, R, 'written into the recreated folder')
    const st = job.status()
    assert.ok(st.rollbackInProgress)
    const r = await job.runBatch(fakeWriter(graph))
    assert.equal(r.stop.reason, 'rollback_interrupted')
    assert.deepEqual(r.stop.options, ['use_restored', 'keep_current', 'stop'])
    const res = job.confirm({ gate: 'resume', digest: r.stop.id, choice, userSaid: choice })
    const backups = fs.readdirSync(path.join(job.dir, 'backups'))
    if (choice === 'use_restored') {
      assert.ok(!fs.existsSync(path.join(graph, R)), 'the restored graph is in place')
      assert.ok(backups.some((d) => d.startsWith('recreated-during-rollback-')) && fs.existsSync(path.join(job.dir, 'backups', backups.find((d) => d.startsWith('recreated-during-rollback-')), R)))
      assert.match(res.note, /restored graph is in place/)
    } else {
      assert.ok(fs.existsSync(path.join(graph, R)), 'the recreated folder stays the graph')
      assert.ok(backups.some((d) => d.startsWith('unused-restore-')) && backups.some((d) => d.startsWith('replaced-')))
    }
    assert.equal(fs.readdirSync(path.dirname(graph)).filter((n) => n.includes('rollback-')).length, 0)
  })
}

test('LOW: plan and the first batch re-check the existing node ids against the gate-1 list', async () => {
  const { job, graph } = setupJob(1)
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'y' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'y' })
  const plan = job.plan()
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  // same count, different node
  fs.rmSync(path.join(graph, PRE), { recursive: true })
  writeNode(graph, nextId(), 'a different node')
  assert.throws(() => job.plan(), (e) => e.code === 'existing_nodes_changed')
  await assert.rejects(job.runBatch(fakeWriter(graph)), (e) => e.code === 'existing_nodes_changed')
})

test('agent-tools write hooks fire around a real memory_write in a real manage delegation', async () => {
  const agentTools = await import('../lib/bundle/agent-tools.js')
  const graphRoot = tmp('hookgraph')
  const host = rowCtx(undefined)
  const provided = new Map()
  const hostCtx = { ...host.ctx, provide: (n, v) => provided.set(n, v), on: () => {}, tools: { register: (d) => host.tools.set(d.name, d) } }
  agent.apply(hostCtx, { graphRoot })
  const tools = new Map()
  const childCtx = {
    [SETTINGS_SERVICE]: provided.get(SETTINGS_SERVICE),
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)), definitions: () => [...tools.keys()].map((name) => ({ name })), restrict: () => () => {} },
    inject: () => () => {},
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }
  agentTools.apply(childCtx, { authority: 'manage' })
  const events = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      const exec = { agent: { id: spec.childId } }
      const result = (async () => {
        await tools.get('memory_write').execute({ description: 'hooked write', body: 'x' }, exec)
        return { output: [{ type: 'text', text: JSON.stringify({ text: 'ok', unknown: false, citations: [] }) }], stopReason: 'completed' }
      })()
      return { childId: spec.childId, result, dispose: async () => {} }
    },
  }
  const out = await agent.delegate({ get: (n) => ({ subagents })[n] }, provided.get(SETTINGS_SERVICE), { message: 'm', authority: 'manage', evidence: [] }, { agent: { id: 'p' } }, {
    withRecord: true,
    onRecord: (_id, rec) => { rec.hooks = { beforeWrite: (e) => events.push(['before', e.tool]), afterWrite: (e) => events.push(['after', e.tool, e.result.id]) } },
  })
  assert.deepEqual(events.map((e) => e.slice(0, 2)), [['before', 'memory_write'], ['after', 'memory_write']])
  assert.equal(events[1][2], out.record.writes[0].id)
})
