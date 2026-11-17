/**
 * The DSH row on the shared import core (lib/import, generated from mexplore_import/src): the plan
 * names its mode for the user (modeName), refusals keep their compact JSON, and a whole batch runs
 * through the row's own writer — the in-process memory agent, with a real memory_write from
 * agent-tools, observed by the core's write hooks. Also: the generated copies match their sources.
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
import * as core from '../lib/import/index.js'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.dirname(pkgDir)
const fixtures = path.join(pkgDir, 'test', 'fixtures', 'history')
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `imp-${p}-`))

function rowCtx(settings, subagents) {
  const tools = new Map()
  const listeners = new Map()
  const sections = []
  const ctx = {
    [SETTINGS_SERVICE]: settings,
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    effect: (fn) => fn(),
    on: (n, fn) => listeners.set(n, fn),
    inject: (_names, cb) => cb({ systemPrompt: { section: (s) => sections.push(s) } }),
    get: (n) => (n === 'subagents' ? subagents : undefined),
  }
  return { ctx, tools, listeners, sections }
}

const call = async (tools, name, args = {}, exec = {}) => {
  const out = await tools.get(name).execute(args, exec)
  return { text: out.text, json: JSON.parse(out.text) }
}

test('vendored: the generated copies in dsh_plugin match mexplore_graph/src and mexplore_import/src', async (t) => {
  const script = path.join(repo, 'scripts', 'sync-vendored.mjs')
  if (!fs.existsSync(script) || !fs.existsSync(path.join(repo, 'mexplore_import'))) {
    t.skip('not in the repository checkout (installed package)')
    return
  }
  const { check } = await import(script)
  assert.deepEqual(check(repo), [])
  for (const f of ['graph.js', 'index.js', 'tool.js']) assert.match(fs.readFileSync(path.join(pkgDir, 'lib', f), 'utf8').split('\n')[0], /^\/\/ GENERATED from mexplore_graph\/src\//)
  for (const f of fs.readdirSync(path.join(pkgDir, 'lib', 'import')).filter((n) => n.endsWith('.js'))) {
    assert.match(fs.readFileSync(path.join(pkgDir, 'lib', 'import', f), 'utf8').split('\n')[0], /^\/\/ GENERATED from mexplore_import\/src\//, f)
  }
})

test('history_plan shows the mode by its user-facing name (modeName), and refusals stay compact JSON', async () => {
  const graph = path.join(tmp('plan'), 'g')
  const { ctx, tools } = rowCtx(agent.resolveAgentConfig({ graphRoot: graph }))
  history.apply(ctx, { projectsDir: path.join(fixtures, 'projects'), now: '2026-06-09T00:10:00+08:00' })
  const refused = await call(tools, 'history_plan')
  assert.equal(refused.text, JSON.stringify({ error: 'no_scan', message: 'run history_scan first' }))
  const scan = (await call(tools, 'history_scan')).json
  await call(tools, 'history_confirm', { gate: 'scope', digest: scan.digest, userSaid: 'y' })
  await call(tools, 'history_confirm', { gate: 'privacy', digest: scan.digest, userSaid: 'y' })
  const plan = await call(tools, 'history_plan')
  assert.equal(plan.text, JSON.stringify(plan.json, null, 1))
  assert.equal(plan.json.mode, 'full_replay')
  assert.equal(plan.json.modeName.zh, '逐段导入')
  assert.equal(plan.json.modeName.en, 'one conversation segment at a time')
  assert.doesNotMatch(JSON.stringify(plan.json.modeName), /\bM1\b|full[ _]replay/i)
})

test('the row exports the core’s tools and prompt unchanged: same names, DSH section with its two cards', () => {
  assert.deepEqual([...history.TOOLS], [...core.TOOLS])
  assert.equal(history.SECTION_TEXT, core.sectionText({ cards: 'supported' }))
  assert.match(history.SECTION_TEXT, /DSH will show one approval card/)
  assert.equal(history.name, 'memory-graph-history')
})

test('a batch runs through the row’s writer: the in-process memory agent writes with agent-tools, the core observes each write', async () => {
  const agentTools = await import('../lib/bundle/agent-tools.js')
  const graphRoot = path.join(tmp('rowbatch'), 'g')
  fs.mkdirSync(graphRoot)
  // The memory agent row provides its settings; the child gets the manage tools of agent-tools.
  const host = rowCtx(undefined)
  const provided = new Map()
  agent.apply({ ...host.ctx, provide: (n, v) => provided.set(n, v), on: () => {}, tools: { register: () => () => {} } }, { graphRoot })
  const settings = provided.get(SETTINGS_SERVICE)
  const childTools = new Map()
  const childCtx = {
    [SETTINGS_SERVICE]: settings,
    tools: { register: (d) => (childTools.set(d.name, d), () => childTools.delete(d.name)), definitions: () => [...childTools.keys()].map((name) => ({ name })), restrict: () => () => {} },
    inject: () => () => {},
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }
  agentTools.apply(childCtx, { authority: 'manage' })
  const prompts = []
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      prompts.push(spec.prompt[0].text)
      const exec = { agent: { id: spec.childId } }
      const result = (async () => {
        await childTools.get('memory_write').execute({ description: `imported ${prompts.length}`, body: 'x' }, exec)
        return { output: [{ type: 'text', text: JSON.stringify({ text: 'ok', unknown: false, citations: [] }) }], stopReason: 'completed' }
      })()
      return { childId: spec.childId, result, dispose: async () => {} }
    },
  }
  const { ctx, tools } = rowCtx(settings, subagents)
  history.apply(ctx, { projectsDir: path.join(fixtures, 'projects'), now: '2026-06-09T00:10:00+08:00', batchSize: 2 })
  const scan = (await call(tools, 'history_scan', { fromDay: '2026-06-01' })).json
  assert.ok(scan.units >= 3, `fixture units: ${scan.units}`)
  await call(tools, 'history_confirm', { gate: 'scope', digest: scan.digest, userSaid: 'y' })
  await call(tools, 'history_confirm', { gate: 'privacy', digest: scan.digest, userSaid: 'y' })
  const est = (await call(tools, 'history_estimate')).json
  if (est.modePrompt.ask) await call(tools, 'history_confirm', { gate: 'mode', digest: est.digest, choice: 'full_replay', userSaid: 'one by one' })
  const plan = (await call(tools, 'history_plan')).json
  await call(tools, 'history_confirm', { gate: 'start', digest: plan.digest, userSaid: 'go' })
  const exec = { agent: { id: 'main' }, callId: 'c1' }
  const b1 = (await call(tools, 'history_import_batch', {}, exec)).json
  assert.equal(b1.progress.done, 2)
  assert.equal(b1.batch.length, 2)
  assert.ok(b1.batch.every((l) => l.verdict === 'ok' && l.nodesWritten.length === 1))
  // the core's hooks recorded each write as the import's own, with its hash
  const cursor = JSON.parse(fs.readFileSync(`${graphRoot}.history-import/cursor.json`, 'utf8'))
  const written = b1.batch.flatMap((l) => l.nodesWritten)
  assert.deepEqual([...cursor.batches[0].touch.created].sort(), [...written].sort())
  for (const id of written) assert.match(cursor.batches[0].touch.hashes[id], /^[0-9a-f]{64}$/)
  // each delegation carries the conversation's own date, not today's
  const days = plan.delegations && JSON.parse(fs.readFileSync(`${graphRoot}.history-import/plan.json`, 'utf8')).itemDays
  for (const [i, p] of prompts.entries()) assert.ok(p.includes(days[i]), `delegation ${i + 1} is dated ${days[i]}`)
  const st = (await call(tools, 'history_status')).json
  assert.equal(st.plan.modeName.zh, '逐段导入')
})

test('a delegation that throws keeps its message and record: a timeout is classified as timed out, rolled back and rerun', async () => {
  const graphRoot = path.join(tmp('rowthrow'), 'g')
  fs.mkdirSync(graphRoot)
  let n = 0
  const c = core.createImportCore({
    graphRoot: () => graphRoot,
    approveWrites: () => false,
    cards: 'supported',
    writer: {
      async delegate(_req, { observe }) {
        n += 1
        assert.equal(typeof observe.beforeWrite, 'function')
        if (n === 1) {
          const e = new Error('memory agent did not finish within 300000 ms and was stopped')
          e.record = { childId: 'x', writes: [], fenceLatched: false, stopReason: 'timeout' }
          throw e
        }
        return { childId: 'y', writes: [], fenceLatched: false, stopReason: 'completed', structured: true }
      },
    },
  }, { projectsDir: path.join(fixtures, 'projects'), now: '2026-06-09T00:10:00+08:00', batchSize: 1 })
  const t = Object.fromEntries(c.tools.map((x) => [x.name, x]))
  const scan = await t.history_scan.execute({}, {})
  await t.history_confirm.execute({ gate: 'scope', digest: scan.digest, userSaid: 'y' }, {})
  await t.history_confirm.execute({ gate: 'privacy', digest: scan.digest, userSaid: 'y' }, {})
  const est = await t.history_estimate.execute({}, {})
  if (est.modePrompt.ask) await t.history_confirm.execute({ gate: 'mode', digest: est.digest, choice: 'full_replay', userSaid: 'y' }, {})
  const plan = await t.history_plan.execute({}, {})
  await t.history_confirm.execute({ gate: 'start', digest: plan.digest, userSaid: 'go' }, {})
  const r = await t.history_import_batch.execute({}, {})
  assert.equal(r.progress.done, 1)
  const cur = JSON.parse(fs.readFileSync(`${graphRoot}.history-import/cursor.json`, 'utf8'))
  assert.equal(cur.rollbacks.length, 1)
  assert.match(cur.rollbacks[0].why, /delegation 1 timed out/)
})
