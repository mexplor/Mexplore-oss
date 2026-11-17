// App data store (pure: no React, no DOM). One Resource per API view; the live sync drives their refetches.
// Components set queries (selected node, dashboard range/sort/page) and subscribe; they never fetch on their own.
import { HttpError, type Backend, type RunsQuery } from './api.ts'
import type { GraphResponse, Meta, NodeDetail, RunsPage, UsageSummary } from '../shared/types.ts'
import type { LiveSync } from './liveSync.ts'

export interface FetchError {
  status: number | null
  message: string
}

export function toFetchError(e: unknown): FetchError {
  if (e instanceof HttpError) return { status: e.status, message: e.message }
  const message = String((e as Error)?.message ?? e)
  const m = /^(\d{3})\b/.exec(message)
  return { status: m ? Number(m[1]) : null, message }
}

/** 4xx = the server rejected this query (bad id, range too large …): retrying the same query cannot help. */
export const isRejected = (e: FetchError | null | undefined): boolean =>
  !!e && e.status !== null && e.status >= 400 && e.status < 500

export interface ResourceState<R> {
  data: R | null
  /** Key of the query that produced `data`. */
  dataKey: string | null
  error: FetchError | null
  /** Key of the query whose last attempt failed. */
  errorKey: string | null
  loading: boolean
  /** Increments on every successful load (even when the payload is unchanged). */
  version: number
  fetchedAt: number | null
}

/**
 * A latest-request-wins loader for one API view. `setQuery(null, null)` pauses it (refetches become no-ops);
 * setting a query whose key differs from the current one loads it immediately.
 */
export class Resource<Q, R> {
  private q: Q | null = null
  private key: string | null = null
  private seq = 0
  /** seq of the response whose data is currently applied */
  private appliedSeq = 0
  private listeners = new Set<() => void>()
  state: ResourceState<R> = { data: null, dataKey: null, error: null, errorKey: null, loading: false, version: 0, fetchedAt: null }

  constructor(
    private readonly fetcher: (q: Q) => Promise<R>,
    private readonly opts: { same?: (a: R, b: R) => boolean } = {},
  ) {}

  get currentKey(): string | null {
    return this.key
  }

  setQuery(q: Q | null, key: string | null): void {
    if (key === this.key) return
    this.q = q
    this.key = key
    if (q !== null) this.load()
  }

  /** Reload the current query (no-op while paused). */
  refetch(): void {
    if (this.q !== null) this.load()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private load() {
    const seq = ++this.seq
    const key = this.key
    const q = this.q as Q
    // an error belongs to the query that produced it; a different query starts clean (loading, not failed)
    this.set(this.state.errorKey === key ? { loading: true } : { loading: true, error: null, errorKey: null })
    this.fetcher(q).then(
      (r) => {
        // Any response for the current query that is newer than the applied one is valid data — even if a
        // later refetch of the same query is still in flight (that one may yet fail). Other queries' results drop.
        if (key !== this.key || seq < this.appliedSeq) return
        this.appliedSeq = seq
        const latest = seq === this.seq
        const prev = this.state.data
        const keep = prev !== null && this.state.dataKey === key && !!this.opts.same?.(prev, r)
        this.set({
          data: keep ? prev : r,
          dataKey: key,
          ...(latest ? { error: null, errorKey: null, loading: false } : {}),
          version: this.state.version + 1,
          fetchedAt: Date.now(),
        })
      },
      (e: unknown) => {
        // only the latest attempt decides the error state
        if (seq !== this.seq) return
        this.set({ error: toFetchError(e), errorKey: key, loading: false })
      },
    )
  }

  private set(patch: Partial<ResourceState<R>>) {
    this.state = { ...this.state, ...patch }
    for (const l of [...this.listeners]) l()
  }
}

export interface UsageQuery {
  from: string
  to: string
}

export interface AppStore {
  backend: Backend
  sync: LiveSync
  meta: Resource<true, Meta>
  graph: Resource<true, GraphResponse>
  node: Resource<string, NodeDetail>
  usage: Resource<UsageQuery, UsageSummary>
  runs: Resource<RunsQuery, RunsPage>
  dispose(): void
}

/**
 * Wire every view to the live sync. Scopes:
 *   graph → meta, graph, selected node      node → selected node      run → meta, usage, runs
 * (an open of the event stream runs all of them).
 */
export function createAppStore(backend: Backend, sync: LiveSync): AppStore {
  const meta = new Resource<true, Meta>(() => backend.meta())
  const graph = new Resource<true, GraphResponse>(() => backend.graph(), {
    // unchanged snapshot → keep the same object so the force layout is not rebuilt
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  })
  const node = new Resource<string, NodeDetail>((id) => backend.node(id))
  const usage = new Resource<UsageQuery, UsageSummary>((q) => backend.usage(q.from, q.to))
  const runs = new Resource<RunsQuery, RunsPage>((q) => backend.runs(q))

  const unregister = [
    sync.register(['graph', 'run'], () => meta.refetch()),
    sync.register(['graph'], () => graph.refetch()),
    sync.register(['graph', 'node'], () => node.refetch()),
    sync.register(['run'], () => usage.refetch()),
    sync.register(['run'], () => runs.refetch()),
  ]

  // Graph and meta are always wanted; node/usage/runs load once the UI sets their queries.
  meta.setQuery(true, 'meta')
  graph.setQuery(true, 'graph')

  return {
    backend,
    sync,
    meta,
    graph,
    node,
    usage,
    runs,
    dispose() {
      for (const u of unregister) u()
      sync.stop()
    },
  }
}
