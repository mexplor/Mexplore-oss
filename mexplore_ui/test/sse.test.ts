// Live-update tests: SSE heartbeat, invalidation on a real filesystem change,
// and the reconnect case (REQ-007, AC-006, AC-019).
//
// Timers are shortened through the Store's injectable intervals so the suite
// stays fast without weakening the assertion.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createApp } from '../src/server/app.ts'
import { Store } from '../src/server/store.ts'
import type { SseEvent } from '../src/shared/types.ts'
import {
  cleanupTemps,
  completeObservation,
  edgeAdd,
  jsonl,
  newNode,
  taskUuid,
  tempDir,
  waitFor,
  writeConfig,
  writeRunDir,
  writeTasksDb,
} from './helpers.ts'

const open: ({ stop(): Promise<void> } | Store)[] = []

afterAll(async () => {
  for (const handle of open) {
    if (handle instanceof Store) handle.close()
    else await handle.stop()
  }
  cleanupTemps()
})

/**
 * Build an app wired to its server exactly as `cli.ts` does, so the SSE handler
 * can opt out of Bun's per-request idle timer.
 */
function appWithServer(options: Omit<Parameters<typeof createApp>[0], 'port'>): {
  app: ReturnType<typeof createApp>
  attach(server: { timeout?(request: Request, seconds: number): void }): void
} {
  const holder: { server: { timeout?(request: Request, seconds: number): void } | null } = { server: null }
  const app = createApp({
    ...options,
    // Bound by the caller right after `Bun.serve`; see `attach`.
    port: 0,
    server: {
      timeout(request: Request, seconds: number) {
        holder.server?.timeout?.(request, seconds)
      },
    },
  })
  return {
    app,
    // Reporting the bound port is REQUIRED: until `setListeningPort` runs the app
    // refuses every Host (fail closed), because port 0 is not a real port.
    attach: (server) => {
      holder.server = server
      const bound = (server as { port?: number }).port
      if (typeof bound === 'number') app.setListeningPort(bound)
    },
  }
}

interface LiveHarness {
  base: string
  store: Store
  graphRoot: string
  stateDir: string
  stop(): Promise<void>
}

async function startLive(options: { heartbeatMs?: number; reconcileMs?: number; debounceMs?: number } = {}): Promise<LiveHarness> {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'live fixture root node')
  const stateDir = path.join(base, 'state')
  writeTasksDb(stateDir, [])
  const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)

  const store = new Store({
    graphRoot,
    stateDir,
    debounceMs: options.debounceMs ?? 40,
    reconcileMs: options.reconcileMs ?? 60_000,
    heartbeatMs: options.heartbeatMs ?? 150,
  })
  store.start()
  const { app, attach } = appWithServer({ store, configPath, graphRoot, stateDir, tz: 'UTC' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, fetch: (request) => app.handle(request) })
  attach(server)
  const handle: LiveHarness = {
    base: `http://127.0.0.1:${server.port}`,
    store,
    graphRoot,
    stateDir,
    async stop() {
      store.close()
      await server.stop(true)
    },
  }
  open.push(handle)
  return handle
}

interface SseClient {
  events: SseEvent[]
  comments: string[]
  close(): void
  closed: Promise<void>
}

function connectSse(url: string): SseClient {
  const events: SseEvent[] = []
  const comments: string[] = []
  const controller = new AbortController()
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  void (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
      if (response.body === null) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as SseEvent)
            else if (line.startsWith(':')) comments.push(line)
          }
          index = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // aborted by the client
    } finally {
      resolveClosed()
    }
  })()

  return {
    events,
    comments,
    close: () => controller.abort(),
    closed,
  }
}

describe('AC-006 / AC-019: SSE invalidation', () => {
  test('the stream opens with a graph hint and survives beyond the idle timeout', async () => {
    const live = await startLive({ heartbeatMs: 100 })
    const client = connectSse(`${live.base}/api/events`)

    expect(await waitFor(() => client.events.some((event) => event.kind === 'graph'), 2000)).toBe(true)

    // Heartbeats must keep arriving; Bun's default idleTimeout is 10 s, so the
    // 5 s heartbeat is what keeps a quiet stream open.
    expect(await waitFor(() => client.comments.filter((line) => line.includes('hb')).length >= 3, 3000)).toBe(true)
    client.close()
    await client.closed
  })

  test('AC-006: a Node created and linked while connected appears within ~2 s', async () => {
    const live = await startLive({ debounceMs: 40 })
    const client = connectSse(`${live.base}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)
    const baseline = client.events.length

    const existing = live.store.graph().nodes[0]?.id as string
    const created = newNode(live.graphRoot, 'brand new live node')
    edgeAdd(live.graphRoot, existing, created)

    // A watcher event (any kind) must arrive without a manual refresh.
    expect(await waitFor(() => client.events.length > baseline, 2500)).toBe(true)

    // And the next fetch must already see the node and the link.
    expect(await waitFor(() => live.store.graph().nodeById.has(created), 2500)).toBe(true)
    const response = await fetch(`${live.base}/api/graph`)
    const body = (await response.json()) as { nodes: { id: string }[]; edges: { source: string; target: string }[] }
    expect(body.nodes.some((node) => node.id === created)).toBe(true)
    expect(body.edges.some((edge) => edge.source === created || edge.target === created)).toBe(true)

    client.close()
    await client.closed
  })

  test('AC-019: a client that disconnects, misses a change and reconnects sees it', async () => {
    const live = await startLive({ debounceMs: 40 })
    const first = connectSse(`${live.base}/api/events`)
    expect(await waitFor(() => first.events.length > 0, 2000)).toBe(true)
    first.close()
    await first.closed
    expect(await waitFor(() => live.store.subscriberCount === 0, 2000)).toBe(true)

    const added = newNode(live.graphRoot, 'node added while disconnected')
    expect(await waitFor(() => live.store.graph().nodeById.has(added), 3000)).toBe(true)

    const second = connectSse(`${live.base}/api/events`)
    // A fresh connection gets an immediate invalidation hint, so the client
    // refetches everything on open (REQ-007).
    expect(await waitFor(() => second.events.some((event) => event.kind === 'graph'), 2000)).toBe(true)
    const graph = (await (await fetch(`${live.base}/api/graph`)).json()) as { nodes: { id: string }[] }
    expect(graph.nodes.some((node) => node.id === added)).toBe(true)
    second.close()
    await second.closed
  })

  test('the generation counter bumps on a rebuild', async () => {
    const live = await startLive()
    const before = live.store.graph().generation
    live.store.rebuildNow()
    expect(live.store.graph().generation).toBe(before + 1)
  })

  test('an access-log append emits an access hint', async () => {
    // Some platforms coalesce creation of .access and its first log. Exercise
    // both supported invalidation paths with a short reconciliation interval.
    const live = await startLive({ debounceMs: 30, reconcileMs: 100 })
    const client = connectSse(`${live.base}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)
    const baseline = client.events.length

    const id = live.store.graph().nodes[0]?.id as string
    fs.mkdirSync(path.join(live.graphRoot, '.access'), { recursive: true })
    fs.appendFileSync(path.join(live.graphRoot, '.access', `${id}.log`), `${id} 2026-11-04T00:00:00Z\n`, 'utf8')

    expect(await waitFor(() => client.events.length > baseline, 2500)).toBe(true)
    expect(await waitFor(() => live.store.graph().nodeById.get(id)?.visitCount === 1, 2500)).toBe(true)
    client.close()
    await client.closed
  })

  test('the reconcile poll catches a change the watcher was not told about', async () => {
    const live = await startLive({ reconcileMs: 60_000 })
    const client = connectSse(`${live.base}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)
    const baseline = client.events.length

    // Simulate a missed watch event by writing while the watcher is closed.
    live.store.stopWatching()
    const added = newNode(live.graphRoot, 'added while the watcher was blind')
    live.store.reconcile()
    expect(await waitFor(() => client.events.length > baseline, 2000)).toBe(true)
    expect(live.store.graph().nodeById.has(added)).toBe(true)
    client.close()
    await client.closed
  })

  test('a deleted Node disappears from the snapshot', async () => {
    const live = await startLive({ debounceMs: 30 })
    const victim = newNode(live.graphRoot, 'node to be removed')
    expect(await waitFor(() => live.store.graph().nodeById.has(victim), 2500)).toBe(true)
    fs.rmSync(path.join(live.graphRoot, victim), { recursive: true, force: true })
    expect(await waitFor(() => !live.store.graph().nodeById.has(victim), 2500)).toBe(true)
  })

  test('subscribers are released when the store closes', async () => {
    const live = await startLive()
    const client = connectSse(`${live.base}/api/events`)
    expect(await waitFor(() => live.store.subscriberCount === 1, 2000)).toBe(true)
    client.close()
    expect(await waitFor(() => live.store.subscriberCount === 0, 2000)).toBe(true)
  })
})

describe('SSE edge cases', () => {
  test('HEAD /api/events does not open a stream or hold a subscriber', async () => {
    const live = await startLive()
    const response = await fetch(`${live.base}/api/events`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    await Bun.sleep(150)
    expect(live.store.subscriberCount).toBe(0)
  })

  test('the heartbeat interval equals the documented 5 s by default', () => {
    const store = new Store({
      graphRoot: tempDir(),
      stateDir: tempDir(),
      debounceMs: 10,
      reconcileMs: 60_000,
    })
    open.push(store)
    expect(store.heartbeatMs).toBe(5_000)
    expect(store.reconcileMs).toBe(60_000)
    // Defaults per REQ-007: 300 ms debounce, 10 s reconcile.
    const defaults = new Store({ graphRoot: tempDir(), stateDir: tempDir() })
    open.push(defaults)
    expect(defaults.debounceMs).toBe(300)
    expect(defaults.reconcileMs).toBe(10_000)
  })
})

// ---- #4: observation-only changes invalidate the dashboard --------------

describe('#4: run-side invalidation', () => {
  test('a late observation.jsonl appears without any task-row change', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'late observation node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('late-observation')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])

    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 30,
      reconcileMs: 100,
      taskPollMs: 60_000, // isolate the run fingerprint from the task poll
      heartbeatMs: 1000,
    })
    store.start()
    open.push(store)
    const { app, attach } = appWithServer({ store, configPath: path.join(base, 'c.json'), graphRoot, stateDir, tz: 'UTC' })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, fetch: (request) => app.handle(request) })
    attach(server)
    open.push({ stop: () => server.stop(true) })
    const client = connectSse(`http://127.0.0.1:${server.port}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)

    // No run directory at all yet: usage is unknown.
    expect(store.runs().runs[0]?.usageStatus).toBe('unknown')
    const baseline = client.events.filter((event) => event.kind === 'run').length

    // The capture lands AFTER the task row, with no change to updated_at.
    writeRunDir(stateDir, { taskId, observation: completeObservation(7, 7, 77) }, 0)

    expect(await waitFor(() => store.runs().runs[0]?.usageStatus === 'complete', 3000)).toBe(true)
    expect(await waitFor(() => client.events.some((event) => event.kind === 'run'), 3000)).toBe(true)
    expect(client.events.filter((event) => event.kind === 'run').length).toBeGreaterThan(baseline)
    client.close()
    await client.closed
  })

  test('appending usage to an existing capture emits a run hint', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'appended usage node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('appended')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    const runDir = writeRunDir(stateDir, { taskId, observation: jsonl([{ seq: 1, type: 'request_start', requestId: 'r1' }]) }, 0)

    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 30,
      reconcileMs: 100,
      taskPollMs: 60_000,
      heartbeatMs: 1000,
    })
    store.start()
    open.push(store)
    const { app, attach } = appWithServer({ store, configPath: path.join(base, 'c.json'), graphRoot, stateDir, tz: 'UTC' })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60, fetch: (request) => app.handle(request) })
    attach(server)
    open.push({ stop: () => server.stop(true) })
    const client = connectSse(`http://127.0.0.1:${server.port}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)
    expect(store.runs().runs[0]?.usageStatus).toBe('unknown')

    fs.appendFileSync(
      path.join(runDir, 'observation.jsonl'),
      JSON.stringify({ v: 1, seq: 2, type: 'request_end', requestId: 'r1', usage: { totalTokens: 500 } }) + '\n',
      'utf8',
    )

    expect(await waitFor(() => store.runs().runs[0]?.usage?.totalTokens === 500, 3000)).toBe(true)
    expect(await waitFor(() => client.events.some((event) => event.kind === 'run'), 3000)).toBe(true)
    client.close()
    await client.closed
  })

  test('a graph-only change does not claim the run index moved', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'graph only node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('graph-only')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])
    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 60_000 })
    store.start()
    open.push(store)

    const events: SseEvent[] = []
    store.subscribe((event) => events.push(event))
    newNode(graphRoot, 'a second node appears')
    store.rebuildNow()
    expect(events.some((event) => event.kind === 'graph')).toBe(true)
    // The run index did not change, so no `run` hint is fabricated.
    expect(events.some((event) => event.kind === 'run')).toBe(false)
  })

  test('a new run directory alone is noticed (2 s task poll, no graph change)', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'new run dir node')
    const stateDir = path.join(base, 'state')
    const taskId = taskUuid('new-run-dir')
    writeTasksDb(stateDir, [{ taskId, createdAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:05Z' }])

    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, taskPollMs: 2_000 })
    store.start()
    open.push(store)
    const events: SseEvent[] = []
    store.subscribe((event) => events.push(event))
    expect(store.runs().runs[0]?.usageStatus).toBe('unknown')

    writeRunDir(stateDir, { taskId, observation: completeObservation() }, 0)
    // The runs watcher fires; give it the debounce window.
    expect(await waitFor(() => store.runs().runs[0]?.usageStatus === 'complete', 3000)).toBe(true)
    expect(events.some((event) => event.kind === 'run')).toBe(true)
  })
})

// ---- #11: the stream outlives the server's own idle timeout -------------

describe('#11: SSE survives a configured idle timeout', () => {
  test('a quiet stream stays open past Bun idleTimeout and keeps heartbeating', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'idle timeout node')
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 60_000, heartbeatMs: 150 })
    store.start()
    open.push(store)
    const { app, attach } = appWithServer({ store, configPath: path.join(base, 'c.json'), graphRoot, stateDir, tz: 'UTC' })
    // A deliberately SHORT idleTimeout: without the per-request opt-out Bun
    // closes a streaming response at this deadline however often it enqueues.
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 2, fetch: (request) => app.handle(request) })
    attach(server)
    open.push({ stop: () => server.stop(true) })

    const client = connectSse(`http://127.0.0.1:${server.port}/api/events`)
    expect(await waitFor(() => client.events.length > 0, 2000)).toBe(true)
    // Proof of survival is TIME-BASED: the stream must still be receiving
    // heartbeats after the 2 s idleTimeout has elapsed.
    const beats = (): number => client.comments.filter((line) => line.includes('hb')).length
    const start = Date.now()
    expect(await waitFor(() => beats() >= 2, 6000)).toBe(true)
    while (Date.now() - start < 3000) await Bun.sleep(100)
    expect(beats()).toBeGreaterThan(2)

    // Still open after the idleTimeout: more heartbeats keep arriving.
    const before = beats()
    expect(await waitFor(() => beats() > before, 6000)).toBe(true)
    // At ~150 ms per beat over >3 s, a stream that had been torn down at 2 s
    // could not have produced this many.
    expect(beats()).toBeGreaterThan(12)
    expect(client.closed).toBeDefined()
    client.close()
    await client.closed
  }, 20_000)
})
