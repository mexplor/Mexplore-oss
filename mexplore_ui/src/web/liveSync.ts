// Live-sync orchestration (pure: no React, no DOM). SSE events are invalidation hints only; this module decides
// which registered refetchers to run and when:
//   • every open of the event stream — the first one and every reconnect — runs ALL refetchers immediately
//     (hints sent while we were disconnected are lost, so we must assume everything changed);
//   • hints are batched per scope for `batchMs` and each affected refetcher runs once per batch.
import type { EventHandlers } from './api.ts'
import type { SseEvent } from '../shared/types.ts'

export type Scope = 'graph' | 'node' | 'run'
export const ALL_SCOPES: readonly Scope[] = ['graph', 'node', 'run']
export type LiveStatus = 'connecting' | 'live' | 'reconnecting'

/**
 * Which scopes an SSE hint invalidates. `run` covers task rows and observation files; a node hint that names its
 * node only refetches the selected node (a provenance append sends one alone; content changes always add a `graph`
 * hint); everything else is graph data.
 */
export function scopesForHint(e: Pick<SseEvent, 'kind' | 'id'>): Scope[] {
  if (e.kind === 'run') return ['run']
  return e.kind === 'node' && e.id !== undefined ? ['node'] : ['graph', 'node']
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

interface Registration {
  scopes: ReadonlySet<Scope>
  fn: () => void
}

export class LiveSync {
  private regs = new Set<Registration>()
  private pending = new Set<Scope>()
  private timer: unknown = null
  private disconnect: (() => void) | null = null
  private statusListeners = new Set<() => void>()
  private _status: LiveStatus = 'connecting'
  private readonly timers: Timers
  private readonly batchMs: number

  constructor(
    private readonly connect: (h: EventHandlers) => () => void,
    opts: { timers?: Timers; batchMs?: number } = {},
  ) {
    this.timers = opts.timers ?? realTimers
    this.batchMs = opts.batchMs ?? 250
  }

  get status(): LiveStatus {
    return this._status
  }

  /** Register a refetcher for one or more scopes. Returns an unregister function. */
  register(scopes: readonly Scope[], fn: () => void): () => void {
    const r: Registration = { scopes: new Set(scopes), fn }
    this.regs.add(r)
    return () => {
      this.regs.delete(r)
    }
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  start(): void {
    if (this.disconnect) return
    this.disconnect = this.connect({
      onOpen: () => {
        this.setStatus('live')
        // (Re)connected: anything may have changed while we were away — refetch every view now.
        this.cancelBatch()
        this.run(ALL_SCOPES)
      },
      onError: () => this.setStatus('reconnecting'),
      onEvent: (e) => this.hint(scopesForHint(e)),
    })
  }

  stop(): void {
    this.cancelBatch()
    this.disconnect?.()
    this.disconnect = null
  }

  /** Queue scopes for the next batch flush. */
  hint(scopes: readonly Scope[]): void {
    for (const s of scopes) this.pending.add(s)
    if (this.timer === null) this.timer = this.timers.set(() => this.flush(), this.batchMs)
  }

  /** Run pending batched scopes now (also what the batch timer calls). */
  flush(): void {
    this.timer = null
    const scopes = [...this.pending]
    this.pending.clear()
    if (scopes.length) this.run(scopes)
  }

  private cancelBatch() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    this.pending.clear()
  }

  /** Each registered refetcher whose scopes intersect runs exactly once. */
  private run(scopes: readonly Scope[]) {
    for (const r of [...this.regs]) {
      if (scopes.some((s) => r.scopes.has(s))) {
        try {
          r.fn()
        } catch {
          /* one failing refetcher must not block the others */
        }
      }
    }
  }

  private setStatus(s: LiveStatus) {
    if (s === this._status) return
    this._status = s
    for (const l of [...this.statusListeners]) l()
  }
}
