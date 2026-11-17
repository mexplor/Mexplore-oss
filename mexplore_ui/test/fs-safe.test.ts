// Pass-2 blocker #1: the guard must be revalidated per read, must not follow
// symlinked CONTAINERS, and must bind the opened descriptor to the verified path
// (inode identity), so a concurrent swap cannot hand us an outside file.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { SafeRoot, setListingHook, setOpenHook } from '../src/server/fs-safe.ts'
import { buildGraphSnapshot } from '../src/server/graph/build.ts'
import { Store } from '../src/server/store.ts'
import { fingerprintRuns } from '../src/server/watch.ts'
import { buildRunIndex, ObservationCache } from '../src/server/usage/runs.ts'
import { readTasks } from '../src/server/usage/tasks.ts'
import { completeObservation, newNode, taskUuid, tempDir, writeRunDir, writeTasksDb } from './helpers.ts'

const stores: Store[] = []

afterEach(() => {
  setOpenHook(null)
  setListingHook(null)
})

afterAll(() => {
  for (const store of stores) store.close()
})

// ---- symlinked containers ------------------------------------------------

describe('#1: a symlinked container is refused on every read', () => {
  test('.access -> outside is not followed for either read or stat', () => {
    const root = tempDir()
    const outside = tempDir()
    const id = newNode(root, 'container victim')
    const planted = path.join(outside, `${id}.log`)
    fs.writeFileSync(planted, `${id} 2026-11-01T00:00:00Z\n`, 'utf8')
    // The legacy layout puts logs in the node dir; `.access` is the current one.
    fs.symlinkSync(outside, path.join(root, '.access'))

    const safe = SafeRoot.open(root) as SafeRoot
    expect(safe.read(path.posix.join('.access', `${id}.log`)).reason).toBe('symlink')
    expect(safe.stat(path.posix.join('.access', `${id}.log`)).reason).toBe('symlink')
    expect(safe.listDirResult('.access').ok).toBe(false)

    // Through the snapshot builder the visit count stays 0 and a warning appears.
    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(id)?.visitCount).toBe(0)
    expect(snapshot.warnings.join('\n')).toContain('access log refused')
  })

  test('a node directory swapped for an in-root symlink is refused', () => {
    const root = tempDir()
    const realA = newNode(root, 'real a')
    const realB = newNode(root, 'real b')
    fs.writeFileSync(path.join(root, realB, 'node.md'), '---\ndescription: B CONTENT\n---\n', 'utf8')

    // Replace A with a symlink pointing at B: inside the root, so a lexical
    // containment check would happily serve B's bytes under A's id.
    const safe = SafeRoot.open(root) as SafeRoot
    expect(safe.read(path.posix.join(realA, 'node.md')).ok).toBe(true)

    fs.rmSync(path.join(root, realA), { recursive: true, force: true })
    fs.symlinkSync(path.join(root, realB), path.join(root, realA))
    expect(safe.read(path.posix.join(realA, 'node.md')).reason).toBe('symlink')
    expect(safe.listDirResult(realA).ok).toBe(false)

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(realA)).toBeUndefined()
    expect(snapshot.warnings.join('\n')).toContain(`${realA} is a symlink; skipped`)
  })

  test('a symlinked runs/ task directory is not traversed', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'runs container node')
    const stateDir = path.join(base, 'state')
    const outside = tempDir()
    const taskId = taskUuid('runs-container')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])

    // The task's run directory lives OUTSIDE stateDir, reached via a symlink.
    writeRunDir(outside, { taskId, observation: completeObservation() }, 0)
    fs.mkdirSync(path.join(stateDir, 'runs'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'runs', taskId), path.join(stateDir, 'runs', taskId))

    const index = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache: new ObservationCache() })
    // The task is still a row (runs are never dropped) but its usage is unknown.
    expect(index.runs).toHaveLength(1)
    expect(index.runs[0]?.usageStatus).toBe('unknown')
    expect(index.runs[0]?.usage).toBeNull()
  })

  test('the fingerprint does not follow a symlinked container', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'fp container node')
    const outside = tempDir()
    fs.mkdirSync(path.join(outside, 'edges'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'edges', '.edge-types'), 'x', 'utf8')
    fs.rmSync(path.join(graphRoot, id, '__edges__'), { recursive: true, force: true })
    fs.symlinkSync(path.join(outside, 'edges'), path.join(graphRoot, id, '__edges__'))

    // The fingerprint records the symlink as unusable rather than statting
    // through it — the digest must not describe outside files.
    const fingerprint = fingerprintRuns(base)
    expect(fingerprint.runsUnavailable).toBe(false)
    const graphFp = buildGraphSnapshot(graphRoot, 1)
    // An edge half planted through the redirected __edges__ is not an edge.
    expect(graphFp.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TOCTOU: the leaf is swapped between open() and the path recheck, so the file
// descriptor and the (restored) path disagree. The guard must refuse.
// ---------------------------------------------------------------------------
describe('TOCTOU: descriptor must match the verified path (#1)', () => {
  test('a swap between open and verification is refused', () => {
    const root = tempDir()
    const outside = tempDir()
    const secretText = 'OUTSIDE-SECRET-MUST-NOT-LEAK'
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, secretText, 'utf8')

    const target = path.join(root, 'data.txt')
    fs.writeFileSync(target, 'benign contents', 'utf8')

    const safe = SafeRoot.open(root) as SafeRoot
    // Before the hook: the file is legitimately readable.
    expect(safe.read('data.txt').text).toBe('benign contents')

    // Simulate the attacker: after the open, replace the leaf with a symlink and
    // restore the original path so the recheck sees a valid inside file again.
    let swapped = false
    setOpenHook(() => {
      if (swapped) return
      swapped = true
      const held = path.join(root, 'held.txt')
      fs.renameSync(target, held)
      fs.symlinkSync(secret, target)
    })

    const result = safe.read('data.txt')
    expect(result.ok).toBe(false)
    // Either the leaf is seen as a symlink or the inode disagrees; both refuse.
    expect(['symlink', 'inode-mismatch']).toContain(result.reason as string)
    expect(result.text).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(secretText)
    expect(result.ok).toBe(false)
  })

  test('an inode mismatch alone is refused even when every path checks out', () => {
    const root = tempDir()
    const outside = tempDir()
    const secretText = 'INODE-SWAP-SECRET'
    fs.writeFileSync(path.join(outside, 'secret.txt'), secretText, 'utf8')

    // Two real files inside the root: the hook swaps the CONTENT behind the fd
    // by renaming a different inode into place, leaving a valid path.
    const target = path.join(root, 'data.txt')
    fs.writeFileSync(target, 'benign', 'utf8')
    const decoy = path.join(root, 'decoy.txt')
    fs.writeFileSync(decoy, secretText, 'utf8')

    const safe = SafeRoot.open(root) as SafeRoot
    let swapped = false
    setOpenHook(() => {
      if (swapped) return
      swapped = true
      // Replace the leaf with the decoy inode AFTER the descriptor is open.
      fs.renameSync(decoy, target)
    })
    const result = safe.read('data.txt')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('inode-mismatch')
    expect(result.text).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// #9: an unlistable root must not look like a healthy empty graph.
// ---------------------------------------------------------------------------
describe('#9: an unlistable root is a failure, not an empty graph', () => {
  test('listDirResult distinguishes failure from an empty directory', () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'empty'))
    const safe = SafeRoot.open(root) as SafeRoot
    const empty = safe.listDirResult('empty')
    expect(empty.ok).toBe(true)
    expect(empty.entries).toEqual([])

    const missing = safe.listDirResult('nope')
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('missing')
  })

  test('a listing failure makes the builder THROW (never a healthy empty graph)', () => {
    const root = tempDir()
    newNode(root, 'listing node')

    // Simulate EACCES on the root's own listing while it still canonicalises:
    // that is the exact window the contract is about (build.ts:listNodeIds).
    // Compare canonical paths: on macOS the root's realpath differs from the temp
    // path (``/var`` -> ``/private/var``).
    const canonicalRoot = fs.realpathSync(root)
    setListingHook((absolute) => {
      if (absolute !== canonicalRoot) return
      const error = new Error('EACCES: permission denied, scandir') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })
    try {
      expect(() => buildGraphSnapshot(root, 1)).toThrow(/could not be listed/)
    } finally {
      setListingHook(null)
    }

    // With the listing working again the builder succeeds normally.
    const snapshot = buildGraphSnapshot(root, 2)
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.warnings).toEqual([])
  })

  test('an unreadable root keeps the Store snapshot and exposes the warning', () => {
    // Root bypasses permission bits; the test is meaningless as root.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const base = tempDir()
    const root = path.join(base, 'graph')
    const id = newNode(root, 'chmod node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])

    // Store first, so it holds a good snapshot before the chmod.
    const store = new Store({ graphRoot: root, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.start()
    expect(store.graph().nodeById.get(id)?.description).toBe('chmod node')

    fs.chmodSync(root, 0o000)
    try {
      // Whatever the OS refuses first (realpath or the listing), the Store must
      // catch it, keep the last good snapshot and flag it as stale.
      expect(() => store.rebuildNow()).not.toThrow()
      expect(store.graph().nodeById.get(id)?.description).toBe('chmod node')
      expect(store.healthWarnings().join(',')).toContain('graph root')
    } finally {
      fs.chmodSync(root, 0o755)
    }

    // Recovery clears the warning and the node is still served.
    store.rebuildNow()
    expect(store.healthWarnings()).toEqual([])
    expect(store.graph().nodeById.get(id)?.description).toBe('chmod node')
  })
})
