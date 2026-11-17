/**
 * Audited pre-mutation refusals (#245).
 *
 * Two layers are pinned here:
 *
 *   1. `tool.js` provenance: a refusal proof belongs to ONE definition, ONE
 *      exec object and ONE invocation, is settled only when that invocation
 *      exits with the very branded error, and is consumable once. Foreign,
 *      replayed, wrapped or hand-built shapes earn nothing.
 *   2. the AUDITED plugin branches — the four id-update codes (#245), the
 *      attachment-overwrite guard (#247) and the three supersede pre-checks
 *      (#253): the original Error/message/class is preserved, the node bytes
 *      are untouched, and the code is one of the closed set. A branch the audit
 *      did NOT cover (F88.3 correction, a supersede gate's LOCKED re-check)
 *      stays unbranded even when it writes a correction, and a handler that
 *      mutates and then throws a refusal-shaped error earns nothing because it
 *      never used the scoped helper.
 *
 * Direct plugin calls keep their old behaviour: the helper returns the same
 * error object, so message, class and stack are unchanged.
 *
 * Disposable graph roots only. Nothing here talks to a live graph or service.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { ATTACH_MAX_BYTES, ATTACH_READ_BYTES, PREV_NODE_FILE, prevAttachmentFile } from '../lib/graph.js'
import { fromPathAttachmentName } from '../lib/index.js'
import { apply } from '../lib/index.js'
import { ToolArgsError, consumeAuditedRefusal, defineTool, trustedPreparationFor } from '../lib/tool.js'

const roots = []
after(async () => {
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true })
})

async function freshRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-refusals-'))
  roots.push(root)
  return root
}

/** A context that records what the plugin registers (same shape as plugin.test.js). */
function fakeCtx() {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(_names, callback) {
      callback({ systemPrompt: { section: () => () => {}, variable: () => () => {} } })
      return () => {}
    },
  }
  return { ctx, tools }
}

async function harness(config = {}) {
  const root = await freshRoot()
  const { ctx, tools } = fakeCtx()
  apply(ctx, { graphRoot: root, indexCacheMs: 0, ...config })
  return {
    root,
    tools,
    write: tools.get('memory_write'),
    read: tools.get('memory_read'),
    attach: tools.get('memory_attach'),
  }
}

/** One conversation identity per scenario: the read gate is per Session. */
const execFor = (id) => ({ agent: { id } })

const nodePath = (root, id) => path.join(root, id, 'node.md')
const bytes = async (file) => new Uint8Array(await fsp.readFile(file))

/** Run a write expected to be refused, and return the error plus its code. */
async function refusal(definition, args, exec) {
  try {
    await definition.execute(args, exec)
  } catch (error) {
    return { error, code: consumeAuditedRefusal(definition, exec, error) }
  }
  throw new Error('expected the write to be refused')
}

// ---------------------------------------------------------------- provenance

test('tool.js: a declared helper brands the exact error for this invocation and is consumed once', async () => {
  const original = new Error('original refusal')
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      throw refuse('update_unread', original)
    },
  })
  const exec = { agent: { id: 'session-a' } }
  const thrown = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(thrown, original, 'the same Error instance is thrown, class/message/stack untouched')
  assert.equal(consumeAuditedRefusal(definition, exec, thrown), 'update_unread')
  assert.equal(consumeAuditedRefusal(definition, exec, thrown), undefined, 'proof is consumed once')
  assert.equal(trustedPreparationFor(definition) !== undefined, true)
})

test('tool.js: foreign definition, foreign exec, wrapped and replayed errors earn nothing', async () => {
  const make = (code) =>
    defineTool({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object' }, render: () => '' },
      auditedRefusals: ['update_unread'],
      async execute(_args, _exec, refuse) {
        throw refuse(code, new Error(code))
      },
    })
  const first = make('update_unread')
  const second = make('update_unread')
  const execA = { agent: { id: 'a' } }
  const execB = { agent: { id: 'b' } }

  const error = await first.execute({}, execA).then(() => undefined, (thrown) => thrown)
  assert.equal(consumeAuditedRefusal(first, execB, error), undefined, 'foreign exec')
  assert.equal(consumeAuditedRefusal(second, execA, error), undefined, 'foreign definition')
  assert.equal(consumeAuditedRefusal(first, execA, new Error(error.message)), undefined, 'a look-alike error')

  // A wrapped proof: the branded error exists but the invocation exits with a
  // different error object, so nothing settles.
  const wrappedDefinition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      const branded = refuse('update_unread', new Error('inner'))
      throw new Error('outer', { cause: branded })
    },
  })
  const wrapped = await wrappedDefinition.execute({}, execA).then(() => undefined, (thrown) => thrown)
  assert.equal(consumeAuditedRefusal(wrappedDefinition, execA, wrapped), undefined, 'wrapped proof')
})

test('tool.js: reusing one exec across calls cannot carry an old unconsumed proof forward', async () => {
  const exec = { agent: { id: 'reused' } }
  let captured
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      if (captured === undefined) {
        captured = refuse('update_unread', new Error('first'))
        return { swallowed: true } // exits normally: no proof settles
      }
      throw captured // a REPLAYED error from the previous invocation
    },
  })
  const first = await definition.execute({}, exec)
  assert.deepEqual(first, { swallowed: true })
  const replay = await definition.execute({}, exec).then(() => undefined, (thrown) => thrown)
  assert.equal(replay, captured)
  assert.equal(consumeAuditedRefusal(definition, exec, replay), undefined)
})

test('tool.js: an undeclared code or a second brand in one invocation is not trusted', async () => {
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      if (refuse === undefined) throw new Error('no helper')
      refuse('update_unread', new Error('first'))
      throw refuse('not_declared', new Error('second'))
    },
  })
  const exec = {}
  const thrown = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(thrown.message, 'second')
  assert.equal(consumeAuditedRefusal(definition, exec, thrown), undefined)
})

test('tool.js: a definition that declares nothing gets no helper and no proof', async () => {
  let helperSeen = 'unset'
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    async execute(_args, _exec, refuse) {
      helperSeen = refuse
      throw new Error('plain')
    },
  })
  await assert.rejects(definition.execute({}, {}), /plain/)
  assert.equal(helperSeen, undefined)
  assert.equal(consumeAuditedRefusal(definition, {}, new Error('plain')), undefined)
})

// ------------------------------------------------------------- plugin branches

test('update_unread: refusal keeps the original message, leaves node bytes untouched, and a read-then-write self-corrects', async () => {
  const { root, write, read } = await harness()
  // A create seeds its OWN session's read expectation, so the unread writer
  // must be a different conversation (the common multi-Session shape).
  const creator = execFor('self-correct-creator')
  const exec = execFor('self-correct')
  const created = await write.execute({ description: 'a fact', body: 'body one', links: [] }, creator)
  const before = await bytes(nodePath(root, created.id))

  const refused = await refusal(write, { id: created.id, body: 'body two' }, exec)
  assert.equal(refused.code, 'update_unread')
  assert.ok(refused.error instanceof Error)
  assert.match(refused.error.message, /has not been read this session — memory_read it before updating/)
  assert.deepEqual(await bytes(nodePath(root, created.id)), before)

  // US-002 / FR-008: read the latest state, then the valid update lands.
  await read.execute({ id: created.id }, exec)
  const updated = await write.execute({ id: created.id, body: 'body two' }, exec)
  assert.equal(updated.id, created.id)
  assert.match(await fsp.readFile(nodePath(root, created.id), 'utf8'), /body two/)
})

test('update_stale: a fresh disk change rejects with the Stale Write gate and changes nothing', async () => {
  const { root, write, read } = await harness()
  const exec = execFor('stale')
  const created = await write.execute({ description: 'stale target', body: 'first body', links: [] }, exec)
  await read.execute({ id: created.id }, exec)
  // Another Session edits the node after this Session's read.
  await fsp.appendFile(nodePath(root, created.id), '\n- added elsewhere\n', 'utf8')
  const before = await bytes(nodePath(root, created.id))

  const refused = await refusal(write, { id: created.id, body: 'replacement body' }, exec)
  assert.equal(refused.code, 'update_stale')
  assert.match(refused.error.message, /changed since it was read — a Stale Write/)
  assert.doesNotMatch(refused.error.message, /has not been read this session/)
  assert.deepEqual(await bytes(nodePath(root, created.id)), before)
})

test('update_stale: a failed hub-hint lookup keeps the message unchanged but is not certified', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('hint-creator')
  const exec = execFor('hint')
  const created = await write.execute({ description: 'hint failure', body: 'first body', links: [] }, creator)
  await read.execute({ id: created.id }, exec)
  await fsp.appendFile(nodePath(root, created.id), '\n- edited elsewhere\n', 'utf8')

  // A readable node.md with an unreadable __edges__ lookup: the advisory hint
  // cannot be retrieved, so the audited prefix did not complete.
  const edgesDir = path.join(root, created.id, '__edges__')
  await fsp.chmod(edgesDir, 0o000)
  try {
    const refused = await refusal(write, { id: created.id, body: 'replacement body' }, exec)
    assert.equal(refused.code, undefined)
    assert.equal(
      refused.error.message,
      `memory_write: ${created.id} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`,
    )
    assert.doesNotMatch(refused.error.message, /high-traffic hub/)
  } finally {
    await fsp.chmod(edgesDir, 0o755)
  }
})

test('update_contradicted_figure: the pre-lock reject is audited and the stored figure survives', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('contradicted-creator')
  const exec = execFor('contradicted')
  const created = await write.execute(
    {
      description: 'QQQ ETF 报告核心结论',
      body: '## 报告核心结论\n- 近半年涨幅 **+21.38%**\n- 前10大持仓占 44.92%',
    },
    creator,
  )
  await read.execute({ id: created.id }, exec)
  const before = await bytes(nodePath(root, created.id))

  const refused = await refusal(
    write,
    { id: created.id, body: '## 报告核心结论\n- 风险：PE约32x（均值25x）、前十大持仓约55%、利率反复' },
    exec,
  )
  assert.equal(refused.code, 'update_contradicted_figure')
  assert.match(refused.error.message, /contradicted figure/)
  assert.match(refused.error.message, /44\.92%/)
  assert.deepEqual(await bytes(nodePath(root, created.id)), before)
  assert.match(await fsp.readFile(nodePath(root, created.id), 'utf8'), /44\.92/)
})

test('update_target_missing: only this update read ENOENT is certified, with the original fs Error object', async () => {
  const { root, write, read } = await harness()
  const exec = execFor('missing')
  const created = await write.execute({ description: 'vanishing', body: 'body', links: [] }, exec)
  await read.execute({ id: created.id }, exec)
  await fsp.rm(path.join(root, created.id), { recursive: true, force: true })

  const refused = await refusal(write, { id: created.id, body: 'next body' }, exec)
  assert.equal(refused.code, 'update_target_missing')
  assert.equal(refused.error.code, 'ENOENT')
  assert.equal(refused.error.constructor, Error)
})

test('supersede_unread: the create/supersede pre-check is audited and writes nothing (#253)', async () => {
  const { root, write } = await harness()
  const creator = execFor('supersede-creator')
  const exec = execFor('supersede-unread')
  const target = await write.execute({ description: 'supersede target', body: 'old', links: [] }, creator)
  const before = await bytes(nodePath(root, target.id))
  // A create-with-supersedes whose target this Session never read. The gate
  // runs before createNode, so nothing was written — certified since #253.
  const refused = await refusal(
    write,
    { description: 'successor', body: 'new', supersedes: target.id },
    exec,
  )
  assert.equal(refused.code, 'supersede_unread')
  assert.match(refused.error.message, /has not been read this session/)
  assert.deepEqual(await bytes(nodePath(root, target.id)), before)
  // No successor was published either.
  assert.deepEqual(await fsp.readdir(root).then((names) => names.filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))), [target.id])
})

// -------------------------------------------- #253 argument shapes

/**
 * Assert a call is refused by the TRUSTED PREPARATION — i.e. `execute` was
 * never entered — and that the refusal mints no audited code. This is the
 * receipt-level property memory_service's fence tests rely on; here it is
 * pinned at the plugin boundary the wrapper calls.
 */
async function preExecutionRefusal(definition, args, exec, pattern, label = 'case') {
  const prepared = trustedPreparationFor(definition)(args)
  assert.ok(prepared.violations.length > 0, `${label}: expected an argument-shape violation for ${JSON.stringify(args).slice(0, 120)}`)
  assert.ok(
    prepared.violations.some((violation) => pattern.test(violation)),
    `${label}: no violation matching ${pattern}: ${prepared.violations.join(' | ')}`,
  )
  const error = await definition.execute(args, exec).then(() => undefined, (thrown) => thrown)
  assert.ok(error instanceof ToolArgsError, `${label}: the refusal is the preparation ToolArgsError, not a handler Error`)
  assert.equal(consumeAuditedRefusal(definition, exec, error), undefined, `${label}: a shape error mints no audited code`)
}

test('argument-shape errors are rejected pre-execution and write nothing (#253)', async () => {
  const { root, write, attach } = await harness()
  const creator = execFor('shape-creator')
  const exec = execFor('shape')
  const node = await write.execute({ description: 'shape target', body: 'body', links: [] }, creator)
  const nodeDirs = async () => (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).sort()
  const dirsBefore = await nodeDirs()
  const before = await bytes(nodePath(root, node.id))
  const filesBefore = (await fsp.readdir(path.join(root, node.id))).sort()

  // `memory_write`: every id that cannot name a node, the description rules the
  // storage layer enforces, and the attachment name/byte rules. The first case
  // is a synthetic regression: `id: ""` throws `invalid node id: ""` INSIDE the
  // handler and latches the manage fence.
  for (const [label, args, pattern] of [
    ['empty id', { id: '', body: 'x' }, /`id` must be a 26-character node id/],
    ['slug id', { id: 'not-a-ulid', body: 'x' }, /`id` must be a 26-character node id/],
    ['empty supersedes', { description: 'x', supersedes: '' }, /`supersedes` must be a 26-character node id/],
    ['slug supersedes', { description: 'x', supersedes: 'successor-of-something' }, /`supersedes` must be a 26-character node id/],
    ['empty link', { description: 'x', links: [''] }, /`links` must contain only 26-character node ids/],
    ['typed link id', { description: 'x', typed_links: [{ id: '', type: 'relates-to' }] }, /`typed_links\[\]\.id` must contain only 26-character node ids/],
    ['reserved name', { description: 'x', attach: { filename: 'node.md', content: 'x' } }, /reserved by the framework/],
    ['path name', { description: 'x', attach: { filename: 'reports/q3.md', content: 'x' } }, /path separators/],
    ['dotfile name', { description: 'x', attach: { filename: '.hidden', content: 'x' } }, /start with a dot/],
    ['empty name', { id: node.id, body: 'x', attach: { filename: '', content: 'x' } }, /must be a non-empty string/],
    ['over cap', { description: 'x', attach: { filename: 'big.md', content: 'x'.repeat(ATTACH_MAX_BYTES + 1) } }, /`attach\.content` too large/],
    ['blank description', { description: '   ' }, /must be a non-empty string/],
    ['escaped description', { description: 'two\\nlines, escaped' }, /literal escape sequence/],
    ['long description', { description: 'x'.repeat(501) }, /description too long/],
  ]) {
    await preExecutionRefusal(write, args, exec, pattern, label)
  }

  // `memory_attach`: the same class on the standalone route — one source, a
  // filename with `content`, the name rules, the target id and the byte cap.
  for (const [args, pattern] of [
    [{ id: node.id, content: 'x', from_path: 'README.md' }, /exactly one of `content` and `from_path`/],
    [{ id: node.id }, /exactly one of `content` and `from_path`/],
    [{ id: node.id, content: 'x' }, /`filename` is required with `content`/],
    [{ id: '', content: 'x', filename: 'ok.md' }, /`id` must be a 26-character node id/],
    [{ id: node.id, content: 'x', filename: 'MAP.md' }, /reserved by the framework/],
    [{ id: node.id, content: 'x', filename: '../q3.md' }, /path separators/],
    [{ id: node.id, content: 'x'.repeat(ATTACH_MAX_BYTES + 1), filename: 'ok.md' }, /`content` too large/],
    // #253 review 1: with `from_path` and no explicit `filename`, the name this
    // call stores is the SOURCE's basename — so the same rule must judge that,
    // or a reserved/dotfile basename sails past preparation and is refused only
    // later, in the handler.
    [{ id: node.id, from_path: '/tmp/node.md' }, /from_path \(default filename\)` — filename is reserved/],
    [{ id: node.id, from_path: 'reports/../.hidden.md' }, /start with a dot/],
    [{ id: node.id, from_path: '' }, /`from_path` must be a non-empty path/],
    [{ id: node.id, from_path: '   ' }, /`from_path` must be a non-empty path/],
    // Review 2: the name is derived AFTER the handler's `~` expansion, so a
    // trailing `.` (or `/`) must be judged as what actually lands. Raw
    // `path.basename` reads `~/node.md/.` as `.` — a false refusal with the
    // wrong reason, and the same gap #255 found in its own rule.
    [{ id: node.id, from_path: '~/node.md/.' }, /reserved by the framework/],
    [{ id: node.id, from_path: '/tmp/x/../node.md' }, /reserved by the framework/],
    [{ id: node.id, from_path: 'node.md/' }, /reserved by the framework/],
  ]) {
    await preExecutionRefusal(attach, args, exec, pattern)
  }

  // A legitimate `from_path` is still admitted: the basename rule must not
  // reject an ordinary source path, an explicit `filename` overrides it, and a
  // trailing `.` resolves to the name that actually lands rather than to `.`.
  assert.deepEqual(trustedPreparationFor(attach)({ id: node.id, from_path: 'docs/discussion.md' }).violations, [])
  assert.deepEqual(trustedPreparationFor(attach)({ id: node.id, from_path: '/tmp/node.md', filename: 'ok.md' }).violations, [])
  assert.deepEqual(trustedPreparationFor(attach)({ id: node.id, from_path: '~/x/.' }).violations, [])

  // Byte-identical: no node created, no node.md written, no attachment.
  assert.deepEqual(await nodeDirs(), dirsBefore, 'not one create landed')
  assert.deepEqual(await bytes(nodePath(root, node.id)), before, 'the target node.md is untouched')
  assert.deepEqual((await fsp.readdir(path.join(root, node.id))).sort(), filesBefore, 'no attachment and no .prev')
})

test('supersede_stale: BOTH unlocked supersede pre-checks are certified (#253)', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('supersede-stale-creator')
  const exec = execFor('supersede-stale')
  const target = await write.execute({ description: 'stale supersede target', body: 'old', links: [] }, creator)
  const other = await write.execute({ description: 'stale typed target', body: 'old peer', links: [] }, creator)
  const updatable = await write.execute({ description: 'stale typed source', body: 'source body', links: [] }, creator)
  for (const id of [target.id, other.id, updatable.id]) await read.execute({ id }, exec)
  // Someone else's write lands after this Session's read: a genuine Stale Write.
  await fsp.appendFile(nodePath(root, target.id), '\n- edited elsewhere\n', 'utf8')
  await fsp.appendFile(nodePath(root, other.id), '\n- edited elsewhere\n', 'utf8')
  const before = { target: await bytes(nodePath(root, target.id)), source: await bytes(nodePath(root, updatable.id)) }

  // The `supersedes:` argument, before createNode.
  const created = await refusal(write, { description: 'successor', body: 'new', supersedes: target.id }, exec)
  assert.equal(created.code, 'supersede_stale')
  assert.match(created.error.message, /changed since it was read — a Stale Write/)
  assert.deepEqual(await bytes(nodePath(root, target.id)), before.target, 'the target is untouched')

  // The typed-link spelling of the same gate, on the id-update path.
  const typed = await refusal(
    write,
    { id: updatable.id, body: 'new source body', typed_links: [{ id: other.id, type: 'supersedes' }] },
    exec,
  )
  assert.equal(typed.code, 'supersede_stale')
  assert.match(typed.error.message, /changed since it was read — a Stale Write/)
  assert.deepEqual(await bytes(nodePath(root, updatable.id)), before.source, 'the updated node is untouched')
})

test('supersede_target_missing: a create naming a nonexistent target is certified (#253)', async () => {
  const { root, write } = await harness()
  const exec = execFor('missing-supersede-target')
  const nodeDirs = async () => (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))
  const before = await nodeDirs()
  // Same class as update_target_missing: a pure state pre-check before the
  // first write (createNode), so it is certified rather than left to latch.
  const refused = await refusal(write, { description: 'successor', body: 'new', supersedes: '01J00000000000000000000013' }, exec)
  assert.equal(refused.code, 'supersede_target_missing')
  assert.match(refused.error.message, /cannot supersede — node does not exist/)
  assert.deepEqual(await nodeDirs(), before, 'no successor was published')
})

test('link_target_missing: a link naming a nonexistent node is certified', async () => {
  const { root, write } = await harness()
  const exec = execFor('missing-link-target')
  const nodeDirs = async () => (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name))
  // The live incident (history import, 2026-11-09): a link id that was never in
  // the graph used to be discarded AFTER the node, the banner and the
  // attachment landed, and rendered as `Unlinked: <id>` — a known partial
  // effect, so the manage fence latched and the importer rolled the batch back.
  // The pre-check is a READ before the first write, so it certifies a no-op.
  const before = await nodeDirs()
  const create = await refusal(write, { description: 'links nowhere', body: 'body text', links: ['01J00000000000000000000013'] }, exec)
  assert.equal(create.code, 'link_target_missing')
  assert.match(create.error.message, /cannot link — node does not exist/)
  assert.match(create.error.message, /Nothing was written/)
  assert.deepEqual(await nodeDirs(), before, 'no node was published')

  // The same pre-check on the update route and for the typed spelling.
  const target = await write.execute({ description: 'the real node', body: 'body' }, execFor('missing-link-target-owner'))
  const update = await refusal(write, { id: target.id, links: ['01J00000000000000000000013'] }, exec)
  assert.equal(update.code, 'link_target_missing')
  const typed = await refusal(write, { description: 'typed nowhere', body: 'body', typed_links: [{ id: '01J00000000000000000000013', type: 'follows-from' }] }, exec)
  assert.equal(typed.code, 'link_target_missing')
  assert.deepEqual((await nodeDirs()).sort(), [target.id], 'only the earlier node exists')
})

test('a missing link is refused before an attachment guard can annotate node.md', async () => {
  const { root, write } = await harness()
  const exec = execFor('missing-link-before-annotation')
  const seeded = await write.execute({ description: 'attachment promise', body: 'The full report is in weekly.md.' }, exec)
  const nodeFile = nodePath(root, seeded.id)
  const before = await bytes(nodeFile)
  const untraceable = '# 季度复盘\n\n董事会确认仓储合约续签，配送半径缩短，客服改为两班制。\n'.repeat(20)
  const result = await refusal(write, {
    id: seeded.id,
    links: ['01J00000000000000000000013'],
    attach: { filename: 'weekly.md', content: untraceable },
  }, exec)
  assert.equal(result.code, 'link_target_missing')
  assert.deepEqual(await bytes(nodeFile), before, 'no refusal annotation changed the node')
  await assert.rejects(() => fsp.access(path.join(root, seeded.id, 'weekly.md')))
})

test('the LOCKED supersede re-check stays unbranded: same message, rolled-back write (#253)', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('locked-recheck-creator')
  const exec = execFor('locked-recheck')
  const target = await write.execute({ description: 'locked re-check target', body: 'old', links: [] }, creator)
  await read.execute({ id: target.id }, exec)
  const file = nodePath(root, target.id)
  const original = await bytes(file)
  // Simulate a peer write landing between this call's unlocked pre-check and
  // the locked re-check: the pre-check's reads see the real bytes, every read
  // after them sees a changed node. Patching the shared `fs/promises` object is
  // what reaches graph.js — both importers hold the same module object.
  const realReadFile = fsp.readFile
  let targeted = 0
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(file)) {
      targeted += 1
      if (targeted > 2) return Buffer.from(`${Buffer.from(original).toString('utf8')}\n- edited elsewhere\n`, 'utf8')
    }
    return realReadFile(filePath, ...rest)
  }
  try {
    const refused = await refusal(write, { description: 'successor', body: 'new', supersedes: target.id }, exec)
    // The locked gate DID reject (only the third read onward is altered)...
    assert.ok(targeted > 2, 'the locked re-check read the target')
    assert.match(refused.error.message, /changed since it was read — a Stale Write/)
    // ...but after createNode, so it is a rolled-back write, never a certified
    // no-op: the identical message is thrown unbranded.
    assert.equal(refused.code, undefined, 'a throw after createNode cannot be certified')
    // And the successor this call had published was removed again.
    assert.deepEqual(
      (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).sort(),
      [target.id],
    )
  } finally {
    fsp.readFile = realReadFile
  }
})


test('a failed supersede pre-check read is never certified by a later target (#253 review 1)', async () => {
  // The rule under test: a failed audited prefix ⇒ unbranded. The typed-target
  // read used to swallow EVERY I/O error and continue, so a later target in the
  // same loop could still mint a code — certifying an invocation whose read of
  // an earlier target never completed.
  const nodeDirsOf = async (root) => (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).sort()

  // Scenario 1: target A's read raises EIO, target B is simply unread.
  {
    const { root, write } = await harness()
    const creator = execFor('eio-creator')
    const exec = execFor('eio-unread')
    const broken = await write.execute({ description: 'eio target', body: 'old', links: [] }, creator)
    const unread = await write.execute({ description: 'unread target', body: 'old', links: [] }, creator)
    const brokenFile = nodePath(root, broken.id)
    const realReadFile = fsp.readFile
    fsp.readFile = async (filePath, ...rest) => {
      if (path.resolve(String(filePath)) === path.resolve(brokenFile)) {
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      }
      return realReadFile(filePath, ...rest)
    }
    try {
      const refused = await refusal(
        write,
        {
          description: 'successor',
          body: 'new',
          typed_links: [{ id: broken.id, type: 'supersedes' }, { id: unread.id, type: 'supersedes' }],
        },
        exec,
      )
      assert.equal(refused.code, undefined, 'no code may follow a read that did not complete')
      assert.match(refused.error.message, /EIO/)
    } finally {
      fsp.readFile = realReadFile
    }
    // The failure landed before createNode: no successor, nothing touched.
    assert.deepEqual(await nodeDirsOf(root), [broken.id, unread.id].sort())
  }

  // Scenario 2: target A's read raises EIO, target B is genuinely stale. The
  // stale code must not ride out on the failed prefix either.
  {
    const { root, write, read } = await harness()
    const creator = execFor('eio-stale-creator')
    const exec = execFor('eio-stale')
    const broken = await write.execute({ description: 'eio target', body: 'old', links: [] }, creator)
    const stale = await write.execute({ description: 'stale target', body: 'old', links: [] }, creator)
    await read.execute({ id: stale.id }, exec)
    await fsp.appendFile(nodePath(root, stale.id), '\n- edited elsewhere\n', 'utf8')
    const brokenFile = nodePath(root, broken.id)
    const realReadFile = fsp.readFile
    fsp.readFile = async (filePath, ...rest) => {
      if (path.resolve(String(filePath)) === path.resolve(brokenFile)) {
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      }
      return realReadFile(filePath, ...rest)
    }
    try {
      const refused = await refusal(
        write,
        {
          description: 'successor',
          body: 'new',
          typed_links: [{ id: broken.id, type: 'supersedes' }, { id: stale.id, type: 'supersedes' }],
        },
        exec,
      )
      assert.equal(refused.code, undefined, 'the stale code is not reachable past a failed read')
      assert.match(refused.error.message, /EIO/)
    } finally {
      fsp.readFile = realReadFile
    }
    assert.deepEqual(await nodeDirsOf(root), [broken.id, stale.id].sort())
  }

  // Control: a missing first target is rejected by the existence check before
  // the supersede loop; no later unread target can change that diagnosis.
  {
    const { write } = await harness()
    const creator = execFor('missing-first-creator')
    const exec = execFor('missing-first')
    const unread = await write.execute({ description: 'unread later', body: 'old', links: [] }, creator)
    const refused = await refusal(
      write,
      {
        description: 'successor',
        body: 'new',
        typed_links: [{ id: '01J00000000000000000000013', type: 'supersedes' }, { id: unread.id, type: 'supersedes' }],
      },
      exec,
    )
    assert.equal(refused.code, 'link_target_missing', 'the existence check owns a missing target')
  }
})

test('the LOCKED re-check on the ID-UPDATE path stays unbranded and keeps the landed update (#253 review 1)', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('locked-update-creator')
  const exec = execFor('locked-update')
  const source = await write.execute({ description: 'locked update source', body: 'source body', links: [] }, creator)
  const target = await write.execute({ description: 'locked update target', body: 'target body', links: [] }, creator)
  // Both are read, so the UNLOCKED pre-check passes and the reject can only
  // come from the locked re-check.
  await read.execute({ id: source.id }, exec)
  await read.execute({ id: target.id }, exec)
  const targetFile = nodePath(root, target.id)
  const original = await bytes(targetFile)
  // A peer write landing between the pre-checks and the locked re-check: the
  // link-existence pre-check and the unlocked supersede gate read the real
  // bytes, every read after them sees the change.
  const realReadFile = fsp.readFile
  let targeted = 0
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(targetFile)) {
      targeted += 1
      if (targeted > 2) return Buffer.from(`${Buffer.from(original).toString('utf8')}\n- edited elsewhere\n`, 'utf8')
    }
    return realReadFile(filePath, ...rest)
  }
  try {
    const refused = await refusal(
      write,
      { id: source.id, body: 'revised source body', typed_links: [{ id: target.id, type: 'supersedes' }] },
      exec,
    )
    assert.ok(targeted > 2, 'the locked re-check read the target')
    assert.match(refused.error.message, /changed since it was read — a Stale Write/)
    assert.equal(refused.code, undefined, 'a throw after updateNode cannot be certified')
  } finally {
    fsp.readFile = realReadFile
  }
  // Unlike the create path, there is NOTHING to roll back here: `updateNode`
  // already landed on the source, and the refusal leaves it in place. That
  // retained partial write is exactly why this throw cannot be a certified
  // no-op — and why the docs must not promise a rollback for it.
  assert.match(await fsp.readFile(nodePath(root, source.id), 'utf8'), /revised source body/)
  assert.deepEqual(await bytes(targetFile), original, 'the target itself is untouched')
})

test('a failed freeze read aborts the call unbranded — no later gate may certify it (#253 review 2)', async () => {
  // The restatement freeze reads the node before EVERY branded site of the
  // invocation (the attach-overwrite guard, the typed supersede pre-check), and
  // used to swallow every read error. An EIO there returned normally, and a
  // later unread typed target then minted `supersede_unread` from a prefix that
  // never completed.
  const { root, write } = await harness()
  const creator = execFor('freeze-eio-creator')
  const exec = {
    agent: {
      id: 'freeze-eio',
      session: {
        deriveMessages: () => [
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'short unrelated turn' }] },
        ],
      },
    },
  }
  const frozen = await write.execute(
    { description: 'promises a file', body: '周报完整内容存于附件 invented-freeze.md', links: [] },
    exec,
  )
  const unread = await write.execute({ description: 'unread supersede target', body: 'old', links: [] }, creator)
  // Freeze the node for this turn: an untraceable inline attachment is refused
  // and the F88.1 freeze closes the node (that path is itself uncertified).
  const invented = '# 季度营收复盘\n\n' + '董事会确认了仓储合约与配送半径的安排，客服排班改为两班制。\n'.repeat(12)
  await assert.rejects(
    () => write.execute({ id: frozen.id, attach: { filename: 'invented-freeze.md', content: invented } }, exec),
    /not traceable to this conversation/,
  )

  const frozenFile = nodePath(root, frozen.id)
  const before = await bytes(frozenFile)
  const realReadFile = fsp.readFile
  fsp.readFile = async (filePath, ...rest) => {
    if (path.resolve(String(filePath)) === path.resolve(frozenFile)) {
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
    }
    return realReadFile(filePath, ...rest)
  }
  try {
    const refused = await refusal(
      write,
      { id: frozen.id, body: 'replacement body', typed_links: [{ id: unread.id, type: 'supersedes' }] },
      exec,
    )
    assert.equal(refused.code, undefined, 'the freeze read did not complete, so nothing after it may be certified')
    assert.match(refused.error.message, /EIO/)
  } finally {
    fsp.readFile = realReadFile
  }
  // The failed read aborted the call before any write.
  assert.deepEqual(await bytes(frozenFile), before)
})

test('fromPathAttachmentName derives the name the handler stores (#253 review 2)', async () => {
  const cases = [
    ['docs/discussion.md', 'discussion.md'],
    ['/tmp/node.md', 'node.md'],
    ['/tmp/x/../node.md', 'node.md'],
    ['node.md/', 'node.md'],
    // The raw `path.basename` of these three is '.', which is NOT what lands:
    // the handler expands `~` first, then takes the basename.
    ['~/node.md/.', 'node.md'],
    ['~/x/.', 'x'],
  ]
  for (const [source, expected] of cases) {
    assert.equal(fromPathAttachmentName(source), expected, `from_path ${JSON.stringify(source)}`)
  }
  // A '..' tail resolves against the home directory, so the name is that
  // directory's basename — never the literal '..' the raw derivation reported.
  assert.doesNotMatch(fromPathAttachmentName('~/node.md/..'), /^\.\.?$/)
})

test('F88.3: an attachment refusal that appends a correction is unknown, never certified as no-change', async () => {
  const { root, write } = await harness()
  const exec = {
    agent: {
      id: 'f883',
      session: {
        deriveMessages: () => [
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'short unrelated turn' }] },
        ],
      },
    },
  }
  const created = await write.execute(
    { description: 'promises a file', body: '周报完整内容存于附件 invented-report.md', links: [] },
    exec,
  )
  const before = await bytes(nodePath(root, created.id))
  const invented = '# 季度营收复盘\n\n' + '董事会确认了仓储合约与配送半径的安排，客服排班改为两班制。\n'.repeat(12)

  const refused = await refusal(
    write,
    { id: created.id, attach: { filename: 'invented-report.md', content: invented } },
    exec,
  )
  assert.equal(refused.code, undefined, 'not one of the four audited branches')
  assert.match(refused.error.message, /not traceable to this conversation/)
  // The correction appended to node.md is exactly why this must stay unknown:
  // the call DID modify node bytes.
  assert.notDeepEqual(await bytes(nodePath(root, created.id)), before)
})

// ------------------------------------------------ #247 attachment overwrite

/**
 * The attachment-overwrite guard is certified as `attach_overwrite_unseen`
 * (#247 × #245). Its refusal sites all run before ANY graph mutation — the
 * unlocked pre-checks before F88 (whose refusal path appends a correction to
 * node.md), and the authoritative re-checks as the first statement of the
 * section that otherwise writes (`updateNode` / `attach` / `attachFromPath`).
 * Every assertion below is against DISK BYTES, not the message: a certified
 * refusal must leave node.md, its body snapshot and the attachment byte-
 * identical. The wrapper can use the audited pre-mutation refusal to avoid
 * fencing a delegation when nothing was changed.
 */
test('attach_overwrite_unseen: an unread overwrite on the memory_write route is certified and writes nothing', async () => {
  const { root, tools, write, read } = await harness()
  const readFile = tools.get('memory_read_file')
  const creator = execFor('overwrite-creator')
  const exec = execFor('overwrite-writer')
  const name = 'report.md'
  const original = `${'format row\n'.repeat(100)}`.padEnd(1696, '.')
  const created = await write.execute(
    { description: '周报格式', body: `格式见 ${name}。`, attach: { filename: name, content: original } },
    creator,
  )
  // A prior body version, so a `.node.md.prev` exists and must survive too.
  await read.execute({ id: created.id }, creator)
  await write.execute({ id: created.id, body: `格式见 ${name}（已核对）。` }, creator)
  const nodeFile = nodePath(root, created.id)
  const attachment = path.join(root, created.id, name)
  const prev = path.join(root, created.id, PREV_NODE_FILE)
  const before = { node: await bytes(nodeFile), prev: await bytes(prev), file: await bytes(attachment) }

  // A LATER Session reads the NODE — which lists the file — and never opens it.
  await read.execute({ id: created.id }, exec)
  const refused = await refusal(write, { id: created.id, attach: { filename: name, content: '11 bytes!!!' } }, exec)
  assert.equal(refused.code, 'attach_overwrite_unseen')
  assert.match(
    refused.error.message,
    new RegExp(`^memory_write: ${name} on ${created.id} holds 1696 bytes you have not fully read this session \\(or it changed since you read it\\) — attaching that name REPLACES the file\\. Nothing was written\\.`),
  )
  assert.match(refused.error.message, /memory_read_file every page/)
  assert.deepEqual(await bytes(nodeFile), before.node, 'no body landed')
  assert.deepEqual(await bytes(prev), before.prev, 'the body snapshot was not burned')
  assert.deepEqual(await bytes(attachment), before.file, 'the attachment is byte-identical')

  // Reading every page authorizes the replacement, and `.prev` keeps the prior
  // bytes because this Session did not author what it replaced.
  const page = await readFile.execute({ id: created.id, file: name }, exec)
  assert.equal(page.bytes, 1696)
  assert.ok(!('next_offset' in page), 'a 1,696-byte file is one page')
  const landed = await write.execute({ id: created.id, attach: { filename: name, content: 'short\n' } }, exec)
  assert.equal(landed.attached.status, 'overwritten')
  assert.equal(await fsp.readFile(attachment, 'utf8'), 'short\n')
  // The refused call burned neither snapshot; the successful overwrite keeps
  // the replaced attachment one deep, beside the body's own snapshot.
  assert.deepEqual(await bytes(prev), before.prev)
  assert.equal(await fsp.readFile(path.join(root, created.id, prevAttachmentFile(name)), 'utf8'), original)
})

test('attach_overwrite_unseen: the standalone content route is certified, and every page must be read', async () => {
  const { root, tools, write, read, attach } = await harness()
  const readFile = tools.get('memory_read_file')
  const author = execFor('standalone-author')
  const exec = execFor('standalone-writer')
  const name = 'transcript.md'
  const big = 'x'.repeat(ATTACH_READ_BYTES + 10_000)
  const created = await write.execute(
    { description: '长转录', body: `全文见 ${name}。`, attach: { filename: name, content: big } },
    author,
  )
  await read.execute({ id: created.id }, exec)
  const attachment = path.join(root, created.id, name)
  const before = await bytes(attachment)

  const firstPage = await readFile.execute({ id: created.id, file: name }, exec)
  assert.equal(firstPage.bytes, ATTACH_READ_BYTES)
  assert.equal(firstPage.next_offset, ATTACH_READ_BYTES)
  const trimmed = 'x'.repeat(big.length - 1)
  const partial = await refusal(attach, { id: created.id, filename: name, content: trimmed }, exec)
  assert.equal(partial.code, 'attach_overwrite_unseen')
  assert.match(
    partial.error.message,
    new RegExp(`^memory_attach: ${name} on ${created.id} holds ${big.length} bytes you have not fully read this session`),
  )
  assert.deepEqual(await bytes(attachment), before, 'the partial read changed nothing')

  await readFile.execute({ id: created.id, file: name, offset: firstPage.next_offset }, exec)
  const landed = await attach.execute({ id: created.id, filename: name, content: trimmed }, exec)
  assert.equal(landed.status, 'overwritten', 'every page read in order covers the file')
  assert.equal(await fsp.readFile(attachment, 'utf8'), trimmed)
})

test('attach_overwrite_unseen: the from_path authorize hook is certified on the published bytes', async () => {
  // #247 review finding 2: there is no separate read of the loose source any
  // more, so this refusal is thrown from INSIDE graph.js's `authorize` callback
  // (before the snapshot and the staged copy). The proof must survive that
  // frame: `refusal()` consumes against the very object `execute` threw, so a
  // rethrow/wrap anywhere between here and graph.js would fail this test.
  const loose = await freshRoot()
  const { root, tools, write, read, attach } = await harness({ attachFromPathRoots: [loose] })
  const readFile = tools.get('memory_read_file')
  const author = execFor('frompath-author')
  const exec = execFor('frompath-writer')
  const name = 'notes.md'
  const created = await write.execute(
    { description: '笔记', body: `见 ${name}。`, attach: { filename: name, content: 'the original\n' } },
    author,
  )
  // A prior body version, so a `.node.md.prev` exists and must survive too.
  await read.execute({ id: created.id }, author)
  await write.execute({ id: created.id, body: `见 ${name}（已核对）。` }, author)
  await read.execute({ id: created.id }, exec)
  const nodeFile = nodePath(root, created.id)
  const attachment = path.join(root, created.id, name)
  const before = { node: await bytes(nodeFile), file: await bytes(attachment) }
  const source = path.join(loose, name)
  await fsp.writeFile(source, 'tiny\n')

  const refused = await refusal(attach, { id: created.id, from_path: source }, exec)
  assert.equal(refused.code, 'attach_overwrite_unseen')
  assert.match(
    refused.error.message,
    new RegExp(`^memory_attach: ${name} on ${created.id} holds 13 bytes you have not fully read this session`),
  )
  assert.deepEqual(await bytes(nodeFile), before.node, 'no body landed')
  assert.deepEqual(await bytes(attachment), before.file, 'the attachment is byte-identical')
  await assert.rejects(() => fsp.lstat(path.join(root, created.id, '.notes.md.prev')), 'a refused overwrite takes no snapshot')
  assert.equal(await fsp.readFile(source, 'utf8'), 'tiny\n', 'the source is untouched')

  // Opening the ATTACHMENT (not the source) is what authorizes the copy.
  await readFile.execute({ id: created.id, file: name }, exec)
  const landed = await attach.execute({ id: created.id, from_path: source }, exec)
  assert.equal(landed.status, 'overwritten')
  assert.equal(await fsp.readFile(attachment, 'utf8'), 'tiny\n')
  assert.equal(await fsp.readFile(path.join(root, created.id, '.notes.md.prev'), 'utf8'), 'the original\n', '.prev holds the pre-session bytes')
})

test('attach_overwrite_unseen: a replay, a foreign definition and forged text earn nothing', async () => {
  const { root, write, read, attach } = await harness()
  const author = execFor('provenance-author')
  const exec = execFor('provenance-writer')
  const created = await write.execute(
    { description: 'provenance', body: '见 a.md。', attach: { filename: 'a.md', content: 'original\n' } },
    author,
  )
  await read.execute({ id: created.id }, exec)

  const refused = await refusal(write, { id: created.id, attach: { filename: 'a.md', content: 'other\n' } }, exec)
  assert.equal(refused.code, 'attach_overwrite_unseen')
  // `refusal()` consumed the proof; a replay earns nothing.
  assert.equal(consumeAuditedRefusal(write, exec, refused.error), undefined, 'consumed once')
  // A different DEFINITION cannot consume this invocation's proof.
  assert.equal(consumeAuditedRefusal(attach, exec, refused.error), undefined)
  // Nor can a different exec object.
  assert.equal(consumeAuditedRefusal(write, execFor('someone-else'), refused.error), undefined)
  // The same text on a hand-built Error is not provenance.
  assert.equal(consumeAuditedRefusal(write, exec, new Error(refused.error.message)), undefined)
})

test('attach_overwrite_unseen: an Error object can witness only one invocation (brand-once)', async () => {
  const exec = { agent: { id: 'attach-brand-once' } }
  const shared = new Error('shared attach refusal')
  let calls = 0
  const definition = defineTool({
    name: 'attach-probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['attach_overwrite_unseen'],
    async execute(_args, _exec, refuse) {
      calls += 1
      // The SECOND serial call reuses the first call's Error object.
      throw refuse('attach_overwrite_unseen', shared)
    },
  })
  const first = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(consumeAuditedRefusal(definition, exec, first), 'attach_overwrite_unseen')
  const second = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(second, shared)
  assert.equal(consumeAuditedRefusal(definition, exec, second), undefined, 'one Error witnesses one invocation')
})

test('a handler that mutates and then throws refusal-shaped metadata earns no proof', async () => {
  const root = await freshRoot()
  const marker = path.join(root, 'mutated.txt')
  const definition = defineTool({
    name: 'memory_write',
    description: 'forged probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute() {
      await fsp.writeFile(marker, 'mutated', 'utf8')
      const forged = new Error('memory_write: 01ABCDEFGHJKMNPQRSTVWXYZ01 has not been read this session')
      forged.code = 'update_unread'
      forged.auditedRefusal = 'update_unread'
      forged.executionStarted = true
      throw forged
    },
  })
  const exec = {}
  const thrown = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(consumeAuditedRefusal(definition, exec, thrown), undefined)
  assert.equal(await fsp.readFile(marker, 'utf8'), 'mutated')
})

test('a lock-release failure after a branded refusal revokes the proof', async () => {
  const { root, write, read } = await harness()
  const exec = execFor('release-failure')
  const created = await write.execute({ description: 'release target', body: 'body', links: [] }, exec)
  await read.execute({ id: created.id }, exec)
  await fsp.rm(path.join(root, created.id), { recursive: true, force: true })

  const fsPromises = (await import('node:fs/promises')).default
  const original = fsPromises.rmdir
  fsPromises.rmdir = async () => {
    throw Object.assign(new Error('lock release failed'), { code: 'EACCES' })
  }
  try {
    const thrown = await write.execute({ id: created.id, body: 'next body' }, exec).then(
      () => undefined,
      (error) => error,
    )
    // withNodeLocks' finally replaces the branded ENOENT with the release
    // error, so the refusal never reaches the caller and nothing is proven.
    assert.equal(thrown.message, 'lock release failed')
    assert.equal(consumeAuditedRefusal(write, exec, thrown), undefined)
  } finally {
    fsPromises.rmdir = original
  }
})

test('tool.js: a later rejected call on the same exec invalidates an older settled, unconsumed proof', async () => {
  const exec = { agent: { id: 'same-session' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      throw refuse('update_unread', new Error('first refusal'))
    },
  })

  const first = await definition.execute({ value: 'ok' }, exec).then(() => undefined, (error) => error)
  assert.equal(first.message, 'first refusal')
  // Deliberately NOT consumed yet.
  // A later call reuses the SAME exec and is rejected by preparation, so its
  // handler never runs. The fresh invocation must already have replaced the
  // old slot, or the older proof would remain reachable through this call.
  await assert.rejects(definition.execute({}, exec), (error) => error instanceof ToolArgsError)
  assert.equal(consumeAuditedRefusal(definition, exec, first), undefined)
})

test('tool.js: a non-object exec gets no helper and no proof (errors unchanged)', async () => {
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      // Mirrors the production pattern: without a helper the error is simply
      // thrown, so class/message are unchanged for direct callers.
      const error = new Error('primitive refusal')
      throw refuse === undefined ? error : refuse('update_unread', error)
    },
  })

  for (const exec of [undefined, null, 0, 7, 'session']) {
    const thrown = await definition.execute({}, exec).then(() => undefined, (error) => error)
    assert.equal(thrown.message, 'primitive refusal')
    assert.equal(consumeAuditedRefusal(definition, exec, thrown), undefined)
  }
})

test('tool.js: overlapping same-exec invocations poison the epoch — neither proof is usable', async () => {
  let markAEntered
  const aEntered = new Promise((resolve) => { markAEntered = resolve })
  let releaseA
  const aGate = new Promise((resolve) => { releaseA = resolve })
  let calls = 0
  let sharedError
  const exec = { agent: { id: 'overlap' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) {
        // A waits for B to finish, then throws B's Error WITHOUT branding it.
        markAEntered()
        await aGate
        throw sharedError
      }
      sharedError = refuse('update_unread', new Error('shared refusal'))
      throw sharedError
    },
  })

  const aPromise = definition.execute({}, exec).then(() => undefined, (error) => error)
  await aEntered
  const bThrown = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(bThrown, sharedError)
  releaseA()
  const aThrown = await aPromise
  assert.equal(aThrown, sharedError)
  // Both calls overlapped, so the epoch is poisoned: no proof for either one.
  assert.equal(consumeAuditedRefusal(definition, exec, bThrown), undefined)
  assert.equal(consumeAuditedRefusal(definition, exec, aThrown), undefined)
})

test('tool.js: three overlapping calls poison the epoch — not even the earliest or latest is trusted', async () => {
  let entered = 0
  let markAllEntered
  const allEntered = new Promise((resolve) => { markAllEntered = resolve })
  const gates = []
  let calls = 0
  let sharedError
  const exec = { agent: { id: 'overlap-three' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      const call = calls
      if (call <= 2) {
        const gate = new Promise((resolve) => gates.push(resolve))
        entered += 1
        if (entered === 2) markAllEntered()
        await gate
        throw sharedError
      }
      sharedError = refuse('update_unread', new Error('three-way refusal'))
      throw sharedError
    },
  })

  const first = definition.execute({}, exec).then(() => undefined, (error) => error)
  const second = definition.execute({}, exec).then(() => undefined, (error) => error)
  await allEntered
  const third = await definition.execute({}, exec).then(() => undefined, (error) => error)
  for (const release of gates) release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, sharedError)
  assert.equal(b, sharedError)
  assert.equal(consumeAuditedRefusal(definition, exec, third), undefined)
  assert.equal(consumeAuditedRefusal(definition, exec, a), undefined)
})

test('tool.js: a fresh serial call after a poisoned epoch recovers proof exactly once', async () => {
  let calls = 0
  let markWaiting
  const waiting = new Promise((resolve) => { markWaiting = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const exec = { agent: { id: 'recover' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) {
        markWaiting()
        await gate
        throw new Error('overlap tail')
      }
      throw refuse('update_unread', new Error('fresh serial refusal'))
    },
  })

  const overlap = definition.execute({}, exec).then(() => undefined, (error) => error)
  await waiting
  // A second concurrent call starts before the first ends: poisoned epoch.
  const concurrent = definition.execute({}, exec).then(() => undefined, (error) => error)
  release()
  await Promise.all([overlap, concurrent])

  // The next call starts serially (active === 0), beginning a clean epoch.
  const fresh = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(fresh.message, 'fresh serial refusal')
  assert.equal(consumeAuditedRefusal(definition, exec, fresh), 'update_unread')
  assert.equal(consumeAuditedRefusal(definition, exec, fresh), undefined, 'still consumed once')
})

test('tool.js: a delayed consumer after a newer serial begin fails closed', async () => {
  let firstError
  let calls = 0
  let markSecondEntered
  const secondEntered = new Promise((resolve) => { markSecondEntered = resolve })
  let releaseSecond
  const secondGate = new Promise((resolve) => { releaseSecond = resolve })
  const exec = { agent: { id: 'delayed-consume' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) {
        firstError = refuse('update_unread', new Error('first serial'))
        throw firstError
      }
      markSecondEntered()
      await secondGate
      throw new Error('second serial')
    },
  })

  const first = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(first, firstError)
  // A newer serial call begins and is still in flight when the old proof is
  // offered for consumption.
  const secondPromise = definition.execute({}, exec).then(() => undefined, (error) => error)
  await secondEntered
  assert.equal(consumeAuditedRefusal(definition, exec, first), undefined)
  releaseSecond()
  await secondPromise
  // Returning to zero does not revive the old epoch/current record.
  assert.equal(consumeAuditedRefusal(definition, exec, first), undefined)
})

test('static: the audited-site allowlist is exactly the agreed codes, at the agreed sites', async () => {
  // A REVIEW AID, not a runtime purity detector: it pins the producer call
  // sites so an added or duplicated helper call is visible in review. The
  // trust boundary remains the source audit of those branches.
  const indexSource = await fsp.readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const produced = [...indexSource.matchAll(/\b(?:auditedRefusal|brandRefusal)\('([^']+)'/g)].map((match) => match[1])
  // Two codes are shared by BOTH write routes or by both spellings of one gate:
  //   - `attach_overwrite_unseen` (#247): `memory_write` and `memory_attach`
  //     each guard their own routes, so one brand literal per tool.
  //   - `supersede_unread` / `supersede_stale` (#253): one supersede invariant,
  //     two pre-checks — the `supersedes:` argument before createNode and the
  //     typed-link target before the same call writes.
  // `supersede_target_missing` exists only on the create path.
  // `link_target_missing` exists once: the shared link pre-check, before
  // `createNode`/`updateNode`, on both routes.
  assert.deepEqual(produced.slice().sort(), [
    'attach_overwrite_unseen',
    'attach_overwrite_unseen',
    'link_target_missing',
    'supersede_stale',
    'supersede_stale',
    'supersede_target_missing',
    'supersede_unread',
    'supersede_unread',
    'update_contradicted_figure',
    'update_stale',
    'update_target_missing',
    'update_unread',
  ])
  assert.deepEqual(
    [...new Set(produced)].sort(),
    [
      'attach_overwrite_unseen',
      'link_target_missing',
      'supersede_stale',
      'supersede_target_missing',
      'supersede_unread',
      'update_contradicted_figure',
      'update_stale',
      'update_target_missing',
      'update_unread',
    ],
    'exactly nine codes, no others',
  )
  assert.equal(produced.length, 12, '12 brand literals: no duplicates beyond the shared sites above')

  // Each tool's DECLARED list matches the codes it may mint, so a code can
  // never be produced by a tool that cannot certify it (or vice versa).
  const declared = [...indexSource.matchAll(/auditedRefusals: \[([^\]]*)\]/g)].map((match) => [...match[1].matchAll(/'([^']+)'/g)].map((code) => code[1]))
  assert.deepEqual(declared, [
    [
      'update_unread',
      'update_stale',
      'update_contradicted_figure',
      'update_target_missing',
      'attach_overwrite_unseen',
      'supersede_unread',
      'supersede_stale',
      'supersede_target_missing',
      'link_target_missing',
    ],
    ['attach_overwrite_unseen'],
  ])

  // The LOCKED supersede re-checks must stay UNBRANDED (#253): they run after
  // `createNode`/`updateNode`, so a throw there is a rolled-back write, not a
  // provable no-op. Each message therefore appears once per pre-check site
  // (branded) and once per locked site (a plain `new Error(`), and the plain
  // throws are exactly the two locked re-checks.
  const count = (pattern) => [...indexSource.matchAll(pattern)].length
  const unreadSupersede = /has not been read this session — memory_read it before superseding it/g
  const staleSupersede = /changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying/g
  assert.equal(count(unreadSupersede), 3, 'two branded pre-checks + one locked re-check')
  // Four supersede sites (two branded pre-checks, two locked re-checks) plus
  // the id-update Stale Write, which carries the same phrase with the #145 hub
  // hint appended.
  assert.equal(count(staleSupersede), 5, 'two branded pre-checks + two locked re-checks + the update-path stale message')
  assert.equal(
    count(/new Error\(`memory_write: \$\{[^}]+\} has not been read this session — memory_read it before superseding it`\)/g),
    1,
    'the typed-link locked re-check stays unbranded',
  )
  assert.equal(
    count(/new Error\(`memory_write: \$\{[^}]+\} changed since it was read — a Stale Write; memory_read it again to re-read and reconcile before retrying`\)/g),
    2,
    'both locked stale re-checks stay unbranded',
  )

  // Every GUARD call site must pass the scoped brand. This is the assertion the
  // brand-literal count above cannot make: a new site (the from_path
  // `authorize` hook is one) that forgot the sixth argument would still throw
  // the right message, write nothing, and be permanently uncertifiable — a
  // silent loss of coverage rather than a failure. The declaration itself does
  // not match (its name is followed by `= async (`), so every match is a call.
  // Five sites today: memory_write's pre-check and under-lock re-check;
  // memory_attach's content pre-check and content re-check; and the from_path
  // `authorize` hook. Each ends `exec, refuseUnseenOverwrite)`.
  const guardCalls = [...indexSource.matchAll(/refuseUnseenAttachmentOverwrite\((.*)$/gm)].map((match) => match[1])
  assert.equal(guardCalls.length, 5, 'five guard call sites')
  for (const rest of guardCalls) {
    assert.match(rest, /, exec, refuseUnseenOverwrite\)/, `unbranded guard call site: ${rest}`)
  }

  // No other plugin module may mint an audited refusal.
  const libDir = new URL('../lib/', import.meta.url)
  for (const file of await fsp.readdir(libDir)) {
    if (!file.endsWith('.js') || file === 'index.js') continue
    const text = await fsp.readFile(new URL(file, libDir), 'utf8')
    assert.doesNotMatch(text, /\b(?:auditedRefusal|brandRefusal)\(/, `${file} must not mint audited refusals`)
  }
})

test('tool.js: a serial call cannot brand an Error an earlier call already threw', async () => {
  const exec = { agent: { id: 'shared-serial' } }
  const shared = new Error('shared serial error')
  let calls = 0
  let effects = 0
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) {
        // A does an ordinary effect and throws the Error UNBRANDED.
        effects += 1
        throw shared
      }
      // B is serial and legitimate, but reuses A's Error object.
      throw refuse('update_unread', shared)
    },
  })

  const aError = await definition.execute({}, exec).then(() => undefined, (error) => error)
  const bError = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(aError, shared)
  assert.equal(bError, shared)
  assert.equal(effects, 1, 'A performed its ordinary effect')
  // Neither consumer gets a proof: A had none, and B was denied a brand.
  assert.equal(consumeAuditedRefusal(definition, exec, aError), undefined)
  assert.equal(consumeAuditedRefusal(definition, exec, bError), undefined)
})

test('tool.js: a fresh Error in the newer serial call is still certified exactly once (control)', async () => {
  const exec = { agent: { id: 'fresh-error' } }
  let calls = 0
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) throw new Error('ordinary first')
      throw refuse('update_unread', new Error('legitimate refusal'))
    },
  })
  await definition.execute({}, exec).then(() => undefined, () => undefined)
  const bError = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(bError.message, 'legitimate refusal')
  assert.equal(consumeAuditedRefusal(definition, exec, bError), 'update_unread')
  assert.equal(consumeAuditedRefusal(definition, exec, bError), undefined)
})

test('tool.js: an Error is never brandable again after consumption, a swallowed brand, or a wrap', async () => {
  const exec = { agent: { id: 'brand-once' } }
  let mode = 'consume'
  let branded
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      if (mode === 'consume') {
        branded = new Error('consumed brand')
        throw refuse('update_unread', branded)
      }
      if (mode === 'swallow') {
        branded = new Error('swallowed brand')
        refuse('update_unread', branded)
        return { swallowed: true }
      }
      if (mode === 'wrap') {
        branded = new Error('wrapped inner')
        const inner = refuse('update_unread', branded)
        throw new Error('wrapped outer', { cause: inner })
      }
      // Later invocations try to brand the SAME already-seen Error.
      throw refuse('update_unread', branded)
    },
  })

  // Consumed once, then unusable.
  const consumed = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(consumeAuditedRefusal(definition, exec, consumed), 'update_unread')
  mode = 'retry'
  const retry = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(retry, branded)
  assert.equal(consumeAuditedRefusal(definition, exec, retry), undefined)

  // A brand the handler swallowed (returned normally) never settles, and the
  // Error is still burned for every later invocation.
  mode = 'swallow'
  const swallowedResult = await definition.execute({}, exec)
  assert.deepEqual(swallowedResult, { swallowed: true })
  const swallowedError = branded
  mode = 'retry'
  const afterSwallow = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(consumeAuditedRefusal(definition, exec, swallowedError), undefined)
  assert.equal(consumeAuditedRefusal(definition, exec, afterSwallow), undefined)

  // A branded Error then wrapped by the handler: the wrap clears the record,
  // and the inner Error can never be branded again.
  mode = 'wrap'
  const wrapped = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(wrapped.message, 'wrapped outer')
  const wrappedInner = branded
  assert.equal(consumeAuditedRefusal(definition, exec, wrapped), undefined)
  mode = 'retry'
  const afterWrap = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(afterWrap, wrappedInner)
  assert.equal(consumeAuditedRefusal(definition, exec, wrappedInner), undefined)
})

test('tool.js: a seen Error cannot be re-branded through a different exec or definition', async () => {
  const shared = new Error('cross-boundary shared')
  const make = () =>
    defineTool({
      name: 'probe',
      description: 'probe',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object' }, render: () => '' },
      auditedRefusals: ['update_unread'],
      async execute(_args, _exec, refuse) {
        throw refuse('update_unread', shared)
      },
    })
  const first = make()
  const second = make()
  const execA = { agent: { id: 'cross-a' } }
  const execB = { agent: { id: 'cross-b' } }

  const brandedError = await first.execute({}, execA).then(() => undefined, (error) => error)
  assert.equal(brandedError, shared)
  // Same definition, different exec.
  const otherExec = await first.execute({}, execB).then(() => undefined, (error) => error)
  // Different definition, same exec.
  const otherDefinition = await second.execute({}, execA).then(() => undefined, (error) => error)
  assert.equal(otherExec, shared)
  assert.equal(otherDefinition, shared)
  assert.equal(consumeAuditedRefusal(first, execB, otherExec), undefined)
  assert.equal(consumeAuditedRefusal(second, execA, otherDefinition), undefined)
})

test('tool.js: a refuse attempt while poisoned still burns the Error for a later serial attempt', async () => {
  let markA
  const aEntered = new Promise((resolve) => { markA = resolve })
  let releaseA
  const aGate = new Promise((resolve) => { releaseA = resolve })
  let calls = 0
  let sharedError
  let serialError
  const exec = { agent: { id: 'poison-burn' } }
  const definition = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      calls += 1
      if (calls === 1) {
        markA()
        await aGate
        throw new Error('A ordinary tail')
      }
      if (calls === 2) {
        // Overlap: the helper must deny AND still record the object.
        sharedError = new Error('poisoned attempt')
        throw refuse('update_unread', sharedError)
      }
      // A later SERIAL attempt reuses the same Error.
      serialError = sharedError
      throw refuse('update_unread', serialError)
    },
  })

  const aPromise = definition.execute({}, exec).then(() => undefined, (error) => error)
  await aEntered
  const poisoned = await definition.execute({}, exec).then(() => undefined, (error) => error)
  releaseA()
  await aPromise
  assert.equal(poisoned, sharedError)

  const serial = await definition.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(serial, serialError)
  assert.equal(consumeAuditedRefusal(definition, exec, serial), undefined)
})

test('tool.js: two missing-target refusals each get a fresh fs Error and are both certified', async () => {
  const { root, write, read } = await harness()
  const creator = execFor('fresh-enoent-creator')
  const exec = execFor('fresh-enoent')
  const first = await write.execute({ description: 'first vanished', body: 'a', links: [] }, creator)
  const second = await write.execute({ description: 'second vanished', body: 'b', links: [] }, creator)
  await read.execute({ id: first.id }, exec)
  await read.execute({ id: second.id }, exec)
  await fsp.rm(path.join(root, first.id), { recursive: true, force: true })
  await fsp.rm(path.join(root, second.id), { recursive: true, force: true })

  const one = await refusal(write, { id: first.id, body: 'next' }, exec)
  const two = await refusal(write, { id: second.id, body: 'next' }, exec)
  assert.equal(one.code, 'update_target_missing')
  assert.equal(two.code, 'update_target_missing')
  assert.notEqual(one.error, two.error, 'each ENOENT is its own Error object')
  assert.equal(one.error.constructor, Error)
  assert.equal(two.error.constructor, Error)
  assert.equal(one.error.code, 'ENOENT')
  assert.equal(two.error.code, 'ENOENT')
})

test('tool.js: a tool with no audited codes, or a non-object exec, still burns the Error module-wide', async () => {
  const shared = new Error('shared through a plain tool')
  let attemptedError = shared
  // A registered tool that declares NO audited codes still records its throws.
  const plain = defineTool({
    name: 'plain',
    description: 'plain',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    async execute() {
      throw shared
    },
  })
  const coded = defineTool({
    name: 'coded',
    description: 'coded',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute(_args, _exec, refuse) {
      throw refuse('update_unread', attemptedError)
    },
  })

  // Even a primitive exec records the throw (no helper, but the catch runs).
  const plainError = await plain.execute({}, undefined).then(() => undefined, (error) => error)
  assert.equal(plainError, shared)
  const exec = { agent: { id: 'after-plain' } }
  const codedError = await coded.execute({}, exec).then(() => undefined, (error) => error)
  assert.equal(codedError, shared)
  assert.equal(consumeAuditedRefusal(coded, exec, codedError), undefined)

  // Same for an Error thrown by a declined non-object exec on a CODED tool.
  const primitiveShared = new Error('thrown with a primitive exec')
  const primitiveTool = defineTool({
    name: 'primitive-throw',
    description: 'primitive throw',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object' }, render: () => '' },
    auditedRefusals: ['update_unread'],
    async execute() {
      throw primitiveShared
    },
  })
  await primitiveTool.execute({}, 11).then(() => undefined, () => undefined)
  attemptedError = primitiveShared
  const laterExec = { agent: { id: 'after-primitive' } }
  const later = await coded.execute({}, laterExec).then(() => undefined, (error) => error)
  // Attempt to brand the exact Error burned by the primitive-exec call.
  assert.equal(later, primitiveShared)
  assert.equal(consumeAuditedRefusal(coded, laterExec, later), undefined)
})

// ---------------------------------------------- #255 never-authorizable targets

/**
 * The guard's other three states (#252 item 1): a symlink/FIFO, a file over the
 * attachment cap, and a file that shrank mid-read. No amount of
 * `memory_read_file` can ever authorize replacing any of them, so pointing the
 * writer at "read every page" was a loop with no exit. Each now gets its own
 * message and says what actually works — while staying the SAME certified code,
 * because every site still runs before any mutation.
 */
test('attach_overwrite_unseen: a non-regular target gets its own message and stays certified', async () => {
  const { root, write, read, attach } = await harness()
  const author = execFor('nonregular-author')
  const exec = execFor('nonregular-writer')
  const created = await write.execute(
    { description: 'holds a symlink', body: '见 report.md。', attach: { filename: 'report.md', content: 'the original\n' } },
    author,
  )
  await read.execute({ id: created.id }, exec)
  const link = path.join(root, created.id, 'link.md')
  await fsp.symlink(path.join(root, created.id, 'report.md'), link)

  const refused = await refusal(attach, { id: created.id, filename: 'link.md', content: 'via the link\n' }, exec)
  assert.equal(refused.code, 'attach_overwrite_unseen', 'still the certified code')
  assert.match(refused.error.message, new RegExp(`^memory_attach: link\\.md on ${created.id} is not a regular file, so its prior content cannot be kept`))
  assert.match(refused.error.message, /store the replacement under a new filename/)
  assert.doesNotMatch(refused.error.message, /memory_read_file every page/, 'reading can never authorize it')
  assert.equal((await fsp.lstat(link)).isSymbolicLink(), true, 'the link was not replaced')
  assert.equal(await fsp.readFile(path.join(root, created.id, 'report.md'), 'utf8'), 'the original\n')
})

test('attach_overwrite_unseen: an over-cap target says so, and points at a new filename', async () => {
  const { root, write, read, attach } = await harness()
  const author = execFor('overcap-author')
  const exec = execFor('overcap-writer')
  const created = await write.execute({ description: 'holds a huge file', body: 'gist' }, author)
  const name = 'huge.md'
  // Out of band: every write path caps, so this shape is only reachable by an
  // outside writer (or a lowered cap).
  await fsp.writeFile(path.join(root, created.id, name), 'x'.repeat(ATTACH_MAX_BYTES + 1))
  await read.execute({ id: created.id }, exec)

  const refused = await refusal(attach, { id: created.id, filename: name, content: 'small\n' }, exec)
  assert.equal(refused.code, 'attach_overwrite_unseen')
  assert.match(refused.error.message, new RegExp(`is ${ATTACH_MAX_BYTES + 1} bytes, over the ${ATTACH_MAX_BYTES}-byte attachment cap`))
  assert.match(refused.error.message, /store the replacement under a new filename/)
  assert.doesNotMatch(refused.error.message, /memory_read_file every page/)
  assert.equal((await fsp.stat(path.join(root, created.id, name))).size, ATTACH_MAX_BYTES + 1, 'the file was not replaced')
})

test('attach_overwrite_unseen: a target that shrank mid-read is refused with a re-read message', async () => {
  const { root, write, read, attach } = await harness()
  const author = execFor('shortread-author')
  const exec = execFor('shortread-writer')
  const created = await write.execute(
    { description: 'holds a shifting file', body: '见 report.md。', attach: { filename: 'report.md', content: 'a full report with several lines\n' } },
    author,
  )
  await read.execute({ id: created.id }, exec)
  const file = path.join(root, created.id, 'report.md')

  const realOpen = fsp.open
  fsp.open = async (target, ...rest) => {
    const handle = await realOpen.call(fsp, target, ...rest)
    if (target !== file) return handle
    return {
      stat: (...args) => handle.stat(...args),
      close: (...args) => handle.close(...args),
      read: async (...args) => {
        await fsp.truncate(file, 5)
        return handle.read(...args)
      },
    }
  }
  try {
    const refused = await refusal(attach, { id: created.id, filename: 'report.md', content: 'mine\n' }, exec)
    assert.equal(refused.code, 'attach_overwrite_unseen')
    assert.match(refused.error.message, /changed while it was being read \(5 of 33 bytes\)/)
    assert.match(refused.error.message, /memory_read_file it again and pass the full revised text/)
    assert.match(refused.error.message, /store the replacement under a new filename/)
    assert.notEqual(await fsp.readFile(file, 'utf8'), 'mine\n', 'nothing was replaced')
  } finally {
    fsp.open = realOpen
  }
})
