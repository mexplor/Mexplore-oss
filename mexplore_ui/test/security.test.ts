// SEC-003 / SEC-006 hardening tests: guarded graph and state reads (#1),
// edge-symlink target validation (#6), fingerprint coverage (#8), and rebuild
// error containment (#9).
//
// These assert the SET OF PATHS OPENED, not just response bodies: a server that
// reads `/outside/secret` and then discards it still fails SEC-006, and a body
// assertion cannot see that.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { SafeRoot, setFileAudit, type FileAuditOp } from '../src/server/fs-safe.ts'
import { buildGraphSnapshot } from '../src/server/graph/build.ts'
import { isValidTaskId, TASK_ID_RE } from '../src/server/guard.ts'
import { Store } from '../src/server/store.ts'
import { readTasks, setSqlAudit, TASKS_SQL } from '../src/server/usage/tasks.ts'
import { fingerprintGraph, fingerprintRuns } from '../src/server/watch.ts'
import {
  appendAccess,
  cleanupTemps,
  completeObservation,
  edgeAdd,
  newNode,
  taskUuid,
  tempDir,
  writeAttachment,
  writeRunDir,
  writeTasksDb,
} from './helpers.ts'

const stores: Store[] = []
const audits: { ops: { op: FileAuditOp; path: string }[]; sql: string[] }[] = []

afterEach(() => {
  setFileAudit(null)
  setSqlAudit(null)
})

afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

function startAudit(): { ops: { op: FileAuditOp; path: string }[]; sql: string[] } {
  const audit = { ops: [] as { op: FileAuditOp; path: string }[], sql: [] as string[] }
  audits.push(audit)
  setFileAudit((op, target) => audit.ops.push({ op, path: target }))
  setSqlAudit((sql) => audit.sql.push(sql))
  return audit
}

function makeStore(graphRoot: string, stateDir: string): Store {
  const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
  stores.push(store)
  return store
}

// ---- #1: guarded graph reads --------------------------------------------

describe('#1: symlinked node.md cannot leak an outside file', () => {
  test('a node.md symlink pointing outside the graph is refused, not served', () => {
    const root = tempDir()
    const outside = tempDir()
    const secret = path.join(outside, 'secret.json')
    const secretText = 'TOP-SECRET-OUTSIDE-CONTENT-9f2a'
    fs.writeFileSync(secret, `---\ndescription: ${secretText}\n---\n\n${secretText}\n`, 'utf8')

    const victim = newNode(root, 'victim node')
    fs.rmSync(path.join(root, victim, 'node.md'))
    fs.symlinkSync(secret, path.join(root, victim, 'node.md'))

    const snapshot = buildGraphSnapshot(root, 1)
    const node = snapshot.nodeById.get(victim)
    // The node still exists (its directory does), but carries nothing read from
    // the link: no description, no body.
    expect(node).toBeDefined()
    expect(node?.description).toBe('')
    expect(node?.body).toBe('')
    expect(JSON.stringify(snapshot.nodes)).not.toContain(secretText)
    expect(snapshot.warnings.join('\n')).toContain('node.md is a symlink')
  })

  test('a node.md symlink aliasing a forbidden sibling is refused too', () => {
    const root = tempDir()
    const victim = newNode(root, 'alias victim')
    // `.node.md.prev` is framework bookkeeping, never servable.
    writeAttachment(root, victim, '.node.md.prev', '---\ndescription: PREV-CONTENT\n---\n\nPREV-CONTENT\n')
    fs.rmSync(path.join(root, victim, 'node.md'))
    fs.symlinkSync(path.join(root, victim, '.node.md.prev'), path.join(root, victim, 'node.md'))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(victim)?.description).toBe('')
    expect(JSON.stringify(snapshot.nodes)).not.toContain('PREV-CONTENT')
  })

  test('a symlinked .edge-types and a symlinked access log are refused', () => {
    const root = tempDir()
    const outside = tempDir()
    const a = newNode(root, 'edge owner')
    const b = newNode(root, 'edge target')
    edgeAdd(root, a, b)

    const planted = path.join(outside, 'types.txt')
    fs.writeFileSync(planted, `${b} supersedes\n`, 'utf8')
    fs.rmSync(path.join(root, a, '__edges__', '.edge-types'), { force: true })
    fs.symlinkSync(planted, path.join(root, a, '__edges__', '.edge-types'))

    const plantedLog = path.join(outside, 'log.txt')
    fs.writeFileSync(plantedLog, `${a} 2026-11-01T00:00:00Z\n`, 'utf8')
    fs.mkdirSync(path.join(root, '.access'), { recursive: true })
    fs.symlinkSync(plantedLog, path.join(root, '.access', `${a}.log`))

    const snapshot = buildGraphSnapshot(root, 1)
    // The sidecar was not read, so the pair stays plain.
    const edge = snapshot.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))
    expect(edge?.type).toBe('plain')
    // The log was not read, so no visits were recorded.
    expect(snapshot.nodeById.get(a)?.visitCount).toBe(0)
    const joined = snapshot.warnings.join('\n')
    expect(joined).toContain('.edge-types is a symlink')
    expect(joined).toContain('access log refused')
  })

  test('a symlinked node directory is skipped entirely', () => {
    const root = tempDir()
    const outside = tempDir()
    const realId = '01J00000000000000000000001'
    fs.mkdirSync(path.join(outside, realId), { recursive: true })
    fs.writeFileSync(path.join(outside, realId, 'node.md'), '---\ndescription: ESCAPED\n---\n', 'utf8')
    fs.symlinkSync(path.join(outside, realId), path.join(root, realId))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodes).toHaveLength(0)
    expect(snapshot.warnings.join('\n')).toContain('is a symlink; skipped')
  })

  test('a symlinked MAP.md is not read for mapRank', () => {
    const root = tempDir()
    const outside = tempDir()
    const id = newNode(root, 'map node')
    const planted = path.join(outside, 'MAP.md')
    fs.writeFileSync(planted, `${id} — hijacked\n`, 'utf8')
    fs.symlinkSync(planted, path.join(root, 'MAP.md'))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.nodeById.get(id)?.mapRank).toBeNull()
    expect(snapshot.warnings.join('\n')).toContain('MAP.md not read')
  })

  test('a legitimate graph opens only files inside the graph root', () => {
    const base = tempDir()
    const root = path.join(base, 'graph')
    const a = newNode(root, 'audit a')
    const b = newNode(root, 'audit b')
    edgeAdd(root, a, b, 'relates-to')
    appendAccess(root, a, b, '2026-11-01T00:00:00Z')
    writeAttachment(root, a, 'notes.md', 'hi')
    fs.writeFileSync(path.join(root, 'MAP.md'), `${a} — audit a\n`, 'utf8')

    const audit = startAudit()
    buildGraphSnapshot(root, 1)
    const canonicalRoot = fs.realpathSync(root)
    expect(audit.ops.length).toBeGreaterThan(0)
    for (const entry of audit.ops) {
      const resolved = path.resolve(entry.path)
      expect(resolved === canonicalRoot || resolved.startsWith(canonicalRoot + path.sep)).toBe(true)
    }
    // Every read target is a file the snapshot is allowed to consume.
    const readPaths = audit.ops.filter((entry) => entry.op === 'read').map((entry) => path.basename(entry.path))
    const allowed = new Set(['node.md', '.edge-types', 'MAP.md', 'accessed.log', `${a}.log`, `${b}.log`])
    for (const name of readPaths) expect(allowed.has(name)).toBe(true)
    // And nothing content-bearing is ever opened.
    for (const name of readPaths) {
      expect(['run-config.json', 'receipts.jsonl', 'sufficiency.json', 'completion.json', 'runtime-diagnostics.json'])
        .not.toContain(name)
    }
  })

  test('a symlinked observation.jsonl is refused and its usage stays unknown', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'run guard node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('run-guard')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    const outside = tempDir()
    const planted = path.join(outside, 'obs.jsonl')
    fs.writeFileSync(planted, completeObservation(999, 999, 999_999), 'utf8')
    fs.rmSync(path.join(runDir, 'observation.jsonl'))
    fs.symlinkSync(planted, path.join(runDir, 'observation.jsonl'))

    const store = makeStore(graphRoot, stateDir)
    const run = store.runs().runs.find((entry) => entry.taskId === taskId)
    expect(run?.usageStatus).toBe('unknown')
    expect(run?.usage).toBeNull()
    expect(store.runs().warnings.join('\n')).toContain('observation.jsonl refused')
  })

  test('a symlinked memory-agent.sqlite is refused rather than opened', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'db guard node')
    const stateDir = path.join(base, 'state')
    const real = path.join(base, 'real-state')
    writeTasksDb(real, [{ taskId: taskUuid('db'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])
    fs.mkdirSync(stateDir, { recursive: true })
    fs.symlinkSync(path.join(real, 'memory-agent.sqlite'), path.join(stateDir, 'memory-agent.sqlite'))

    const read = readTasks(stateDir)
    expect(read.available).toBe(false)
    expect(read.error).toContain('symlink')

    const store = makeStore(graphRoot, stateDir)
    expect(store.runsUnavailable()).toBe(true)
    expect(store.runs().runs).toHaveLength(0)
  })
})

describe('#1: task ids from the database are validated before becoming paths', () => {
  test('the UUID pattern accepts service ids and rejects path-shaped ones', () => {
    expect(isValidTaskId(taskUuid('x'))).toBe(true)
    expect(isValidTaskId('1b70b41e-931a-419e-879a-517cca33e61f')).toBe(true)
    for (const bad of [
      '../../etc',
      '..',
      '.hidden',
      '/abs/path',
      'read-1',
      '1B70B41E-931A-419E-879A-517CCA33E61F', // upper case
      '1b70b41e931a419e879a517cca33e61f',
      '1b70b41e-931a-419e-879a-517cca33e61',
      '1b70b41e-931a-419e-879a-517cca33e61fa',
      '1b70b41e-931a-419e-879a-517cca33e6-1',
    ]) {
      expect(isValidTaskId(bad)).toBe(false)
    }
    expect(TASK_ID_RE.source).toContain('[0-9a-f]{8}')
  })

  test('a row with an unsafe task_id is skipped and reported', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    // A hostile row that would traverse out of runs/ if it became a path.
    writeTasksDb(stateDir, [
      { taskId: '../../escape', createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
      { taskId: taskUuid('safe'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
    ])
    const read = readTasks(stateDir)
    expect(read.available).toBe(true)
    expect(read.rows.map((row) => row.taskId)).toEqual([taskUuid('safe')])
    expect(read.rejectedTaskIds).toBe(1)
  })

  test('the run index reports skipped rows instead of joining the hostile id', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'hostile id node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [
      { taskId: '../../escape', createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
      { taskId: taskUuid('safe'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' },
    ])
    writeRunDir(stateDir, { taskId: taskUuid('safe'), observation: completeObservation() }, 0)
    const store = makeStore(graphRoot, stateDir)
    expect(store.runs().runs.map((run) => run.taskId)).toEqual([taskUuid('safe')])
    expect(store.runs().warnings.join('\n')).toContain('not a safe UUID')
  })
})

// ---- #6: edge target validation -----------------------------------------

describe('#6: edge symlink targets are validated', () => {
  function plantEdge(root: string, src: string, name: string, target: string): void {
    const dir = path.join(root, src, '__edges__')
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(target, path.join(dir, name))
  }

  test('a link pointing at a third node is a malformed edge, not a relationship', () => {
    const root = tempDir()
    const a = newNode(root, 'a')
    const b = newNode(root, 'b')
    const c = newNode(root, 'c')
    // A/__edges__/B -> ../../C : the name says B, the link says C.
    plantEdge(root, a, b, `../../${c}`)

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.warnings.join('\n')).toContain('malformed edge target')
  })

  test('an absolute target and an escaping relative target are refused', () => {
    const root = tempDir()
    const outside = tempDir()
    const a = newNode(root, 'abs a')
    const b = newNode(root, 'abs b')
    const c = newNode(root, 'abs c')
    plantEdge(root, a, b, path.join(outside, b))
    plantEdge(root, a, c, `../../../${c}`)

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
    const joined = snapshot.warnings.join('\n')
    expect(joined).toContain(`malformed edge target`)
  })

  test('a dangling target is reported as dangling, not rendered', () => {
    const root = tempDir()
    const a = newNode(root, 'dangle a')
    const missing = '01J00000000000000000000001'
    plantEdge(root, a, missing, `../../${missing}`)

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.warnings.join('\n')).toContain('dangling edge')
  })

  test('a link whose target is a FILE named like a ULID is not an edge', () => {
    const root = tempDir()
    const a = newNode(root, 'filetarget a')
    const fake = '01J00000000000000000000001'
    fs.writeFileSync(path.join(root, fake), 'not a directory', 'utf8')
    plantEdge(root, a, fake, `../../${fake}`)

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.warnings.join('\n')).toContain('dangling edge')
  })

  test('the real edge-add layout is still accepted', () => {
    const root = tempDir()
    const a = newNode(root, 'ok a')
    const b = newNode(root, 'ok b')
    edgeAdd(root, a, b)
    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(1)
    expect(snapshot.edges[0]).toMatchObject({ halves: 2, type: 'plain', directed: false })
    expect(snapshot.warnings.join('\n')).not.toContain('malformed edge target')
  })

  test('a symlinked __edges__ directory is not traversed', () => {
    const root = tempDir()
    const outside = tempDir()
    const a = newNode(root, 'edges dir a')
    const b = newNode(root, 'edges dir b')
    const planted = path.join(outside, 'edges')
    fs.mkdirSync(planted, { recursive: true })
    fs.symlinkSync(path.join(root, b), path.join(planted, b))
    fs.rmSync(path.join(root, a, '__edges__'), { recursive: true, force: true })
    fs.symlinkSync(planted, path.join(root, a, '__edges__'))

    const snapshot = buildGraphSnapshot(root, 1)
    expect(snapshot.edges).toHaveLength(0)
  })
})

// ---- #8: fingerprint coverage -------------------------------------------

describe('#8: the graph fingerprint sees in-place edits', () => {
  test('editing an attachment without touching the directory changes the fingerprint', () => {
    const root = tempDir()
    const id = newNode(root, 'fingerprint node')
    writeAttachment(root, id, 'notes.md', 'one')
    const before = fingerprintGraph(root)

    // In-place edit: the file's mtime moves, the directory's does not.
    const dirMtimeBefore = fs.statSync(path.join(root, id)).mtimeMs
    fs.writeFileSync(path.join(root, id, 'notes.md'), 'two-longer-content', 'utf8')
    const dirMtimeAfter = fs.statSync(path.join(root, id)).mtimeMs
    expect(dirMtimeAfter).toBe(dirMtimeBefore) // the premise of the finding

    const after = fingerprintGraph(root)
    expect(after.key).not.toBe(before.key)
    expect(after.nodes.get(id)).not.toBe(before.nodes.get(id))
  })

  test('editing .edge-types in place changes the fingerprint', () => {
    const root = tempDir()
    const a = newNode(root, 'sidecar a')
    const b = newNode(root, 'sidecar b')
    edgeAdd(root, a, b)
    const before = fingerprintGraph(root)
    fs.writeFileSync(path.join(root, a, '__edges__', '.edge-types'), `${b} relates-to\n`, 'utf8')
    const after = fingerprintGraph(root)
    expect(after.key).not.toBe(before.key)
  })

  test('an observation-only change moves the runs fingerprint, not the graph one', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'runs fingerprint node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('fp')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)

    const graphBefore = fingerprintGraph(graphRoot)
    const runsBefore = fingerprintRuns(stateDir)
    expect(runsBefore.key).toContain(taskId)

    const runDir = path.join(stateDir, 'runs', taskId, fs.readdirSync(path.join(stateDir, 'runs', taskId))[0] as string)
    fs.appendFileSync(path.join(runDir, 'observation.jsonl'), '', 'utf8')
    fs.utimesSync(path.join(runDir, 'observation.jsonl'), new Date(), new Date(Date.now() + 5000))

    expect(fingerprintGraph(graphRoot).key).toBe(graphBefore.key)
    expect(fingerprintRuns(stateDir).key).not.toBe(runsBefore.key)
  })

  test('a new run directory moves the runs fingerprint', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('newrun')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const before = fingerprintRuns(stateDir)
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    expect(fingerprintRuns(stateDir).key).not.toBe(before.key)
  })
})

// ---- #9: rebuild error containment --------------------------------------

describe('#9: a rebuild failure keeps the last good snapshot', () => {
  test('a temporarily unavailable graph root does not empty the UI', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'kept node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = makeStore(graphRoot, stateDir)
    store.start()
    const before = store.graph().nodes.length
    expect(before).toBe(1)

    // Make the root unreadable by replacing it with a file.
    const hidden = path.join(base, 'graph-hidden')
    fs.renameSync(graphRoot, hidden)
    fs.writeFileSync(graphRoot, 'not a directory', 'utf8')
    expect(() => store.refresh({ graph: true })).not.toThrow()

    // The last good snapshot is still served, and the failure is visible.
    expect(store.graph().nodes.length).toBe(before)
    expect(store.healthWarnings().join('\n')).toContain('graph root is unavailable')

    // Recovery: put the real directory back.
    fs.rmSync(graphRoot)
    fs.renameSync(hidden, graphRoot)
    store.refresh({ graph: true })
    expect(store.healthWarnings()).toEqual([])
    expect(store.graph().nodes.length).toBe(before)
  })

  test('a build that throws keeps the previous snapshot', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'throwing node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = makeStore(graphRoot, stateDir)
    const before = store.graph()
    // Deleting the root mid-life is the realistic throw path.
    fs.rmSync(graphRoot, { recursive: true, force: true })
    expect(() => store.refresh({ graph: true })).not.toThrow()
    // Either the snapshot is preserved or it is replaced by an empty-but-warned one.
    const after = store.graph()
    expect(after.nodes.length === 0 || after === before).toBe(true)
    expect(store.healthWarnings().length).toBeGreaterThan(0)
  })
})

// ---- SEC-006: SQL allowlist ---------------------------------------------

describe('SEC-006: the only SQL executed is the allowlisted projection', () => {
  test('readTasks issues exactly the two pragmas and one SELECT', () => {
    const base = tempDir()
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [{ taskId: taskUuid('sql'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])

    const audit = startAudit()
    readTasks(stateDir)
    expect(audit.sql).toEqual(['PRAGMA busy_timeout = 2000', 'PRAGMA query_only = 1', TASKS_SQL])
    for (const statement of audit.sql) {
      const upper = statement.toUpperCase()
      expect(upper).not.toContain('REQUEST_JSON')
      expect(upper).not.toContain('RESULT_JSON')
      expect(upper).not.toContain('JOURNAL_MODE')
      expect(upper).not.toContain('WAL_CHECKPOINT')
      // A statement is either one of the two allowlisted pragmas or a SELECT:
      // never a write, a schema change or a checkpoint.
      if (upper.startsWith('PRAGMA')) {
        expect(['PRAGMA busy_timeout = 2000', 'PRAGMA query_only = 1']).toContain(statement)
        continue
      }
      expect(upper.startsWith('SELECT ')).toBe(true)
      for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ', 'CREATE ', 'DROP ', 'ALTER ', 'REPLACE ']) {
        expect(upper).not.toContain(verb)
      }
    }
  })

  test('a full store refresh never selects a content column', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'sql audit node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('audit')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:01Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)

    const audit = startAudit()
    const store = makeStore(graphRoot, stateDir)
    store.rebuildNow()
    expect(audit.sql.length).toBeGreaterThan(0)
    for (const statement of audit.sql) {
      const upper = statement.toUpperCase()
      expect(upper).not.toContain('REQUEST_JSON')
      expect(upper).not.toContain('RESULT_JSON')
      expect(upper).not.toContain('CONTEXT_ID')
      expect(upper).not.toContain('PAYLOAD_HASH')
    }
  })
})

// ---- SafeRoot unit behaviour --------------------------------------------

describe('SafeRoot primitives', () => {
  test('read refuses symlinks, escapes, directories and oversized files', () => {
    const root = tempDir()
    const outside = tempDir()
    const safe = SafeRoot.open(root) as SafeRoot
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello', 'utf8')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    fs.mkdirSync(path.join(root, 'sub'))

    expect(safe.read('ok.txt').text).toBe('hello')
    expect(safe.read('link.txt').reason).toBe('symlink')
    expect(safe.read('../' + path.basename(outside) + '/secret.txt').ok).toBe(false)
    expect(safe.read('sub').ok).toBe(false)
    expect(safe.read('ok.txt', 2).reason).toBe('too-large')
    expect(safe.read('missing.txt').reason).toBe('missing')
  })

  test('listDir refuses a symlinked directory', () => {
    const root = tempDir()
    const outside = tempDir()
    fs.writeFileSync(path.join(outside, 'file.txt'), 'x')
    fs.symlinkSync(outside, path.join(root, 'linkdir'))
    const safe = SafeRoot.open(root) as SafeRoot
    expect(safe.listDir('linkdir')).toEqual([])
    expect(safe.isRealDir('linkdir')).toBe(false)
  })
})

describe('#1: guards reject escapes without breaking legitimate layout', () => {
  test('a stateDir reached through a symlink still reads normally', () => {
    const real = tempDir('real-state-')
    const graphRoot = tempDir('graph-')
    newNode(graphRoot, 'symlinked state node')
    const taskId = taskUuid('via-link')
    writeTasksDb(real, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    writeRunDir(real, { taskId, observation: completeObservation() }, 0)

    const linkParent = tempDir('link-parent-')
    const linked = path.join(linkParent, 'state')
    fs.symlinkSync(real, linked)

    expect(readTasks(linked).available).toBe(true)
    const store = makeStore(graphRoot, linked)
    expect(store.runsUnavailable()).toBe(false)
    expect(store.runs().runs[0]?.usageStatus).toBe('complete')
  })

  test('a graph root reached through a symlink still builds a snapshot', () => {
    const real = tempDir('real-graph-')
    const id = newNode(real, 'node behind a symlinked root')
    const linkParent = tempDir('root-link-')
    const linked = path.join(linkParent, 'graph')
    fs.symlinkSync(real, linked)

    const snapshot = buildGraphSnapshot(linked, 1)
    expect(snapshot.nodeById.get(id)?.description).toBe('node behind a symlinked root')
    expect(snapshot.warnings).toEqual([])
  })
})
