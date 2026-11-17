/**
 * The DSH bundle layer: the bundle manifest and patch, the direct-tools row,
 * the memory preset's guarded tools, the reply checks, and one memory_agent
 * delegation driven by a fake `subagents` service.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { attach, createNode } from '../lib/graph.js'
import * as direct from '../lib/bundle/direct.js'
import * as agent from '../lib/bundle/agent.js'
import * as agentTools from '../lib/bundle/agent-tools.js'
import * as historyRow from '../lib/bundle/history.js'
import { HELP_TOOL_NAME, SWITCHES, helpText } from '../lib/bundle/history-help.js'
import { buildArtifacts, fallbackCitations, groundCitations, parseAgentReply } from '../lib/bundle/reply.js'
import { buildPrompt } from '../lib/bundle/prompt.js'
import { DEFAULT_GRAPH_ROOT, MANAGE_PRESET, READ_PRESET, SETTINGS_SERVICE, state, withDefaults } from '../lib/bundle/state.js'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let root
before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-bundle-'))
})
after(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})
beforeEach(() => {
  state.directActive = 0
  state.delegations.clear()
})

/** A Cordis stand-in that records registrations, restrictions, listeners and effects. */
function fakeCtx(services = {}, globals = []) {
  const tools = new Map()
  const restrictions = []
  const listeners = new Map()
  const provided = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      // The row's own view after restrictions: inherited names minus the
      // denied ones, plus its own registrations (never restricted).
      definitions() {
        const denied = new Set(restrictions.flatMap((r) => r.deny ?? []))
        return [...globals.filter((name) => !denied.has(name)).map((name) => ({ name })), ...[...tools.keys()].map((name) => ({ name }))]
      },
      restrict(filter) {
        restrictions.push(filter)
        return () => restrictions.splice(restrictions.indexOf(filter), 1)
      },
    },
    inject() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name) {
      return services[name]
    },
  }
  const disposeAll = () => {
    while (disposers.length > 0) disposers.pop()()
  }
  return { ctx, tools, restrictions, listeners, provided, disposeAll }
}

const freshRoot = () => fs.mkdtempSync(path.join(root, 'g-'))

// ---------------------------------------------------------------- manifest

test('package.json declares the bundle patch and exports every row and display resource', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  for (const sub of ['direct', 'agent', 'agent-tools']) {
    const target = pkg.exports[`./${sub}`]
    assert.ok(fs.existsSync(path.join(pkgDir, target)), `export ./${sub} -> ${target}`)
    for (const lang of ['en', 'zh']) {
      const file = pkg.exports[`./${sub}/locale/*.json`].replace('*', lang)
      const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, file), 'utf8')).meta
      assert.ok(meta.title && meta.description, `${sub} ${lang} metadata`)
    }
    assert.equal(pkg.exports[`./${sub}/icon`], './icon.svg')
  }
  assert.ok(fs.statSync(path.join(pkgDir, 'icon.svg')).size < 256 * 1024)
  // The original entry points stay exported for memory_service's wrapper.
  for (const key of ['.', './graph', './tool', './package.json']) assert.ok(pkg.exports[key], key)
})

test('the bundle patch inserts the two rows (agent off) and two presets that use agent-tools', () => {
  const text = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- id: memory-graph-direct\n\s+name: dsh-mexplore\/direct\n/)
  assert.match(text, /- id: memory-graph-agent\n\s+name: dsh-mexplore\/agent\n\s+disabled: true\n/)
  assert.match(text, new RegExp(`id: ${READ_PRESET}\\n`))
  assert.match(text, new RegExp(`id: ${MANAGE_PRESET}\\n`))
  assert.equal(text.match(/name: dsh-mexplore\/agent-tools/g).length, 2)
  assert.match(text, /authority: read\n/)
  assert.match(text, /authority: manage\n/)
})

// ---------------------------------------------------------------- direct row

test('withDefaults fills graph root and the 30-line index, and the deployment wins', () => {
  assert.deepEqual(withDefaults({}), { graphRoot: DEFAULT_GRAPH_ROOT, maxIndexEntries: 30 })
  assert.deepEqual(withDefaults({ maxIndexEntries: 200, searchLimit: 5 }), { graphRoot: DEFAULT_GRAPH_ROOT, maxIndexEntries: 200, searchLimit: 5 })
})

test('direct row registers the core tools and counts itself live until disposed', () => {
  const { ctx, tools, disposeAll } = fakeCtx()
  const graphRoot = freshRoot()
  direct.apply(ctx, { graphRoot })
  assert.ok(tools.has('memory_search') && tools.has('memory_write') && tools.has('memory_merge'))
  assert.equal(state.directActive, 1)
  // The memory-graph panel shows this row's graph while it is live.
  assert.equal(state.directGraphRoot, graphRoot)
  disposeAll()
  assert.equal(state.directActive, 0)
  assert.equal(state.directGraphRoot, undefined)
})

// ---------------------------------------------------------------- 「导入历史」 in direct mode

test('direct mode: history_import_help is present, the import tools are absent', async () => {
  const { ctx, tools, disposeAll } = fakeCtx()
  const graphRoot = freshRoot()
  await createNode(graphRoot, { description: 'one existing fact' })
  direct.apply(ctx, { graphRoot })
  assert.ok(tools.has(HELP_TOOL_NAME))
  assert.equal(tools.get(HELP_TOOL_NAME).presentCall({}).kind, 'read')
  assert.equal(historyRow.TOOLS.length, 8)
  for (const name of historyRow.TOOLS) assert.ok(!tools.has(name), `${name} must not exist in direct mode`)
  const before = fs.readdirSync(graphRoot).sort()
  const { text } = await tools.get(HELP_TOOL_NAME).execute({}, {})
  // It says the import does not run here, how to switch, and why; it imports nothing.
  assert.match(text, /not available right now, and nothing has been imported/)
  assert.match(text, /Turn OFF "Mexplore · Memory tools \(direct\)" \(「Mexplore · 直接挂载记忆工具」, memory-graph-direct\) and turn ON "Mexplore · Memory agent" \(「Mexplore · 记忆代理」, memory-graph-agent\)/)
  assert.match(text, /memory agent is its only writer/)
  assert.match(text, /never write an import script/)
  // A custom graph root needs the same root on the agent row.
  assert.match(text, new RegExp(`- id: memory-graph-agent\\n\\s+config: \\{ graphRoot: ${graphRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}`))
  assert.match(text, /this graph has 1, so it qualifies/)
  assert.deepEqual(fs.readdirSync(graphRoot).sort(), before, 'the help tool writes nothing')
  disposeAll()
  assert.ok(!tools.has(HELP_TOOL_NAME))
})

test('history_import_help: default root needs no patch; a large graph is told to use an empty one', () => {
  const plain = helpText({ graphRoot: DEFAULT_GRAPH_ROOT, nodeCount: 0 })
  assert.match(plain, /Both switches use the same graph \(~\/\.dsh\/memory-graph\), so cordis\.patch\.yml needs no change/)
  assert.doesNotMatch(plain, /- id: memory-graph-agent/)
  assert.match(helpText({ graphRoot: DEFAULT_GRAPH_ROOT, nodeCount: 362 }), /at most 20 existing nodes\), and this graph has 362\. Point the memory agent's graphRoot at a new empty directory/)
})

test('history_import_help names the switches exactly as the Plugins page shows them', () => {
  for (const [row, key] of [['direct', 'direct'], ['agent', 'agent'], ['history', 'history']]) {
    for (const lang of ['en', 'zh']) {
      const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'locale', row, `${lang}.json`), 'utf8')).meta
      assert.equal(SWITCHES[key][lang], meta.title, `${row} ${lang}`)
    }
  }
})

/** Render the memory section a row injects, with every variable resolved. */
function renderSection(apply, config) {
  const sections = []
  const variables = new Map()
  const fake = fakeCtx()
  fake.ctx.inject = (_names, callback) => {
    callback({ systemPrompt: { section: (s) => sections.push(s), variable: (k, p) => variables.set(k, p) } })
    return () => {}
  }
  apply(fake.ctx, config)
  fake.disposeAll()
  return sections.map((s) => ({ name: s.name, text: s.text.replace(/\{\{(\w+)\}\}/g, (_m, k) => (variables.has(k) ? String(variables.get(k)({})) : '')) }))
}

const HANDS_OFF = /Only the memory tools write the memory graph: never create, change or delete anything inside its directory with shell, file or script tools, and never write your own import script\./

test('the hands-off rule is in the direct section, the memory_agent description and the history section', () => {
  const directSections = renderSection(direct.apply, { graphRoot: freshRoot() })
  assert.match(directSections.find((s) => s.name === 'memory:graph').text, HANDS_OFF)
  const host = fakeCtx()
  agent.apply(host.ctx, { graphRoot: freshRoot() })
  assert.match(host.tools.get('memory_agent').description, /Only the memory agent writes the memory graph: never create, change or delete anything inside the\ngraph directory with shell, file or script tools, and never write your own import script\./)
  assert.match(historyRow.SECTION_TEXT, /Only the history_\* tools import\. Never write your own import script, and never create, change or delete anything inside the memory graph directory with shell, file or script tools/)
})

test('the memory agent child (read/manage profiles, no shell tools) does not pay for the hands-off rule', () => {
  for (const authority of ['read', 'manage']) {
    const sections = renderSection((ctx, cfg) => {
      ctx[SETTINGS_SERVICE] = agent.resolveAgentConfig(cfg)
      agentTools.apply(ctx, { authority })
    }, { graphRoot: freshRoot() })
    const memory = sections.find((s) => s.name === 'memory:graph')
    assert.ok(memory, authority)
    assert.doesNotMatch(memory.text, HANDS_OFF, authority)
  }
})

test('agent switch on: the import tools load and history_import_help does not', () => {
  const host = fakeCtx()
  agent.apply(host.ctx, { graphRoot: freshRoot() })
  host.ctx[SETTINGS_SERVICE] = host.provided.get(SETTINGS_SERVICE)
  historyRow.apply(host.ctx, {})
  for (const name of historyRow.TOOLS) assert.ok(host.tools.has(name), name)
  assert.ok(host.tools.has('memory_agent'))
  assert.ok(!host.tools.has(HELP_TOOL_NAME))
  host.disposeAll()
})

// ---------------------------------------------------------------- preset tools

function presetTools(authority, graphRoot, globals = []) {
  const fake = fakeCtx({}, globals)
  fake.ctx[SETTINGS_SERVICE] = agent.resolveAgentConfig({ graphRoot })
  agentTools.apply(fake.ctx, { authority })
  return fake
}

test('read preset exposes only the three read tools and denies every global tool', () => {
  const { tools, restrictions } = presetTools('read', freshRoot(), ['bash', 'memory_agent', 'session_search', 'memory_search'])
  assert.deepEqual([...tools.keys()].sort(), ['memory_read', 'memory_read_file', 'memory_search'])
  // A global memory_search (direct row on) is not denied: the preset's own shadows it.
  assert.deepEqual(restrictions, [{ deny: ['bash', 'memory_agent', 'session_search'] }])
})

test('a tool that appears after the preset loaded is denied on the next registry change', () => {
  const globals = ['working_directory']
  const fake = fakeCtx({}, globals)
  fake.ctx[SETTINGS_SERVICE] = agent.resolveAgentConfig({ graphRoot: freshRoot() })
  agentTools.apply(fake.ctx, { authority: 'read' })
  assert.deepEqual(fake.restrictions, [{ deny: ['working_directory'] }])
  globals.push('memory_agent') // e.g. the agent row switched on through HMR
  fake.listeners.get('tools/change')()
  assert.deepEqual(fake.restrictions, [{ deny: ['working_directory', 'memory_agent'] }])
  fake.disposeAll()
  assert.deepEqual(fake.restrictions, [])
})

test('no global tools means no restriction (restrict refuses an empty filter)', () => {
  const { restrictions } = presetTools('read', freshRoot(), [])
  assert.deepEqual(restrictions, [])
})

test('manage preset adds write and attach, never merge or restore, and drops from_path from the schema', () => {
  const { tools } = presetTools('manage', freshRoot())
  assert.deepEqual([...tools.keys()].sort(), ['memory_attach', 'memory_read', 'memory_read_file', 'memory_search', 'memory_write'])
  assert.equal(tools.get('memory_attach').parameters.properties.from_path, undefined)
})

test('the memory_agent row provides its settings as a service; preset tools need it and use its graph root', async () => {
  assert.deepEqual(agentTools.inject, ['tools', SETTINGS_SERVICE])
  const host = fakeCtx()
  const graphRoot = freshRoot()
  agent.apply(host.ctx, { graphRoot })
  assert.equal(host.provided.get(SETTINGS_SERVICE).plugin.graphRoot, graphRoot)
  assert.throws(() => agentTools.apply(fakeCtx().ctx, { authority: 'read' }), /need the memory_agent row/)
  const preset = fakeCtx()
  preset.ctx[SETTINGS_SERVICE] = host.provided.get(SETTINGS_SERVICE)
  agentTools.apply(preset.ctx, { authority: 'manage' })
  state.delegations.set('c0', { authority: 'manage', calls: [], fence: { latched: false } })
  const written = await preset.tools.get('memory_write').execute({ description: 'lands in the configured root', body: 'x' }, { agent: { id: 'c0' } })
  assert.ok(fs.existsSync(path.join(graphRoot, written.id)))
})

test('an unknown authority fails at load', () => {
  assert.throws(() => presetTools('full', freshRoot()), /authority 'read' or 'manage'/)
})

test('preset tools refuse calls that are not a live delegation, or of another authority', async () => {
  const { tools } = presetTools('manage', freshRoot())
  await assert.rejects(tools.get('memory_search').execute({ query: '' }, { agent: { id: 'stranger' } }), /only inside a memory_agent delegation/)
  state.delegations.set('c1', { authority: 'read', calls: [], fence: { latched: false } })
  await assert.rejects(tools.get('memory_search').execute({ query: '' }, { agent: { id: 'c1' } }), /authority 'read', not 'manage'/)
})

test('memory_attach.from_path is refused at execution even if the schema is bypassed', async () => {
  const { tools } = presetTools('manage', freshRoot())
  state.delegations.set('c2', { authority: 'manage', calls: [], fence: { latched: false } })
  await assert.rejects(
    tools.get('memory_attach').execute({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', from_path: '/etc/hosts' }, { agent: { id: 'c2' } }),
    /from_path is not permitted/,
  )
})

test('a write rejected by argument preparation is recorded as not executed and does not latch the fence', async () => {
  const { tools } = presetTools('manage', freshRoot())
  const record = { authority: 'manage', calls: [], fence: { latched: false } }
  state.delegations.set('c3', record)
  await assert.rejects(tools.get('memory_write').execute({ bogus: 1 }, { agent: { id: 'c3' } }), /invalid arguments/)
  assert.equal(record.fence.latched, false)
  assert.equal(record.calls[0].outcome.executionStarted, false)
})

test('a write that throws after running latches the fence, and later writes are refused before running', { skip: process.getuid?.() === 0 ? 'root ignores the read-only graph root this test relies on' : false }, async () => {
  const graphRoot = freshRoot()
  const { tools } = presetTools('manage', graphRoot)
  const record = { authority: 'manage', calls: [], fence: { latched: false } }
  state.delegations.set('c4', record)
  // Make the graph root unwritable so the create fails inside the handler.
  fs.chmodSync(graphRoot, 0o500)
  try {
    await assert.rejects(tools.get('memory_write').execute({ description: 'a fact', body: 'detail' }, { agent: { id: 'c4' } }))
  } finally {
    fs.chmodSync(graphRoot, 0o700)
  }
  assert.equal(record.fence.latched, true)
  await assert.rejects(
    tools.get('memory_write').execute({ description: 'another fact', body: 'more' }, { agent: { id: 'c4' } }),
    new RegExp(agentTools.WRITE_FENCE_CODE),
  )
  assert.equal(record.calls.at(-1).outcome.executionStarted, false)
  // Reads still work.
  const found = await tools.get('memory_search').execute({ query: '' }, { agent: { id: 'c4' } })
  assert.equal(typeof found.total, 'number')
})

test('an audited refusal (update of an unread node) does not latch the fence', async () => {
  const graphRoot = freshRoot()
  const id = await createNode(graphRoot, { description: 'existing fact', body: 'old body' })
  const { tools } = presetTools('manage', graphRoot)
  const record = { authority: 'manage', calls: [], fence: { latched: false } }
  state.delegations.set('c5', record)
  await assert.rejects(tools.get('memory_write').execute({ id, body: 'new body' }, { agent: { id: 'c5' } }))
  assert.equal(record.calls[0].outcome.auditedRefusal, 'update_unread')
  assert.equal(record.fence.latched, false)
})

test('memory_read_file pages are verified against the bytes on disk', async () => {
  const graphRoot = freshRoot()
  const id = await createNode(graphRoot, { description: 'has a file', body: 'see report.md' })
  await attach(graphRoot, id, 'report.md', '# Report\nline two\n')
  const { tools } = presetTools('read', graphRoot)
  const record = { authority: 'read', calls: [], fence: { latched: false } }
  state.delegations.set('c6', record)
  const page = await tools.get('memory_read_file').execute({ id, file: 'report.md' }, { agent: { id: 'c6' } })
  assert.equal(page.content, '# Report\nline two\n')
  assert.equal(record.calls[0].verification.verified, true)
  const forged = await agentTools.verifyReadFile(graphRoot, { ...page, content: '# Report\nline 2\n' })
  assert.equal(forged.verified, false)
})

// ---------------------------------------------------------------- reply checks

test('citations are kept only for nodes the tools returned, attachments only if seen', () => {
  const calls = [
    { tool: 'memory_search', outcome: { kind: 'result', result: { matches: [{ id: 'A', description: 'a', files: ['f.md'] }] } } },
    { tool: 'memory_read', outcome: { kind: 'result', result: { id: 'B', description: 'b', files: [] } } },
  ]
  const grounded = groundCitations(calls, [{ nodeId: 'A', attachment: 'f.md' }, { nodeId: 'B', attachment: 'x.md' }, { nodeId: 'Z' }, { nodeId: 'B' }])
  assert.deepEqual(grounded, [
    { nodeId: 'A', description: 'a', attachment: 'f.md' },
    { nodeId: 'B', description: 'b' },
  ])
  assert.deepEqual(fallbackCitations(calls), [{ nodeId: 'B', description: 'b' }])
})

test('the reply parser takes the trailing JSON object and repairs raw newlines inside strings', () => {
  const parsed = parseAgentReply('Searching...\n{"text":"line one\nline two","unknown":false,"citations":[{"nodeId":"A"}]}', 1000)
  assert.equal(parsed.structured, true)
  assert.equal(parsed.text, 'line one\nline two')
  assert.deepEqual(parsed.citations, [{ nodeId: 'A' }])
  const prose = parseAgentReply('no json here', 1000)
  assert.equal(prose.structured, false)
})

test('attachments are rebuilt only from verified contiguous pages of one version', () => {
  const page = (offset, text, next, verified = true) => ({
    tool: 'memory_read_file',
    outcome: { kind: 'result', result: { id: 'N', file: 'f.md', content: text, size: 6, offset, bytes: Buffer.byteLength(text), ...(next === undefined ? {} : { next_offset: next }) } },
    verification: { verified, nodeId: 'N', attachment: 'f.md', size: 6, offset, bytes: Buffer.byteLength(text), version: '6:h', fileHash: 'h' },
  })
  assert.deepEqual(buildArtifacts([page(0, 'abc', 3), page(3, 'def')], 100), [
    { nodeId: 'N', attachment: 'f.md', totalBytes: 6, version: '6:h', offset: 0, text: 'abcdef', complete: true },
  ])
  assert.deepEqual(buildArtifacts([page(0, 'abc', 3, false)], 100), [])
})

test('the prompt embeds message and evidence as JSON and marks a missing date unknown', () => {
  const prompt = buildPrompt({ delegationId: 'd', authority: 'read', message: 'what did we decide?', evidence: [{ role: 'user', content: 'x' }], contextDate: '2026-11-06' })
  assert.match(prompt, /"message": "what did we decide\?"/)
  assert.match(prompt, /"dateProvenance": "unknown"/)
  assert.match(prompt, /End with exactly ONE JSON object/)
})

// ---------------------------------------------------------------- memory_agent

test('agent config: defaults, model pinning, and loud failures', () => {
  const resolved = agent.resolveAgentConfig({})
  assert.equal(resolved.approveWrites, false)
  assert.deepEqual(resolved.plugin, { graphRoot: DEFAULT_GRAPH_ROOT, maxIndexEntries: 30 })
  assert.equal(resolved.model, undefined)
  const pinned = agent.resolveAgentConfig({ model: { provider: 'openrouter', model: 'm' }, maxIndexEntries: 200, plugin: { searchLimit: 5 } })
  assert.deepEqual(pinned.model, { provider: 'openrouter', model: 'm' })
  assert.deepEqual(pinned.plugin, { graphRoot: DEFAULT_GRAPH_ROOT, maxIndexEntries: 200, searchLimit: 5 })
  assert.throws(() => agent.resolveAgentConfig({ approveWrites: 'yes' }), /approveWrites/)
  assert.throws(() => agent.resolveAgentConfig({ model: { model: 'm' } }), /provider/)
  assert.throws(() => agent.resolveAgentConfig({ timeout: 5 }), /unknown field `timeout`/)
})

test('approveWrites registers an ask decision for manage calls only', async () => {
  const { ctx, listeners } = fakeCtx()
  agent.apply(ctx, { approveWrites: true })
  const hook = listeners.get('tools/pre-execute')
  const next = async () => ({ kind: 'allow' })
  assert.equal((await hook({ name: 'memory_agent', arguments: { authority: 'manage' } }, next)).kind, 'ask')
  assert.equal((await hook({ name: 'memory_agent', arguments: { message: 'x' } }, next)).kind, 'allow')
  assert.equal((await hook({ name: 'bash', arguments: {} }, next)).kind, 'allow')
  const quiet = fakeCtx()
  agent.apply(quiet.ctx, {})
  assert.equal(quiet.listeners.has('tools/pre-execute'), false)
})

/**
 * A subagents service whose "child" runs a scripted sequence against the real
 * preset tools, with exec.agent.id = the childId memory_agent reserved.
 */
function fakeSubagents(presetToolsByPreset, script) {
  const starts = []
  return {
    starts,
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      starts.push(spec)
      const childExec = { agent: { id: spec.childId } }
      const tools = presetToolsByPreset[spec.agentPreset]
      const result = (async () => {
        const text = await script(tools, childExec)
        return { output: [{ type: 'text', text }], stopReason: 'completed' }
      })()
      return { childId: spec.childId, result, dispose: async () => {} }
    },
  }
}

test('one read delegation: child uses its tools, invented citations are dropped, attachment is returned verbatim', async () => {
  const graphRoot = freshRoot()
  const id = await createNode(graphRoot, { description: 'deploy decision', body: 'ship staging from dev; see notes.md' })
  await attach(graphRoot, id, 'notes.md', 'exact notes\n')
  const host = fakeCtx()
  agent.apply(host.ctx, { graphRoot })
  const read = fakeCtx()
  read.ctx[SETTINGS_SERVICE] = host.provided.get(SETTINGS_SERVICE)
  agentTools.apply(read.ctx, { authority: 'read' })
  const subagents = fakeSubagents({ [READ_PRESET]: read.tools }, async (tools, exec) => {
    await tools.get('memory_search').execute({ query: 'deploy' }, exec)
    await tools.get('memory_read').execute({ id }, exec)
    await tools.get('memory_read_file').execute({ id, file: 'notes.md' }, exec)
    return JSON.stringify({ text: 'We ship staging from dev.', unknown: false, citations: [{ nodeId: id, attachment: 'notes.md' }, { nodeId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }] })
  })
  const services = { subagents }
  host.ctx.get = (name) => services[name]
  const out = await host.tools.get('memory_agent').execute({ message: 'how do we ship staging?' }, { agent: { id: 'parent' }, signal: new AbortController().signal })
  assert.ok(out.text.startsWith('We ship staging from dev.'), out.text.slice(0, 80))
  assert.match(out.text, new RegExp(`- ${id} / notes\\.md — deploy decision`))
  assert.doesNotMatch(out.text, /01ARZ3NDEKTSV4RRFFQ69G5FAV/)
  assert.match(out.text, /--- attachment notes\.md[^\n]*complete\) ---\nexact notes\n\n--- end attachment notes\.md ---/)
  const spec = subagents.starts[0]
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.agentPreset, READ_PRESET)
  assert.equal(spec.agentOptions, undefined)
  for (const key of ['prompt', 'parent', 'agentPreset', 'agentOptions', 'maxDepth']) {
    assert.deepEqual(spec.request[key], spec[key], `flat and nested ${key} agree`)
  }
  assert.equal(state.delegations.size, 0)
})

test('a manage delegation uses the manage preset, pins the configured model, and reports the write from its result', async () => {
  const graphRoot = freshRoot()
  const host = fakeCtx()
  agent.apply(host.ctx, { graphRoot, model: { provider: 'p', model: 'm' } })
  const manage = fakeCtx()
  manage.ctx[SETTINGS_SERVICE] = host.provided.get(SETTINGS_SERVICE)
  agentTools.apply(manage.ctx, { authority: 'manage' })
  let written
  const subagents = fakeSubagents({ [MANAGE_PRESET]: manage.tools }, async (tools, exec) => {
    written = await tools.get('memory_write').execute({ description: 'Alex prefers 30-line index', body: 'Decided 2026-11-06.' }, exec)
    return JSON.stringify({ text: 'Saved.', unknown: false, citations: [] })
  })
  host.ctx.get = (name) => ({ subagents })[name]
  const out = await host.tools.get('memory_agent').execute(
    { message: 'remember: 30-line index', authority: 'manage', evidence: [{ role: 'user', content: '先按30' }] },
    { agent: { id: 'parent' }, signal: new AbortController().signal },
  )
  assert.equal(subagents.starts[0].agentPreset, MANAGE_PRESET)
  assert.deepEqual(subagents.starts[0].agentOptions, { provider: 'p', model: 'm' })
  assert.deepEqual(subagents.starts[0].request.agentOptions, subagents.starts[0].agentOptions)
  assert.match(out.text, new RegExp(`- created node ${written.id}`))
  assert.ok(fs.existsSync(path.join(graphRoot, written.id)))
})

test('memory_agent refuses while the direct tools row is on', async () => {
  const host = fakeCtx({ subagents: fakeSubagents({}, async () => '') })
  agent.apply(host.ctx, { graphRoot: freshRoot() })
  state.directActive = 1
  await assert.rejects(
    host.tools.get('memory_agent').execute({ message: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal }),
    /turn off one of the two memory-graph plugins/,
  )
})

test('a child that never finishes is stopped at the timeout and the record is cleared', async () => {
  let disposed = false
  const subagents = {
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      return { childId: spec.childId, result: new Promise(() => {}), dispose: async () => { disposed = true } }
    },
  }
  const host = fakeCtx({ subagents })
  agent.apply(host.ctx, { graphRoot: freshRoot(), timeoutMs: 20 })
  await assert.rejects(
    host.tools.get('memory_agent').execute({ message: 'x' }, { agent: { id: 'p' }, signal: new AbortController().signal }),
    /did not finish within 20 ms/,
  )
  assert.equal(disposed, true)
  assert.equal(state.delegations.size, 0)
})

// ---------------------------------------------------------------- package root

test('package root keeps the core plugin for existing rows and runs the panel routes with panel: true', async () => {
  const entry = await import('../lib/entry.js')
  const core = await import('../lib/index.js')
  assert.equal(entry.name, core.name)
  assert.deepEqual(entry.inject, core.inject)
  assert.equal(entry.BUILD, core.BUILD)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/entry.js')

  // A core row (graphRoot, no panel flag) registers the seven memory tools.
  const plain = fakeCtx()
  entry.apply(plain.ctx, { graphRoot: freshRoot() })
  assert.ok(plain.tools.has('memory_search') && plain.tools.has('memory_merge'))

  // A panel row waits for the web server and connection gate, then registers the prefix route only.
  const routes = []
  let injected
  const panel = fakeCtx()
  panel.ctx.inject = (names, callback) => {
    injected = names
    callback({
      ...panel.ctx,
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      connection: { requestRejection: () => undefined },
    })
    return () => {}
  }
  entry.apply(panel.ctx, { panel: true })
  assert.deepEqual(injected, ['webServer', 'connection'])
  assert.deepEqual(routes.map((r) => [r.kind, r.path]), [['prefix', '/mexplor/api']])
  assert.equal(panel.tools.size, 0)
  panel.disposeAll()
})

// ---------------------------------------------------------------- distribution

test('Git distribution keeps publication guards and ships license notices', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.private, true)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.scripts['stage:npm'], undefined)
  assert.equal(fs.existsSync(path.join(pkgDir, 'scripts/stage-npm.mjs')), false)
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(pkg.files.includes(file), file)
    assert.ok(fs.existsSync(path.join(pkgDir, file)), file)
  }
})
