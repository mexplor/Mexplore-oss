// Write-session provenance read path (#317): `.provenance/<id>.jsonl` is read
// through SafeRoot, projected onto known fields, capped, and never watched.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createApp } from '../src/server/app.ts'
import { SafeRoot } from '../src/server/fs-safe.ts'
import { buildGraphSnapshot } from '../src/server/graph/build.ts'
import {
  MAX_PROVENANCE_BYTES,
  MAX_PROVENANCE_LINES,
  parseProvenanceLine,
  readProvenance,
} from '../src/server/graph/provenance.ts'
import { Store } from '../src/server/store.ts'
import { fingerprintGraph } from '../src/server/watch.ts'
import type { NodeDetail } from '../src/shared/types.ts'
import { createHttpBackend, type EventSourceLike } from '../src/web/api.ts'
import { createAppStore } from '../src/web/appStore.ts'
import { LiveSync } from '../src/web/liveSync.ts'
import { cleanupTemps, newNode, serveOnEphemeralPort, tempDir, waitFor, writeTasksDb } from './helpers.ts'

const stores: Store[] = []
afterAll(() => {
  for (const store of stores) store.close()
  cleanupTemps()
})

const PEER = '01JC0000000000000000000000'

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ v: 1, ts: '2026-11-10T08:00:00.000Z', actor: 'chat', host: 'dsh', ...fields })}\n`
}

function writeProvenance(root: string, id: string, text: string): string {
  const dir = path.join(root, '.provenance')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function graph(): { root: string; id: string; safe: SafeRoot } {
  const root = path.join(tempDir(), 'graph')
  const id = newNode(root, 'provenance subject')
  return { root, id, safe: SafeRoot.open(root) as SafeRoot }
}

describe('readProvenance', () => {
  test('good lines come back in file order, projected onto the known fields', () => {
    const { root, id, safe } = graph()
    writeProvenance(
      root,
      id,
      line({ op: 'create', session: 'session-1b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d', call: 'call-1' }) +
        line({ ts: '2026-11-10T09:00:00.000Z', op: 'edge', session: 'ses_abc', host: 'opencode', peer: PEER, type: 'relates-to' }) +
        line({ ts: '2026-11-10T10:00:00.000Z', op: 'attach', session: null, reason: 'root-unverified', file: 'notes.md' }),
    )
    const p = readProvenance(safe, id)
    expect(p.unreadable).toBe(false)
    expect(p.truncated).toBe(false)
    expect(p.skipped).toBe(0)
    expect(p.first).toBeNull()
    expect(p.entries).toEqual([
      { ts: '2026-11-10T08:00:00.000Z', op: 'create', actor: 'chat', host: 'dsh', session: 'session-1b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d', call: 'call-1' },
      { ts: '2026-11-10T09:00:00.000Z', op: 'edge', actor: 'chat', host: 'opencode', session: 'ses_abc', peer: PEER, type: 'relates-to' },
      { ts: '2026-11-10T10:00:00.000Z', op: 'attach', actor: 'chat', host: 'dsh', session: null, reason: 'root-unverified', file: 'notes.md' },
    ])
  })

  test('unknown fields, paths and malformed values never pass through', () => {
    const entry = parseProvenanceLine(
      JSON.stringify({
        v: 1,
        ts: '2026-11-10T08:00:00Z',
        op: 'attach',
        actor: 'robot',
        host: 'elsewhere',
        session: 'ses_x',
        reason: 'import', // only kept when session is null
        file: '../../etc/passwd',
        peer: 'not-a-ulid',
        path: '/Users/someone/graph/.provenance/x.jsonl',
        body: 'SECRET BODY',
      }),
    )
    expect(entry).toEqual({ ts: '2026-11-10T08:00:00Z', op: 'attach', actor: 'unknown', host: 'unknown', session: 'ses_x' })
    expect(parseProvenanceLine(JSON.stringify({ ts: '2026-11-10T08:00:00Z', op: 'create', session: 'a'.repeat(201) }))?.session).toBeNull()
    expect(parseProvenanceLine(JSON.stringify({ ts: 'yesterday', op: 'create' }))).toBeNull()
    expect(parseProvenanceLine(JSON.stringify({ ts: '2026-11-10T08:00:00Z', op: 'DROP TABLE' }))).toBeNull()
    expect(parseProvenanceLine('[1,2]')).toBeNull()
  })

  test('a torn or unparseable line is skipped, not fatal', () => {
    const { root, id, safe } = graph()
    writeProvenance(
      root,
      id,
      line({ op: 'create', session: 'ses_a' }) + 'not json at all\n' + line({ op: 'update', session: 'ses_a' }) + '{"v":1,"ts":"2026-11-10T11:00:00Z","op":"ed',
    )
    const p = readProvenance(safe, id)
    expect(p.entries.map((e) => e.op)).toEqual(['create', 'update'])
    expect(p.skipped).toBe(2)
    expect(p.unreadable).toBe(false)
  })

  test('a missing file is the normal empty state', () => {
    const { id, safe } = graph()
    expect(readProvenance(safe, id)).toEqual({ entries: [], first: null, truncated: false, skipped: 0, unreadable: false })
  })

  test('an invalid id is refused before any path is built', () => {
    const { safe } = graph()
    expect(readProvenance(safe, '../MAP').entries).toEqual([])
  })

  test('a symlinked leaf is refused', () => {
    const { root, id, safe } = graph()
    const outside = path.join(tempDir(), 'planted.jsonl')
    fs.writeFileSync(outside, line({ op: 'create', session: 'ses_planted' }), 'utf8')
    fs.mkdirSync(path.join(root, '.provenance'))
    fs.symlinkSync(outside, path.join(root, '.provenance', `${id}.jsonl`))
    const p = readProvenance(safe, id)
    expect(p.entries).toEqual([])
    expect(p.unreadable).toBe(true)
  })

  test('a symlinked .provenance directory is refused, even pointing inside the root', () => {
    const { root, id, safe } = graph()
    const decoy = path.join(root, 'decoy')
    fs.mkdirSync(decoy)
    fs.writeFileSync(path.join(decoy, `${id}.jsonl`), line({ op: 'create', session: 'ses_decoy' }), 'utf8')
    fs.symlinkSync(decoy, path.join(root, '.provenance'))
    const p = readProvenance(safe, id)
    expect(p.entries).toEqual([])
    expect(p.unreadable).toBe(true)
  })

  test('only regular files are read', () => {
    const { root, id, safe } = graph()
    fs.mkdirSync(path.join(root, '.provenance', `${id}.jsonl`), { recursive: true })
    const p = readProvenance(safe, id)
    expect(p.entries).toEqual([])
    expect(p.unreadable).toBe(true)
  })

  test('an oversized file returns the newest tail plus its first line', () => {
    const { root, id, safe } = graph()
    let text = line({ op: 'create', session: 'session-origin' })
    let n = 0
    while (Buffer.byteLength(text) < MAX_PROVENANCE_BYTES * 2) {
      text += line({ ts: new Date(Date.parse('2026-11-10T08:00:00Z') + ++n * 1000).toISOString(), op: 'edge', session: 'ses_busy', peer: PEER })
    }
    text += line({ ts: '2026-11-11T00:00:00.000Z', op: 'update', session: 'ses_last' })
    writeProvenance(root, id, text)
    const p = readProvenance(safe, id)
    expect(p.truncated).toBe(true)
    expect(p.skipped).toBe(0) // the window's leading fragment is dropped, not counted
    expect(p.first).toMatchObject({ op: 'create', session: 'session-origin' })
    expect(p.entries.length).toBeLessThanOrEqual(MAX_PROVENANCE_LINES)
    expect(p.entries.at(-1)).toMatchObject({ op: 'update', session: 'ses_last' })
    expect(p.entries.some((e) => e.op === 'create')).toBe(false)
  })

  test('more lines than the line cap keep the newest ones and report the first', () => {
    const { root, id, safe } = graph()
    const lines = [line({ op: 'create', session: 'ses_origin' })]
    for (let i = 1; i <= MAX_PROVENANCE_LINES + 50; i++) lines.push(`{"ts":"2026-11-10T08:00:00Z","op":"update","session":"s${i}"}\n`)
    writeProvenance(root, id, lines.join(''))
    expect(Buffer.byteLength(lines.join(''))).toBeLessThan(MAX_PROVENANCE_BYTES)
    const p = readProvenance(safe, id)
    expect(p.truncated).toBe(true)
    expect(p.entries).toHaveLength(MAX_PROVENANCE_LINES)
    expect(p.entries.at(-1)?.session).toBe(`s${MAX_PROVENANCE_LINES + 50}`)
    expect(p.first).toMatchObject({ op: 'create', session: 'ses_origin' })
  })
})

describe('provenance stays out of the graph and the watcher', () => {
  test('the snapshot and the reconcile fingerprint ignore .provenance appends', () => {
    const { root, id } = graph()
    const before = fingerprintGraph(root).key
    const nodesBefore = buildGraphSnapshot(root, 1).nodes.length
    writeProvenance(root, id, line({ op: 'create', session: 'ses_a' }))
    fs.appendFileSync(path.join(root, '.provenance', `${id}.jsonl`), line({ op: 'update', session: 'ses_a' }))
    expect(fingerprintGraph(root).key).toBe(before)
    const snapshot = buildGraphSnapshot(root, 2)
    expect(snapshot.nodes.length).toBe(nodesBefore)
    expect(snapshot.nodeById.get(id)?.attachments).toEqual([])
  })

  test('a .provenance watch event does not arm a rebuild', () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'watch subject')
    writeTasksDb(path.join(base, 'state'), [])
    const store = new Store({ graphRoot, stateDir: path.join(base, 'state'), debounceMs: 300, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.scheduleRefresh(path.join('.provenance', `${id}.jsonl`), 'change')
    store.scheduleRefresh('.provenance', 'rename')
    expect(store.hasPendingRebuild()).toBe(false)
    expect(store.pendingKindCount()).toBe(0)
  })

  test('a .provenance append re-sends a node hint for that id only (debounced); stray names are dropped', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'hint subject')
    writeTasksDb(path.join(base, 'state'), [])
    const store = new Store({ graphRoot, stateDir: path.join(base, 'state'), debounceMs: 30, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    const events: unknown[] = []
    store.subscribe((event) => events.push(event))
    const generation = store.currentGeneration
    for (const name of [`${id}.jsonl`, `${id}.jsonl`, 'not-a-ulid.jsonl', `${PEER}.jsonl`, `${id}.jsonl.tmp`, '.DS_Store']) {
      store.scheduleRefresh(path.join('.provenance', name), 'change')
    }
    expect(store.hasPendingRebuild()).toBe(false)
    expect(await waitFor(() => events.length > 0, 1000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 80))
    // One hint for the known node; none for a non-ULID, an unknown node or a temp name; no rescan.
    expect(events).toEqual([{ kind: 'node', id }])
    expect(store.currentGeneration).toBe(generation)
  })
})

/**
 * A minimal EventSource over `fetch` (Bun has none): enough for the app's own
 * backend, which only uses onopen/onmessage/onerror and close().
 */
class FetchEventSource implements EventSourceLike {
  static opens = 0
  onopen: ((ev: Event) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  private readonly controller = new AbortController()
  constructor(url: string, base: string) {
    void this.run(`${base}${url}`)
  }
  private async run(url: string): Promise<void> {
    try {
      const response = await fetch(url, { signal: this.controller.signal, headers: { Accept: 'text/event-stream' } })
      FetchEventSource.opens += 1
      this.onopen?.(new Event('open'))
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = frame.split('\n').find((l) => l.startsWith('data: '))
          if (data !== undefined) this.onmessage?.({ data: data.slice(6) } as MessageEvent)
        }
      }
    } catch {
      if (!this.controller.signal.aborted) this.onerror?.(new Event('error'))
    }
  }
  close(): void {
    this.controller.abort()
  }
}

describe('a provenance append that lands after the content refresh still reaches the open panel', () => {
  test('real Store + API + LiveSync + AppStore: the client ends with the new write, no reconnect, no reopen', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'live provenance subject', { body: 'first body' })
    const file = writeProvenance(graphRoot, id, line({ op: 'create', session: 'ses_live' }))
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    // The reconcile poll is out of reach, so only the watcher can deliver the late append.
    const store = new Store({ graphRoot, stateDir, debounceMs: 40, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.start()
    const app = createApp({ store, graphRoot, stateDir, tz: 'UTC', port: 0 })
    const server = serveOnEphemeralPort(app, { idleTimeout: 30 })
    const origin = `http://127.0.0.1:${server.port}`
    FetchEventSource.opens = 0
    const backend = createHttpBackend({
      fetch: (input, init) => fetch(`${origin}${input}`, init),
      EventSource: class extends FetchEventSource {
        constructor(url: string) {
          super(url, origin)
        }
      },
    })
    const sync = new LiveSync((h) => backend.events(h))
    const client = createAppStore(backend, sync)
    try {
      sync.start()
      client.node.setQuery(id, id) // the panel is open on this node
      const shown = () => client.node.state.data
      expect(await waitFor(() => shown()?.provenance.entries.length === 1 && sync.status === 'live')).toBe(true)

      // The write publishes node.md first; the panel shows the new body with the old history.
      fs.writeFileSync(path.join(graphRoot, id, 'node.md'), fs.readFileSync(path.join(graphRoot, id, 'node.md'), 'utf8').replace('first body', 'second body'))
      expect(await waitFor(() => shown()?.body.includes('second body') === true)).toBe(true)
      expect(shown()?.provenance.entries).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 400)) // every hint of the content write is spent

      // Only now does the provenance append land.
      const generation = store.currentGeneration
      fs.appendFileSync(file, line({ ts: '2026-11-10T09:00:00.000Z', op: 'update', session: 'ses_live' }))
      expect(await waitFor(() => shown()?.provenance.entries.length === 2, 4000)).toBe(true)
      expect(shown()?.provenance.entries.at(-1)).toMatchObject({ op: 'update', session: 'ses_live' })
      expect(FetchEventSource.opens).toBe(1) // no reconnect
      expect(client.node.currentKey).toBe(id) // no reopen
      expect(store.currentGeneration).toBe(generation) // and no graph rescan
    } finally {
      client.dispose()
      await server.stop(true)
    }
  }, 20_000)
})

describe('/api/node/:id carries provenance', () => {
  test('the detail includes the lines and never a file path', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    const id = newNode(graphRoot, 'api subject')
    const empty = newNode(graphRoot, 'never tracked')
    writeProvenance(graphRoot, id, line({ op: 'create', session: 'session-api', path: '/secret/path' }))
    const stateDir = path.join(base, 'state')
    writeTasksDb(stateDir, [])
    const store = new Store({ graphRoot, stateDir, debounceMs: 20, reconcileMs: 600_000, taskPollMs: 600_000 })
    stores.push(store)
    store.rebuildNow()
    const app = createApp({ store, graphRoot, stateDir, tz: 'UTC', port: 4321 })
    const get = async (nodeId: string) => {
      const response = await app.handle(new Request(`http://127.0.0.1:4321/api/node/${nodeId}`, { headers: { host: '127.0.0.1:4321' } }))
      expect(response.status).toBe(200)
      return response.text()
    }
    const text = await get(id)
    const detail = JSON.parse(text) as NodeDetail
    expect(detail.provenance.entries).toEqual([{ ts: '2026-11-10T08:00:00.000Z', op: 'create', actor: 'chat', host: 'dsh', session: 'session-api' }])
    expect(text).not.toContain('.provenance')
    expect(text).not.toContain('/secret/path')
    expect(text).not.toContain(fs.realpathSync(graphRoot))
    const none = JSON.parse(await get(empty)) as NodeDetail
    expect(none.provenance).toEqual({ entries: [], first: null, truncated: false, skipped: 0, unreadable: false })
  })
})
