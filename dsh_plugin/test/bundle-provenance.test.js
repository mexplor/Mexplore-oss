/**
 * Write provenance, DSH side (design 26111000). The bundle adapters only: the
 * root walk over session headers, the resolver the direct row hands the core,
 * the value a delegation stores on its record, and the exec a child's memory
 * tools actually receive. No engine files are involved, so these pass whether
 * or not the engine has learned to write `.provenance` yet.
 */

process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, test } from 'node:test'

import * as agent from '../lib/bundle/agent.js'
import * as agentTools from '../lib/bundle/agent-tools.js'
import * as direct from '../lib/bundle/direct.js'
import { IMPORT_PROVENANCE } from '../lib/bundle/history.js'
import { agentLookup, MAX_HOPS, rootOf } from '../lib/bundle/provenance.js'
import { SETTINGS_SERVICE, state } from '../lib/bundle/state.js'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `prov-${p}-`))

beforeEach(() => {
  state.directActive = 0
  state.delegations.clear()
})

// ---------------------------------------------------------------- fakes

/** A DSH-shaped agent: the session header is the only thing the walk reads. */
function fakeAgent(id, header = {}) {
  return { id, session: { id, header } }
}

const subagentHeader = (parentSession, depth = 1) => ({ origin: 'subagent', parentSession, delegationDepth: depth })

/** The `ctx.get('agents')` service: a live registry over the given agents. */
function registry(...agents) {
  const live = new Map(agents.map((a) => [a.id, a]))
  return { get: (id) => live.get(id), list: () => [...live.values()] }
}

const ctxWith = (services) => ({ get: (name) => services[name] })

/** A top-level chat root and a subagent child of it, both live. */
function chain(depth) {
  const agents = []
  const root = fakeAgent(`session-root-${depth}`)
  agents.push(root)
  let parent = root
  for (let i = 1; i <= depth; i++) {
    const child = fakeAgent(`session-child-${depth}-${i}`, subagentHeader(parent.id, i))
    agents.push(child)
    parent = child
  }
  return { root, leaf: parent, registry: registry(...agents) }
}

// ---------------------------------------------------------------- the walk

test('rootOf: a top-level agent is its own root, id stored verbatim', () => {
  const root = fakeAgent('session-abc')
  assert.deepEqual(rootOf(root, registry(root).get), { session: 'session-abc' })
})

test('rootOf: a depth-2 subagent chain records the root, not the parent', () => {
  const { root, leaf, registry: live } = chain(2)
  assert.notEqual(root.id, leaf.id)
  assert.deepEqual(rootOf(leaf, live.get), { session: root.id })
})

test('rootOf: a fork (parentSession, no subagent origin) counts as its own root', () => {
  const fork = fakeAgent('session-fork', { parentSession: 'session-original', isSeeded: true })
  // The original is not even live: the walk never looks, because a fork is a root.
  assert.deepEqual(rootOf(fork, registry(fork).get), { session: 'session-fork' })
})

test('rootOf: a missing header is root-unverified, never the agent id', () => {
  assert.deepEqual(rootOf({ id: 'session-bare' }, registry().get), { session: null, reason: 'root-unverified' })
  assert.deepEqual(rootOf({ id: 'session-null', session: null }, registry().get), { session: null, reason: 'root-unverified' })
  assert.deepEqual(rootOf(undefined, registry().get), { session: null, reason: 'root-unverified' })
})

test('rootOf: a subagent header without parentSession is root-unverified', () => {
  const orphan = fakeAgent('session-orphan', { origin: 'subagent', delegationDepth: 1 })
  assert.deepEqual(rootOf(orphan, registry(orphan).get), { session: null, reason: 'root-unverified' })
  // delegationDepth alone is a subagent signal too
  const depthOnly = fakeAgent('session-depth', { delegationDepth: 1 })
  assert.deepEqual(rootOf(depthOnly, registry(depthOnly).get), { session: null, reason: 'root-unverified' })
})

test('rootOf: a parent that is not live is walk-failed, never the child', () => {
  const child = fakeAgent('session-child', subagentHeader('session-gone'))
  assert.deepEqual(rootOf(child, registry().get), { session: null, reason: 'walk-failed' })
  // ... and it never falls back to the immediate agent it was given
  const mid = fakeAgent('session-mid', subagentHeader('session-gone'))
  assert.equal(rootOf(mid, registry().get).session, null)
})

test('rootOf: a cycle is walk-failed', () => {
  const a = fakeAgent('session-a', subagentHeader('session-b'))
  const b = fakeAgent('session-b', subagentHeader('session-a'))
  assert.deepEqual(rootOf(a, registry(a, b).get), { session: null, reason: 'walk-failed' })
  const self = fakeAgent('session-self', subagentHeader('session-self'))
  assert.deepEqual(rootOf(self, registry(self).get), { session: null, reason: 'walk-failed' })
})

test(`rootOf: ${MAX_HOPS} hops resolve, one more is walk-failed`, () => {
  const ok = chain(MAX_HOPS)
  assert.deepEqual(rootOf(ok.leaf, ok.registry.get), { session: ok.root.id })
  const tooDeep = chain(MAX_HOPS + 1)
  assert.deepEqual(rootOf(tooDeep.leaf, tooDeep.registry.get), { session: null, reason: 'walk-failed' })
})

test('rootOf: a throwing lookup or a throwing header read fails closed', () => {
  const child = fakeAgent('session-child', subagentHeader('session-parent'))
  assert.deepEqual(rootOf(child, () => { throw new Error('boom') }), { session: null, reason: 'walk-failed' })
  const hostile = { id: 'session-hostile', get session() { throw new Error('boom') } }
  assert.deepEqual(rootOf(hostile, registry().get), { session: null, reason: 'root-unverified' })
})

test('agentLookup: resolves through ctx.get("agents"), undefined without a registry or a bad id', () => {
  const root = fakeAgent('session-r')
  assert.equal(agentLookup(ctxWith({ agents: registry(root) }))('session-r'), root)
  assert.equal(agentLookup(ctxWith({}))('session-r'), undefined)
  assert.equal(agentLookup({})('session-r'), undefined)
  assert.equal(agentLookup({ get() { throw new Error('no service') } })('session-r'), undefined)
  assert.equal(agentLookup(ctxWith({ agents: registry(root) }))(null), undefined)
})

// ---------------------------------------------------------------- the direct row's resolver

test('direct row: the config carries a provenance resolver that resolves the caller root', () => {
  const root = fakeAgent('session-direct')
  const config = direct.directConfig(ctxWith({ agents: registry(root) }), { graphRoot: tmp('d') })
  assert.equal(typeof config.provenance, 'function')
  assert.deepEqual(config.provenance({ agent: root }), { actor: 'chat', host: 'dsh', session: 'session-direct' })
  const { root: chainRoot, leaf, registry: live } = chain(2)
  assert.deepEqual(direct.directConfig(ctxWith({ agents: live }), { graphRoot: tmp('d2') }).provenance({ agent: leaf }), {
    actor: 'chat',
    host: 'dsh',
    session: chainRoot.id,
  })
})

test('direct row: a deployment resolver wins over the derived one', () => {
  const mine = () => ({ actor: 'chat', host: 'dsh', session: 'session-mine' })
  const config = direct.directConfig(ctxWith({ agents: registry() }), { graphRoot: tmp('d3'), provenance: mine })
  assert.equal(config.provenance, mine)
})

// ---------------------------------------------------------------- a delegation

/**
 * A fake `subagents` service: on start it runs `work(exec, record)` with the
 * child's own exec, then reports a parsed reply. `records` holds the delegation
 * record each start was handed (via onRecord), keyed by childId.
 */
function fakeSubagents(work) {
  return {
    resolveMaxDepth: () => 1,
    starts: [],
    async startActivation(spec) {
      this.starts.push(spec)
      const exec = { agent: { id: spec.childId }, callId: `${spec.childId}:1` }
      const result = (async () => {
        await work?.(exec, spec)
        return { output: [{ type: 'text', text: JSON.stringify({ text: 'ok', unknown: false, citations: [] }) }], stopReason: 'completed' }
      })()
      return { childId: spec.childId, result, dispose: async () => {} }
    },
  }
}

/** Run delegate() against a fake subagents service and return the child records. */
async function runDelegate({ services = {}, args = { message: 'm', authority: 'manage', evidence: [] }, exec, options = {}, work }) {
  const subagents = fakeSubagents(work)
  const provided = agent.resolveAgentConfig({ graphRoot: tmp('g') })
  const records = new Map()
  const out = await agent.delegate(
    ctxWith({ subagents, ...services }),
    provided,
    args,
    exec,
    { withRecord: true, onRecord: (id, rec) => records.set(id, rec), ...options },
  )
  return { out, records, subagents }
}

test('delegate: a top-level caller records its own id on the delegation record', async () => {
  const root = fakeAgent('session-top')
  const { records } = await runDelegate({ services: { agents: registry(root) }, exec: { agent: root } })
  const [record] = [...records.values()]
  assert.deepEqual(record.provenance, { actor: 'chat', host: 'dsh', session: 'session-top' })
})

test('delegate: a depth-2 subagent caller records the root chat', async () => {
  const { root, leaf, registry: live } = chain(2)
  const { records } = await runDelegate({ services: { agents: live }, exec: { agent: leaf } })
  assert.deepEqual([...records.values()][0].provenance, { actor: 'chat', host: 'dsh', session: root.id })
})

test('delegate: no header / no live parent records null with the right reason', async () => {
  const bare = { id: 'session-bare' }
  const noHeader = await runDelegate({ services: { agents: registry() }, exec: { agent: bare } })
  assert.deepEqual([...noHeader.records.values()][0].provenance, { actor: 'chat', host: 'dsh', session: null, reason: 'root-unverified' })
  const deadParent = await runDelegate({
    services: { agents: registry() },
    exec: { agent: fakeAgent('session-orphan', subagentHeader('session-gone')) },
  })
  assert.deepEqual([...deadParent.records.values()][0].provenance, { actor: 'chat', host: 'dsh', session: null, reason: 'walk-failed' })
})

test('delegate: without an agents service the walk fails closed rather than guessing', async () => {
  const { records } = await runDelegate({ exec: { agent: fakeAgent('session-x', subagentHeader('session-p')) } })
  assert.deepEqual([...records.values()][0].provenance.session, null)
  assert.equal([...records.values()][0].provenance.reason, 'walk-failed')
})

test('delegate: options.provenance wins over the derived root (the import label)', async () => {
  const root = fakeAgent('session-chat')
  const { records } = await runDelegate({
    services: { agents: registry(root) },
    exec: { agent: root },
    options: { provenance: IMPORT_PROVENANCE },
  })
  assert.deepEqual([...records.values()][0].provenance, { actor: 'import', host: 'dsh', session: null, reason: 'import' })
  // The frozen constant is stored as is, never re-derived from the parent.
  assert.equal([...records.values()][0].provenance, IMPORT_PROVENANCE)
})

test('the import row labels its own delegations actor:import', () => {
  assert.deepEqual(IMPORT_PROVENANCE, { actor: 'import', host: 'dsh', session: null, reason: 'import' })
})

// ---------------------------------------------------------------- the exec a child tool receives

/** A definition that only observes; no graph, no schema trust. */
function spyDefinition(name, seen) {
  return {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    async execute(args, exec) {
      seen.push({ name, args, exec })
      return { id: 'x', description: 'x', body: 'x' }
    },
  }
}

const delegationRecord = (provenance) => ({ authority: 'manage', calls: [], fence: { latched: false }, provenance })

test('executeRecorded: stamps the record provenance on a copy, agent.id and the caller exec untouched', async () => {
  const seen = []
  const definition = spyDefinition('memory_write', seen)
  const provenance = { actor: 'chat', host: 'dsh', session: 'session-root' }
  const callerExec = { agent: { id: 'child-1' }, callId: 'c1', signal: new AbortController().signal }
  const exec = { ...callerExec }
  const record = delegationRecord(provenance)
  await agentTools.executeRecorded({ definition, args: {}, exec, toolName: 'memory_write', record, graphRoot: tmp('stamp') })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].exec.provenance, provenance)
  assert.equal(seen[0].exec.agent.id, 'child-1')
  assert.equal(seen[0].exec.callId, 'c1')
  assert.equal(seen[0].exec.signal, callerExec.signal)
  // the caller's own exec object was not mutated
  assert.equal(exec.provenance, undefined)
  assert.equal(callerExec.provenance, undefined)
  assert.equal(exec.agent.id, 'child-1')
})

test('executeRecorded: without a provenance on the record the exec passes through unchanged', async () => {
  const seen = []
  const definition = spyDefinition('memory_write', seen)
  const exec = { agent: { id: 'child-2' } }
  const record = { authority: 'read', calls: [], fence: { latched: false } }
  await agentTools.executeRecorded({ definition, args: {}, exec, toolName: 'memory_write', record, graphRoot: tmp('none') })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].exec, exec, 'the very same exec object is handed down')
  assert.equal(Object.hasOwn(exec, 'provenance'), false)
})

test('executeRecorded: a null/absent provenance value is not stamped', async () => {
  const seen = []
  const definition = spyDefinition('memory_write', seen)
  const exec = { agent: { id: 'child-3' } }
  await agentTools.executeRecorded({ definition, args: {}, exec, toolName: 'memory_write', record: delegationRecord(null), graphRoot: tmp('null') })
  assert.equal(seen[0].exec.provenance, undefined)
})

test('executeRecorded: one exec object keeps one identity after stamping (audited-refusal epochs)', async () => {
  const seen = []
  const definition = spyDefinition('memory_write', seen)
  const exec = { agent: { id: 'child-4' } }
  const record = delegationRecord({ actor: 'chat', host: 'dsh', session: 'session-s' })
  for (const n of [1, 2]) {
    await agentTools.executeRecorded({ definition, args: { n }, exec, toolName: 'memory_write', record, graphRoot: tmp('id') })
  }
  assert.equal(seen.length, 2)
  // Same caller exec -> the same stamped copy, so the registry's per-exec
  // serial-epoch bookkeeping still sees one object (an overlapping pair still
  // poisons its epoch instead of splitting into two clean ones).
  assert.equal(seen[0].exec, seen[1].exec)
  assert.notEqual(seen[0].exec, exec)
  // A different caller exec gets its own copy with the same provenance.
  const other = { agent: { id: 'child-5' } }
  await agentTools.executeRecorded({ definition, args: { n: 3 }, exec: other, toolName: 'memory_write', record, graphRoot: tmp('id') })
  assert.notEqual(seen[2].exec, seen[0].exec)
  assert.deepEqual(seen[2].exec.provenance, record.provenance)
  assert.equal(other.provenance, undefined)
})

test('two concurrent delegations from different roots stamp their own roots on the child exec', async () => {
  const rootA = fakeAgent('session-a')
  const rootB = fakeAgent('session-b')
  const midB = fakeAgent('session-b-mid', subagentHeader(rootB.id, 1))
  const live = registry(rootA, rootB, midB)
  const seen = []
  const definition = spyDefinition('memory_write', seen)

  // Both children are in flight at once; each stamps from its OWN record.
  const barrier = () => new Promise((resolve) => setImmediate(resolve))
  const work = async (exec, spec) => {
    const record = records.get(spec.childId)
    assert.ok(record, 'the record is on the delegation before the child runs')
    await barrier()
    await agentTools.executeRecorded({ definition, args: { n: spec.childId }, exec, toolName: 'memory_write', record, graphRoot: tmp('conc') })
  }
  const records = new Map()
  const settings = agent.resolveAgentConfig({ graphRoot: tmp('cg') })
  const subagents = fakeSubagents(work)
  const ctx = ctxWith({ subagents, agents: live })
  const onRecord = (id, rec) => records.set(id, rec)
  await Promise.all([
    agent.delegate(ctx, settings, { message: 'a', authority: 'manage', evidence: [] }, { agent: rootA }, { onRecord }),
    agent.delegate(ctx, settings, { message: 'b', authority: 'manage', evidence: [] }, { agent: midB }, { onRecord }),
  ])
  const bySession = seen.map((s) => s.exec.provenance.session).sort()
  assert.deepEqual(bySession, ['session-a', 'session-b'])
  assert.deepEqual(seen.map((s) => s.exec.provenance.actor), ['chat', 'chat'])
  assert.ok(seen.every((s) => s.exec.provenance.host === 'dsh'))
  // and the authorization key is still each delegation's own child
  assert.notEqual(seen[0].exec.agent.id, seen[1].exec.agent.id)
  assert.ok(seen.every((s) => !s.exec.agent.id.startsWith('session-')))
})

test('the real memory_agent row resolves one root per delegation and clears its record', async () => {
  // The real rows over a fake `subagents` service: `memory_agent` on top,
  // agent-tools registering the manage tools for the child — the exact adapter
  // chain a live memory agent runs. The stamp itself is exercised above through
  // executeRecorded, the one production path that hands a child's exec down.
  const graphRoot = tmp('realgraph')
  fs.mkdirSync(graphRoot, { recursive: true })
  const childTools = new Map()
  const childCtx = {
    tools: {
      register: (d) => (childTools.set(d.name, d), () => childTools.delete(d.name)),
      definitions: () => [...childTools.keys()].map((name) => ({ name })),
      restrict: () => () => {},
    },
    inject: () => () => {},
    effect: (fn) => fn(),
    on: () => () => {},
    get: () => undefined,
  }

  const root = fakeAgent('session-live-root')
  const mid = fakeAgent('session-live-mid', subagentHeader(root.id, 1))
  let liveRecord
  let childExec
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      childExec = { agent: { id: spec.childId }, callId: `${spec.childId}:1` }
      liveRecord = state.delegations.get(spec.childId)
      const result = (async () => {
        await childTools.get('memory_write').execute({ description: 'provenance test node', body: 'x' }, childExec)
        return { output: [{ type: 'text', text: JSON.stringify({ text: 'ok', unknown: false, citations: [] }) }], stopReason: 'completed' }
      })()
      return { childId: spec.childId, result, dispose: async () => {} }
    },
  }

  const hostTools = new Map()
  const provided = new Map()
  const host = {
    tools: { register: (d) => (hostTools.set(d.name, d), () => hostTools.delete(d.name)) },
    provide: (n, v) => provided.set(n, v),
    on: () => () => {},
    effect: (fn) => fn(),
    inject: () => () => {},
    get: (n) => ({ subagents, agents: registry(root, mid) })[n],
  }
  agent.apply(host, { graphRoot })
  childCtx[SETTINGS_SERVICE] = provided.get(SETTINGS_SERVICE)
  agentTools.apply(childCtx, { authority: 'manage' })

  const out = await hostTools.get('memory_agent').execute(
    { message: 'remember provenance', authority: 'manage', evidence: [] },
    { agent: mid, signal: new AbortController().signal },
  )

  // The live record carried the ROOT chat, resolved once from the caller — and
  // the child still authorized as itself.
  assert.deepEqual(liveRecord.provenance, { actor: 'chat', host: 'dsh', session: root.id })
  assert.notEqual(childExec.agent.id, mid.id)
  // The write landed, and the record is gone once the delegation finished.
  assert.match(out.text, /created node/)
  assert.equal(state.delegations.size, 0)
  // Provenance is never model-visible.
  assert.equal(out.text.includes(root.id), false)
})
