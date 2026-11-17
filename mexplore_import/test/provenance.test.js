/**
 * `.provenance/` in the history-import rollback (issue #317).
 *
 * The import writes into the live graph, snapshots it before every batch and
 * rolls back to that snapshot when a batch fails. `.provenance/` is bookkeeping
 * the engine appends to on every write (#317), so it must:
 *
 *   - never be reported as a FOREIGN write — a rollback would stop and ask the
 *     user to discard a log line the import itself caused;
 *   - never be rewound — the live copy is a superset of the snapshot's, and
 *     lines appended during the batch describe writes that happened;
 *   - still leave a real foreign write NEXT TO it detectable, so the exclusion
 *     is scoped to the directory and does not blind the attribution.
 *
 * The KNOWN GAP is deliberately not asserted as a feature: appends made between
 * copy and swap can be lost, and job.js's module comment records that.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { HistoryJob, attributeChanges, manifest } from '../src/job.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `prov-${p}-`))
let idSeq = 0
const nextId = () => `01JC${String(++idSeq).padStart(22, '0')}`

function writeNode(graph, id, text) {
  fs.mkdirSync(path.join(graph, id), { recursive: true })
  fs.writeFileSync(path.join(graph, id, 'node.md'), `---\ndescription: ${text}\ncreated: 2026-11-09\n---\n${text}\n`)
}

/** One provenance line, in the engine's v1 shape. */
const provenanceLine = (op, session = 'session-root-a') => `${JSON.stringify({ v: 1, ts: '2026-11-10T09:00:00.000Z', op, actor: 'chat', host: 'dsh', session })}\n`

/** Append a line the way the engine does: one node's file, `.provenance/<id>.jsonl`. */
function appendProvenance(graph, id, op = 'update') {
  const dir = path.join(graph, '.provenance')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), provenanceLine(op))
}

/** The scan/estimate/plan/start sequence the job's four gates require. */
function confirmAll(job) {
  const s = job.scan({})
  job.confirm({ gate: 'scope', digest: s.digest, userSaid: 'all of it' })
  job.confirm({ gate: 'privacy', digest: s.digest, userSaid: 'ok' })
  job.estimate()
  const plan = job.plan()
  job.confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  return plan
}

/**
 * One blank conversation per unit, so the scan has something to import. The
 * delegate is the caller's, and runs AFTER the snapshot: this is the batch's
 * write phase, which is exactly when a real writer appends provenance.
 */
function setupJob(nUnits, delegate) {
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
  const config = { projectsDir: projects, now: '2026-07-01T00:00:00+08:00', batchSize: 2 }
  return { job: new HistoryJob({ graphRoot: graph, config }), graph, config, delegate }
}

/**
 * A delegate writer. `during` runs inside the delegation on every attempt (so a
 * provenance append or a foreign node can land DURING the batch, which is
 * exactly the window this test is about); `fail` makes the delegation throw, so
 * the batch takes the rerun/rollback path.
 */
function writer(graph, { fail = false, during } = {}) {
  const fn = async (req, { index, onRecord }) => {
    const record = { childId: `c${index}` }
    onRecord?.(null, record)
    if (fail) {
      during?.()
      const e = new Error('memory agent did not finish within 300000 ms and was stopped')
      e.record = { childId: `c${index}`, writes: [], fenceLatched: false, stopReason: 'timeout' }
      throw e
    }
    const id = nextId()
    record.hooks?.beforeWrite({ tool: 'memory_write', args: {} })
    writeNode(graph, id, `imported ${index}`)
    during?.()
    record.hooks?.afterWrite({ tool: 'memory_write', args: {}, result: { id, created: true, links: [] } })
    return { text: 'ok', record: { childId: `c${index}`, writes: [{ tool: 'memory_write', landed: true, id }], fenceLatched: false, stopReason: 'completed', structured: true, maintenanceDue: null } }
  }
  return fn
}

test('.provenance is never a foreign write, and a real foreign write beside it still is', () => {
  // Pure attribution: a provenance append between two manifests must be
  // skipped, while a node write in the same diff must be reported.
  const before = { 'MAP.md': 'h0' }
  const after = {
    'MAP.md': 'h1',
    '.provenance/01JC0000000000000000000001.jsonl': 'hash-1',
    '.provenance/01JC0000000000000000000002.jsonl': 'hash-2',
    '01JC0000000000000000000003/node.md': 'hash-3',
  }
  const diff = attributeChanges(before, after, { links: [], foreignTouched: [], hashes: {}, sidecars: {} })
  assert.equal(diff.foreign.some((p) => p.startsWith('.provenance')), false, 'provenance lines are bookkeeping, never foreign evidence')
  assert.ok(diff.foreignNodes.includes('01JC0000000000000000000003'), 'a real foreign node write is still detected')
})

test('a failed batch with .provenance lines present rolls back without calling them foreign', async () => {
  const { job, graph } = setupJob(2)
  // A live provenance file BEFORE the scan, the way an earlier session wrote
  // it. Seeded before the scan so its node is in the gate-1 list.
  const seeded = nextId()
  writeNode(graph, seeded, 'seeded before the import')
  appendProvenance(graph, seeded, 'create')
  confirmAll(job)

  // The batch fails, and a live session appends to `.provenance` meanwhile —
  // the exact shape a real write during an import produces.
  const r = await job.runBatch(writer(graph, { fail: true, during: () => appendProvenance(graph, seeded, 'update') }))
  // The failure alone reruns the batch; what must NOT happen is a stop that
  // names our own bookkeeping as another session's write.
  if (r.stop) assert.notEqual(r.stop.reason, 'foreign_writes', `provenance must not read as foreign: ${r.stop.reason}`)
  const kept = fs.readFileSync(path.join(graph, '.provenance', `${seeded}.jsonl`), 'utf8')
  assert.match(kept, /"op":"create"/, 'the pre-import line is still there')
  assert.match(kept, /"op":"update"/, 'the line appended during the batch is still there')

  // A user rollback over the whole import: bookkeeping is kept live, not rewound.
  const rolled = await job.rollback({ to: 'before_import' })
  assert.equal(rolled.refused, undefined, 'the rollback is not blocked by its own bookkeeping')
  assert.equal(rolled.rolledBack, true, JSON.stringify(rolled.stop ?? rolled))
  assert.equal(fs.readFileSync(path.join(graph, '.provenance', `${seeded}.jsonl`), 'utf8'), kept, 'the live provenance log is kept, never rewound to the snapshot')
})

test('a foreign write beside .provenance still stops the rollback and is named for the user', async () => {
  const { job, graph } = setupJob(3)
  confirmAll(job)
  // One clean batch first (batchSize 2), so a batch snapshot exists to roll back to.
  assert.equal((await job.runBatch(writer(graph))).progress.done, 2)
  const foreignId = nextId()
  // The next batch fails, and ANOTHER session writes a node while it runs.
  const r = await job.runBatch(writer(graph, {
    fail: true,
    during: () => {
      writeNode(graph, foreignId, 'another session wrote this')
      appendProvenance(graph, foreignId, 'create')
    },
  }))
  assert.equal(r.stop?.reason, 'foreign_writes', 'a real foreign node beside .provenance is still detected')
  assert.ok(r.stop.foreign.some((f) => f.id === foreignId), 'the foreign node is named')
  assert.equal(r.stop.foreign.some((f) => f.id.startsWith('.')), false, 'provenance itself is never listed as foreign')

  const refused = await job.rollback({ confirmForeign: false })
  assert.equal(refused.refused, true, 'the foreign node blocks the user rollback too')

  // With the user's consent the rollback runs, and the log is still live.
  const done = await job.rollback({ confirmForeign: true })
  assert.equal(done.rolledBack, true, JSON.stringify(done.stop ?? done))
  assert.ok(fs.existsSync(path.join(graph, '.provenance')), '.provenance survives the swap')
  assert.ok(fs.existsSync(path.join(graph, '.provenance', `${foreignId}.jsonl`)), 'the foreign session’s own log is kept too')
})

test('the module documents the real copy-to-swap loss window and backup-only recovery', () => {
  // A comment is a contract here — the design's "Document the gap" point. Read
  // it from the source so a future edit that drops or overclaims it fails this
  // test. The old wording claimed the reverse loss "cannot happen"; it can, and
  // recovery is from the backup only.
  const source = fs.readFileSync(new URL('../src/job.js', import.meta.url), 'utf8')
  assert.match(source, /LOSS WINDOW \(documented, not closed\): `restore` copies the live `.provenance\/` into the staging tree/, 'the window is named')
  assert.match(source, /a line appended AFTER that copy and BEFORE the[\s\S]{0,200}final rename stays only in the replaced tree/, 'both ends of the window are stated')
  assert.match(source, /Recovery for such a line is from that backup alone; the rollback does not[\s\S]{0,80}replay it\./, 'and the recovery path is stated')
  assert.match(source, /Import backups and snapshots are full graph copies, so they CONTAIN session ids/, 'the retained session ids are stated')
  assert.doesNotMatch(source, /cannot happen/, 'the impossibility claim is gone')
  // `manifest` (the attribution input) still walks everything — the exclusion
  // lives in `attributeChanges`/`restore`, which is what the other tests check.
  const before = manifest(fs.mkdtempSync(path.join(os.tmpdir(), 'prov-empty-')))
  assert.deepEqual(before, {})
})
