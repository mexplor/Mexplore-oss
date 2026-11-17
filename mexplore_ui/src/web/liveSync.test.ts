// Live-sync contract: the app refetches every view on each open of the event stream (first open and every
// reconnect) and batches hints per scope. Exercised through the app's own wiring — the real HTTP backend
// (createHttpBackend), the real store (createAppStore) and the real LiveSync — with a fake EventSource and a
// fake fetch. The test never fetches anything itself; it only fires stream events and inspects what the app did.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createHttpBackend, type EventSourceLike, type RunsQuery } from './api.ts'
import { createAppStore, type AppStore } from './appStore.ts'
import { LiveSync, type Timers } from './liveSync.ts'
import type { GraphResponse, Meta, NodeDetail, RunsPage, Stats, UsageSummary } from '../shared/types.ts'

// ---------- fake EventSource ----------
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  onopen: ((ev: Event) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  // test controls (a real EventSource reconnects by itself and fires onopen again on the same instance)
  open() {
    this.onopen?.(new Event('open'))
  }
  drop() {
    this.onerror?.(new Event('error'))
  }
  hint(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

// ---------- fake server data + fetch ----------
const NODE = '01J00000000000000000000021'

function stats(runs: number, totalTokens?: number): Stats {
  return {
    runs,
    runsWithLatency: runs,
    usageRuns: { complete: runs, partial: 0, unknown: 0 },
    totals: totalTokens === undefined ? {} : { totalTokens },
    tokensPerRun: { mean: null, p50: null, p95: null },
    latencyMs: { p50: null, p95: null, max: null },
  }
}

interface ServerData {
  version: number
}
const server: ServerData = { version: 1 }

function body(path: string, v: number): unknown {
  if (path === '/api/meta')
    return { configPath: 'c', graphRoot: '/g/test_1', stateDir: '/s', nodeCount: v, runCount: v * 3, serverTime: '', tz: 'UTC' } satisfies Meta
  if (path === '/api/graph')
    return {
      nodes: [],
      edges: [],
      openHandoffs: [],
      warnings: [],
      generation: v,
    } satisfies GraphResponse
  if (path === `/api/node/${NODE}`)
    return {
      id: NODE,
      description: `node v${v}`,
      type: 'thread',
      created: '2026-11-01',
      updated: null,
      superseded: false,
      supersededBy: null,
      openHandoff: false,
      degree: 0,
      attachmentCount: 0,
      mapRank: 0,
      visitCount: v,
      body: '',
      frontmatter: {},
      attachments: [],
      neighbours: [],
      recentAccess: [],
      provenance: { entries: [], first: null, truncated: false, skipped: 0, unreadable: false },
    } satisfies NodeDetail
  if (path === '/api/usage')
    return { from: '', to: '', tz: 'UTC', read: stats(v), manage: stats(v), combined: stats(v * 2, v * 100), series: [], warnings: [] } satisfies UsageSummary
  if (path === '/api/runs') return { total: v * 2, offset: 0, limit: 50, runs: [] } satisfies RunsPage
  return null
}

let calls: string[] = []
const fakeFetch = async (input: string): Promise<Response> => {
  calls.push(input)
  const path = input.split('?')[0]!
  const b = body(path, server.version)
  if (b === null) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  return new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ---------- fake timers for hint batching ----------
function fakeTimers() {
  const queue = new Map<number, () => void>()
  let id = 0
  const timers: Timers = {
    set: (fn) => {
      queue.set(++id, fn)
      return id
    },
    clear: (h) => {
      queue.delete(h as number)
    },
  }
  return {
    timers,
    pending: () => queue.size,
    runAll() {
      const fns = [...queue.values()]
      queue.clear()
      for (const f of fns) f()
    },
  }
}

/** Let fetch → json → resource promise chains settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const USAGE_Q = { from: '2026-10-29T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' }
const RUNS_Q: RunsQuery = { ...USAGE_Q, sort: 'createdAt', dir: 'desc', offset: 0, limit: 50 }

/** Mount the app's data layer and set the queries the UI would set (selected node + visible dashboard). */
function mountApp() {
  const clock = fakeTimers()
  const backend = createHttpBackend({ fetch: fakeFetch, EventSource: FakeEventSource })
  const sync = new LiveSync((h) => backend.events(h), { timers: clock.timers })
  const store: AppStore = createAppStore(backend, sync)
  sync.start()
  store.node.setQuery(NODE, NODE) // NodePanel open on NODE
  store.usage.setQuery(USAGE_Q, 'usage-key') // Dashboard visible
  store.runs.setQuery(RUNS_Q, 'runs-key')
  const es = FakeEventSource.instances.at(-1)!
  return { store, sync, es, clock }
}

const paths = () => calls.map((c) => c.split('?')[0]!)
const count = (p: string) => paths().filter((x) => x === p).length

beforeEach(() => {
  FakeEventSource.instances = []
  calls = []
  server.version = 1
})

describe('live sync: refetch on every EventSource open', () => {
  test('initial open and reconnect open refetch meta, graph, selected node, usage and runs', async () => {
    const { store, sync, es } = mountApp()
    expect(es.url).toBe('/api/events')
    expect(sync.status).toBe('connecting')
    await settle()

    // initial open → everything refetched
    calls = []
    es.open()
    await settle()
    expect(sync.status).toBe('live')
    for (const p of ['/api/meta', '/api/graph', `/api/node/${NODE}`, '/api/usage', '/api/runs']) expect(count(p)).toBe(1)
    expect(store.graph.state.data?.generation).toBe(1)

    // disconnect; data changes on the server while no hints can reach us
    es.drop()
    expect(sync.status).toBe('reconnecting')
    server.version = 2
    calls = []
    await settle()
    expect(calls).toEqual([]) // nothing refetches merely because the stream dropped

    // reconnect open → every view refetched again and now shows the new data
    es.open()
    await settle()
    expect(sync.status).toBe('live')
    for (const p of ['/api/meta', '/api/graph', `/api/node/${NODE}`, '/api/usage', '/api/runs']) expect(count(p)).toBe(1)
    expect(calls.find((c) => c.startsWith('/api/usage?'))).toContain(encodeURIComponent(USAGE_Q.from))
    expect(calls.find((c) => c.startsWith('/api/runs?'))).toContain('sort=createdAt')

    expect(store.meta.state.data?.nodeCount).toBe(2)
    expect(store.graph.state.data?.generation).toBe(2)
    expect(store.node.state.data?.description).toBe('node v2')
    expect(store.usage.state.data?.combined.runs).toBe(4)
    expect(store.runs.state.data?.total).toBe(4)
  })

  test('an open cancels a pending hint batch instead of refetching twice', async () => {
    const { es, clock } = mountApp()
    await settle()
    es.hint({ kind: 'run' })
    expect(clock.pending()).toBe(1)
    calls = []
    es.open()
    expect(clock.pending()).toBe(0)
    await settle()
    expect(count('/api/usage')).toBe(1)
    expect(count('/api/runs')).toBe(1)
  })

  test('paused views (hidden dashboard, closed panel) are not refetched; they load when shown again', async () => {
    const { store, es } = mountApp()
    await settle()
    store.usage.setQuery(null, null)
    store.runs.setQuery(null, null)
    store.node.setQuery(null, null)
    calls = []
    es.open()
    await settle()
    expect(paths().sort()).toEqual(['/api/graph', '/api/meta'])
    calls = []
    store.usage.setQuery(USAGE_Q, 'usage-key')
    await settle()
    expect(paths()).toEqual(['/api/usage'])
  })
})

describe('live sync: hints are batched per scope', () => {
  test('run hints refetch meta, usage and runs once per batch — not graph or node', async () => {
    const { es, clock } = mountApp()
    es.open()
    await settle()
    calls = []
    es.hint({ kind: 'run' })
    es.hint({ kind: 'run', id: 'x' })
    es.hint({ kind: 'run' })
    await settle()
    expect(calls).toEqual([]) // batched, not yet flushed
    clock.runAll()
    await settle()
    expect(paths().sort()).toEqual(['/api/meta', '/api/runs', '/api/usage'])
  })

  test('graph/node/access hints refetch meta, graph and the selected node — not usage or runs', async () => {
    const { es, clock } = mountApp()
    es.open()
    await settle()
    calls = []
    es.hint({ kind: 'access', id: NODE })
    es.hint({ kind: 'node', id: NODE })
    es.hint({ kind: 'graph' })
    clock.runAll()
    await settle()
    expect(paths().sort()).toEqual(['/api/graph', '/api/meta', `/api/node/${NODE}`])
  })

  test('a lone node hint (a provenance append) refetches only the selected node, and nothing when no panel is open', async () => {
    const { store, es, clock } = mountApp()
    es.open()
    await settle()
    calls = []
    es.hint({ kind: 'node', id: NODE })
    clock.runAll()
    await settle()
    expect(paths()).toEqual([`/api/node/${NODE}`])
    store.node.setQuery(null, null)
    calls = []
    es.hint({ kind: 'node', id: '01J00000000000000000000022' })
    clock.runAll()
    await settle()
    expect(calls).toEqual([])
  })

  test('malformed hints are ignored', async () => {
    const { es, clock } = mountApp()
    es.open()
    await settle()
    calls = []
    es.onmessage?.({ data: 'not json' } as MessageEvent)
    es.hint({ nope: true })
    expect(clock.pending()).toBe(0)
  })

  test('stop() closes the stream', () => {
    const { store, es } = mountApp()
    store.dispose()
    expect(es.closed).toBe(true)
  })
})

describe('Resource (latest-request-wins, per query key)', () => {
  function deferredFetcher() {
    const pending: { q: string; resolve: (v: string) => void; reject: (e: unknown) => void }[] = []
    const fetcher = (q: string) => new Promise<string>((resolve, reject) => pending.push({ q, resolve, reject }))
    return { fetcher, pending }
  }

  test('an overlapping refetch of the same query that fails does not discard the earlier good response', async () => {
    const { Resource } = await import('./appStore.ts')
    const f = deferredFetcher()
    const res = new Resource<string, string>(f.fetcher)
    res.setQuery('a', 'a') // #1 (e.g. initial load)
    res.refetch() // #2 (e.g. the SSE open refetch) while #1 is in flight
    f.pending[0]!.resolve('A1')
    await settle()
    expect(res.state.data).toBe('A1')
    expect(res.state.loading).toBe(true) // #2 still pending
    f.pending[1]!.reject(new Error('503 down'))
    await settle()
    expect(res.state).toMatchObject({ data: 'A1', dataKey: 'a', errorKey: 'a', loading: false })
    expect(res.state.error?.status).toBe(503)
  })

  test("a stale response for a previous query never lands on the new one", async () => {
    const { Resource } = await import('./appStore.ts')
    const f = deferredFetcher()
    const res = new Resource<string, string>(f.fetcher)
    res.setQuery('page1', 'page1')
    res.setQuery('page2', 'page2')
    f.pending[0]!.resolve('P1')
    await settle()
    expect(res.state.data).toBeNull()
    f.pending[1]!.resolve('P2')
    await settle()
    expect(res.state).toMatchObject({ data: 'P2', dataKey: 'page2', loading: false })
  })

  test('an error belongs to its query: switching query clears it', async () => {
    const { Resource } = await import('./appStore.ts')
    const f = deferredFetcher()
    const res = new Resource<string, string>(f.fetcher)
    res.setQuery('x', 'x')
    f.pending[0]!.reject(new Error('400 range too large'))
    await settle()
    expect(res.state.error?.status).toBe(400)
    res.setQuery('y', 'y')
    expect(res.state.error).toBeNull()
    expect(res.state.loading).toBe(true)
  })
})
