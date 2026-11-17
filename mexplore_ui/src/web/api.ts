// Data access. Real mode talks to the Bun server under /api; `?mock=1` swaps in an in-browser fake backend.
import type {
  GraphResponse,
  Meta,
  NodeDetail,
  RunsPage,
  SearchResponse,
  SseEvent,
  UsageSummary,
} from '../shared/types.ts'

export type FileResult =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

export type RunSort = 'createdAt' | 'totalTokens' | 'latencyMs'
export type SortDir = 'asc' | 'desc'

export interface RunsQuery {
  from: string
  to: string
  sort: RunSort
  dir: SortDir
  offset: number
  limit: number
}

export interface EventHandlers {
  onOpen: () => void
  onEvent: (e: SseEvent) => void
  onError: () => void
}

export interface Backend {
  readonly mock: boolean
  meta(): Promise<Meta>
  graph(): Promise<GraphResponse>
  node(id: string): Promise<NodeDetail>
  file(id: string, name: string): Promise<FileResult>
  usage(from: string, to: string): Promise<UsageSummary>
  runs(q: RunsQuery): Promise<RunsPage>
  search(q: string): Promise<SearchResponse>
  /** Subscribe to live invalidation hints. Returns an unsubscribe function. */
  events(h: EventHandlers): () => void
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Minimal EventSource surface the backend needs (lets tests inject a fake). */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
  onmessage: ((ev: MessageEvent) => unknown) | null
  close(): void
}

export interface HttpDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  EventSource: new (url: string) => EventSourceLike
}

const qs = (o: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString()

/** The real backend over HTTP + SSE. Dependencies default to the browser globals. */
export function createHttpBackend(deps: Partial<HttpDeps> = {}): Backend {
  const doFetch: HttpDeps['fetch'] = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(path, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) msg = body.error
      } catch {
        /* not json */
      }
      throw new HttpError(res.status, msg)
    }
    return (await res.json()) as T
  }

  return {
    mock: false,
    meta: () => getJson<Meta>('/api/meta'),
    graph: () => getJson<GraphResponse>('/api/graph'),
    node: (id) => getJson<NodeDetail>(`/api/node/${encodeURIComponent(id)}`),
    async file(id, name) {
      const res = await doFetch(`/api/node/${encodeURIComponent(id)}/file/${encodeURIComponent(name)}`)
      if (res.status === 415) return { kind: 'binary' }
      if (res.status === 404) return { kind: 'missing' }
      if (!res.ok) return { kind: 'error', message: `${res.status} ${res.statusText}` }
      return { kind: 'text', text: await res.text(), truncated: res.headers.get('X-Truncated') === '1' }
    },
    usage: (from, to) => getJson<UsageSummary>(`/api/usage?${qs({ from, to, bucket: 'day' })}`),
    runs: (q) => getJson<RunsPage>(`/api/runs?${qs({ ...q })}`),
    search: (q) => getJson<SearchResponse>(`/api/search?${qs({ q })}`),
    events(h) {
      const ES = deps.EventSource ?? (globalThis.EventSource as unknown as HttpDeps['EventSource'])
      // EventSource reconnects by itself after an error and fires onopen again on the same instance.
      const es = new ES('/api/events')
      es.onopen = () => h.onOpen()
      es.onerror = () => h.onError()
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data as string) as SseEvent
          if (e && typeof e.kind === 'string') h.onEvent(e)
        } catch {
          /* ignore malformed hint */
        }
      }
      return () => es.close()
    },
  }
}

export function isMockMode(): boolean {
  return new URLSearchParams(window.location.search).get('mock') === '1'
}

export async function loadBackend(): Promise<Backend> {
  if (isMockMode()) {
    const { createMockBackend } = await import('./mock/mockBackend.ts')
    const n = Number(new URLSearchParams(window.location.search).get('nodes') ?? '')
    return createMockBackend({ nodes: Number.isFinite(n) && n > 0 ? n : 90 })
  }
  return createHttpBackend()
}
