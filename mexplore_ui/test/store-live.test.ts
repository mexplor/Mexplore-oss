// Pass-2 #11: a stream of watch events must not starve the rebuild, and events
// for paths that cannot change the snapshot must not touch the timer at all.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { Store } from '../src/server/store.ts'
import { cleanupTemps, newNode, tempDir, waitFor, writeTasksDb } from './helpers.ts'

const stores: Store[] = []

afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

function makeStore(graphRoot: string, stateDir: string, debounceMs = 300): Store {
  const store = new Store({ graphRoot, stateDir, debounceMs, reconcileMs: 600_000, taskPollMs: 600_000 })
  stores.push(store)
  return store
}

function fixture(): { graphRoot: string; store: Store } {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'debounce fixture node')
  const stateDir = path.join(base, 'state')
  writeTasksDb(stateDir, [])
  return { graphRoot, store: makeStore(graphRoot, stateDir) }
}

describe('#11: debounce cannot be starved', () => {
  test('an excluded path does not arm or postpone the timer', () => {
    const { store } = fixture()
    // .locks/ is never part of a snapshot.
    store.scheduleRefresh('.locks/some.lock', 'change')
    expect(store.hasPendingRebuild()).toBe(false)
    // .DS_Store likewise.
    store.scheduleRefresh('.DS_Store', 'rename')
    expect(store.pendingKindCount()).toBe(0)
  })

  test('a relevant event DOES arm the timer', () => {
    const { store } = fixture()
    store.scheduleRefresh('MAP.md', 'change')
    expect(store.hasPendingRebuild()).toBe(true)
    expect(store.pendingKindCount()).toBeGreaterThan(0)
  })

  test('a Node added during sustained irrelevant events still appears within the cap', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'sustained fixture node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    // A long-ish debounce so a naive trailing debounce would be starved clearly.
    const store = makeStore(graphRoot, stateDir, 300)
    store.start()

    // Sustained, irrelevant events every 20 ms: a trailing-only debounce would
    // never fire while they continue.
    let stop = false
    const churn = (async () => {
      while (!stop) {
        store.scheduleRefresh('.locks/x.lock', 'change')
        store.scheduleRefresh('.advisories', 'rename')
        await Bun.sleep(20)
      }
    })()

    // One REAL event: a new Node appears.
    const added = newNode(graphRoot, 'node added mid-churn')
    store.scheduleRefresh(`${added}/node.md`, 'rename')

    // The cap is 1 s, so the rebuild must land well inside the ~1.5 s budget.
    const appeared = await waitFor(() => store.graph().nodeById.has(added), 2500, 25)
    stop = true
    await churn
    expect(appeared).toBe(true)
  }, 20_000)

  test('continuous relevant events still rebuild within the cap', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const first = newNode(graphRoot, 'churn base node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = makeStore(graphRoot, stateDir, 300)
    store.start()

    const started = Date.now()
    const added = newNode(graphRoot, 'node under continuous churn')
    let stop = false
    const churn = (async () => {
      let i = 0
      while (!stop) {
        // Alternating relevant events: every one of them WOULD reset a naive timer.
        store.scheduleRefresh(i % 2 === 0 ? `${added}/node.md` : 'MAP.md', 'change')
        i += 1
        await Bun.sleep(20)
      }
    })()

    const appeared = await waitFor(() => store.graph().nodeById.has(added), 3000, 25)
    const elapsed = Date.now() - started
    stop = true
    await churn
    expect(appeared).toBe(true)
    // The cap (1 s) plus scheduling slack; well under a starved 10 s reconcile.
    expect(elapsed).toBeLessThan(2500)
    expect(store.graph().nodeById.get(first)).toBeDefined()
  }, 20_000)
})

describe('#9: the store keeps its last good snapshot when the root cannot be listed', () => {
  test('an unlistable root does not empty the served graph', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'snapshot survival node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = makeStore(graphRoot, stateDir)
    store.start()
    expect(store.graph().nodeById.get(id)).toBeDefined()

    fs.chmodSync(graphRoot, 0o000)
    try {
      expect(() => store.rebuildNow()).not.toThrow()
      // The last good snapshot is still served, with a warning attached.
      expect(store.graph().nodeById.get(id)).toBeDefined()
      expect(store.healthWarnings().join('\n')).toContain('graph root')
    } finally {
      fs.chmodSync(graphRoot, 0o755)
    }
    store.rebuildNow()
    expect(store.healthWarnings()).toEqual([])
    expect(store.graph().nodeById.get(id)).toBeDefined()
  })
})
