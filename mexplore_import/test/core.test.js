/**
 * The import core through a fake host: tools and prompt as data, cards on hosts that can and cannot
 * show them, the two chat-only confirmations of a card-less host (approve all writes; discard exactly
 * the foreign nodes the user saw), the writer contract (observe hooks, outcomes, throws), host
 * secrets, a custom HistorySource, and the sync script's import rule. No model, no network. The DSH
 * row's own tests (gates, batches, rollback, parity goldens) are in dsh_plugin/test/history.test.js.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { cardFor, createImportCore, foreignDigest, MODE_NAMES, PARAMETERS, sectionText, TEXTS, TOOLS } from '../src/index.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `core-${p}-`))
let idSeq = 0
const nextId = () => `01JB${String(++idSeq).padStart(22, '0')}`

function writeNode(graph, id, text) {
  fs.mkdirSync(path.join(graph, id), { recursive: true })
  fs.writeFileSync(path.join(graph, id, 'node.md'), `---\ndescription: ${text}\ncreated: 2026-11-09\n---\n${text}\n`)
}

/** Claude Code history with one session per day; `extra` is appended to every user message. */
function projects(nUnits, extra = '') {
  const dir = path.join(tmp('proj'), '-Users-x-Code-repo')
  fs.mkdirSync(dir, { recursive: true })
  const lines = []
  for (let i = 0; i < nUnits; i++) {
    const day = `2026-06-${String(1 + i).padStart(2, '0')}`
    const ts = (h, m) => new Date(Date.parse(`${day}T${h}:${m}:00+08:00`)).toISOString()
    lines.push({ type: 'user', uuid: `u${i}`, timestamp: ts('09', '00'), sessionId: `s${i}`, cwd: '/Users/x/Code/repo', message: { role: 'user', content: `question ${i} ${'w '.repeat(200)}${extra}` } })
    lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: ts('09', '05'), sessionId: `s${i}`, cwd: '/Users/x/Code/repo', message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } })
  }
  fs.writeFileSync(path.join(dir, 'all.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path.dirname(dir)
}

/** A writer that creates one node per delegation through the observe hooks, like a real host. */
function fakeWriter(graphRoot, script = {}) {
  const calls = []
  return {
    calls,
    async delegate(req, { contextDate, index, observe, call }) {
      calls.push({ index, contextDate, call, evidence: req.evidence.length })
      const b = script[index]?.shift?.() ?? 'ok'
      if (b === 'throw-outcome') {
        const e = new Error('memory agent did not finish within 1000 ms and was stopped')
        e.outcome = { childId: 'c', writes: [], fenceLatched: false, stopReason: 'timeout' }
        throw e
      }
      const id = nextId()
      observe.beforeWrite({ tool: 'memory_write', args: {} })
      writeNode(graphRoot, id, `imported ${contextDate}`)
      observe.afterWrite({ tool: 'memory_write', args: {}, result: { id, created: true, links: [] } })
      return { childId: `c${index}`, stopReason: 'completed', fenceLatched: false, structured: true, writes: [{ tool: 'memory_write', id, landed: true }], maintenanceDue: null }
    },
  }
}

function setup({ cards = 'unsupported', approveWrites = false, units = 3, config = {}, host = {}, script = {} } = {}) {
  const graphRoot = path.join(tmp('graph'), 'g')
  fs.mkdirSync(graphRoot)
  const writer = fakeWriter(graphRoot, script)
  const core = createImportCore(
    { graphRoot: () => graphRoot, approveWrites: () => approveWrites, cards, writer, ...host },
    { projectsDir: projects(units), now: '2026-07-01T00:00:00+08:00', batchSize: 2, ...config },
  )
  const t = Object.fromEntries(core.tools.map((x) => [x.name, (args = {}, call = {}) => x.execute(args, call)]))
  return { core, t, graphRoot, writer }
}

async function confirmAll(t, startChoice) {
  const s = await t.history_scan()
  await t.history_confirm({ gate: 'scope', digest: s.digest, userSaid: 'all' })
  await t.history_confirm({ gate: 'privacy', digest: s.digest, userSaid: 'ok' })
  const e = await t.history_estimate()
  if (e.modePrompt.ask) await t.history_confirm({ gate: 'mode', digest: e.digest, choice: 'full_replay', userSaid: 'one by one' })
  const plan = await t.history_plan()
  const r = await t.history_confirm({ gate: 'start', digest: plan.digest, userSaid: 'go', ...(startChoice ? { choice: startChoice } : {}) })
  return { s, plan, r }
}

const userFacing = (o) => (typeof o === 'string' ? [o] : Object.values(o).flatMap(userFacing))

// ---------------------------------------------------------------- data

test('tools and prompt are data: eight history_* tools, the DSH section, a card-less variant', () => {
  const { core } = setup({ cards: 'supported' })
  assert.deepEqual(core.tools.map((x) => x.name), [...TOOLS])
  assert.equal(TOOLS.length, 8)
  for (const x of core.tools) assert.deepEqual(x.parameters, PARAMETERS[x.name], x.name)
  assert.deepEqual(core.section, { name: 'memory:history-import', order: 160, text: sectionText() })
  assert.match(core.section.text, /DSH will show one approval card/)
  const { core: none } = setup({ cards: 'unsupported', host: { prompt: { host: 'OpenCode', recommend: 'recommend nothing' } } })
  const rollback = none.tools.find((x) => x.name === 'history_rollback')
  assert.ok(rollback.parameters.properties.foreignDigest, 'a card-less host names the foreign nodes the user agreed to lose')
  assert.doesNotMatch(none.section.text, /will show one approval card|also shows a .* approval card/)
  assert.match(none.section.text, /foreignDigest/)
  assert.match(none.section.text, /there is no approval card, so ask exactly that in the chat/)
  assert.match(none.section.text, /after OpenCode restarted/)
  assert.match(none.section.text, /recommend nothing\./)
  assert.doesNotMatch(none.section.text, /DSH/)
})

test('user-facing texts name the modes 「逐段导入」 / 「按天合并导入」 and never M1 or full replay', () => {
  assert.equal(TEXTS.zh.modeFullReplay, '逐段导入')
  assert.equal(TEXTS.zh.modeByDay, '按天合并导入')
  assert.equal(TEXTS.en.modeByDay, MODE_NAMES.m1.en)
  const all = [...userFacing(TEXTS), ...userFacing(MODE_NAMES)]
  for (const s of all) {
    assert.doesNotMatch(s, /\bM1\b/i)
    assert.doesNotMatch(s, /full[ _]replay/i)
  }
  assert.ok(!/[一-鿿]/.test(TEXTS.en.notice) && /[一-鿿]/.test(TEXTS.zh.notice))
})

// ---------------------------------------------------------------- cards

test('cards: a card-less host gets none; a host with cards gets the two (foreign rollback, approve all writes) and askOnConfirm adds the rest', () => {
  const plan = () => ({ approveWrites: true, delegations: 7, graphRoot: '/g' })
  const none = { cards: 'unsupported', askOnConfirm: true, plan, approveWrites: true, graphRoot: '/g' }
  for (const [tool, args] of [['history_confirm', { gate: 'start' }], ['history_rollback', { confirmForeign: true }], ['history_confirm', { gate: 'scope' }], ['history_rollback', {}]]) assert.equal(cardFor(tool, args, none), null)
  const some = { cards: 'supported', askOnConfirm: false, plan: () => ({ approveWrites: false, delegations: 3, graphRoot: '/g' }), approveWrites: false, graphRoot: '/g' }
  assert.equal(cardFor('history_confirm', { gate: 'start' }, some), null)
  assert.equal(cardFor('history_confirm', { gate: 'scope' }, some), null)
  assert.equal(cardFor('history_rollback', {}, some), null)
  assert.equal(cardFor('history_rollback', { confirmForeign: true }, some).kind, 'foreign_rollback')
  const all = cardFor('history_confirm', { gate: 'start' }, { ...some, plan })
  assert.equal(all.kind, 'approve_all_writes')
  assert.match(all.en, /ALL writes of its 7 memory-agent delegations into \/g/)
  const noPlan = cardFor('history_confirm', { gate: 'start' }, { ...some, plan: () => { throw new Error('no plan') }, approveWrites: true })
  assert.equal(noPlan.kind, 'approve_all_writes', 'without a plan the host setting decides')
  const ask = { ...some, askOnConfirm: true }
  assert.equal(cardFor('history_confirm', { gate: 'scope', userSaid: 'yes' }, ask).kind, 'gate')
  assert.equal(cardFor('history_confirm', { gate: 'start' }, ask).kind, 'gate')
  assert.equal(cardFor('history_rollback', { to: 'before_import' }, ask).zh, '把整张记忆图回滚（到导入之前）吗？当前状态会另存备份。')
  assert.equal(cardFor('history_scan', {}, ask), null)
})

// ---------------------------------------------------------------- the two chat-only confirmations

test('card-less host, approveWrites on: the start gate needs choice approve_all_writes, recorded from the chat', async () => {
  const { t, writer } = setup({ approveWrites: true })
  const s = await t.history_scan()
  await t.history_confirm({ gate: 'scope', digest: s.digest, userSaid: 'y' })
  await t.history_confirm({ gate: 'privacy', digest: s.digest, userSaid: 'y' })
  const plan = await t.history_plan()
  assert.ok(plan.writeApproval)
  const refused = await t.history_confirm({ gate: 'start', digest: plan.digest, userSaid: 'go' })
  assert.equal(refused.error, 'needs_write_approval')
  const ok = await t.history_confirm({ gate: 'start', digest: plan.digest, userSaid: 'yes, approve all writes', choice: 'approve_all_writes' })
  assert.equal(ok.recorded.choice, 'approve_all_writes')
  const r = await t.history_import_batch({}, { signal: new AbortController().signal, host: 'call-context' })
  assert.equal(r.progress.done, 2)
  assert.equal(writer.calls[0].call.host, 'call-context', 'the host’s call context reaches its writer untouched')
})

test('card-less host: discarding foreign writes needs the foreignDigest of exactly the nodes the user saw', async () => {
  const { t, graphRoot } = setup()
  await confirmAll(t)
  const b1 = await t.history_import_batch()
  assert.equal(b1.progress.done, 2)
  const F = nextId()
  writeNode(graphRoot, F, 'written by another session')
  const listed = await t.history_rollback({})
  assert.equal(listed.refused, true)
  assert.deepEqual(listed.foreign.map((f) => f.id), [F])
  assert.equal(listed.foreignDigest, foreignDigest([{ id: F }]))
  const noDigest = await t.history_rollback({ confirmForeign: true })
  assert.equal(noDigest.refused, true, 'confirmForeign alone is not enough without a card')
  const G = nextId()
  writeNode(graphRoot, G, 'a second foreign node, written after the user saw the list')
  const stale = await t.history_rollback({ confirmForeign: true, foreignDigest: listed.foreignDigest })
  assert.equal(stale.refused, true)
  assert.deepEqual(stale.foreign.map((f) => f.id).sort(), [F, G].sort())
  const done = await t.history_rollback({ confirmForeign: true, foreignDigest: stale.foreignDigest })
  assert.equal(done.rolledBack, true)
  assert.deepEqual(done.discardedForeign.map((f) => f.id).sort(), [F, G].sort())
  assert.ok(!fs.existsSync(path.join(graphRoot, F)))
  assert.ok(fs.existsSync(path.join(done.backup, F)), 'the replaced tree, with the foreign node, is kept as a backup')
})

test('host with cards: confirmForeign alone discards (the card is the confirmation), as in DSH', async () => {
  const { t, graphRoot } = setup({ cards: 'supported' })
  await confirmAll(t)
  await t.history_import_batch()
  writeNode(graphRoot, nextId(), 'foreign')
  const listed = await t.history_rollback({})
  assert.equal(listed.refused, true)
  assert.equal(listed.foreignDigest, undefined)
  assert.equal((await t.history_rollback({ confirmForeign: true })).rolledBack, true)
})

// ---------------------------------------------------------------- writer contract, secrets, source

test('writer: observe hooks attribute the writes; a throw carrying its outcome is classified from its message, rolled back and rerun', async () => {
  const { t, graphRoot, writer } = setup({ units: 2, script: { 1: ['throw-outcome'] } })
  await confirmAll(t)
  const r = await t.history_import_batch()
  assert.equal(r.done, true)
  const cur = JSON.parse(fs.readFileSync(`${graphRoot}.history-import/cursor.json`, 'utf8'))
  assert.equal(cur.rollbacks.length, 1)
  assert.match(cur.rollbacks[0].why, /delegation 2 timed out/)
  assert.deepEqual(writer.calls.map((c) => c.contextDate), ['2026-06-01', '2026-06-02', '2026-06-01', '2026-06-02'])
  const report = await t.history_report()
  assert.equal(report.modeName.zh, '逐段导入')
  assert.equal(report.nodesInGraph, 2)
})

test('secrets: values the host holds are redacted from the units and never written', async () => {
  const secret = 'hostheld-Secret-9f8e7d6c5b'
  const graphRoot = path.join(tmp('sec'), 'g')
  fs.mkdirSync(graphRoot)
  const core = createImportCore(
    { graphRoot: () => graphRoot, approveWrites: () => false, cards: 'unsupported', writer: fakeWriter(graphRoot), secrets: () => ({ envFiles: [], values: [secret] }) },
    { projectsDir: projects(1, ` my key is ${secret} ok`), now: '2026-07-01T00:00:00+08:00' },
  )
  const scan = await core.tools.find((x) => x.name === 'history_scan').execute({}, {})
  assert.equal(scan.units, 1)
  const stateDir = `${graphRoot}.history-import`
  const unitsDir = path.join(stateDir, 'units')
  const text = fs.readFileSync(path.join(unitsDir, fs.readdirSync(unitsDir)[0]), 'utf8')
  assert.ok(!text.includes(secret))
  assert.match(text, /\[REDACTED:env_exact:HOST_SECRET\]/)
  const everything = fs.readdirSync(stateDir, { recursive: true }).filter((f) => fs.statSync(path.join(stateDir, f)).isFile()).map((f) => fs.readFileSync(path.join(stateDir, f), 'utf8')).join('\n')
  assert.ok(!everything.includes(secret))
})

test('HistorySource: a host can import from another source; the job reads units through it', async () => {
  const unit = { schema: 'mexplor-unit-v1', unit_id: 'u-src-1', session_id: 's-src', day: '2026-05-04', started_at: '2026-05-04T10:00:00+08:00', ended_at: '2026-05-04T10:30:00+08:00', turn_ids: ['t0'], text: 'Conversation dated 2026-05-04 (Claude Code session s-src in /x/repo, part 1 of that session)\nUSER: hello\nASSISTANT: hi' }
  const source = { id: 'test', label: 'Test', scan: () => ({ units: [unit], listing: [{ project: 'repo', flags: [], sessions: 1, units: 1, kb: 0.1, firstDay: '2026-05-04', lastDay: '2026-05-04', keywordSessions: 0, sessionFiles: 1 }], selectedDirs: ['repo'], months: [], autoExcluded: {}, redactionPreview: [], keywordFlaggedSessions: 0 }) }
  const { t, writer } = setup({ host: { source } })
  await confirmAll(t)
  const r = await t.history_import_batch()
  assert.equal(r.done, true)
  assert.deepEqual(writer.calls.map((c) => c.contextDate), ['2026-05-04'])
})

test('stateDir: the host decides where the import keeps its state', async () => {
  const state = path.join(tmp('state'), 'here')
  const { t } = setup({ host: { stateDir: (g) => { assert.ok(g.endsWith('/g')); return state } } })
  await t.history_scan()
  assert.ok(fs.existsSync(path.join(state, 'scan.json')))
})

// ---------------------------------------------------------------- the sync script's import rule

test('sync-vendored: sources may import only node: modules and files of their own tree', async () => {
  const { importProblems, check } = await import(path.join(repo, 'scripts', 'sync-vendored.mjs'))
  assert.deepEqual(importProblems("import fs from 'node:fs'\nimport { a } from './a.js'\nexport * from './sub/b.js'\n", 'x.js'), [])
  assert.deepEqual(importProblems("import { b } from '../b.js'\n", 'sub/x.js'), [], 'up within the tree is fine')
  assert.equal(importProblems("import { b } from '../b.js'\n", 'x.js').length, 1, 'out of the tree is not')
  assert.deepEqual(importProblems("import {\n  a,\n  b as c,\n} from './a.js'\n", 'x.js'), [])
  assert.equal(importProblems("import x from 'lodash'\n", 'x.js').length, 1)
  assert.equal(importProblems("import x from '../../dsh_plugin/lib/tool.js'\n", 'x.js').length, 1)
  assert.equal(importProblems("export { y } from 'dsh-mexplore/tool'\n", 'x.js').length, 1)
  assert.equal(importProblems("const m = await import('zod')\n", 'x.js').length, 1)
  assert.equal(importProblems("const m = require('fs')\n", 'x.js').length, 1)
  assert.deepEqual(importProblems("this.require('scope', d)\nconst s = 'see the import from \"x\" docs'\n", 'x.js'), [])
  assert.deepEqual(check(repo), [], 'the committed copies match the sources')
})
