/**
 * 2a placeholder-fill guards (`placeholderGuards`, 2026-11-05).
 *
 * A synthetic regression case stores a node with no body, an attachment
 * `x` holding `x`, and `supersedes` naming the same id it also passed in
 * `links`. With the guards on, each of those is refused by the TRUSTED
 * PREPARATION: `execute` is never entered, the error is a ToolArgsError, no
 * audited code is minted, and the graph is untouched. With the guards off (the
 * default), only the placeholder rules are disabled; relationship conflicts
 * are always refused.
 *
 * Disposable graph roots only.
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { ToolArgsError, consumeAuditedRefusal, trustedPreparationFor } from '../lib/tool.js'

const roots = []
after(async () => {
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true })
})

async function harness(config = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-2a-'))
  roots.push(root)
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    inject(_names, callback) {
      callback({ systemPrompt: { section: () => () => {}, variable: () => () => {} } })
      return () => {}
    },
  }
  apply(ctx, { graphRoot: root, indexCacheMs: 0, ...config })
  return { root, write: tools.get('memory_write'), attach: tools.get('memory_attach'), read: tools.get('memory_read') }
}

const execFor = (id) => ({ agent: { id } })
const DETAIL = 'A detail-tier payload long enough to be a real attachment, well over sixty-four bytes.'

/** Snapshot every node dir and file so a refusal can be shown to write nothing. */
async function treeOf(root) {
  const out = {}
  for (const id of (await fsp.readdir(root)).filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)).sort()) {
    const dir = path.join(root, id)
    for (const name of (await fsp.readdir(dir)).sort()) {
      if (name === '__edges__') continue
      out[`${id}/${name}`] = await fsp.readFile(path.join(dir, name), 'utf8')
    }
  }
  return out
}

async function refusedBeforeExecution(definition, args, exec, pattern, label) {
  const prepared = trustedPreparationFor(definition)(args)
  assert.ok(prepared.violations.some((violation) => pattern.test(violation)), `${label}: no violation matching ${pattern}: ${prepared.violations.join(' | ')}`)
  assert.ok(prepared.violations.some((violation) => /Nothing was written/.test(violation)), `${label}: the remedy says nothing was written`)
  const error = await definition.execute(args, exec).then(() => undefined, (thrown) => thrown)
  assert.ok(error instanceof ToolArgsError, `${label}: refused by the preparation, not the handler`)
  assert.equal(consumeAuditedRefusal(definition, exec, error), undefined, `${label}: mints no audited code`)
}

test('2a: guards are off by default — the placeholder fills are still admitted', async () => {
  const { write } = await harness()
  const exec = execFor('default')
  const target = await write.execute({ description: 'rollout decision', body: 'ship one plugin first' }, exec)
  // The synthetic case carries four placeholder fills. Two of them — the
  // supersede/link contradiction — are now refused ALWAYS: that
  // contradiction half-fulfils the write and latches the manage fence, which is
  // a correctness rule rather than a placeholder heuristic. The other two (the
  // `x`/`x` attachment) stay admitted with the guards off.
  const incident = { description: 'playground uses dsv4.1 flash', type: 'identity', links: [target.id], attach: { filename: 'x', content: 'x' }, supersedes: target.id }
  const violations = trustedPreparationFor(write)(incident).violations
  assert.ok(violations.some((violation) => /`supersedes` and `links` both name/.test(violation)), 'the contradiction is always refused')
  assert.ok(!violations.some((violation) => /`attach\.content`|`attach\.filename`/.test(violation)), 'the placeholder attachment rules stay opt-in')
  assert.deepEqual(trustedPreparationFor(write)({ description: 'no body yet' }).violations, [], 'the body rule stays opt-in')
})

test('2a: placeholderGuards must be a boolean', async () => {
  await assert.rejects(harness({ placeholderGuards: 'yes' }), /`placeholderGuards` must be a boolean/)
  // null is malformed, not "off" — the wrapper and the service config refuse it too.
  await assert.rejects(harness({ placeholderGuards: null }), /`placeholderGuards` must be a boolean, got null/)
})

test('2a: each placeholder fill is refused before execution and writes nothing', async () => {
  const { root, write, attach, read } = await harness({ placeholderGuards: true })
  const exec = execFor('guards')
  const target = await write.execute({ description: 'rollout decision', body: 'ship one plugin first' }, exec)
  await read.execute({ id: target.id }, exec)
  const before = await treeOf(root)

  for (const [label, args, pattern] of [
    ['no body', { description: 'a fact with no body' }, /a new node needs a `body`/],
    ['blank body', { description: 'a fact with a blank body', body: '  \n ' }, /a new node needs a `body`/],
    // Literal escapes that normalizeBody turns into whitespace (review of #287).
    ['escaped newline body', { description: 'a fact with an escaped blank body', body: '\\n' }, /a new node needs a `body`/],
    ['escaped whitespace body', { description: 'a fact with an escaped blank body', body: '\\n\\t' }, /a new node needs a `body`/],
    ['supersede also linked', { description: 'rollout decision, revised', body: 'ship two plugins', supersedes: target.id, links: [target.id] }, /`supersedes` and `links` both name/],
    ['typed supersede also linked', { description: 'rollout decision, revised', body: 'ship two plugins', typed_links: [{ id: target.id, type: 'supersedes' }], links: [target.id] }, /`typed_links` supersedes .* and `links` also names it/],
    ['tiny attachment', { description: 'a fact', body: 'the fact', attach: { filename: 'detail.md', content: 'x' } }, /`attach\.content` is only 1 bytes/],
    ['one-letter name', { description: 'a fact', body: 'the fact', attach: { filename: 'x', content: DETAIL } }, /`attach\.filename` "x" does not name/],
    ['short stem', { description: 'a fact', body: 'the fact', attach: { filename: 'ab.md', content: DETAIL } }, /`attach\.filename` "ab\.md" does not name/],
    ['no extension', { description: 'a fact', body: 'the fact', attach: { filename: 'notes', content: DETAIL } }, /`attach\.filename` "notes" does not name/],
    ['empty extension', { description: 'a fact', body: 'the fact', attach: { filename: 'notes.', content: DETAIL } }, /`attach\.filename` "notes\." does not name/],
    ['astral short stem', { description: 'a fact', body: 'the fact', attach: { filename: '😀a.md', content: DETAIL } }, /`attach\.filename` "😀a\.md" does not name/],
    ['tiny attachment on update', { id: target.id, attach: { filename: 'detail.md', content: 'short' } }, /`attach\.content` is only 5 bytes/],
  ]) {
    await refusedBeforeExecution(write, args, exec, pattern, label)
  }

  // The live incident: every placeholder is named in ONE refusal, so a retry
  // can fix them all at once instead of discovering them one by one.
  const incident = { description: 'playground uses dsv4.1 flash', type: 'identity', links: [target.id], attach: { filename: 'x', content: 'x' }, supersedes: target.id }
  const violations = trustedPreparationFor(write)(incident).violations
  for (const pattern of [/`supersedes` and `links` both name/, /`attach\.content` is only 1 bytes/, /`attach\.filename` "x"/]) {
    assert.ok(violations.some((violation) => pattern.test(violation)), `incident: missing ${pattern}`)
  }
  await refusedBeforeExecution(write, incident, exec, /both name/, 'incident')

  for (const [label, args, pattern] of [
    ['standalone tiny', { id: target.id, filename: 'detail.md', content: 'x' }, /`content` is only 1 bytes/],
    ['standalone bad name', { id: target.id, filename: 'x', content: DETAIL }, /`filename` "x" does not name/],
  ]) {
    await refusedBeforeExecution(attach, args, exec, pattern, label)
  }

  assert.deepEqual(await treeOf(root), before, 'no refused call touched the graph')
})

test('one relationship, one spelling — refused always, before execution, writing nothing', async () => {
  const { root, write, read } = await harness()
  const exec = execFor('one-spelling')
  const target = await write.execute({ description: 'old plan node', body: 'the plan' }, exec)
  await read.execute({ id: target.id }, exec)

  // A `relates-to` overlap is the symmetric edge either way, so it is admitted
  // and the typed spelling merely labels the pair (no partial, no fence).
  const labelled = await write.execute({ description: 'rollout v2', body: 'ship it', links: [target.id], typed_links: [{ id: target.id, type: 'relates-to' }] }, exec)
  assert.equal(labelled.created, true)
  assert.deepEqual(labelled.links.map((link) => link.status), ['created', 'exists'])

  const before = await treeOf(root)

  for (const [label, args, pattern] of [
    // The live shape: supersede X, link X, and type the link to X in one call.
    ['supersede also linked', { description: 'rollout v3', body: 'ship it', supersedes: target.id, links: [target.id] }, /`supersedes` and `links` both name/],
    ['supersede also typed', { description: 'rollout v3', body: 'ship it', supersedes: target.id, typed_links: [{ id: target.id, type: 'follows-from' }] }, /`supersedes` and `typed_links` both name/],
    ['all three spellings', { description: 'rollout v3', body: 'ship it', supersedes: target.id, links: [target.id], typed_links: [{ id: target.id, type: 'follows-from' }] }, /`supersedes`, `links` and `typed_links` all name/],
    ['typed supersede also linked', { description: 'rollout v3', body: 'ship it', typed_links: [{ id: target.id, type: 'supersedes' }], links: [target.id] }, /`typed_links` supersedes .* and `links` also names it/],
    // Two different meanings for one target: symmetric plain and directed typed.
    ['plain link plus directed typed link', { description: 'rollout v3', body: 'ship it', links: [target.id], typed_links: [{ id: target.id, type: 'follows-from' }] }, /`links` and `typed_links` both name/],
    ['self link on update', { id: target.id, links: [target.id] }, /carries no information/],
  ]) {
    await refusedBeforeExecution(write, args, exec, pattern, label)
  }

  assert.deepEqual(await treeOf(root), before, 'no refused call touched the graph')
})

test('typed_links rejects conflicting types per target before any mutation, but admits identical duplicates', async () => {
  const { root, write, read, attach } = await harness()
  const exec = execFor('typed-conflict')
  const target = await write.execute({ description: 'old decision with evidence', body: 'keep this decision until replaced' }, exec)
  await attach.execute({ id: target.id, filename: 'decision-evidence.txt', content: 'original evidence' }, exec)
  await read.execute({ id: target.id }, exec)
  const before = await treeOf(root)
  const types = ['supersedes', 'relates-to', 'follows-from']
  for (const first of types) {
    for (const second of types) {
      if (first === second) continue
      await refusedBeforeExecution(write, {
        description: 'a proposed replacement', body: 'new decision',
        typed_links: [{ id: target.id, type: first }, { id: target.id, type: second }],
      }, exec, /one relationship takes one type/, `${first} then ${second}`)
      assert.deepEqual(await treeOf(root), before, 'no node, banner or attachment move on a conflict')
    }
  }
  for (const type of types) {
    const peer = await write.execute({ description: `peer for duplicate ${type}`, body: 'existing target' }, exec)
    await read.execute({ id: peer.id }, exec)
    const result = await write.execute({
      description: `identical duplicate ${type}`, body: 'one relationship',
      typed_links: [{ id: peer.id, type }, { id: peer.id, type }],
    }, exec)
    assert.equal(result.created, true)
    assert.deepEqual(result.links.map((link) => link.status), ['created', 'exists'])
  }
})

test('2a: ordinary writes are still admitted with the guards on', async () => {
  const { root, write, attach, read } = await harness({ placeholderGuards: true })
  const exec = execFor('admitted')
  const old = await write.execute({ description: 'standup at 10:30', body: 'Standup starts at 10:30.' }, exec)
  await read.execute({ id: old.id }, exec)

  // A real supersede, an update without a body, and a gist-less node whose
  // detail is all in a properly named, non-trivial attachment (the one pattern
  // the synthetic attachment-only fixture exercises).
  const successor = await write.execute({ description: 'standup moves to 11:00 from 2026-11-10', body: 'Standup starts at 11:00 from 2026-11-10.', supersedes: old.id }, exec)
  assert.equal(successor.created, true)
  const updated = await write.execute({ id: successor.id, links: [] }, exec)
  assert.equal(updated.created, false)
  const gistless = await write.execute({ description: 'sample article on graph maintenance', attach: { filename: 'sample-article.md', content: DETAIL } }, exec)
  assert.equal(gistless.created, true)
  await attach.execute({ id: successor.id, filename: 'standup-schedule.md', content: DETAIL }, exec)
  // A body that is a real multi-line text written with escapes is still a body.
  const escaped = await write.execute({ description: 'standup notes', body: 'Standup moved.\\nOwner: ops.' }, exec)
  assert.equal(escaped.created, true)
  // A three-code-point stem with an astral character is a name.
  await attach.execute({ id: successor.id, filename: '😀ab.md', content: DETAIL }, exec)

  const files = await fsp.readdir(path.join(root, successor.id))
  assert.ok(files.includes('standup-schedule.md'))
})
