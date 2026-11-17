/**
 * The job itself, driven directly (hooks for timing and crashes): the three LOW findings of issue #308.
 *   1. two processes taking over the same dead lock: exactly one wins, the other gets busy;
 *   2. keep_current after an interrupted rollback abandons the batch, so the next batch reports no
 *      false foreign writes;
 *   3. "continue" after foreign_writes, then "stop": the skipped item whose partial writes were kept is
 *      recorded as partial in imported.json, skipped by a later scan and plan, and listed in the report.
 * No model, no network.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HistoryJob } from '../src/job.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `job-${p}-`))
let idSeq = 0
const nextId = () => `01JC${String(++idSeq).padStart(22, '0')}`
const liveNodes = (graph) => fs.readdirSync(graph).filter((d) => /^[0-9A-Z]{26}$/.test(d)).sort()

function writeNode(graph, id, text) {
  fs.mkdirSync(path.join(graph, id), { recursive: true })
  fs.writeFileSync(path.join(graph, id, 'node.md'), `---\ndescription: ${text}\ncreated: 2026-11-09\n---\n${text}\n`)
}

/**
 * runBatch's delegateItem: one created node per item through the write hooks. `script[index]` is a list
 * of behaviours per call: 'ok' | 'throw' | {kind: 'throw', during}.
 */
function fakeWriter(graph, script = {}) {
  const calls = []
  const fn = async (req, { contextDate, index, onRecord }) => {
    calls.push({ index, contextDate })
    const raw = script[index]?.shift?.() ?? 'ok'
    const spec = typeof raw === 'string' ? { kind: raw } : raw
    const record = { childId: `c${index}` }
    onRecord?.(null, record)
    const id = nextId()
    record.hooks?.beforeWrite({ tool: 'memory_write', args: {} })
    writeNode(graph, id, `imported ${contextDate}`)
    record.hooks?.afterWrite({ tool: 'memory_write', args: {}, result: { id, created: true, links: [] } })
    const writes = [{ tool: 'memory_write', landed: true, id }]
    await spec.during?.()
    if (spec.kind === 'throw') {
      const e = new Error('memory agent did not finish within 300000 ms and was stopped')
      e.record = { childId: `c${index}`, writes, fenceLatched: false, stopReason: 'timeout' }
      throw e
    }
    return { text: 'ok', record: { childId: `c${index}`, writes, fenceLatched: false, stopReason: 'completed', structured: true, maintenanceDue: null } }
  }
  fn.calls = calls
  return fn
}

function setupJob(nUnits, extra = {}, jobOpts = {}) {
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
  const config = { projectsDir: projects, now: '2026-07-01T00:00:00+08:00', batchSize: 2, ...extra }
  return { job: new HistoryJob({ graphRoot: graph, config, ...jobOpts }), graph, config }
}

function confirmAll(job) {
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'all of it' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'ok' })
  job.estimate()
  const plan = job.plan()
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  return plan
}

const readOwner = (job) => JSON.parse(fs.readFileSync(path.join(job.dir, 'lock', 'owner.json'), 'utf8'))

// ---------------------------------------------------------------- 1. lock takeover race

test('#308.1 lock: two takeovers of the same dead lock — exactly one wins, the other gets busy and leaves the winner’s lock in place', () => {
  const { job, graph, config } = setupJob(1)
  fs.mkdirSync(path.join(job.dir, 'lock'), { recursive: true })
  fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: 999999, nonce: 'dead' }))
  const a = new HistoryJob({ graphRoot: graph, config })
  let aError = null
  // B judges pid 999999 dead; before B moves the lock aside, A judges the same, takes over and holds it.
  const b = new HistoryJob({ graphRoot: graph, config, hooks: { beforeTakeover: () => {
    try {
      a.lock()
    } catch (error) {
      aError = error
    }
  } } })
  assert.throws(() => b.lock(), (e) => e.code === 'busy' && /took the lock over at the same moment/.test(e.message))
  assert.equal(aError, null, 'A took the lock')
  assert.equal(readOwner(job).nonce, a.lockNonce, 'A’s lock is back in place, not B’s')
  assert.equal(b.lockNonce, undefined, 'B holds nothing')
  assert.deepEqual(fs.readdirSync(job.dir).filter((n) => n.startsWith('lock.')), [], 'no stale or temp lock dirs left')
  b.unlock()
  assert.equal(readOwner(job).nonce, a.lockNonce, 'B’s unlock does not remove A’s lock')
  a.unlock()
  assert.ok(!fs.existsSync(path.join(job.dir, 'lock')))
})

test('#308.1 lock: a dead owner is still taken over (legacy owner without a nonce too)', () => {
  const { job } = setupJob(1)
  fs.mkdirSync(path.join(job.dir, 'lock'), { recursive: true })
  fs.writeFileSync(path.join(job.dir, 'lock', 'owner.json'), JSON.stringify({ pid: 999999 }))
  job.lock()
  assert.equal(readOwner(job).pid, process.pid)
  assert.deepEqual(fs.readdirSync(job.dir).filter((n) => n.startsWith('lock.')), [])
  job.unlock()
  assert.ok(!fs.existsSync(path.join(job.dir, 'lock')))
})

// ---------------------------------------------------------------- 2. keep_current

test('#308.2 keep_current after an interrupted rollback: the batch is abandoned and the next batch reports no false foreign writes', async () => {
  const { job, graph, config } = setupJob(4)
  confirmAll(job)
  // One clean batch first, so the snapshot of the next batch holds imported nodes.
  assert.equal((await job.runBatch(fakeWriter(graph))).progress.done, 2)
  const crashing = new HistoryJob({ graphRoot: graph, config, hooks: { crashAt: 'moved' } })
  await assert.rejects(crashing.runBatch(fakeWriter(graph, { 2: ['throw'] })), /simulated crash at moved/)
  // Another writer recreates the graph folder meanwhile.
  const R = nextId()
  writeNode(graph, R, 'written into the recreated folder')
  const r = await job.runBatch(fakeWriter(graph))
  assert.equal(r.stop.reason, 'rollback_interrupted')
  const res = job.confirm({ gate: 'resume', digest: r.stop.id, choice: 'keep_current', userSaid: 'keep what is there now' })
  assert.match(res.note, /current graph is kept/)
  const cur = job.cursor()
  assert.equal(cur.batches.filter((b) => b.status === 'running').length, 0, 'no batch is left running')
  assert.equal(cur.batches.at(-1).status, 'abandoned')
  const backups = fs.readdirSync(path.join(job.dir, 'backups'))
  assert.ok(backups.some((d) => d.startsWith('unused-restore-')) && backups.some((d) => d.startsWith('replaced-')), 'both trees are kept')

  const next = await job.runBatch(fakeWriter(graph))
  assert.ok(!next.stopped, `no stop: ${next.stop?.reason} ${next.stop?.detail ?? ''}`)
  assert.ok(next.progress.done > cur.next, 'the import moved on')
  assert.ok(fs.existsSync(path.join(graph, R, 'node.md')), 'the other writer’s node stays')
  const after = job.cursor()
  assert.equal(after.batches.at(-1).status, 'done')
  const snap = JSON.parse(fs.readFileSync(path.join(after.batches.at(-1).snapshot, 'manifest.json'), 'utf8'))
  assert.ok(Object.keys(snap).some((p) => p.startsWith(`${R}/`)), 'the new batch’s snapshot was taken from the current graph')
  // A user rollback to the last batch uses that fresh snapshot, never the abandoned batch’s.
  const rb = await job.rollback({})
  assert.equal(rb.rolledBack, true, JSON.stringify(rb.foreign ?? null))
  assert.ok(fs.existsSync(path.join(graph, R, 'node.md')))
})

// ---------------------------------------------------------------- 3. partial items

test('#308.3 continue after foreign_writes, then stop: the item is recorded as partial, a re-scan and plan skip it, the report lists it', async () => {
  const { job, graph } = setupJob(5)
  confirmAll(job)
  const F = nextId()
  // Item 2 fails while another session writes F: the import stops with foreign_writes.
  const r = await job.runBatch(fakeWriter(graph, { 1: [{ kind: 'throw', during: () => writeNode(graph, F, 'another session') }] }))
  assert.equal(r.stop.reason, 'foreign_writes')
  const partialUnits = job.loadPlan().items[1]
  const partialNodes = liveNodes(graph)
  job.confirm({ gate: 'resume', digest: r.stop.id, choice: 'continue', userSaid: 'keep the graph' })
  // The next batch fails twice (rerun_unclean); the user stops there.
  const r2 = await job.runBatch(fakeWriter(graph, { 3: ['throw', 'throw'] }))
  assert.equal(r2.stop.reason, 'rerun_unclean')
  job.confirm({ gate: 'resume', digest: r2.stop.id, choice: 'stop', userSaid: 'stop here' })
  for (const id of partialNodes) assert.ok(fs.existsSync(path.join(graph, id)), 'the partial writes stay')

  const report = job.report()
  assert.deepEqual(report.partialItems.map((x) => x.item), [2])
  assert.deepEqual(report.partialItems[0].units, partialUnits)
  assert.deepEqual(report.skippedItems.map((x) => x.item), [2])

  const imported = JSON.parse(fs.readFileSync(path.join(job.dir, 'imported.json'), 'utf8'))
  assert.deepEqual(imported.partial, partialUnits)
  assert.ok(!partialUnits.some((u) => imported.unitIds.includes(u)), 'partial, not imported')

  // A new import: the scan and the plan skip the partial item; the failed (rolled-back) items come back.
  const s = job.scan({})
  for (const u of partialUnits) assert.ok(!s.unitIds.includes(u), 'the re-scan skips the partial item')
  assert.equal(s.alreadyPartial, partialUnits.length)
  assert.equal(s.alreadyImported, imported.unitIds.length + partialUnits.length)
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'the rest' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'ok' })
  job.estimate()
  const p2 = job.plan()
  assert.ok(!p2.items.flat().some((u) => partialUnits.includes(u)), 'the plan skips the partial item')
  assert.ok(p2.items.length > 0)
})

test('#308.3 a partial item whose writes a later rollback discarded is not partial any more and is imported again', async () => {
  const { job, graph } = setupJob(3, { batchSize: 5 })
  confirmAll(job)
  const F = nextId()
  const r = await job.runBatch(fakeWriter(graph, { 0: [{ kind: 'throw', during: () => writeNode(graph, F, 'another session') }] }))
  assert.equal(r.stop.reason, 'foreign_writes')
  const partialUnits = job.loadPlan().items[0]
  job.confirm({ gate: 'resume', digest: r.stop.id, choice: 'continue', userSaid: 'keep the graph' })
  assert.deepEqual(job.report().partialItems.map((x) => x.item), [1])
  // Back to before the import (the user agreed to lose F): the partial writes are gone with it.
  const rb = await job.rollback({ to: 'before_import', confirmForeign: true })
  assert.equal(rb.rolledBack, true)
  assert.deepEqual(job.report().partialItems, [])
  assert.deepEqual(job.report().skippedItems, [], 'the item is no longer skipped')
  assert.ok(!fs.existsSync(path.join(job.dir, 'imported.json')) || !(JSON.parse(fs.readFileSync(path.join(job.dir, 'imported.json'), 'utf8')).partial ?? []).some((u) => partialUnits.includes(u)))
})
