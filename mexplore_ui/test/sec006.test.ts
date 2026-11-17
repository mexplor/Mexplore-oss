// SEC-006 proof by instrumentation (#10): the server must never OPEN a
// content-bearing file and never SELECT a content column.
//
// Response-body assertions alone cannot distinguish "never read" from "read and
// discarded". These tests install the audit hooks, exercise SUCCESSFUL responses
// (a real node, a real attachment, a live SSE stream) and assert the read/SQL
// allowlist directly.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createApp } from '../src/server/app.ts'
import { setFileAudit, type FileAuditOp } from '../src/server/fs-safe.ts'
import { Store } from '../src/server/store.ts'
import { setSqlAudit, TASKS_SQL } from '../src/server/usage/tasks.ts'
import {
  cleanupTemps,
  completeObservation,
  jsonl,
  newNode,
  taskUuid,
  tempDir,
  waitFor,
  writeAttachment,
  writeConfig,
  writeRunDir,
  writeTasksDb,
  serveOnEphemeralPort,
} from './helpers.ts'

const handles: { stop(): Promise<void> }[] = []

afterEach(() => {
  setFileAudit(null)
  setSqlAudit(null)
})

afterAll(async () => {
  for (const handle of handles) await handle.stop()
  cleanupTemps()
})

const FORBIDDEN_FILES = [
  'run-config.json',
  'receipts.jsonl',
  'sufficiency.json',
  'completion.json',
  'runtime-diagnostics.json',
  '.node.md.prev',
  '.notes.md.prev',
  'accessed.log',
]

/** Files whose OPEN would be a SEC-006 violation. */
const FORBIDDEN_BASENAMES = new Set(FORBIDDEN_FILES.filter((name) => name !== 'accessed.log'))

interface Instrumented {
  base: string
  store: Store
  graphRoot: string
  stateDir: string
  nodeId: string
  attachmentName: string
  taskId: string
  stop(): Promise<void>
}

async function instrumented(): Promise<Instrumented> {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  const nodeId = newNode(graphRoot, 'instrumented node', {
    type: 'decision',
    body: 'body text for the canary test',
  })
  const attachmentName = 'notes.md'
  writeAttachment(graphRoot, nodeId, attachmentName, '# Notes\n\nattachment body\n')
  // Decoys that must never be opened.
  writeAttachment(graphRoot, nodeId, '.node.md.prev', 'PREV-CANARY')
  writeAttachment(graphRoot, nodeId, '.notes.md.prev', 'PREV-CANARY')
  writeAttachment(graphRoot, nodeId, '..attach-x', 'TMP-CANARY')
  writeAttachment(graphRoot, nodeId, 'accessed.log', `${nodeId} 2026-11-01T00:00:00Z\n`)
  writeAttachment(graphRoot, nodeId, 'subdir/inner.txt', 'INNER-CANARY')

  const stateDir = path.join(base, 'state')
  const taskId = taskUuid('instrumented')
  writeTasksDb(stateDir, [
    {
      taskId,
      createdAt: '2026-11-01T00:00:00Z',
      finishedAt: '2026-11-01T00:00:05Z',
      requestJson: JSON.stringify({ message: 'REQUEST-JSON-CANARY' }),
    },
  ])
  const runDir = writeRunDir(
    stateDir,
    {
      taskId,
      // An EXTRA FIELD inside a legitimate observation line is the sharp case:
      // the parser must drop it, not merely avoid printing it.
      observation: jsonl([
        { seq: 1, type: 'request_start', requestId: 'r1', message: 'OBS-EXTRA-FIELD-CANARY' },
        {
          seq: 2,
          type: 'request_end',
          requestId: 'r1',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          message: 'OBS-EXTRA-FIELD-CANARY',
          toolResult: 'OBS-EXTRA-FIELD-CANARY',
        },
      ]),
    },
    0,
  )
  for (const name of FORBIDDEN_FILES) {
    fs.writeFileSync(path.join(runDir, name), JSON.stringify({ message: 'FORBIDDEN-FILE-CANARY' }), 'utf8')
  }

  const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
  const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
  store.start()
  const app = createApp({ store, configPath, graphRoot, stateDir, tz: 'UTC', port: 0 })
  const server = serveOnEphemeralPort(app, { idleTimeout: 30 })
  const handle: Instrumented = {
    base: `http://127.0.0.1:${server.port}`,
    store,
    graphRoot,
    stateDir,
    nodeId,
    attachmentName,
    taskId,
    async stop() {
      store.close()
      await server.stop(true)
    },
  }
  handles.push(handle)
  return handle
}

describe('#10: SEC-006 read allowlist', () => {
  test('successful responses never open a content-bearing file', async () => {
    const fixture = await instrumented()
    const ops: { op: FileAuditOp; path: string }[] = []
    const sql: string[] = []
    setFileAudit((op, target) => ops.push({ op, path: target }))
    setSqlAudit((statement) => sql.push(statement))

    // Requests are served from the cached snapshot (GUD-002), so force one real
    // refresh under the audit — that is the code path that reads disk and SQL.
    fixture.store.rebuildNow()

    // Exercise SUCCESS paths, not just 404s.
    const meta = await fetch(`${fixture.base}/api/meta`)
    expect(meta.status).toBe(200)
    const graph = await fetch(`${fixture.base}/api/graph`)
    expect(graph.status).toBe(200)
    const node = await fetch(`${fixture.base}/api/node/${fixture.nodeId}`)
    expect(node.status).toBe(200)
    const nodeBody = (await node.json()) as { attachments: { name: string }[]; body: string }
    expect(nodeBody.body).toContain('body text for the canary test')
    const attachment = await fetch(`${fixture.base}/api/node/${fixture.nodeId}/file/${fixture.attachmentName}`)
    expect(attachment.status).toBe(200)
    expect(await attachment.text()).toContain('attachment body')
    const usage = await fetch(`${fixture.base}/api/usage?from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z`)
    expect(usage.status).toBe(200)
    const usageBody = (await usage.json()) as { combined: { usageRuns: { complete: number } } }
    expect(usageBody.combined.usageRuns.complete).toBe(1)
    const runs = await fetch(`${fixture.base}/api/runs?limit=200`)
    expect(runs.status).toBe(200)
    const search = await fetch(`${fixture.base}/api/search?q=body`)
    expect(search.status).toBe(200)

    // A bounded SSE capture (the stream never closes on its own).
    const controller = new AbortController()
    const stream = await fetch(`${fixture.base}/api/events`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    let sseText = ''
    if (reader !== undefined) {
      const deadline = Date.now() + 1500
      while (Date.now() < deadline && !sseText.includes('"kind":"graph"')) {
        const chunk = await reader.read()
        if (chunk.done) break
        sseText += new TextDecoder().decode(chunk.value)
      }
      controller.abort()
    }
    expect(sseText).toContain('data:')

    // ---- the allowlist assertions -------------------------------------
    const opened = ops.map((entry) => path.basename(entry.path))
    for (const name of opened) {
      expect(FORBIDDEN_BASENAMES.has(name)).toBe(false)
    }
    // Nothing inside runs/ was opened in a way that is not observation.jsonl.
    // (The parse cache may already hold the file, so zero reads is fine here;
    // the sibling test asserts the positive case after a forced change.)
    const runReads = ops.filter(
      (entry) => entry.op === 'read' && entry.path.includes(`${path.sep}runs${path.sep}`),
    )
    for (const entry of runReads) expect(path.basename(entry.path)).toBe('observation.jsonl')
    // Every path touched is inside the graph root or the state dir.
    const canonicalGraph = fs.realpathSync(fixture.graphRoot)
    const canonicalState = fs.realpathSync(fixture.stateDir)
    for (const entry of ops) {
      const resolved = path.resolve(entry.path)
      const inside =
        resolved.startsWith(canonicalGraph + path.sep) ||
        resolved === canonicalGraph ||
        resolved.startsWith(canonicalState + path.sep) ||
        resolved === canonicalState
      expect(inside).toBe(true)
    }
    // Only the allowlisted projection was executed.
    expect(sql.length).toBeGreaterThan(0)
    for (const statement of sql) {
      const upper = statement.toUpperCase()
      if (upper.startsWith('PRAGMA')) {
        expect(['PRAGMA BUSY_TIMEOUT = 2000', 'PRAGMA QUERY_ONLY = 1']).toContain(upper)
        continue
      }
      expect(upper).not.toContain('REQUEST_JSON')
      expect(upper).not.toContain('RESULT_JSON')
    }
    expect(sql.filter((statement) => statement === TASKS_SQL).length).toBeGreaterThan(0)
  }, 20_000)

  test('no response body carries any canary, including the observation extra field', async () => {
    const fixture = await instrumented()
    const canaries = [
      'FORBIDDEN-FILE-CANARY',
      'REQUEST-JSON-CANARY',
      'OBS-EXTRA-FIELD-CANARY',
      'PREV-CANARY',
      'INNER-CANARY',
    ]
    const endpoints = [
      '/api/meta',
      '/api/graph',
      `/api/node/${fixture.nodeId}`,
      '/api/usage?from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z',
      '/api/runs?limit=200&from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z',
      '/api/search?q=CANARY',
      '/api/search?q=',
    ]
    for (const endpoint of endpoints) {
      const body = await (await fetch(`${fixture.base}${endpoint}`)).text()
      for (const canary of canaries) expect(body).not.toContain(canary)
    }
  })

  test('the run row carries only the six contract fields even with extra event fields', async () => {
    const fixture = await instrumented()
    const page = (await (await fetch(`${fixture.base}/api/runs?limit=200&from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z`)).json()) as {
      runs: Record<string, unknown>[]
    }
    expect(page.runs).toHaveLength(1)
    expect(Object.keys(page.runs[0] as object).sort()).toEqual([
      'authority',
      'createdAt',
      'latencyMs',
      'taskId',
      'usage',
      'usageStatus',
    ])
    expect(page.runs[0]?.['usageStatus']).toBe('complete')
    expect(JSON.stringify(page)).not.toContain('OBS-EXTRA-FIELD-CANARY')
  })

  test('the graph snapshot keeps no attachment bytes, only name/size/mtime', async () => {
    const fixture = await instrumented()
    const detail = (await (await fetch(`${fixture.base}/api/node/${fixture.nodeId}`)).json()) as {
      attachments: Record<string, unknown>[]
    }
    const names = detail.attachments.map((attachment) => attachment['name'])
    expect(names).toContain('notes.md')
    expect(names).not.toContain('.node.md.prev')
    expect(names).not.toContain('accessed.log')
    expect(names).not.toContain('subdir')
    for (const attachment of detail.attachments) {
      expect(Object.keys(attachment).sort()).toEqual(['mtime', 'name', 'size'])
    }
  })

  test('a request for a forbidden sibling is refused without opening it', async () => {
    const fixture = await instrumented()
    const ops: { op: FileAuditOp; path: string }[] = []
    setFileAudit((op, target) => ops.push({ op, path: target }))

    for (const name of ['.node.md.prev', '.notes.md.prev', 'accessed.log', 'subdir']) {
      const response = await fetch(`${fixture.base}/api/node/${fixture.nodeId}/file/${encodeURIComponent(name)}`)
      expect([400, 404]).toContain(response.status)
    }
    // The only paths consulted are the requested ones, and none is read.
    const reads = ops.filter((entry) => entry.op === 'read').map((entry) => path.basename(entry.path))
    for (const name of ['.node.md.prev', '.notes.md.prev']) expect(reads).not.toContain(name)
  })
})

describe('#10: the store never opens forbidden run files across refreshes', () => {
  test('repeated rebuilds touch observation.jsonl and nothing else in runs/', async () => {
    const fixture = await instrumented()
    const ops: { op: FileAuditOp; path: string }[] = []
    const runReads = (): string[] =>
      ops
        .filter((entry) => entry.op === 'read' && entry.path.includes(`${path.sep}runs${path.sep}`))
        .map((entry) => path.basename(entry.path))

    setFileAudit((op, target) => ops.push({ op, path: target }))
    // Unchanged files are served from the parse cache — no re-read at all.
    for (let i = 0; i < 3; i++) fixture.store.rebuildNow()
    expect(runReads()).toEqual([])

    // After a real change the only file opened in runs/ is observation.jsonl.
    const runDir = path.join(
      fixture.stateDir,
      'runs',
      fixture.taskId,
      fs.readdirSync(path.join(fixture.stateDir, 'runs', fixture.taskId))[0] as string,
    )
    fs.utimesSync(path.join(runDir, 'observation.jsonl'), new Date(), new Date(Date.now() + 5000))
    fixture.store.rebuildNow()
    const reads = runReads()
    expect(reads.length).toBeGreaterThan(0)
    for (const name of reads) expect(name).toBe('observation.jsonl')
  })

  test('an SSE client receives only invalidation kinds, never payloads', async () => {
    const fixture = await instrumented()
    const controller = new AbortController()
    const response = await fetch(`${fixture.base}/api/events`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
    const reader = response.body?.getReader()
    let text = ''
    if (reader !== undefined) {
      const deadline = Date.now() + 1200
      while (Date.now() < deadline && !text.includes('"kind":"graph"')) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += new TextDecoder().decode(chunk.value)
      }
      controller.abort()
    }
    const payloads = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { kind: string; id?: string })
    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      expect(['graph', 'node', 'access', 'run']).toContain(payload.kind)
      expect(Object.keys(payload).sort()).toEqual(payload.id === undefined ? ['kind'] : ['id', 'kind'])
    }
    expect(text).not.toContain('FORBIDDEN-FILE-CANARY')
  })
})
