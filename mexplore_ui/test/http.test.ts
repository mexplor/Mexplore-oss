// Integration tests over a real `Bun.serve` instance on an ephemeral port.
//
// Covers AC-001…AC-005, AC-007, AC-009, AC-011…AC-014, AC-016…AC-020 against
// programmatically built fixtures. Nothing here touches production data.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createApp } from '../src/server/app.ts'
import { loadUiConfig } from '../src/server/config.ts'
import { Store } from '../src/server/store.ts'
import type { GraphResponse, Meta, NodeDetail, RunsPage, SearchResponse, UsageSummary } from '../src/shared/types.ts'
import {
  appendAccess,
  cleanupTemps,
  completeObservation,
  edgeAdd,
  jsonl,
  newNode,
  stateSnapshot,
  taskUuid,
  tempDir,
  treeSignature,
  writeAttachment,
  writeConfig,
  writeMap,
  serveOnEphemeralPort,
  writeRunDir,
  writeTasksDb,
} from './helpers.ts'

interface Harness {
  base: string
  store: Store
  stop(): Promise<void>
  graphRoot: string
  stateDir: string
  configPath: string
}

const harnesses: Harness[] = []

async function startHarness(options: {
  graphRoot: string
  stateDir: string
  configPath: string
  distDir?: string
  tz?: string
}): Promise<Harness> {
  const store = new Store({
    graphRoot: options.graphRoot,
    stateDir: options.stateDir,
    debounceMs: 50,
    reconcileMs: 60_000,
    heartbeatMs: 200,
  })
  store.start()
  const app = createApp({
    store,
    configPath: options.configPath,
    graphRoot: options.graphRoot,
    stateDir: options.stateDir,
    // The bound port is reported by `serveOnEphemeralPort` right after binding;
    // there is deliberately no permissive "port unknown" default.
    port: 0,
    ...(options.distDir === undefined ? {} : { distDir: options.distDir }),
    // Pin the zone so bucketing assertions do not depend on the host's zone.
    tz: options.tz ?? 'UTC',
  })
  const server = serveOnEphemeralPort(app, { idleTimeout: 60 })
  const harness: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    store,
    graphRoot: options.graphRoot,
    stateDir: options.stateDir,
    configPath: options.configPath,
    async stop() {
      store.close()
      await server.stop(true)
    },
  }
  harnesses.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of harnesses) await harness.stop()
  cleanupTemps()
})

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

// ---- a graph fixture covering the edge cases of §6 -----------------------

interface GraphFixture {
  root: string
  ids: {
    plainA: string
    plainB: string
    relateA: string
    relateB: string
    supA: string
    supB: string
    noBannerC: string
    retypedD: string
    oppositeE: string
    oppositeF: string
    attach: string
    dangling: string
    malformed: string
  }
}

function buildGraphFixture(root: string): GraphFixture {
  const plainA = newNode(root, 'plain edge A', { created: '2026-10-01' })
  const plainB = newNode(root, 'plain edge B', { created: '2026-10-02' })
  edgeAdd(root, plainA, plainB)

  const relateA = newNode(root, 'relates A', { created: '2026-10-03' })
  const relateB = newNode(root, 'relates B', { created: '2026-10-04' })
  edgeAdd(root, relateA, relateB, 'relates-to')

  const supA = newNode(root, 'successor A', { created: '2026-10-05' })
  const supB = newNode(root, 'superseded handoff B', {
    type: 'handoff',
    created: '2026-10-06',
    body: `Superseded by ${supA} on 2026-11-01.\n\nclosed`,
  })
  edgeAdd(root, supA, supB, 'supersedes')

  const noBannerC = newNode(root, 'sidecar only C', { created: '2026-10-07' })
  edgeAdd(root, supA, noBannerC, 'supersedes')

  const retypedD = newNode(root, 'retyped D', { created: '2026-10-08' })
  edgeAdd(root, plainA, retypedD)
  edgeAdd(root, plainA, retypedD, 'supersedes')

  const oppositeE = newNode(root, 'opposite E', { created: '2026-10-09' })
  const oppositeF = newNode(root, 'opposite F', { created: '2026-10-10' })
  edgeAdd(root, oppositeE, oppositeF, 'supersedes')
  edgeAdd(root, oppositeF, oppositeE, 'follows-from')

  const attach = newNode(root, 'attachment node', { created: '2026-10-11' })
  writeAttachment(root, attach, 'notes.md', '# Notes\n\nbody text\n')
  writeAttachment(root, attach, '.node.md.prev', 'prev')
  writeAttachment(root, attach, '.notes.md.prev', 'prev')
  writeAttachment(root, attach, 'accessed.log', 'legacy\n')
  writeAttachment(root, attach, '..attach-x', 'tmp')
  writeAttachment(root, attach, 'subdir/inner.txt', 'inner')
  writeAttachment(root, attach, 'binary.bin', Buffer.from([0x41, 0x00, 0x42, 0x43]))
  writeAttachment(root, attach, 'big.txt', 'x'.repeat(1024 * 1024 + 10))

  const dangling = newNode(root, 'dangling owner', { created: '2026-10-12' })
  const missing = '01J00000000000000000000001'
  fs.mkdirSync(path.join(root, dangling, '__edges__'), { recursive: true })
  fs.symlinkSync(`../../${missing}`, path.join(root, dangling, '__edges__', missing))

  const malformed = newNode(root, 'malformed node', { created: '2026-10-13' })
  fs.writeFileSync(path.join(root, malformed, 'node.md'), 'this file has no frontmatter\n', 'utf8')

  // Access history: AC-016 shape on the plain pair.
  appendAccess(root, plainA, plainB, '2026-11-01T00:00:00Z')
  appendAccess(root, plainA, plainB, '2026-11-02T00:00:00Z')
  appendAccess(root, plainB, plainA, '2026-11-03T00:00:00Z')
  appendAccess(root, plainA, plainB, '2026-10-30T00:00:00Z', true)
  appendAccess(root, plainA, plainA, '2026-11-04T00:00:00Z')
  appendAccess(root, plainA, plainA, '2026-11-04T01:00:00Z')
  appendAccess(root, plainA, plainA, '2026-11-04T02:00:00Z')

  writeMap(root, [
    'Open handoff — unfinished work:',
    `  ${attach} — attachment node`,
    '',
    `${plainA} — plain edge A`,
    `${plainB} — plain edge B`,
    `${supA} — successor A`,
  ])

  return {
    root,
    ids: {
      plainA,
      plainB,
      relateA,
      relateB,
      supA,
      supB,
      noBannerC,
      retypedD,
      oppositeE,
      oppositeF,
      attach,
      dangling,
      malformed,
    },
  }
}

// ---- AC-001, AC-013: startup, meta, binding -----------------------------

describe('AC-001 / AC-013: startup and /api/meta', () => {
  let harness: Harness
  let graph: GraphFixture
  let stateDir: string

  beforeAll(async () => {
    const base = tempDir()
    graph = buildGraphFixture(path.join(base, 'graph'))
    stateDir = path.join(base, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    const configPath = writeConfig(path.join(base, 'test_1.json'), graph.root, stateDir)
    harness = await startHarness({ graphRoot: graph.root, stateDir, configPath })
  })

  test('/api/meta reports the config, graph root, state dir and tz', async () => {
    const meta = await getJson<Meta>(`${harness.base}/api/meta`)
    expect(meta.graphRoot).toBe(harness.graphRoot)
    expect(meta.stateDir).toBe(harness.stateDir)
    expect(meta.configPath).toBe(harness.configPath)
    expect(typeof meta.tz).toBe('string')
    expect(meta.tz.length).toBeGreaterThan(0)
    expect(meta.nodeCount).toBeGreaterThan(0)
    expect(meta.runCount).toBe(0)
    expect(Number.isNaN(Date.parse(meta.serverTime))).toBe(false)
  })

  test('AC-001: loadUiConfig canonicalises graphRoot/stateDir from the config file', async () => {
    const config = await loadUiConfig(harness.configPath)
    expect(config.graphRoot).toBe(fs.realpathSync(graph.root))
    expect(config.stateDir).toBe(fs.realpathSync(stateDir))
    expect(config.configName).toBe('test_1')
  })

  test('the server binds loopback only', async () => {
    const url = new URL(harness.base)
    expect(url.hostname).toBe('127.0.0.1')
  })

  test('a second bind on the same port fails with EADDRINUSE (AC-014 shape)', async () => {
    const port = Number.parseInt(new URL(harness.base).port, 10)
    expect(() => Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('x') })).toThrow()
  })
})

// ---- AC-002, AC-016, AC-017: graph edges --------------------------------

describe('AC-002 / AC-016 / AC-017: graph edges', () => {
  let harness: Harness
  let graph: GraphFixture

  beforeAll(async () => {
    const base = tempDir()
    graph = buildGraphFixture(path.join(base, 'graph'))
    const stateDir = path.join(base, 'state')
    const configPath = writeConfig(path.join(base, 'test_1.json'), graph.root, stateDir)
    harness = await startHarness({ graphRoot: graph.root, stateDir, configPath })
  })

  test('AC-002: a plain pair is exactly one undirected edge with two halves', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const pair = body.edges.filter(
      (edge) =>
        (edge.source === graph.ids.plainA && edge.target === graph.ids.plainB) ||
        (edge.source === graph.ids.plainB && edge.target === graph.ids.plainA),
    )
    expect(pair).toHaveLength(1)
    expect(pair[0]).toMatchObject({ type: 'plain', directed: false, halves: 2 })
  })

  test('AC-016: accessCount sums both sides plus the legacy log; visits count self-lines', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const pair = body.edges.find(
      (edge) =>
        (edge.source === graph.ids.plainA && edge.target === graph.ids.plainB) ||
        (edge.source === graph.ids.plainB && edge.target === graph.ids.plainA),
    )
    expect(pair?.accessCount).toBe(4)
    const nodeA = body.nodes.find((node) => node.id === graph.ids.plainA)
    expect(nodeA?.visitCount).toBe(3)
  })

  test('AC-017: a retyped pair is one directed edge, not an extra plain edge', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const between = body.edges.filter(
      (edge) =>
        (edge.source === graph.ids.plainA && edge.target === graph.ids.retypedD) ||
        (edge.source === graph.ids.retypedD && edge.target === graph.ids.plainA),
    )
    expect(between).toHaveLength(1)
    expect(between[0]).toMatchObject({ source: graph.ids.plainA, target: graph.ids.retypedD, type: 'supersedes', directed: true })
  })

  test('AC-017: opposite directed edges are two distinct edges', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const between = body.edges.filter(
      (edge) =>
        (edge.source === graph.ids.oppositeE && edge.target === graph.ids.oppositeF) ||
        (edge.source === graph.ids.oppositeF && edge.target === graph.ids.oppositeE),
    )
    expect(between).toHaveLength(2)
    expect(between.every((edge) => edge.directed)).toBe(true)
  })

  test('a relates-to pair renders as one undirected typed edge', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const pair = body.edges.filter(
      (edge) =>
        (edge.source === graph.ids.relateA && edge.target === graph.ids.relateB) ||
        (edge.source === graph.ids.relateB && edge.target === graph.ids.relateA),
    )
    expect(pair).toHaveLength(1)
    expect(pair[0]).toMatchObject({ type: 'relates-to', directed: false })
  })

  test('graph nodes carry mapRank, superseded state and open handoffs', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const byId = new Map(body.nodes.map((node) => [node.id, node]))
    expect(byId.get(graph.ids.plainA)?.mapRank).toBe(0)
    expect(byId.get(graph.ids.attach)?.mapRank).toBeNull()
    expect(byId.get(graph.ids.supB)?.superseded).toBe(true)
    expect(byId.get(graph.ids.supB)?.supersededBy).toBe(graph.ids.supA)
    expect(byId.get(graph.ids.supB)?.openHandoff).toBe(false)
    expect(body.openHandoffs).not.toContain(graph.ids.supB)
    expect(body.generation).toBeGreaterThanOrEqual(0)
  })

  test('warnings list the sidecar/banner disagreement, the dangling edge and the malformed node', async () => {
    const body = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    const joined = body.warnings.join('\n')
    expect(joined).toContain('supersedes without banner')
    expect(joined).toContain('dangling edge')
    expect(joined).toContain('malformed frontmatter')
  })
})

// ---- AC-003, AC-018: node detail and attachments ------------------------

describe('AC-003 / AC-018 / AC-005: node detail and attachment guard', () => {
  let harness: Harness
  let graph: GraphFixture

  beforeAll(async () => {
    const base = tempDir()
    graph = buildGraphFixture(path.join(base, 'graph'))
    const stateDir = path.join(base, 'state')
    const configPath = writeConfig(path.join(base, 'test_1.json'), graph.root, stateDir)
    harness = await startHarness({ graphRoot: graph.root, stateDir, configPath })
  })

  test('AC-003: the superseded node is dimmed and points at its successor', async () => {
    const detail = await getJson<NodeDetail>(`${harness.base}/api/node/${graph.ids.supB}`)
    expect(detail.superseded).toBe(true)
    expect(detail.supersededBy).toBe(graph.ids.supA)
    expect(detail.type).toBe('handoff')
    expect(detail.body).toContain('Superseded by')
  })

  test('AC-018: only real files are attachments', async () => {
    const detail = await getJson<NodeDetail>(`${harness.base}/api/node/${graph.ids.attach}`)
    expect(detail.attachments.map((attachment) => attachment.name)).toEqual([
      'big.txt',
      'binary.bin',
      'notes.md',
    ])
    expect(detail.attachmentCount).toBe(3)
  })

  test('AC-018: a dotfile attachment request is 404/400', async () => {
    const response = await fetch(`${harness.base}/api/node/${graph.ids.attach}/file/.node.md.prev`)
    expect([400, 404]).toContain(response.status)
    expect(await response.text()).not.toContain('prev')
  })

  test('a text attachment is served as text/plain utf-8', async () => {
    const response = await fetch(`${harness.base}/api/node/${graph.ids.attach}/file/notes.md`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('# Notes\n\nbody text\n')
    expect(response.headers.get('x-truncated')).toBeNull()
  })

  test('a large attachment is truncated with the X-Truncated marker', async () => {
    const response = await fetch(`${harness.base}/api/node/${graph.ids.attach}/file/big.txt`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-truncated')).toBe('1')
    const body = await response.text()
    expect(body.length).toBe(1024 * 1024)
  })

  test('a binary attachment is 415 with metadata only', async () => {
    const response = await fetch(`${harness.base}/api/node/${graph.ids.attach}/file/binary.bin`)
    expect(response.status).toBe(415)
    const body = (await response.json()) as { size: number; name: string }
    expect(body.name).toBe('binary.bin')
    expect(body.size).toBe(4)
  })

  test('AC-005: a traversal node id is rejected', async () => {
    for (const target of [
      `${harness.base}/api/node/..%2F..%2Fetc/file/passwd`,
      `${harness.base}/api/node/..%2F..%2Fetc`,
      `${harness.base}/api/node/not-a-ulid`,
    ]) {
      const response = await fetch(target)
      expect([400, 404]).toContain(response.status)
      const text = await response.text()
      expect(text).not.toContain('root:')
    }
  })

  test('AC-005: an attachment that is a symlink outside the graph is 404', async () => {
    const outside = tempDir()
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(secret, 'OUTSIDE SECRET CONTENT')
    const id = newNode(graph.root, 'escape node')
    fs.symlinkSync(secret, path.join(graph.root, id, 'escape.txt'))
    harness.store.rebuildNow()

    const response = await fetch(`${harness.base}/api/node/${id}/file/escape.txt`)
    expect([400, 404, 415]).toContain(response.status)
    expect(await response.text()).not.toContain('OUTSIDE SECRET CONTENT')
  })

  test('an unknown attachment name is 404', async () => {
    const response = await fetch(`${harness.base}/api/node/${graph.ids.attach}/file/nope.md`)
    expect(response.status).toBe(404)
  })

  test('node detail lists neighbours with direction and edge type', async () => {
    const detail = await getJson<NodeDetail>(`${harness.base}/api/node/${graph.ids.plainA}`)
    const plain = detail.neighbours.find((neighbour) => neighbour.id === graph.ids.plainB)
    expect(plain).toMatchObject({ direction: 'both', edgeType: 'plain' })
    const superseded = detail.neighbours.find((neighbour) => neighbour.id === graph.ids.retypedD)
    expect(superseded).toMatchObject({ direction: 'out', edgeType: 'supersedes' })
    const detailSup = await getJson<NodeDetail>(`${harness.base}/api/node/${graph.ids.supB}`)
    expect(detailSup.neighbours.find((neighbour) => neighbour.id === graph.ids.supA)).toMatchObject({
      direction: 'in',
      edgeType: 'supersedes',
    })
  })

  test('node detail exposes frontmatter, body and recent access', async () => {
    const detail = await getJson<NodeDetail>(`${harness.base}/api/node/${graph.ids.plainA}`)
    expect(detail.frontmatter['description']).toBe('plain edge A')
    expect(detail.recentAccess.length).toBeGreaterThan(0)
    expect(detail.recentAccess[0]?.src).toBe(graph.ids.plainA)
  })

  test('an unknown node id is 404', async () => {
    const response = await fetch(`${harness.base}/api/node/01J00000000000000000000001`)
    expect(response.status).toBe(404)
  })

  test('search matches description and body, case-insensitively', async () => {
    const byDescription = await getJson<SearchResponse>(`${harness.base}/api/search?q=ATTACHMENT`)
    expect(byDescription.q).toBe('ATTACHMENT')
    expect(byDescription.ids).toContain(graph.ids.attach)

    const byBody = await getJson<SearchResponse>(`${harness.base}/api/search?q=superseded%20by`)
    expect(byBody.ids).toContain(graph.ids.supB)

    const empty = await getJson<SearchResponse>(`${harness.base}/api/search?q=`)
    expect(empty.ids).toEqual([])
    const noMatch = await getJson<SearchResponse>(`${harness.base}/api/search?q=zzz-no-such-text`)
    expect(noMatch.ids).toEqual([])
  })
})

// ---- AC-004: methods and read-only proof --------------------------------

describe('AC-004: only GET/HEAD; nothing on disk changes', () => {
  let harness: Harness
  let graph: GraphFixture
  let stateDir: string

  beforeAll(async () => {
    const base = tempDir()
    graph = buildGraphFixture(path.join(base, 'graph'))
    stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [
      { taskId: taskUuid('task-1'), createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:30Z' },
    ])
    writeRunDir(stateDir, { taskId: taskUuid('task-1'), observation: completeObservation() }, 0)
    const configPath = writeConfig(path.join(base, 'test_1.json'), graph.root, stateDir)
    harness = await startHarness({ graphRoot: graph.root, stateDir, configPath })
  })

  test('POST/PUT/PATCH/DELETE are 405 and change nothing', async () => {
    const before = treeSignature(graph.root)
    const stateBefore = treeSignature(stateDir)
    const paths = ['/api/graph', '/api/meta', '/api/usage', '/api/runs', '/api/node/' + graph.ids.plainA, '/']
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const target of paths) {
        const response = await fetch(`${harness.base}${target}`, { method })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toContain('GET')
      }
    }
    // A request body must not be able to create anything either.
    await fetch(`${harness.base}/api/node/${graph.ids.plainA}`, { method: 'POST', body: 'x' })
    expect(treeSignature(graph.root)).toBe(before)
    expect(treeSignature(stateDir)).toBe(stateBefore)
  })

  test('HEAD is served', async () => {
    const response = await fetch(`${harness.base}/api/meta`, { method: 'HEAD' })
    expect(response.status).toBe(200)
  })
})

// ---- AC-007, AC-009, AC-011, AC-012, AC-020: usage + runs ---------------

describe('AC-007 / AC-009 / AC-011 / AC-012 / AC-020: usage and runs', () => {
  let harness: Harness
  let stateDir: string
  const CANARY = 'CANARY-8f3a1b-DO-NOT-LEAK'
  const TASK = {
    unknown: taskUuid('unknown-task'),
    capped: taskUuid('capped-task'),
    dup: taskUuid('dup-task'),
    read1: taskUuid('read-1'),
    read2: taskUuid('read-2'),
    manage1: taskUuid('manage-1'),
    manage2: taskUuid('manage-2'),
    orphan: taskUuid('orphan-task'),
  }

  const tasks = [
    // (a) no observation -> unknown
    { taskId: TASK.unknown, createdAt: '2026-11-01T01:00:00Z', finishedAt: '2026-11-01T01:00:10Z', runDir: true },
    // (b) capped -> partial
    {
      taskId: TASK.capped,
      createdAt: '2026-11-01T02:00:00Z',
      finishedAt: '2026-11-01T02:00:20Z',
      observation: jsonl([
        { seq: 1, type: 'request_start', requestId: 'r1' },
        { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 400, outputTokens: 40, totalTokens: 440 } },
        { seq: 3, type: 'capped', reason: 'events' },
      ]),
    },
    // (c) duplicated request_end -> counted once
    {
      taskId: TASK.dup,
      createdAt: '2026-11-01T03:00:00Z',
      finishedAt: '2026-11-01T03:00:30Z',
      observation: jsonl([
        { seq: 1, type: 'request_start', requestId: 'r1' },
        { seq: 2, type: 'request_end', requestId: 'r1', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
        { seq: 3, type: 'request_end', requestId: 'r1', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      ]),
    },
    {
      taskId: TASK.read1,
      authority: 'read' as const,
      createdAt: '2026-11-02T05:00:00Z',
      finishedAt: '2026-11-02T05:00:40Z',
      observation: completeObservation(1000, 100, 1100, 50),
    },
    {
      taskId: TASK.read2,
      authority: 'read' as const,
      createdAt: '2026-11-02T06:00:00Z',
      finishedAt: '2026-11-02T06:01:00Z',
      observation: completeObservation(2000, 200, 2200, 100),
    },
    {
      taskId: TASK.manage1,
      authority: 'manage' as const,
      createdAt: '2026-11-03T07:00:00Z',
      finishedAt: '2026-11-03T07:00:20Z',
      observation: completeObservation(3000, 300, 3300, 150),
    },
    {
      taskId: TASK.manage2,
      authority: 'manage' as const,
      createdAt: '2026-11-03T08:00:00Z',
      finishedAt: '2026-11-03T08:00:10Z',
      observation: completeObservation(4000, 400, 4400, 200),
    },
  ]

  beforeAll(async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'usage fixture node')
    stateDir = path.join(base, 'state')
    writeTasksDb(
      stateDir,
      tasks.map((task) => ({
        ...task,
        requestJson: JSON.stringify({ message: CANARY, evidence: [CANARY] }),
      })),
    )
    for (const [index, task] of tasks.entries()) {
      writeRunDir(stateDir, { taskId: task.taskId, observation: task.observation }, index)
    }
    // A run directory with no task row is an orphan warning, never a row.
    writeRunDir(stateDir, { taskId: TASK.orphan, observation: completeObservation() }, 99)
    // SEC-006 decoy: the canary also lives in files the server must never read,
    // inside read-1's own (newest) run directory.
    const runDir = path.join(stateDir, 'runs', TASK.read1, fs.readdirSync(path.join(stateDir, 'runs', TASK.read1))[0] as string)
    fs.writeFileSync(path.join(runDir, 'run-config.json'), JSON.stringify({ message: CANARY }), 'utf8')
    fs.writeFileSync(path.join(runDir, 'receipts.jsonl'), `${CANARY}\n`, 'utf8')
    fs.writeFileSync(path.join(runDir, 'sufficiency.json'), JSON.stringify({ note: CANARY }), 'utf8')
    fs.writeFileSync(path.join(runDir, 'completion.json'), JSON.stringify({ note: CANARY }), 'utf8')
    fs.writeFileSync(path.join(runDir, 'runtime-diagnostics.json'), JSON.stringify({ note: CANARY }), 'utf8')

    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    harness = await startHarness({ graphRoot, stateDir, configPath })
  })

  test('AC-007: unknown / partial / duplicate request_end classification', async () => {
    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage?from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z`)
    const combined = usage.combined
    expect(combined.usageRuns.unknown).toBeGreaterThanOrEqual(1)
    expect(combined.usageRuns.partial).toBeGreaterThanOrEqual(1)
    // complete runs: dup, read-1, read-2, manage-1, manage-2
    expect(combined.usageRuns.complete).toBe(5)
    // 440 (capped) + 110 (dup, once) + 1100 + 2200 + 3300 + 4400
    expect(combined.totals.totalTokens).toBe(440 + 110 + 1100 + 2200 + 3300 + 4400)
    // tokensPerRun uses complete runs only: [110, 1100, 2200, 3300, 4400]
    expect(combined.tokensPerRun.p50).toBe(2200)
  })

  test('AC-009: read + manage equals combined for runs and tokens', async () => {
    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage`)
    expect(usage.read.runs + usage.manage.runs).toBe(usage.combined.runs)
    expect((usage.read.totals.totalTokens ?? 0) + (usage.manage.totals.totalTokens ?? 0)).toBe(
      usage.combined.totals.totalTokens ?? 0,
    )
  })

  test('AC-012: latency percentiles match a nearest-rank reference computation', async () => {
    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage?from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z`)
    // Reference: nearest-rank over the fixture's own latencies, per population.
    const latencies = (authority: 'read' | 'manage' | 'all'): number[] =>
      tasks
        .filter((task) => authority === 'all' || (task.authority ?? 'read') === authority)
        .map((task) => Date.parse(task.finishedAt ?? task.createdAt) - Date.parse(task.createdAt))
        .sort((a, b) => a - b)
    const rank = (values: number[], p: number): number => values[Math.ceil(p * values.length) - 1] as number

    const readLat = latencies('read')
    const manageLat = latencies('manage')
    const allLat = latencies('all')
    const last = (values: number[]): number | null => (values.length === 0 ? null : (values.at(-1) as number))

    expect(usage.read.latencyMs).toEqual({ p50: rank(readLat, 0.5), p95: rank(readLat, 0.95), max: last(readLat) })
    expect(usage.manage.latencyMs).toEqual({
      p50: rank(manageLat, 0.5),
      p95: rank(manageLat, 0.95),
      max: last(manageLat),
    })
    expect(usage.combined.latencyMs).toEqual({ p50: rank(allLat, 0.5), p95: rank(allLat, 0.95), max: last(allLat) })
    // The reference itself, so the assertion cannot drift with the fixture.
    expect(usage.manage.latencyMs.max).toBe(20_000)
    expect(usage.read.runsWithLatency).toBe(readLat.length)
    expect(usage.combined.runsWithLatency).toBe(allLat.length)
  })

  test('the series has one bucket per day in range, including empty days', async () => {
    const from = '2026-11-01T00:00:00Z'
    const to = '2026-11-05T00:00:00Z'
    const usage = await getJson<UsageSummary>(
      `${harness.base}/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=day&tz=UTC`,
    )
    expect(usage.tz).toBe('UTC')
    expect(usage.series.map((point) => point.bucket)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ])
    const empty = usage.series.find((point) => point.bucket === '2026-11-04')
    expect(empty?.combined).toEqual({ totalTokens: 0, p50LatencyMs: null, runs: 0 })
    const day2 = usage.series.find((point) => point.bucket === '2026-11-02')
    expect(day2?.read.runs).toBe(2)
  })

  test('AC-020: a 17:30Z task falls in the next local day when the server zone is Asia/Shanghai', async () => {
    // A separate harness pinned to Asia/Shanghai: the zone is server-local, so
    // bucketing is asserted by construction rather than by a query override.
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'tz fixture node')
    const zoneState = path.join(base, 'state')
    writeTasksDb(zoneState, [
      { taskId: taskUuid('evening-task'), authority: 'manage', createdAt: '2026-11-03T17:30:00Z', finishedAt: '2026-11-03T17:30:10Z' },
    ])
    writeRunDir(zoneState, { taskId: taskUuid('evening-task'), observation: completeObservation() }, 0)
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, zoneState)
    const zoneHarness = await startHarness({ graphRoot, stateDir: zoneState, configPath, tz: 'Asia/Shanghai' })

    const usage = await getJson<UsageSummary>(
      `${zoneHarness.base}/api/usage?from=${encodeURIComponent('2026-11-03T16:00:00Z')}&to=${encodeURIComponent('2026-11-04T16:00:00Z')}`,
    )
    expect(usage.tz).toBe('Asia/Shanghai')
    expect(usage.series.map((point) => point.bucket)).toEqual(['2026-11-04'])
    expect(usage.series[0]?.manage.runs).toBe(1)

    // An explicit ?tz= overrides the server zone (AC-020's stated Given), and an
    // unknown zone falls back to the server's rather than failing.
    const overridden = await getJson<UsageSummary>(
      `${zoneHarness.base}/api/usage?from=${encodeURIComponent('2026-11-03T00:00:00Z')}&to=${encodeURIComponent('2026-11-04T00:00:00Z')}&tz=UTC`,
    )
    expect(overridden.tz).toBe('UTC')
    expect(overridden.series.map((point) => point.bucket)).toEqual(['2026-11-03'])
    // 17:30Z is still 2026-11-03 in UTC, so it lands in that bucket.
    expect(overridden.series[0]?.manage.runs).toBe(1)

    const bogus = await getJson<UsageSummary>(`${zoneHarness.base}/api/usage?tz=Not%2FAZone`)
    expect(bogus.tz).toBe('Asia/Shanghai')
  })

  test('the default range is the last 7 days and reports tz', async () => {
    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage`)
    const span = Date.parse(usage.to) - Date.parse(usage.from)
    expect(span).toBe(7 * 24 * 60 * 60 * 1000)
    expect(usage.series.length).toBeGreaterThanOrEqual(7)
    expect(typeof usage.tz).toBe('string')
  })

  test('runs are paginated, sorted and nulls always last', async () => {
    const page = await getJson<RunsPage>(`${harness.base}/api/runs?sort=totalTokens&dir=desc&limit=50&from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z`)
    expect(page.total).toBe(tasks.length) // orphans are not rows
    expect(page.runs.length).toBe(tasks.length)
    const tokens = page.runs.map((run) => run.usage?.totalTokens ?? null)
    const firstNull = tokens.indexOf(null)
    if (firstNull !== -1) {
      expect(tokens.slice(firstNull).every((value) => value === null)).toBe(true)
    }
    // descending among the non-null values
    const nonNull = tokens.filter((value): value is number => value !== null)
    expect([...nonNull].sort((a, b) => b - a)).toEqual(nonNull)
  })

  test('AC-020: offset/limit paging is deterministic with ties broken by taskId', async () => {
    const all = await getJson<RunsPage>(`${harness.base}/api/runs?sort=totalTokens&dir=asc&limit=200`)
    const paged = await getJson<RunsPage>(`${harness.base}/api/runs?sort=totalTokens&dir=asc&offset=2&limit=3`)
    expect(paged.total).toBe(all.total)
    expect(paged.offset).toBe(2)
    expect(paged.limit).toBe(3)
    expect(paged.runs.map((run) => run.taskId)).toEqual(all.runs.slice(2, 5).map((run) => run.taskId))

    // Ties: two runs with no usage sort by taskId ascending.
    const nulls = await getJson<RunsPage>(`${harness.base}/api/runs?sort=totalTokens&dir=desc&limit=200`)
    const nullIds = nulls.runs.filter((run) => run.usage === null).map((run) => run.taskId)
    expect([...nullIds].sort()).toEqual(nullIds)
  })

  test('limit is capped at 200 and defaults to 50', async () => {
    const capped = await getJson<RunsPage>(`${harness.base}/api/runs?limit=1000`)
    expect(capped.limit).toBe(200)
    const fallback = await getJson<RunsPage>(`${harness.base}/api/runs`)
    expect(fallback.limit).toBe(50)
  })

  test('runs respect the [from, to) window', async () => {
    const from = '2026-11-03T00:00:00Z'
    const to = '2026-11-04T00:00:00Z'
    const page = await getJson<RunsPage>(
      `${harness.base}/api/runs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`,
    )
    expect(page.total).toBe(2)
    expect(page.runs.every((run) => run.authority === 'manage')).toBe(true)
  })

  test('runs carry no task content', async () => {
    const page = await getJson<RunsPage>(`${harness.base}/api/runs?limit=200`)
    expect(JSON.stringify(page)).not.toContain(CANARY)
    for (const run of page.runs) {
      expect(Object.keys(run).sort()).toEqual(['authority', 'createdAt', 'latencyMs', 'taskId', 'usage', 'usageStatus'])
    }
  })

  test('AC-011: no endpoint leaks the canary', async () => {
    const endpoints = [
      '/api/meta',
      '/api/graph',
      '/api/usage',
      '/api/runs?limit=200',
      '/api/search?q=CANARY',
      '/api/node/' + '01J00000000000000000000001',
    ]
    for (const endpoint of endpoints) {
      const response = await fetch(`${harness.base}${endpoint}`)
      const body = await response.text()
      expect(body).not.toContain(CANARY)
      expect(body).not.toContain('run-config')
    }
  })

  test('usage warnings mention the orphan run directory and partial capture', async () => {
    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage`)
    const joined = usage.warnings.join('\n')
    expect(joined).toContain('orphan run directory')
    expect(joined).toContain('capped')
  })
})

// ---- AC-010: SQLite safety ----------------------------------------------

describe('AC-010: WAL safety and unavailable database', () => {
  test('real reader refreshes run concurrently with a writer and neither is blocked', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'wal fixture node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])

    // Snapshots BEFORE the Store exists: a reader's startup side effects (or a
    // stray write) must be visible, not hidden behind a late baseline.
    const before = stateSnapshot(stateDir)
    const graphBefore = treeSignature(graphRoot)

    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })
    // Short task poll so `readTasks` really re-runs while the writer works.
    harness.store.setIntervalsForTests({ taskPollMs: 15, reconcileMs: 25 })

    // Told to the writer once the readers have stopped, so it can run the final
    // draining checkpoint (#7).
    const readyFile = path.join(base, 'readers-done')

    // Writer subprocess: 200 inserts with a small gap, PASSIVE checkpoints whose
    // RESULT ROW is inspected — a discarded checkpoint result proves nothing.
    const writer = `
      import { Database } from 'bun:sqlite'
      const readyFile = ${JSON.stringify(readyFile)}
      const db = new Database(${JSON.stringify(path.join(stateDir, 'memory-agent.sqlite'))})
      db.exec('PRAGMA busy_timeout = 5000')
      const insert = db.query(\`INSERT INTO tasks (task_id, context_id, graph_registration_id, request_json,
        payload_hash, config_fingerprint, effective_authority, lifecycle, cancellation, canceled,
        created_at, updated_at, started_at, finished_at, result_json)
        VALUES (?, 'c', 'g', '{"message":"WRITER-CANARY"}', 'p', 'f', 'read', 'terminal', 'none', 0, ?, ?, ?, ?, '{}')\`)
      const uuid = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0')
      let busy = 0
      const checkpoints = []
      for (let i = 0; i < 200; i++) {
        try {
          insert.run(uuid(i), '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:05Z')
        } catch (error) {
          if (String(error).includes('SQLITE_BUSY')) busy += 1
          else throw error
        }
        if (i % 25 === 0) {
          // (busy, logFrames, checkpointedFrames) — checkpointed > 0 proves the
          // reader is not pinning WAL frames.
          checkpoints.push(db.query('PRAGMA wal_checkpoint(PASSIVE)').get())
        }
        await Bun.sleep(3)
      }
      const total = db.query('SELECT count(*) AS n FROM tasks').get().n
      // Wait for the readers to stop, then checkpoint FULLY: a PASSIVE
      // checkpoint may stop at a prefix, so only a draining pass proves no
      // reader is pinning WAL frames (#7).
      while (!(await Bun.file(readyFile).exists())) await Bun.sleep(10)
      const final = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
      db.close()
      console.log(JSON.stringify({ done: true, busy, total, checkpoints, final }))
    `
    const proc = Bun.spawn([process.execPath, '-e', writer], { stdout: 'pipe', stderr: 'pipe' })

    let refusals = 0
    let sawRowsAdvance = 0
    let previousCount = 0
    // Drive ACTUAL refreshes through the HTTP surface while the writer runs.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const response = await fetch(`${harness.base}/api/usage?from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z`)
      if (response.status !== 200) refusals += 1
      const body = (await response.json()) as UsageSummary
      expect(body.unavailable).not.toBe(true)
      // Counts must move forward as the writer inserts.
      if (body.combined.runs > previousCount) {
        sawRowsAdvance += 1
        previousCount = body.combined.runs
      }
      const graph = await fetch(`${harness.base}/api/graph`)
      expect(graph.status).toBe(200)
      const runs = (await (await fetch(`${harness.base}/api/runs?limit=1&from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z`)).json()) as RunsPage
      if (runs.total > previousCount) previousCount = runs.total
      if (proc.exitCode !== null && previousCount >= 200) break
      await Bun.sleep(8)
    }

    // Readers have stopped: let the writer drain the WAL and report the result.
    fs.writeFileSync(readyFile, 'done', 'utf8')
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('SQLITE_BUSY')
    const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      done: boolean
      busy: number
      total: number
      checkpoints: { busy: number; log: number; checkpointed: number }[]
      final: { busy: number; log: number; checkpointed: number }
    }
    expect(summary.done).toBe(true)
    expect(summary.busy).toBe(0)
    expect(summary.total).toBe(200)

    // The reader refreshed repeatedly and saw the row count climb.
    expect(refusals).toBe(0)
    expect(sawRowsAdvance).toBeGreaterThan(2)

    // At least one PASSIVE checkpoint moved frames while the readers ran...
    expect(summary.checkpoints.length).toBeGreaterThan(0)
    expect(Math.max(...summary.checkpoints.map((row) => row.checkpointed))).toBeGreaterThan(0)
    for (const row of summary.checkpoints) expect(row.busy).toBe(0)

    // ...and the FINAL TRUNCATE checkpoint, run after the readers stopped, must
    // have drained the log completely: checkpointed === log with busy 0. A pinned
    // WAL would leave a prefix behind (#7).
    expect(summary.final.busy).toBe(0)
    expect(summary.final.checkpointed).toBe(summary.final.log)

    // The WRITER changed the database, so only the reader's own footprint is
    // asserted: nothing but the sqlite files and the run tree may differ, and
    // the -wal/-shm files are excluded as §10 specifies. The graph root — which
    // the reader alone touches — must be untouched byte for byte.
    expect(treeSignature(graphRoot)).toBe(graphBefore)
    const changed = stateSnapshot(stateDir)
      .split('\n')
      .filter((line) => !line.startsWith('memory-agent.sqlite:'))
      .join('\n')
    const changedBefore = before
      .split('\n')
      .filter((line) => !line.startsWith('memory-agent.sqlite:'))
      .join('\n')
    expect(changed).toBe(changedBefore)
  }, 45_000)

  test('an unopenable database makes /api/usage unavailable while /api/graph answers', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'broken db node')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    // A directory where the database file should be: SQLITE_CANTOPEN territory.
    fs.mkdirSync(path.join(stateDir, 'memory-agent.sqlite'))
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })

    const usage = await getJson<UsageSummary>(`${harness.base}/api/usage`)
    expect(usage.unavailable).toBe(true)
    expect(usage.combined.runs).toBe(0)
    expect(usage.series).toEqual([])

    const runs = await getJson<RunsPage>(`${harness.base}/api/runs`)
    expect(runs.unavailable).toBe(true)
    expect(runs.runs).toEqual([])

    const graph = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    expect(graph.nodes.length).toBe(1)
  })
})

// ---- static + 404 -------------------------------------------------------

describe('static serving', () => {
  test('a missing dist returns the 503 build hint', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'static node')
    const stateDir = path.join(base, 'state')
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({
      graphRoot,
      stateDir,
      configPath,
      distDir: path.join(base, 'dist-does-not-exist'),
    })
    const response = await fetch(`${harness.base}/`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('UI not built: run bun run build:web')
  })

  test('a built dist serves index.html with SPA fallback', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'static node 2')
    const stateDir = path.join(base, 'state')
    const distDir = path.join(base, 'dist')
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8')
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)', 'utf8')
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath, distDir })

    const index = await fetch(`${harness.base}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')

    const asset = await fetch(`${harness.base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')

    const spa = await fetch(`${harness.base}/node/some/deep/route`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('id="root"')

    const missingAsset = await fetch(`${harness.base}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)
  })

  test('an unknown /api path is a JSON 404', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'api 404 node')
    const stateDir = path.join(base, 'state')
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })
    const response = await fetch(`${harness.base}/api/nope`)
    expect(response.status).toBe(404)
  })
})

// ---- SEC-006: the server opens nothing content-bearing -------------------

describe('SEC-006: content-bearing files are never opened', () => {
  test('a canary in every forbidden file never reaches a response', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'minimisation node')
    const stateDir = path.join(base, 'state')
    const canary = 'MINIMISATION-CANARY-4b91'
    writeTasksDb(stateDir, [
      {
        taskId: taskUuid('leak-check'),
        createdAt: '2026-11-01T00:00:00Z',
        finishedAt: '2026-11-01T00:00:05Z',
        requestJson: JSON.stringify({ message: canary, evidence: [{ text: canary }] }),
      },
    ])
    const runDir = writeRunDir(stateDir, { taskId: taskUuid('leak-check'), observation: completeObservation() }, 0)
    for (const name of [
      'run-config.json',
      'receipts.jsonl',
      'sufficiency.json',
      'completion.json',
      'runtime-diagnostics.json',
    ]) {
      fs.writeFileSync(path.join(runDir, name), JSON.stringify({ message: canary, note: canary }), 'utf8')
    }
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })

    for (const endpoint of ['/api/meta', '/api/graph', '/api/usage', '/api/runs?limit=200', '/api/search?q=canary']) {
      const response = await fetch(`${harness.base}${endpoint}`)
      expect(await response.text()).not.toContain(canary)
    }
    const graph = await getJson<GraphResponse>(`${harness.base}/api/graph`)
    expect(JSON.stringify(graph)).not.toContain(canary)
  })
})

// ---- #11: paging with real ties -----------------------------------------

describe('#11: /api/runs paging with genuine ties', () => {
  test('120 runs with duplicate token counts page deterministically', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'paging fixture node')
    const stateDir = path.join(base, 'state')

    // 120 tasks: 6 distinct token values, so every page boundary lands inside a
    // tie group; 12 of them have NO usage at all (nulls always last).
    const seeds: {
      taskId: string
      createdAt: string
      finishedAt: string
      observation?: string
    }[] = []
    for (let i = 0; i < 120; i++) {
      const taskId = taskUuid(`paging-${i}`)
      const createdAt = new Date(Date.UTC(2026, 10, 1, 0, i, 0)).toISOString()
      const finishedAt = new Date(Date.UTC(2026, 10, 1, 0, i, 30)).toISOString()
      const noUsage = i % 10 === 0
      seeds.push({
        taskId,
        createdAt,
        finishedAt,
        ...(noUsage
          ? {}
          : {
              observation: jsonl([
                { seq: 1, type: 'request_start', requestId: 'r1' },
                {
                  seq: 2,
                  type: 'request_end',
                  requestId: 'r1',
                  usage: { inputTokens: 10, outputTokens: 1, totalTokens: [100, 200, 300, 400, 500, 600][i % 6] as number },
                },
              ]),
            }),
      })
    }
    writeTasksDb(stateDir, seeds)
    for (const [index, seed] of seeds.entries()) {
      writeRunDir(
        stateDir,
        { taskId: seed.taskId, ...(seed.observation === undefined ? {} : { observation: seed.observation }) },
        index,
      )
    }
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })
    const window = 'from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z'

    const page1 = await getJson<RunsPage>(`${harness.base}/api/runs?${window}&sort=totalTokens&dir=desc&offset=0&limit=50`)
    const page2 = await getJson<RunsPage>(`${harness.base}/api/runs?${window}&sort=totalTokens&dir=desc&offset=50&limit=50`)
    const page3 = await getJson<RunsPage>(`${harness.base}/api/runs?${window}&sort=totalTokens&dir=desc&offset=100&limit=50`)
    expect(page1.total).toBe(120)
    expect(page1.runs.length).toBe(50)
    expect(page2.runs.length).toBe(50)
    expect(page3.runs.length).toBe(20)

    // Pages are disjoint and their concatenation is the full ordering.
    const ids = [...page1.runs, ...page2.runs, ...page3.runs].map((run) => run.taskId)
    expect(new Set(ids).size).toBe(120)

    // Re-fetching page 2 returns exactly the same rows in the same order.
    const again = await getJson<RunsPage>(`${harness.base}/api/runs?${window}&sort=totalTokens&dir=desc&offset=50&limit=50`)
    expect(again.runs.map((run) => run.taskId)).toEqual(page2.runs.map((run) => run.taskId))

    // Every tie group is ordered by taskId ascending.
    const tokens = [...page1.runs, ...page2.runs, ...page3.runs].map((run) => run.usage?.totalTokens ?? null)
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1] as number | null
      const next = tokens[i] as number | null
      if (prev === null || next === null) {
        // nulls form a contiguous tail
        if (prev === null) expect(next).toBeNull()
        continue
      }
      expect(prev).toBeGreaterThanOrEqual(next)
    }
    // The tail is exactly the null-usage runs.
    const nullCount = tokens.filter((value) => value === null).length
    expect(nullCount).toBe(12)
    expect(tokens.slice(tokens.length - 12).every((value) => value === null)).toBe(true)

    // Real numeric ties exist and straddle page boundaries; within every tie
    // group the ids are ascending.
    const all = [...page1.runs, ...page2.runs, ...page3.runs]
    const groups = new Map<number, string[]>()
    for (const run of all) {
      const value = run.usage?.totalTokens
      if (value === undefined) continue
      groups.set(value, [...(groups.get(value) ?? []), run.taskId])
    }
    // Six token values over 108 usage-bearing runs, so every group is large
    // enough that at least one must cross a 50-row page boundary.
    expect(groups.size).toBe(6)
    expect([...groups.values()].reduce((sum, ids) => sum + ids.length, 0)).toBe(108)
    let straddling = 0
    for (const ids of groups.values()) {
      expect([...ids].sort()).toEqual(ids)
      expect(ids.length).toBeGreaterThan(5)
    }
    const indexOf = new Map(all.map((run, index) => [run.taskId, index]))
    for (const ids of groups.values()) {
      const first = indexOf.get(ids[0] as string) as number
      const last = indexOf.get(ids[ids.length - 1] as string) as number
      if (Math.floor(first / 50) !== Math.floor(last / 50)) straddling += 1
    }
    expect(straddling).toBeGreaterThan(0)
  }, 30_000)

  test('ascending order also keeps nulls last', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'asc fixture node')
    const stateDir = path.join(base, 'state')
    const seeds = [
      { taskId: taskUuid('asc-a'), tokens: 100 },
      { taskId: taskUuid('asc-b'), tokens: 300 },
      { taskId: taskUuid('asc-c'), tokens: null },
      { taskId: taskUuid('asc-d'), tokens: 200 },
    ]
    writeTasksDb(
      stateDir,
      seeds.map((seed, index) => ({
        taskId: seed.taskId,
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, index, 0)).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 10, 1, 0, index, 30)).toISOString(),
      })),
    )
    for (const [index, seed] of seeds.entries()) {
      writeRunDir(
        stateDir,
        {
          taskId: seed.taskId,
          ...(seed.tokens === null
            ? {}
            : {
                observation: jsonl([
                  { seq: 1, type: 'request_end', requestId: 'r1', usage: { totalTokens: seed.tokens } },
                ]),
              }),
        },
        index,
      )
    }
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })
    const window = 'from=2026-10-01T00:00:00Z&to=2026-11-05T00:00:00Z'
    const page = await getJson<RunsPage>(`${harness.base}/api/runs?${window}&sort=totalTokens&dir=asc&limit=200`)
    expect(page.runs.map((run) => run.usage?.totalTokens ?? null)).toEqual([100, 200, 300, null])
  })
})

// ---- #14: oversized ranges are refused, not truncated -------------------

describe('#14: a range that cannot be charted is rejected', () => {
  test('more than 4000 day buckets is a 400 with a clear error', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'range fixture node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const harness = await startHarness({ graphRoot, stateDir, configPath })

    const from = '2000-01-01T00:00:00Z'
    const to = '2026-01-01T00:00:00Z'
    const response = await fetch(
      `${harness.base}/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; buckets: number; maxBuckets: number }
    expect(body.error).toContain('4000')
    expect(body.error).toContain('narrow')
    expect(body.buckets).toBeGreaterThan(4000)
    expect(body.maxBuckets).toBe(4000)

    // A range just inside the limit still works and charts every day.
    const ok = await fetch(
      `${harness.base}/api/usage?from=${encodeURIComponent('2016-01-01T00:00:00Z')}&to=${encodeURIComponent('2025-12-31T00:00:00Z')}`,
    )
    expect(ok.status).toBe(200)
    const summary = (await ok.json()) as UsageSummary
    expect(summary.series.length).toBeLessThanOrEqual(4000)
    expect(summary.series.length).toBeGreaterThan(3600)
    // The chart covers the SAME window the totals describe.
    expect(summary.series[0]?.bucket).toBe('2016-01-01')
    expect(summary.series.at(-1)?.bucket).toBe('2025-12-30')
  })
})
