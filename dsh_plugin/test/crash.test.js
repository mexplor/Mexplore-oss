// F68 (#132): prove the graph's documented crash boundaries with real SIGKILLs.
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  STALE_LOCK_MS, ULID_RE, addEdge, createNode, extraFiles, listIds, parseNode,
  withNodeLocks,
} from '../lib/graph.js'

const GRAPH_URL = new URL('../lib/graph.js', import.meta.url).href
const PLUGIN_URL = new URL('../lib/index.js', import.meta.url).href
const MAINTAIN = fileURLToPath(new URL('../../memory_fs/bin/graph-maintain', import.meta.url))
const PROCESS_TIMEOUT_MS = 5_000

function crashChild(label, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, MEMGRAPH_CRASH_AT: label },
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  assert.equal(
    result.signal,
    'SIGKILL',
    `${label}: child did not die by SIGKILL (status=${result.status}, error=${result.error?.message ?? 'none'}, stderr=${result.stderr})`,
  )
  assert.equal(result.status, null, `${label}: a signal death must not have an exit status`)
}

function maintain(root, args = []) {
  const result = spawnSync(process.execPath, [MAINTAIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GRAPH_ROOT: root },
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  assert.equal(
    result.status,
    0,
    `graph-maintain ${args.join(' ')} failed (signal=${result.signal}, stderr=${result.stderr})`,
  )
  return result.stdout
}

async function backdateLocks(root) {
  const lockRoot = path.join(root, '.locks')
  let names = []
  try { names = await fsp.readdir(lockRoot) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const stale = new Date(Date.now() - STALE_LOCK_MS - 1_000)
  const locks = names.filter((name) => ULID_RE.test(name.replace(/\.lock$/, '')) && name.endsWith('.lock'))
  await Promise.all(locks.map((name) => fsp.utimes(path.join(lockRoot, name), stale, stale)))
  return locks.length
}

async function assertReadable(root, label) {
  const ids = await listIds(root)
  const rootEntries = await fsp.readdir(root)
  for (const entry of rootEntries.filter((name) => name.startsWith('.'))) {
    assert.equal(ids.includes(entry), false, `${label}: dot-prefixed residue surfaced as a live node: ${entry}`)
  }
  for (const id of ids) {
    const parsed = parseNode(await fsp.readFile(path.join(root, id, 'node.md'), 'utf8'))
    assert.notEqual(parsed.description, '', `${label}: ${id}/node.md lost its description`)
    assert.match(parsed.created, /^\d{4}-\d{2}-\d{2}$/, `${label}: ${id}/node.md lost its creation date`)
    const files = await extraFiles(root, id)
    assert.equal(files.some((name) => name.startsWith('.')), false, `${label}: staging temp surfaced as an attachment on ${id}`)
  }
  return ids
}

function assertSummary(output, label, { halfEdges = 0, staleLocks = 0 } = {}) {
  assert.match(output, /summary: .*integrity_issues=0/, `${label}: maintenance found an integrity issue\n${output}`)
  assert.match(output, new RegExp(`summary: .*half_edges=${halfEdges}\\b`), `${label}: wrong half-edge count\n${output}`)
  assert.match(output, new RegExp(`summary: .*stale_locks=${staleLocks}\\b`), `${label}: wrong stale-lock count\n${output}`)
}

function healAndAssertClean(root, label, expected = {}) {
  const applied = maintain(root, ['--apply'])
  assertSummary(applied, label, expected)
  const clean = maintain(root)
  assertSummary(clean, `${label} second maintenance`, { halfEdges: 0, staleLocks: 0 })
  assert.doesNotMatch(clean, /^(?:half edge|stale lock):/m, `${label}: healed advisory recurred\n${clean}`)
  return applied
}

test('held-lock-before-write leaves a stale lock that one maintenance run removes', { timeout: 10_000 }, async () => {
  const label = 'held-lock-before-write'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-crash-lock-'))
  try {
    const id = await createNode(root, { description: 'lock crash target', body: 'unchanged' })
    crashChild(label, `
      const { withNodeLocks } = await import(${JSON.stringify(GRAPH_URL)})
      await withNodeLocks(${JSON.stringify(root)}, [${JSON.stringify(id)}], async () => { throw new Error('checkpoint missed') })
    `)
    const lockDir = path.join(root, '.locks', `${id}.lock`)
    assert.equal((await fsp.stat(lockDir)).isDirectory(), true, `${label}: lock directory was not left behind`)
    assert.equal(parseNode(await fsp.readFile(path.join(root, id, 'node.md'), 'utf8')).body, 'unchanged', `${label}: critical section ran before the crash`)
    await assertReadable(root, label)

    const freshReport = maintain(root)
    assertSummary(freshReport, `${label} fresh-lock report`)
    assert.doesNotMatch(freshReport, /^stale lock:/m, `${label}: maintenance reported a younger-than-threshold lock`)
    assert.equal((await fsp.stat(lockDir)).isDirectory(), true, `${label}: report-only maintenance touched a fresh lock`)

    assert.equal(await backdateLocks(root), 1, `${label}: expected one abandoned lock`)
    const applied = healAndAssertClean(root, label, { staleLocks: 1 })
    assert.match(applied, new RegExp(`^stale lock: ${id} \\(--apply removes\\)$`, 'm'), `${label}: stale lock was not reported`)
    assert.match(applied, new RegExp(`^removed stale lock: ${id}$`, 'm'), `${label}: stale lock was not removed`)

    const result = await Promise.race([
      withNodeLocks(root, [id], async () => 'writer-ran'),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: later writer timed out`)), 1_000)),
    ])
    assert.equal(result, 'writer-ran', `${label}: later writer remained blocked`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('supersede-between-edge-and-banner leaves a readable, typed intent edge', { timeout: 10_000 }, async () => {
  const label = 'supersede-between-edge-and-banner'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-crash-supersede-'))
  try {
    const oldId = await createNode(root, { description: 'supersede old target', body: 'old rationale' })
    crashChild(label, `
      const { apply } = await import(${JSON.stringify(PLUGIN_URL)})
      const tools = new Map()
      apply({ tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } }, inject: () => {} }, { graphRoot: ${JSON.stringify(root)} })
      // The banner prepend is version-gated (#143): read first so the crash
      // point inside the locked section is actually reached.
      await tools.get('memory_read').execute({ id: ${JSON.stringify(oldId)} }, {})
      await tools.get('memory_write').execute({ description: 'supersede replacement', body: 'new rationale', supersedes: ${JSON.stringify(oldId)} }, {})
    `)
    const ids = await assertReadable(root, label)
    assert.equal(ids.length, 2, `${label}: successor was not committed before the checkpoint`)
    const newId = ids.find((id) => id !== oldId)
    assert.ok(newId, `${label}: could not identify the successor`)
    assert.equal(await fsp.readlink(path.join(root, newId, '__edges__', oldId)), `../../${oldId}`, `${label}: supersedes edge is unreadable`)
    assert.match(await fsp.readFile(path.join(root, newId, '__edges__', '.edge-types'), 'utf8'), new RegExp(`^${oldId} supersedes$`, 'm'), `${label}: supersedes type was not committed with its edge`)
    assert.doesNotMatch((await fsp.readFile(path.join(root, oldId, 'node.md'), 'utf8')), /Superseded by /, `${label}: banner was written before the checkpoint`)

    const lockCount = await backdateLocks(root)
    assert.equal(lockCount, 2, `${label}: expected both Node locks to survive SIGKILL`)
    const applied = healAndAssertClean(root, label, { staleLocks: lockCount })
    assert.match(applied, /stale_locks=2/, `${label}: maintenance did not heal both abandoned locks`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('addedge-between-symlinks produces the half-edge maintenance completes', { timeout: 10_000 }, async () => {
  const label = 'addedge-between-symlinks'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-crash-edge-'))
  try {
    const src = await createNode(root, { description: 'edge crash source' })
    const dst = await createNode(root, { description: 'edge crash target' })
    crashChild(label, `
      const { addEdge } = await import(${JSON.stringify(GRAPH_URL)})
      await addEdge(${JSON.stringify(root)}, ${JSON.stringify(src)}, ${JSON.stringify(dst)})
    `)
    await assertReadable(root, label)
    assert.equal(await fsp.readlink(path.join(root, src, '__edges__', dst)), `../../${dst}`, `${label}: forward half is missing`)
    await assert.rejects(fsp.lstat(path.join(root, dst, '__edges__', src)), { code: 'ENOENT' }, `${label}: reverse half landed before the crash`)

    const applied = healAndAssertClean(root, label, { halfEdges: 1 })
    assert.match(applied, new RegExp(`^half edge: ${src} -> ${dst} \\(--apply completes the pair\\)$`, 'm'), `${label}: half-edge residue was not reported`)
    assert.match(applied, new RegExp(`^completed half edge: ${dst} -> ${src}$`, 'm'), `${label}: reverse half was not completed`)
    assert.equal(await fsp.readlink(path.join(root, dst, '__edges__', src)), `../../${src}`, `${label}: completed reverse half is wrong`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

async function setupMerge(root) {
  const keep = await createNode(root, { description: 'merge survivor alpha', body: 'keep facts' })
  const absorb = await createNode(root, { description: 'absorbed record beta', body: 'absorbed facts' })
  const incoming = await createNode(root, { description: 'incoming neighbor gamma', body: 'neighbor facts' })
  await fsp.writeFile(path.join(root, absorb, 'evidence.txt'), 'attachment survives\n')
  await addEdge(root, incoming, absorb)
  return { keep, absorb, incoming }
}

for (const [label, attachmentOwner] of [
  ['merge-after-repoint-before-move', 'absorb'],
  ['merge-after-move-before-archive', 'keep'],
]) {
  test(`${label} leaves a readable prefix that maintenance normalizes`, { timeout: 10_000 }, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `memgraph-crash-${label}-`))
    try {
      const ids = await setupMerge(root)
      crashChild(label, `
        const { mergeNodes } = await import(${JSON.stringify(GRAPH_URL)})
        await mergeNodes(${JSON.stringify(root)}, ${JSON.stringify(ids.keep)}, ${JSON.stringify(ids.absorb)})
      `)
      await assertReadable(root, label)
      const keepNode = parseNode(await fsp.readFile(path.join(root, ids.keep, 'node.md'), 'utf8'))
      const absorbNode = parseNode(await fsp.readFile(path.join(root, ids.absorb, 'node.md'), 'utf8'))
      assert.match(keepNode.body, new RegExp(`Merged from ${ids.absorb}`), `${label}: committed merge provenance is missing`)
      assert.doesNotMatch(absorbNode.body, /Merged into /, `${label}: absorb banner landed before the checkpoint`)
      assert.equal(await fsp.readlink(path.join(root, ids.incoming, '__edges__', ids.keep)), `../../${ids.keep}`, `${label}: incoming edge was not repointed`)
      await assert.rejects(fsp.lstat(path.join(root, ids.incoming, '__edges__', ids.absorb)), { code: 'ENOENT' }, `${label}: detached incoming half survived`)
      assert.equal(await fsp.readlink(path.join(root, ids.absorb, '__edges__', ids.incoming)), `../../${ids.incoming}`, `${label}: absorb's own edge record was lost`)
      const expectedOwner = ids[attachmentOwner]
      const otherOwner = attachmentOwner === 'keep' ? ids.absorb : ids.keep
      assert.equal(await fsp.readFile(path.join(root, expectedOwner, 'evidence.txt'), 'utf8'), 'attachment survives\n', `${label}: attachment is not at the ordered checkpoint`)
      await assert.rejects(fsp.lstat(path.join(root, otherOwner, 'evidence.txt')), { code: 'ENOENT' }, `${label}: attachment exists on both nodes`)

      const lockCount = await backdateLocks(root)
      assert.equal(lockCount, 3, `${label}: merge did not retain its complete lock set`)
      const applied = healAndAssertClean(root, label, { halfEdges: 1, staleLocks: lockCount })
      assert.match(applied, /half_edges=1/, `${label}: maintenance did not see the detached merge half`)
      assert.match(applied, /stale_locks=3/, `${label}: maintenance did not see all abandoned merge locks`)
      assert.equal(await fsp.readlink(path.join(root, ids.incoming, '__edges__', ids.absorb)), `../../${ids.absorb}`, `${label}: maintenance did not normalize the half-edge`)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
}

test('writeatomic-before-rename leaves the old node readable and its temp inert', { timeout: 10_000 }, async () => {
  const label = 'writeatomic-before-rename'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-crash-atomic-'))
  try {
    const id = await createNode(root, { description: 'atomic rewrite target', body: 'body before crash' })
    crashChild(label, `
      const { updateNode, withNodeLocks } = await import(${JSON.stringify(GRAPH_URL)})
      await withNodeLocks(${JSON.stringify(root)}, [${JSON.stringify(id)}], () => updateNode(${JSON.stringify(root)}, ${JSON.stringify(id)}, { body: 'body after crash' }))
    `)
    await assertReadable(root, label)
    assert.equal(parseNode(await fsp.readFile(path.join(root, id, 'node.md'), 'utf8')).body, 'body before crash', `${label}: node.md exposed uncommitted bytes`)
    const residue = (await fsp.readdir(path.join(root, id))).filter((name) => /^\.\.node\.md\.prev\.tmp-/.test(name))
    assert.equal(residue.length, 1, `${label}: expected one inert staged snapshot, got ${residue.join(', ')}`)
    assert.deepEqual(await extraFiles(root, id), [], `${label}: staged snapshot surfaced as an attachment`)

    const lockCount = await backdateLocks(root)
    assert.equal(lockCount, 1, `${label}: writer lock did not survive SIGKILL`)
    healAndAssertClean(root, label, { staleLocks: lockCount })
    assert.equal((await fsp.readdir(path.join(root, id))).includes(residue[0]), true, `${label}: inert temp unexpectedly became graph data`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('createnode-before-rename leaves a complete but invisible staging directory', { timeout: 10_000 }, async () => {
  const label = 'createnode-before-rename'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-crash-create-'))
  try {
    crashChild(label, `
      const { createNode } = await import(${JSON.stringify(GRAPH_URL)})
      await createNode(${JSON.stringify(root)}, { description: 'staged crash node', body: 'complete staged body' })
    `)
    const entries = await fsp.readdir(root)
    const staging = entries.filter((name) => name.startsWith('.staging-'))
    assert.equal(staging.length, 1, `${label}: expected one staging directory, got ${staging.join(', ')}`)
    const staged = parseNode(await fsp.readFile(path.join(root, staging[0], 'node.md'), 'utf8'))
    assert.equal(staged.description, 'staged crash node', `${label}: staged node is torn`)
    assert.equal(staged.body, 'complete staged body', `${label}: staged body is torn`)
    assert.deepEqual(await assertReadable(root, label), [], `${label}: staging directory surfaced as a live node`)

    healAndAssertClean(root, label)
    assert.equal((await fsp.readdir(root)).includes(staging[0]), true, `${label}: ignored staging directory unexpectedly became live data`)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
