// Pass-2 #7: a READER-ONLY proof. No writer subprocess touches the fixture, so
// every file — including `-wal`/`-shm` — is snapshotted before the Store exists
// and compared after startup plus several refreshes.

import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'

import { Store } from '../src/server/store.ts'
import { cleanupTemps, completeObservation, newNode, taskUuid, tempDir, writeRunDir, writeTasksDb } from './helpers.ts'

const stores: Store[] = []
const fixtureWriters: Database[] = []

afterAll(() => {
  for (const store of stores) store.close()
  for (const db of fixtureWriters) db.close()
  cleanupTemps()
})

interface FileDigest {
  /** Every regular file, by relative path -> sha256 + size. */
  files: Map<string, string>
  /** Directory entries (names only) per relative path. */
  dirs: Map<string, string>
}

function digestTree(root: string): FileDigest {
  const files = new Map<string, string>()
  const dirs = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    dirs.set(prefix === '' ? '.' : prefix, entries.map((entry) => entry.name).join(','))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const info = fs.lstatSync(full)
      if (info.isSymbolicLink()) {
        files.set(rel, `link:${fs.readlinkSync(full)}`)
        continue
      }
      if (info.isDirectory()) {
        walk(full, rel)
        continue
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      files.set(rel, `${info.size}:${hash}`)
    }
  }
  walk(root, '')
  return { files, dirs }
}

function diff(before: FileDigest, after: FileDigest): string[] {
  const changed: string[] = []
  for (const [rel, value] of after.files) if (before.files.get(rel) !== value) changed.push(`file:${rel}`)
  for (const rel of before.files.keys()) if (!after.files.has(rel)) changed.push(`removed:${rel}`)
  for (const [rel, value] of after.dirs) if (before.dirs.get(rel) !== value) changed.push(`dir:${rel}`)
  return changed.sort()
}

describe('#7: reader-only read-only proof, WAL and SHM included', () => {
  test('startup and repeated refreshes leave every fixture file byte-identical', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const nodeId = newNode(graphRoot, 'reader-only node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('reader-only')
    const tasks = [
      { taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' },
      { taskId: taskUuid('reader-only-2'), createdAt: '2026-11-01T01:00:00Z', finishedAt: '2026-11-01T01:00:05Z' },
    ]
    writeTasksDb(stateDir, tasks)
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    writeRunDir(stateDir, { taskId: tasks[1]!.taskId, observation: completeObservation() }, 1)

    // SQLite may delete WAL/SHM when the last connection closes. Keep a
    // fixture connection open, with no writes after the snapshot.
    const writer = new Database(path.join(stateDir, 'memory-agent.sqlite'))
    writer.exec('PRAGMA user_version = 1')
    fixtureWriters.push(writer)

    // Snapshot BEFORE the Store.
    expect(fs.existsSync(path.join(stateDir, 'memory-agent.sqlite-wal'))).toBe(true)
    const stateBefore = digestTree(stateDir)
    const graphBefore = digestTree(graphRoot)
    expect([...stateBefore.files.keys()].some((rel) => rel.endsWith('.sqlite-wal'))).toBe(true)

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
    stores.push(store)
    store.start()
    expect(store.runs().runs).toHaveLength(2)
    expect(store.runs().runs.every((run) => run.usageStatus === 'complete')).toBe(true)
    expect(store.graph().nodeById.get(nodeId)).toBeDefined()

    // Several more full refreshes: tasks SELECT, observation reads, graph rebuild.
    for (let i = 0; i < 5; i++) {
      store.rebuildNow()
      store.pollTasks()
    }

    // The GRAPH is untouched: the reader never opens a graph file for writing.
    expect(diff(graphBefore, digestTree(graphRoot))).toEqual([])

    const stateAfter = digestTree(stateDir)
    const changed = diff(stateBefore, stateAfter)

    // What may legitimately change: SQLite readers MAP the -shm/-wal files, so
    // their contents (and possibly their apparent size) can move. Nothing else
    // may, and no NEW file may appear.
    const allowed = changed.filter(
      (rel) => rel.endsWith('memory-agent.sqlite-shm') || rel.endsWith('memory-agent.sqlite-wal'),
    )
    const unexpected = changed.filter((rel) => !allowed.includes(rel))
    expect(unexpected).toEqual([])

    // The MAIN database file must be byte-identical: no reader ever wrote a frame.
    expect(stateAfter.files.get('memory-agent.sqlite')).toBe(stateBefore.files.get('memory-agent.sqlite'))
    // No new file was created anywhere under the state dir.
    expect(changed.some((rel) => rel.startsWith('removed:'))).toBe(false)
    const beforeNames = new Set(stateBefore.files.keys())
    for (const rel of stateAfter.files.keys()) {
      expect(beforeNames.has(rel) || rel.includes('memory-agent.sqlite')).toBe(true)
    }
  }, 30_000)

  test('the main database bytes are unchanged even after many task polls', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'poll node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [
      { taskId: taskUuid('poll-1'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
    ])
    const dbFile = path.join(stateDir, 'memory-agent.sqlite')
    const digest = (): string => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex')
    const before = digest()

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
    stores.push(store)
    store.start()
    for (let i = 0; i < 20; i++) store.pollTasks()
    expect(digest()).toBe(before)
  })
})
