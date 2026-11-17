// Store-level tests: observation caching, reconcile fingerprinting, task
// signature polling, and the read-only guarantee across refreshes.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { SafeRoot } from '../src/server/fs-safe.ts'
import { Store } from '../src/server/store.ts'
import { ObservationCache } from '../src/server/usage/runs.ts'
import { diffKeys, fingerprintGraph } from '../src/server/watch.ts'
import {
  appendAccess,
  cleanupTemps,
  completeObservation,
  edgeAdd,
  newNode,
  taskUuid,
  tempDir,
  treeSignature,
  writeAttachment,
  writeRunDir,
  writeTasksDb,
} from './helpers.ts'

const stores: Store[] = []

afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

function makeStore(graphRoot: string, stateDir: string): Store {
  const store = new Store({ graphRoot, stateDir, debounceMs: 30, reconcileMs: 60_000, heartbeatMs: 1000 })
  stores.push(store)
  return store
}

describe('fingerprint and reconcile', () => {
  test('the fingerprint changes when a node, an edge or a log changes', () => {
    const root = tempDir()
    const a = newNode(root, 'fp a')
    const b = newNode(root, 'fp b')
    const first = fingerprintGraph(root)

    edgeAdd(root, a, b)
    const afterEdge = fingerprintGraph(root)
    expect(afterEdge.key).not.toBe(first.key)
    expect(diffKeys(first.nodes, afterEdge.nodes)).toContain(a)

    appendAccess(root, a, b, '2026-11-01T00:00:00Z')
    const afterLog = fingerprintGraph(root)
    expect(afterLog.key).not.toBe(afterEdge.key)
    expect(diffKeys(afterEdge.logs, afterLog.logs)).toContain(`${a}.log`)

    writeAttachment(root, a, 'notes.md', 'hello')
    const afterFile = fingerprintGraph(root)
    expect(afterFile.key).not.toBe(afterLog.key)

    // An unrelated dotfile does not move the fingerprint.
    fs.writeFileSync(path.join(root, '.DS_Store'), 'x', 'utf8')
    expect(fingerprintGraph(root).key).toBe(afterFile.key)
  })

  test('reconcile rebuilds and bumps generation when the graph changed', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'reconcile root')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = makeStore(graphRoot, stateDir)
    store.start()

    const before = store.graph().generation
    store.reconcile()
    expect(store.graph().generation).toBe(before) // nothing changed

    const added = newNode(graphRoot, 'added for reconcile')
    store.reconcile()
    expect(store.graph().generation).toBe(before + 1)
    expect(store.graph().nodeById.has(added)).toBe(true)
  })

  test('a task-row change is picked up by the reconcile poll', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'task poll node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [{ taskId: taskUuid('first'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])
    writeRunDir(stateDir, { taskId: taskUuid('first'), observation: completeObservation() }, 0)
    const store = makeStore(graphRoot, stateDir)
    store.start()
    expect(store.runs().runs).toHaveLength(1)
    expect(store.runs().runs[0]?.usageStatus).toBe('complete')

    writeTasksDb(stateDir, [
      { taskId: taskUuid('first'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z', updatedAt: '2026-11-02T00:00:00Z' },
      { taskId: taskUuid('second'), createdAt: '2026-11-02T00:00:00Z', finishedAt: '2026-11-02T00:00:02Z' },
    ])
    store.reconcile()
    expect(store.runs().runs).toHaveLength(2)
  })

  test('an orphan run directory is a warning, not a row', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'orphan node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    writeRunDir(stateDir, { taskId: taskUuid('ghost-task'), observation: completeObservation() }, 0)
    const store = makeStore(graphRoot, stateDir)
    expect(store.runs().runs).toHaveLength(0)
    expect(store.runs().warnings.join('\n')).toContain('orphan run directory')
  })

  test('multiple run directories use the newest and warn', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'multi run node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [{ taskId: taskUuid('multi'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])
    const older = writeRunDir(stateDir, { taskId: taskUuid('multi'), observation: completeObservation(1, 1, 111), uuid: 'old' }, 1)
    await Bun.sleep(10)
    const newer = writeRunDir(stateDir, { taskId: taskUuid('multi'), observation: completeObservation(2, 2, 222), uuid: 'new' }, 2)
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    fs.utimesSync(newer, new Date(), new Date())

    const store = makeStore(graphRoot, stateDir)
    expect(store.runs().runs).toHaveLength(1)
    expect(store.runs().runs[0]?.usage?.totalTokens).toBe(222)
    expect(store.runs().warnings.join('\n')).toContain('multiple run directories')
  })
})

describe('observation cache', () => {
  /** Stat + reader pair the way buildRunIndex supplies them. */
  function probe(file: string): {
    rel: string
    stat: ReturnType<SafeRoot['stat']>
    read: () => { ok: boolean; reason?: string; text?: string }
  } {
    const root = SafeRoot.open(path.dirname(file)) as SafeRoot
    const rel = path.basename(file)
    return {
      rel,
      stat: root.stat(rel),
      read: () => {
        const read = root.read(rel)
        return read.ok ? { ok: true, text: read.text ?? '' } : { ok: false, reason: read.reason ?? 'io-error' }
      },
    }
  }

  test('reuses a parse until mtime or size changes', () => {
    const dir = tempDir()
    const file = path.join(dir, 'observation.jsonl')
    fs.writeFileSync(file, completeObservation(), 'utf8')
    const cache = new ObservationCache()
    const firstProbe = probe(file)
    const first = cache.get(firstProbe.rel, firstProbe.stat, firstProbe.read)
    const secondProbe = probe(file)
    const second = cache.get(secondProbe.rel, secondProbe.stat, secondProbe.read)
    expect(second).toBe(first) // same object: served from cache

    fs.writeFileSync(file, completeObservation(5, 5, 55), 'utf8')
    const thirdProbe = probe(file)
    const third = cache.get(thirdProbe.rel, thirdProbe.stat, thirdProbe.read)
    expect(third).not.toBe(first)
    // The cache stores the REDUCED aggregate, never an event list (#6).
    expect(third).not.toHaveProperty('events')
    expect(third.usageStatus).toBe('complete')
    expect(third.usage).toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 55, cacheReadTokens: 50 })
    // One parse per distinct (mtime,size); the repeat was a hit.
    expect(cache.counters).toEqual({ hits: 1, misses: 2, parses: 2, failures: 0 })
  })

  test('a missing file parses as absent', () => {
    const dir = tempDir()
    const root = SafeRoot.open(dir) as SafeRoot
    const cache = new ObservationCache()
    expect(cache.get('observation.jsonl', root.stat('observation.jsonl'), () => ({ ok: false, reason: 'missing' })).usageStatus).toBe('unknown')
  })

  test('prune drops entries for files that are gone', () => {
    const dir = tempDir()
    const file = path.join(dir, 'observation.jsonl')
    fs.writeFileSync(file, completeObservation(), 'utf8')
    const cache = new ObservationCache()
    const p = probe(file)
    cache.get(p.rel, p.stat, p.read)
    expect(cache.size).toBe(1)
    cache.prune(new Set())
    expect(cache.size).toBe(0)
    // After pruning, a re-read must parse again rather than serve a stale object.
    const again = probe(file)
    const after = cache.get(again.rel, again.stat, again.read)
    expect(after.usageStatus).toBe('complete')
  })
})

describe('store refreshes are read-only', () => {
  test('repeated rebuilds leave the graph and state trees byte-identical', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const a = newNode(graphRoot, 'readonly a')
    const b = newNode(graphRoot, 'readonly b')
    edgeAdd(graphRoot, a, b)
    appendAccess(graphRoot, a, b, '2026-11-01T00:00:00Z')
    writeAttachment(graphRoot, a, 'notes.md', 'content')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [{ taskId: taskUuid('t'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])
    writeRunDir(stateDir, { taskId: taskUuid('t'), observation: completeObservation() }, 0)

    const store = makeStore(graphRoot, stateDir)
    store.start()
    const graphBefore = treeSignature(graphRoot)
    // SQLite readers legitimately map -wal/-shm, so they are excluded here, as
    // §10 specifies for the manual production check.
    const stateFiles = (): string =>
      treeSignature(stateDir)
        .split('\n')
        .filter((line) => !line.includes('memory-agent.sqlite-wal') && !line.includes('memory-agent.sqlite-shm'))
        .join('\n')
    const stateBefore = stateFiles()

    for (let i = 0; i < 5; i++) store.rebuildNow()

    expect(treeSignature(graphRoot)).toBe(graphBefore)
    expect(stateFiles()).toBe(stateBefore)
  })
})
