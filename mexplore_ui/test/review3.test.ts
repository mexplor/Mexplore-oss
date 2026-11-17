// Pass-3 review fixes.
//
// #1  A root moved aside and replaced by a symlink must be REFUSED, not adopted as
//     the new trust boundary — checked through the Store and through the HTTP
//     attachment endpoint, which is where the bytes could otherwise escape.
// #4  A graph rebuild whose only outcome is a health change must still emit a
//     graph SSE hint, so /api/graph warnings are refetched.
// #5  A failed observation read must never be cached: fixing permissions without
//     touching bytes or mtime must recover on the next refresh.
// #6  The observation byte cap must be enforced by the READ, not by an earlier
//     stat, so a file that grows in between is still refused.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createApp } from '../src/server/app.ts'
import { SafeRoot, pinTrustedRoot } from '../src/server/fs-safe.ts'
import { Store } from '../src/server/store.ts'
import { buildRunIndex, ObservationCache } from '../src/server/usage/runs.ts'
import { readTasks } from '../src/server/usage/tasks.ts'
import { MAX_OBSERVATION_BYTES } from '../src/server/usage/observation.ts'
import type { SseEvent } from '../src/shared/types.ts'
import {
  cleanupTemps,
  completeObservation,
  newNode,
  taskUuid,
  tempDir,
  writeAttachment,
  writeConfig,
  writeRunDir,
  writeTasksDb,
  serveOnEphemeralPort,
} from './helpers.ts'

const stores: Store[] = []
const servers: { stop(force?: boolean): unknown }[] = []

afterAll(async () => {
  for (const store of stores) store.close()
  for (const server of servers) await server.stop(true)
  cleanupTemps()
})

// ---- #1: root replacement is refused, never adopted ----------------------

describe('#1: a replaced graph root is refused, not adopted', () => {
  /** Build an outside graph that looks exactly like a real one. */
  function outsideGraph(): { root: string; id: string; canary: string } {
    const root = tempDir('outside-graph-')
    const id = newNode(root, 'CANARY-DESCRIPTION-OUTSIDE')
    const canary = 'OUTSIDE-CANARY-BODY-7c31'
    fs.writeFileSync(
      path.join(root, id, 'node.md'),
      `---\ndescription: ${canary}\n---\n\n${canary}\n`,
      'utf8',
    )
    writeAttachment(root, id, 'secret.md', canary)
    return { root, id, canary }
  }

  test('Store keeps its last good snapshot when the root is replaced by a symlink', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const mine = newNode(graphRoot, 'my own node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])

    // Pin BEFORE anything moves, exactly as config load does.
    const trust = pinTrustedRoot(graphRoot)
    expect(trust).not.toBeNull()

    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
      graphTrust: trust,
    })
    stores.push(store)
    store.start()
    expect(store.graph().nodeById.get(mine)).toBeDefined()

    // Attack: move the real root aside and put a symlink to an outside graph in
    // its place. A naive re-realpath would adopt the outside tree.
    const outside = outsideGraph()
    const hidden = path.join(base, 'graph-hidden')
    fs.renameSync(graphRoot, hidden)
    fs.symlinkSync(outside.root, graphRoot)

    store.rebuildNow()

    // The outside node is NOT visible, and the canary never appears.
    expect(store.graph().nodeById.has(outside.id)).toBe(false)
    expect(JSON.stringify(store.graph().nodes)).not.toContain(outside.canary)
    // The last good snapshot survives, flagged as stale.
    expect(store.graph().nodeById.get(mine)).toBeDefined()
    expect(store.healthWarnings().join('\n')).toContain('graph root')

    // Restoring the real directory recovers cleanly.
    fs.rmSync(graphRoot)
    fs.renameSync(hidden, graphRoot)
    store.rebuildNow()
    expect(store.healthWarnings()).toEqual([])
    expect(store.graph().nodeById.get(mine)).toBeDefined()
  })

  test('the HTTP attachment endpoint never serves the outside tree', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const mine = newNode(graphRoot, 'mine')
    writeAttachment(graphRoot, mine, 'notes.md', 'my notes')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)

    const trust = pinTrustedRoot(graphRoot)
    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
      graphTrust: trust,
    })
    stores.push(store)
    store.start()
    const app = createApp({
      store,
      configPath,
      graphRoot,
      stateDir,
      tz: 'UTC',
      graphTrust: trust,
      port: 0,
    })
    const server = serveOnEphemeralPort(app, { idleTimeout: 30 })
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`

    // Sanity: the legitimate attachment is served.
    const before = await fetch(`${origin}/api/node/${mine}/file/notes.md`)
    expect(before.status).toBe(200)
    expect(await before.text()).toBe('my notes')

    // Replace the root with a symlink to an outside graph whose node reuses the
    // SAME id and attachment name — the sharpest possible attack.
    const outside = tempDir('outside-graph-')
    const canary = 'OUTSIDE-ATTACHMENT-CANARY-91ab'
    fs.mkdirSync(path.join(outside, mine), { recursive: true })
    fs.writeFileSync(path.join(outside, mine, 'node.md'), '---\ndescription: x\n---\n', 'utf8')
    fs.writeFileSync(path.join(outside, mine, 'notes.md'), canary, 'utf8')

    const hidden = path.join(base, 'graph-hidden')
    fs.renameSync(graphRoot, hidden)
    fs.symlinkSync(outside, graphRoot)

    // The snapshot still lists `mine` (last good snapshot), so the attachment is
    // requested for real — the guard, not the listing, must stop it.
    store.rebuildNow()
    const attack = await fetch(`${origin}/api/node/${mine}/file/notes.md`)
    const body = await attack.text()
    expect(body).not.toContain(canary)
    expect(attack.status).toBe(404)

    // And the graph endpoint exposes the stale-root warning.
    const graph = (await (await fetch(`${origin}/api/graph`)).json()) as { nodes: { id: string }[]; warnings: string[] }
    expect(graph.warnings.join('\n')).toContain('graph root')
    expect(JSON.stringify(graph)).not.toContain(canary)
  })

  test('a state dir replaced by a symlink makes usage unavailable', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'state swap node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('state-swap')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)

    const stateTrust = pinTrustedRoot(stateDir)
    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
      stateTrust,
    })
    stores.push(store)
    store.start()
    expect(store.runs().runs).toHaveLength(1)
    expect(store.runsUnavailable()).toBe(false)

    // An outside state dir with a DIFFERENT task would be adopted without the pin.
    const outsideState = tempDir('outside-state-')
    writeTasksDb(outsideState, [
      { taskId: taskUuid('evil'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
    ])
    const hidden = path.join(base, 'state-hidden')
    fs.renameSync(stateDir, hidden)
    fs.symlinkSync(outsideState, stateDir)

    store.rebuildNow()

    expect(store.runsUnavailable()).toBe(true)
    expect(store.runs().runs).toHaveLength(0)
    expect(store.runs().warnings.join('\n')).toContain('state directory was replaced')

    // Recovery.
    fs.rmSync(stateDir)
    fs.renameSync(hidden, stateDir)
    store.rebuildNow()
    expect(store.runsUnavailable()).toBe(false)
    expect(store.runs().runs).toHaveLength(1)
  })
})

// ---- #4: health changes are invalidations --------------------------------

describe('#4: rebuild health changes emit a graph hint', () => {
  test('failure and recovery both emit graph, with task state unchanged', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'health node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.start()

    const events: SseEvent[] = []
    store.subscribe((event) => events.push(event))

    // Failure: the root becomes a file, so the builder's listing fails.
    const hidden = path.join(base, 'hidden')
    fs.renameSync(graphRoot, hidden)
    fs.writeFileSync(graphRoot, 'not a directory', 'utf8')
    store.rebuildNow()
    expect(store.healthWarnings().length).toBeGreaterThan(0)
    expect(events.some((event) => event.kind === 'graph')).toBe(true)
    expect(store.graph().nodeById.get(id)).toBeDefined()

    // RECOVERY is also a health change and must be announced, even though the
    // snapshot content is identical to what the client already has.
    events.length = 0
    fs.rmSync(graphRoot)
    fs.renameSync(hidden, graphRoot)
    store.rebuildNow()
    expect(store.healthWarnings()).toEqual([])
    expect(events.some((event) => event.kind === 'graph')).toBe(true)
  })

  test('a rebuild with no health change and no content change emits no graph hint', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'quiet node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.start()
    const events: SseEvent[] = []
    store.subscribe((event) => events.push(event))
    // refresh() with graph=false and nothing moved: no hints at all.
    store.refresh({ graph: false })
    expect(events).toEqual([])
  })
})

// ---- #5: failed observation reads are never cached -----------------------

describe('#5: a failed observation read is retried, not cached', () => {
  test('permission failure then recovery without touching bytes or mtime', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const base = tempDir()
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('perm-retry')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: completeObservation(10, 1, 11) }, 0)
    const file = path.join(runDir, 'observation.jsonl')
    const before = fs.statSync(file)

    const cache = new ObservationCache()
    fs.chmodSync(file, 0o000)
    try {
      const broken = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache })
      expect(broken.runs[0]?.usageStatus).toBe('unknown')
      // The failure carries its reason rather than a silent unknown.
      expect(broken.warnings.join('\n')).toContain('observation_unreadable')
      // ...and it was NOT cached. (The guarded metadata probe already refuses the
      // unreadable file, so the failure is counted before any read is attempted.)
      expect(cache.size).toBe(0)
      expect(cache.counters.parses).toBe(0)
      expect(cache.counters.failures).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(file, 0o644)
    }

    // Bytes and mtime are unchanged: only the next refresh can recover it.
    const after = fs.statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)

    const fixed = buildRunIndex({ stateDir, tasks: readTasks(stateDir).rows, cache })
    expect(fixed.runs[0]?.usageStatus).toBe('complete')
    expect(fixed.runs[0]?.usage?.totalTokens).toBe(11)
    expect(cache.counters.parses).toBe(1)
  })

  test('the Store retries a failed read on the next refresh', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'retry node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('retry-store')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    const file = path.join(runDir, 'observation.jsonl')
    fs.chmodSync(file, 0o000)
    try {
      const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
      stores.push(store)
      expect(store.runs().runs[0]?.usageStatus).toBe('unknown')
      expect(store.runs().warnings.join('\n')).toContain('observation_unreadable')
    } finally {
      fs.chmodSync(file, 0o644)
    }
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.rebuildNow()
    expect(store.runs().runs[0]?.usageStatus).toBe('complete')
  })
})

// ---- #6: the read itself enforces the byte cap ---------------------------

describe('#6: the observation cap is enforced by the read', () => {
  test('a capture that grows between the stat and the read is refused', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('grow')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    const file = path.join(runDir, 'observation.jsonl')
    const small = fs.statSync(file)

    // Between the cache's metadata probe and its read, the file becomes huge.
    const cache = new ObservationCache()
    const root = SafeRoot.open(stateDir) as SafeRoot
    const rel = path.posix.join('runs', taskId, path.basename(runDir), 'observation.jsonl')
    const stat = root.stat(rel)
    // A stale, small stat is exactly what the cache sees when the file grows right
    // after the probe.
    expect(stat.size).toBe(small.size)

    fs.truncateSync(file, MAX_OBSERVATION_BYTES + 4096)
    const aggregate = cache.get(rel, stat, () => {
      // This is the production reader: the CAP is applied to the OPEN.
      const read = root.read(rel, MAX_OBSERVATION_BYTES)
      return read.ok ? { ok: true, text: read.text ?? '' } : { ok: false, reason: read.reason ?? 'io-error' }
    })
    expect(aggregate.usageStatus).toBe('unknown')
    expect(aggregate.usage).toBeNull()
    expect(aggregate.reasons.join(',')).toContain('observation_too_large')
    // The oversized result is not cached as a parse.
    expect(cache.counters.parses).toBe(0)
  })

  test('the index reports an oversized capture as unknown with a warning', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'oversize index node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('oversize-index')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    fs.truncateSync(path.join(runDir, 'observation.jsonl'), MAX_OBSERVATION_BYTES + 1)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    const run = store.runs().runs.find((entry) => entry.taskId === taskId)
    expect(run?.usageStatus).toBe('unknown')
    expect(store.runs().warnings.join('\n')).toContain('observation_too_large')
  })
})
