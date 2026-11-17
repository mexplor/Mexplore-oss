/**
 * Token-usage capture for one `mexplore` call (Lane B, item 1).
 *
 * **Where the numbers come from.** Not from `session.context`: the child is
 * removed as soon as the call ends, and the messages cascade with it. OpenCode
 * emits usage as EVENTS, and they reach a plugin through `ctx.event.subscribe`:
 *
 *   - `session.usage.updated` — the CUMULATIVE tokens and cost for a session,
 *     emitted as the run progresses. Authoritative when it arrives;
 *   - `session.step.ended` / `session.step.failed` — per-step tokens and cost.
 *     The fallback when no cumulative value came through;
 *   - `session.execution.succeeded` / `.failed` / `.interrupted` — the terminal
 *     event. Its arrival is what makes a record `complete`.
 *
 * The two sources are never ADDED: a cumulative value already contains its
 * steps, so summing both would double-count. The recorder prefers the cumulative
 * value and only falls back to step sums.
 *
 * **Buffering.** A child's first step can start before `session.create` returns,
 * so events for an unknown session id are buffered for a short window and
 * replayed when the call registers. Only owned sessions are recorded: an event
 * for any other session is dropped immediately.
 *
 * **Draining.** On every exit path the recorder waits (bounded) for the terminal
 * event, because the plugin removes the session immediately afterwards and a
 * queued event can otherwise be lost. The drain budget lives inside the call's
 * cleanup budget, so accounting never extends a call.
 *
 * Nothing here touches message text, node content, keys or the child's id: a
 * record carries numbers, the call id, and the model/provider it ran on.
 *
 * @module mexplore/plugin/usage-capture
 */

/** OpenCode's raw token semantics: `input` excludes cached input, `output` excludes reasoning. */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** How trustworthy a record's usage numbers are. */
export type UsageStatus = 'complete' | 'partial' | 'unknown'

/** The event shapes the recorder consumes, as `ctx.event.subscribe` delivers them. */
export interface UsageEvent {
  readonly type: string
  readonly data?: {
    readonly sessionID?: string
    /** OpenCode's own shape: `cache: { read, write }`. */
    readonly tokens?: Partial<TokenUsage> & {
      readonly cache?: { readonly read?: number; readonly write?: number }
    }
    readonly cost?: number
  }
}

/** What one call's recorder knows at the end. */
export interface UsageCapture {
  /** Cumulative tokens, or `undefined` when none arrived. */
  tokens: TokenUsage | undefined
  /**
   * True when `tokens` came from a CUMULATIVE value (the
   * `session.usage.updated` event, or the session's own final totals) rather than
   * from summed steps. Only a cumulative capture can be `complete`
   * (Lane B review #5).
   */
  cumulative: boolean
  /** Cumulative cost, or `undefined` when none arrived. */
  cost: number | undefined
  /** How many steps finished (ended or failed). */
  steps: number
  /** True once a terminal `session.execution.*` event arrived. */
  terminal: boolean
  /** The terminal event's kind, for the outcome cross-check. */
  terminalType: string | undefined
}

const TERMINAL_TYPES = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
])

const STEP_TYPES = new Set(['session.step.ended', 'session.step.failed'])

/** How long an event for an unknown session is held while its call registers. */
export const BUFFER_MS = 10_000

/** How long a call waits for the terminal event before writing its record. */
export const DRAIN_MS = 500

/**
 * Normalize OpenCode's partially-populated token object.
 *
 * The wire shape nests the cache counters (`tokens.cache.read` / `.write`); the
 * record's flat `cacheRead` / `cacheWrite` are this module's own names. Both are
 * accepted so a caller can hand over either without a translation step.
 */
export function normalizeTokens(
  value:
    | (Partial<TokenUsage> & { readonly cache?: { readonly read?: number; readonly write?: number } })
    | undefined,
): TokenUsage | undefined {
  if (value === undefined || value === null) return undefined
  const read = (field: keyof TokenUsage): number => {
    const candidate = value[field]
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0
  }
  const tokens: TokenUsage = {
    input: read('input'),
    output: read('output'),
    reasoning: read('reasoning'),
    cacheRead: value.cacheRead ?? value.cache?.read ?? 0,
    cacheWrite: value.cacheWrite ?? value.cache?.write ?? 0,
  }
  // An all-zero object is indistinguishable from "no usage reported": a provider
  // that reports nothing must not look like a free call (the contract says null,
  // never 0).
  return total(tokens) === 0 ? undefined : tokens
}

/** Sum that mirrors `TokenUsage.total` in the core. */
export function total(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

/**
 * Collects usage for the children this plugin owns.
 *
 * One instance per plugin process. `track(sessionID)` starts a buffer for a
 * child as soon as its id is known; `drain(sessionID)` waits (bounded) for the
 * terminal event and returns the capture.
 */
export class UsageRecorder {
  /** Buffers per session, until `track` claims them. */
  private readonly pending = new Map<string, { events: UsageEvent[]; timer: ReturnType<typeof setTimeout> }>()
  /** Live captures, per owned child. */
  private readonly captures = new Map<string, Capture>()

  /** Feed one event. Unknown sessions are buffered; unowned ones are ignored. */
  observe(event: UsageEvent): void {
    const sessionID = event.data?.sessionID
    if (typeof sessionID !== 'string' || sessionID.length === 0) return
    const capture = this.captures.get(sessionID)
    if (capture !== undefined) {
      apply(capture, event)
      return
    }
    // Before `create` returns, or before `track` runs, a step can already have
    // started. Buffer briefly rather than lose the child's first numbers.
    const buffer = this.pending.get(sessionID)
    if (buffer !== undefined) {
      buffer.events.push(event)
      return
    }
    const timer = setTimeout(() => this.pending.delete(sessionID), BUFFER_MS)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
    this.pending.set(sessionID, { events: [event], timer })
  }

  /**
   * Register a child and replay anything buffered for it. Returns a function
   * that detaches the capture once the record is written.
   */
  track(sessionID: string): () => void {
    if (!this.captures.has(sessionID)) this.captures.set(sessionID, newCapture())
    const buffered = this.pending.get(sessionID)
    if (buffered !== undefined) {
      clearTimeout(buffered.timer)
      this.pending.delete(sessionID)
      const capture = this.captures.get(sessionID) as Capture
      for (const event of buffered.events) apply(capture, event)
    }
    return () => this.captures.delete(sessionID)
  }

  /** The current capture (a snapshot), for a completed call. */
  read(sessionID: string): UsageCapture | undefined {
    const capture = this.captures.get(sessionID)
    return capture === undefined ? undefined : snapshot(capture)
  }

  /**
   * Wait up to `ms` for the terminal event, then return the capture.
   *
   * `session.remove` cascades messages and ends the child's event stream, so a
   * terminal event still in flight would otherwise be lost — and its absence is
   * exactly what distinguishes `complete` from `partial`.
   */
  async drain(sessionID: string, ms = DRAIN_MS): Promise<UsageCapture | undefined> {
    const capture = this.captures.get(sessionID)
    if (capture === undefined) return undefined
    if (!capture.terminal && ms > 0) {
      await new Promise<void>((resolve) => {
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          capture.waiters.delete(finish)
          resolve()
        }
        const timer = setTimeout(finish, ms)
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
        capture.waiters.add(finish)
      })
    }
    return snapshot(capture)
  }

  /** Drop every buffer and capture. Called on dispose. */
  clear(): void {
    for (const buffer of this.pending.values()) clearTimeout(buffer.timer)
    this.pending.clear()
    for (const capture of this.captures.values()) for (const waiter of capture.waiters) waiter()
    this.captures.clear()
  }
}

interface Capture {
  tokens: TokenUsage | undefined
  cost: number | undefined
  stepTokens: TokenUsage | undefined
  stepCost: number | undefined
  steps: number
  terminal: boolean
  terminalType: string | undefined
  waiters: Set<() => void>
}

function newCapture(): Capture {
  return {
    tokens: undefined,
    cost: undefined,
    stepTokens: undefined,
    stepCost: undefined,
    steps: 0,
    terminal: false,
    terminalType: undefined,
    waiters: new Set(),
  }
}

function apply(capture: Capture, event: UsageEvent): void {
  const tokens = normalizeTokens(event.data?.tokens)
  const cost = typeof event.data?.cost === 'number' && event.data.cost > 0 ? event.data.cost : undefined

  if (event.type === 'session.usage.updated') {
    // Cumulative: a later value REPLACES the earlier one. Never added to steps.
    if (tokens !== undefined) capture.tokens = tokens
    if (cost !== undefined) capture.cost = cost
    return
  }
  if (STEP_TYPES.has(event.type)) {
    capture.steps += 1
    // Only kept as a fallback: an event without tokens/cost still counts a step.
    if (tokens !== undefined) capture.stepTokens = add(capture.stepTokens, tokens)
    if (cost !== undefined) capture.stepCost = (capture.stepCost ?? 0) + cost
    return
  }
  if (TERMINAL_TYPES.has(event.type)) {
    capture.terminal = true
    capture.terminalType = event.type
    for (const waiter of [...capture.waiters]) waiter()
  }
}

function add(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (current === undefined) return { ...next }
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    reasoning: current.reasoning + next.reasoning,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
  }
}

function snapshot(capture: Capture): UsageCapture {
  // Cumulative wins; steps are the fallback, never an addition to it.
  const tokens = capture.tokens ?? capture.stepTokens
  const cost = capture.cost ?? capture.stepCost
  return {
    tokens,
    // Provenance survives the snapshot, so `usageStatus` can tell a real
    // cumulative total from an incomplete sum of steps.
    cumulative: capture.tokens !== undefined,
    cost: cost !== undefined && cost > 0 ? cost : undefined,
    steps: capture.steps,
    terminal: capture.terminal,
    terminalType: capture.terminalType,
  }
}

/**
 * Decide `usageStatus` from what actually arrived (contract, Lane B item 1):
 *
 *   - **complete** — the terminal event AND a cumulative value arrived, on a
 *     successful call;
 *   - **partial** — the call timed out / was aborted / the drain expired, but
 *     some usage was captured;
 *   - **unknown** — nothing usable arrived.
 */
export function usageStatus(input: {
  capture: UsageCapture | undefined
  outcome: 'ok' | 'failed' | 'timeout' | 'aborted' | 'no_reply'
}): UsageStatus {
  const tokens = input.capture?.tokens
  if (tokens === undefined && input.capture?.cost === undefined) return 'unknown'
  // `complete` needs all three: a CUMULATIVE value (never a sum of steps), the
  // terminal event, and a successful outcome. A step-only or cost-only capture
  // is real but not the whole bill, so it stays partial (Lane B review #5).
  const settled =
    input.capture?.cumulative === true && input.capture.terminal === true && input.outcome === 'ok'
  return settled ? 'complete' : 'partial'
}
