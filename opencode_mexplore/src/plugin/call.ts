/**
 * One `mexplore` call, end to end (REQ-002, REQ-012, REQ-020).
 *
 * The shape is fixed by the spec: create → own → prompt → wait → check the
 * outcome → read the final text → settle → remove → return text + footer. Four
 * properties are easy to get subtly wrong, so they are stated here rather than
 * discovered later:
 *
 *   - **ONE deadline for the whole call** (REQ-004). Provider publication, child
 *     creation, the prompt and the wait share the configured `timeoutMs`, so a
 *     stalled startup cannot buy a second budget. When it expires the child is
 *     interrupted immediately — before its answer is read — because reading is
 *     exactly the step that would let a stopped call keep working.
 *   - **The footer is built from `GraphCall.footerLines()`** — the REAL tool
 *     results — never from the child's prose, so a child that merely SAYS it
 *     saved something still reports `no writes` (AC-016). A write that landed is
 *     announced even when the run then failed: hiding it invites a duplicate.
 *   - **An empty answer is a FAILURE, never `"" + no writes`** (REQ-020): the
 *     host swallows run failures, so the outcome, the last assistant message AND
 *     a rejected `wait` are all checked explicitly.
 *   - **Nothing model-visible escapes unsanitized** (REQ-003, AC-025, SEC-006).
 *     Every string leaves through one sanitizer bound to the live credential.
 *
 * @module mexplore/plugin/call
 */
import type { Authority, Evidence, GraphCall } from '../graph/index'
import type { HostContext, HostMessage, HostSessionInfo } from './host'
import type { ChildRegistry, WaitOutcome } from './lifecycle'
import { MexploreAborted, MexploreError, StartupFailure } from './lifecycle'
import type { ModelRef, ModelSource, OwnedChild, ToolResultPayload } from './types'
import { buildChildPrompt } from './prompt'
import { DRAIN_MS, normalizeTokens, usageStatus, type TokenUsage, type UsageCapture } from './usage-capture'
import type { UsageRecord } from './usage-log'
import { categoricalProviderError, refreshSanitizer, type Sanitizer } from './redact'
import { formatModelRef, modelNote } from './settings'
import type { ResolvedGraphRoot } from './config'
import { CLEANUP_BOUND_MS, INSPECT_BOUND_MS, MAX_ANSWER_BYTES, MAX_ANSWER_LINES } from './config'

/** Shown above an answer that hit the size cap. */
export const ANSWER_CAP_NOTE =
  'note: the memory agent answer was truncated here to fit the host output limit; ask a narrower question for the rest'

/** The note that makes an incomplete write accounting explicit (REQ-004). */
export const INCOMPLETE_SETTLEMENT_NOTE =
  'note: memory work was still in flight when this call ended; the lines above may be incomplete — check with a read before writing again'

export interface RunCallInput {
  parentSessionID: string
  /** The memory provider's endpoint right now, pinned for this child's lifetime. */
  currentBaseURL: () => string
  authority: Authority
  message: string
  evidence: Evidence[]
  call: GraphCall
  model: ModelRef
  modelSource: ModelSource
  signal: AbortSignal
  registry: ChildRegistry
  graphRoot: ResolvedGraphRoot
  /** The per-call budget, covering startup through the answer (REQ-004). */
  timeoutMs: number
  /** How long to wait for in-flight graph work after the run (default 10 s). */
  cleanupBudgetMs?: number
  /** Scrubs every string that leaves this call, bound to the live credential. */
  sanitize: Sanitizer
  /**
   * True when the failing provider's credential could not be resolved, so exact
   * redaction is impossible: the model's error is then reported by CATEGORY
   * (type + HTTP status) rather than by body (SEC-006).
   */
  categoricalErrors?: boolean
  /** The provider the memory model runs on, named in a categorical report. */
  providerID?: string
  /**
   * The plugin's usage recorder and writer (Lane B). `undefined` when the log is
   * disabled, in which case no usage work happens at all.
   */
  usage?: UsageSink
}

/**
 * Where a call's usage record goes. Injected so `runCall` stays testable
 * without touching `$XDG_STATE_HOME`.
 */
export interface UsageSink {
  /** Start capturing this child (a no-op if it was already seen). */
  track: (sessionID: string) => () => void
  /** Wait (bounded) for the terminal event, then the capture. */
  drain: (sessionID: string, ms?: number) => Promise<UsageCapture | undefined>
  /**
   * The capture as it stands right now. Read after the drain, because an event
   * can land in the moment between the drain expiring and the record being
   * written — and losing it would report `unknown` for a call that did report
   * usage.
   */
  read: (sessionID: string) => UsageCapture | undefined
  /** Append exactly one record. Failures are reported, never thrown. */
  write: (record: UsageRecord) => Promise<void>
  /** Shared constants the caller needs to size its budgets. */
  drainMs: number
  graphRoot: string
  pluginVersion: string
}

export interface CallResult extends ToolResultPayload {
  metadata: Record<string, unknown>
}

/**
 * Run one call. Every exit path — success, timeout, abort, failure — runs the
 * same teardown sequence before returning or throwing.
 */
export async function runCall(ctx: HostContext, input: RunCallInput): Promise<CallResult> {
  const { registry } = input
  // Rebinding happens after `create`, once the child's id exists.
  let sanitize = input.sanitize
  // ONE deadline, from the first line of the call (REQ-004).
  const deadline = Date.now() + input.timeoutMs
  let child: OwnedChild | undefined
  let outcome: WaitOutcome | undefined
  let assistantText: string | undefined
  let failure: MexploreError | undefined
  // Set when the registry no longer owns the child (disposed or removed).
  let lost = false
  // False when graph work outlived the cleanup bound: EVERY exit path then says
  // so rather than claim `no writes` (REQ-004).
  let settled = true
  // Set once the child is registered for usage capture; called after the record
  // is written, so a late event cannot resurrect a finished call.
  let detachUsage: (() => void) | undefined
  /** The child's identity survives a startup failure, so it can still be logged. */
  /** Totals already fetched by the call, reused instead of a fresh `session.get`. */
  let knownTotals: { tokens?: TokenUsage; cost?: number } | undefined
  const startedAt = new Date()

  try {
    child = await registry.create({
      parentSessionID: input.parentSessionID,
      callId: input.call.callId,
      authority: input.authority,
      model: input.model,
      modelSource: input.modelSource,
      call: input.call,
      promptText: buildChildPrompt(input.message, input.evidence),
      currentBaseURL: input.currentBaseURL,
      deadline,
      signal: input.signal,
      // Capture is attached BEFORE prompting: the child's first step can fire
      // events while `prompt` is still pending (Lane B review #2).
      onCreated: (created) => {
        sanitize = input.sanitize.own(created.sessionID)
        detachUsage = input.usage?.track(created.sessionID)
      },
    })
    // The child exists: from here, its id must never appear in any output.
    sanitize = input.sanitize.own(child.sessionID)
    // Idempotent: `onCreated` already registered it.
    detachUsage = input.usage?.track(child.sessionID)

    outcome = await registry.wait(child, input.signal, deadline)
    lost = !registry.isOwned(child.sessionID)
    if (lost) {
      // Disposed underneath us (plugin unload, REQ-004): the child is gone, so
      // the call is aborted rather than reported as "no reply".
      failure = new MexploreAborted('mexplore: the call was aborted because the plugin unloaded')
    } else if (input.signal.aborted) {
      failure = new MexploreAborted('mexplore: the call was aborted')
    } else if (outcome.status === 'timed-out') {
      // The deadline won: STOP the child first. Reading its answer while it may
      // still be running is what let a timed-out call keep working (REQ-004).
      failure = new MexploreError(timeoutMessage(input.timeoutMs), 'TIMEOUT')
    } else if (outcome.status === 'failed') {
      // `wait` rejects on a host or database failure. Reporting "no reply" here
      // would bury the real cause (REQ-020).
      failure = new MexploreError(
        `mexplore: the memory agent run could not be observed — ${describe(input, errorText(outcome.error))}`,
        'WAIT_FAILED',
      )
    } else if (outcome.status === 'completed') {
      const verdict = await inspectWithin(ctx, child.sessionID, input.signal, remaining(deadline))
      assistantText = verdict.text
      // The inspection already made a `session.get`: keep the totals it saw, so
      // accounting never issues a SECOND unbounded fetch (Lane B review #1/#6).
      knownTotals = verdict.totals
      // The model ran; its key may have been rotated since admission, so the
      // scrubber re-reads the credentials before reporting anything (AC-025).
      await refreshSanitizer(sanitize)
      const explained =
        verdict.failure !== undefined && verdict.failure.code === 'MODEL_FAILED' && input.categoricalErrors === true
          ? new MexploreError(
              `mexplore: memory model failed — ${categoricalProviderError(input.providerID ?? 'the provider', verdict.failure)}`,
              'MODEL_FAILED',
            )
          : verdict.failure
      failure =
        explained === undefined ? undefined : new MexploreError(sanitize.text(explained.message), explained.code)
    }
  } catch (error) {
    // A startup failure can still have created the child (a prompt that threw):
    // keep its identity so the SAME finalizer can drain and write its record.
    if (error instanceof StartupFailure && error.child !== undefined) {
      child = error.child
      sanitize = input.sanitize.own(error.child.sessionID)
      detachUsage ??= input.usage?.track(error.child.sessionID)
    }
    if (error instanceof MexploreError && error.code === 'TIMEOUT') {
      failure = new MexploreError(timeoutMessage(input.timeoutMs), 'TIMEOUT')
    } else if (error instanceof MexploreError) {
      failure = new MexploreError(describe(input, error.message), error.code)
    } else {
      failure = new MexploreError(`mexplore: the call failed — ${describe(input, errorText(error))}`, 'CALL_FAILED')
    }
  } finally {
    // Graph work this call STARTED has to be accounted for on EVERY exit path —
    // including a startup that threw before a child object existed, because the
    // prompt may already have started the child and its writes (REQ-004).
    //
    // ONE cleanup deadline, created before settlement: settlement and removal
    // share it, so a stalled write cannot cost two budgets.
    const cleanup = input.cleanupBudgetMs ?? CLEANUP_BOUND_MS
    const deadlineCleanup = Date.now() + cleanup
    if (child !== undefined) {
      const owned = !lost
      if (owned) child.state = 'settling'
      // ORDER (Lane B review #1): interrupt FIRST and do NOT remove, so the
      // terminal event caused by the interrupt can still reach the drain; then
      // drain, then write the record, then remove. Telemetry is bounded by the
      // cleanup deadline, and the removal below runs in a nested `finally`, so a
      // stall or throw in accounting can never leave the child running.
      const interruptNow =
        input.signal.aborted || outcome === undefined || outcome.status !== 'completed'
      try {
        if (owned && interruptNow) {
          await registry.interrupt(child, deadlineCleanup)
        }
        await recordUsage(ctx, input, {
          child,
          startedAt,
          failure,
          detach: detachUsage,
          // An ABSOLUTE deadline (review #2-1): the old value was a remaining
          // DURATION fed to `remaining()`, which subtracts `Date.now()` from it
          // and therefore always clamped to 1 ms — the fetch and the append were
          // effectively unbounded-free but never had their real budget.
          deadlineMs: deadlineCleanup,
          knownTotals,
          inspected: assistantText !== undefined,
          completed: outcome?.status === 'completed',
        })
      } finally {
        settled = await settleWithin(input.call, remaining(deadlineCleanup))
        if (owned) {
          await registry.teardown(child, { interrupt: false, deadline: deadlineCleanup })
        }
      }
      if (input.signal.aborted) failure ??= new MexploreAborted('mexplore: the call was aborted')
    } else {
      // A CHILDLESS failure — `session.create` rejected, the create deadline
      // expired, or provider publication failed (review #2-4). The contract asks
      // for one record per call, so this path writes one too: the shared call id,
      // the failure outcome, null usage and zero steps. Nothing is drained,
      // because there is no child whose events could arrive.
      try {
        await recordChildlessUsage(input, {
          startedAt,
          failure,
          deadlineMs: deadlineCleanup,
        })
      } catch {
        // Accounting never fails a memory call.
      }
      settled = await settleWithin(input.call, remaining(deadlineCleanup))
    }
    // Re-read the credentials before ANY output is produced: `/connect` may have
    // rotated the key while this call was running, and a failure raised on one of
    // the paths above would otherwise be scrubbed against the admission-time
    // snapshot (AC-025).
    await refreshSanitizer(sanitize)
  }

  const report = input.call.report()
  // Pending graph work is a property of the CALL, not of ownership: a disposed
  // child can still leave a write in flight.
  // "Pristine" means: nothing is owned out of band AND settlement finished. A
  // startup that threw after the child began writing leaves `settled` false when
  // the write outlived the budget, and `toolCalls` proves work really started.
  const pristine = settled && !lost
  const metadata = {
    authority: input.authority,
    model: formatModelRef(input.model),
    modelSource: input.modelSource,
    toolCalls: report.toolCalls,
    writes: sanitize.value(report.writes),
    edges: sanitize.value(report.edges),
    timedOut: failure?.code === 'TIMEOUT',
    aborted: input.signal.aborted || outcome?.status === 'aborted',
    truncated: false,
    graphRoot: input.graphRoot.path,
    graphRootSource: input.graphRoot.source,
    ...(pristine ? {} : { incompleteSettlement: true }),
  }

  // A write that LANDED is announced even when the run failed, so a retry does
  // not duplicate it. `no writes` is never added: a failure is not a claim about
  // what was written (REQ-012).
  const landed = report.writes.length === 0 ? [] : input.call.footerLines()
  const incomplete = pristine ? [] : [INCOMPLETE_SETTLEMENT_NOTE]
  const explain = (message: string, code: string): MexploreError => {
    const extra = [...landed, ...incomplete]
    return new MexploreError(
      sanitize.text(extra.length === 0 ? message : `${message}\n\n${extra.join('\n')}`),
      code,
    )
  }

  if (failure !== undefined) throw explain(failure.message, failure.code)
  if (assistantText === undefined || assistantText.length === 0) {
    throw explain('mexplore: no assistant reply — the memory model produced no text', 'NO_REPLY')
  }

  // The footer is built and SANITIZED first, because its real size has to be
  // reserved before the answer is capped: twenty 500-character save
  // announcements would otherwise push the total straight back over the host
  // limit (Minor 13). Every footer line goes through the bound sanitizer too — a
  // write description comes from the model, so it can carry an id or a credential.
  const footerCore = [...input.call.footerLines(), ...modelNote({ model: input.model, source: input.modelSource })]
    .map((line) => sanitize.text(line))
  if (!pristine) footerCore.push(INCOMPLETE_SETTLEMENT_NOTE)
  // Room the footer needs: its lines plus the blank separator. The cap note is
  // charged separately and only when the answer is actually cut.
  // +2 lines: the blank separator AND the trailing newline semantics of the
  // joined output (`split('\n')` counts one more line once the footer is joined).
  const footerCost = budgetOf(footerCore)
  const reserved = { lines: footerCost.lines + 2, bytes: footerCost.bytes + 1 }

  // The answer is capped like a graph result, so a child that pages through an
  // attachment cannot spill the transcript to `tool-output/` (SEC-004).
  const capped = capAnswer(sanitize.text(assistantText), reserved)
  const footer = capped.truncated ? [ANSWER_CAP_NOTE, ...footerCore] : footerCore

  return {
    content: [capped.text, '', ...footer].join('\n'),
    metadata: { ...metadata, truncated: capped.truncated },
  }
}

/**
 * Drain, reconcile and write this call's ONE usage record (Lane B, item 1).
 *
 * Called from the single finalizer, AFTER an interrupt has been sent and BEFORE
 * the child is removed — removal cascades the messages and ends the event
 * stream, so the terminal event the interrupt provokes has to be collected in
 * between. Every step is bounded by `budgetMs` (the remaining cleanup deadline),
 * so telemetry can never extend a call past its bound, and a throw here is
 * swallowed by the caller's nested `finally`.
 *
 * **Reconciliation (review #5/#6).** `complete` requires the CUMULATIVE event,
 * the terminal event and outcome `ok` — a step-only or cost-only capture is
 * `partial`. On a completed run the core's final totals REPLACE whatever the
 * events produced (a stale cumulative value, or an incomplete step fallback);
 * sources are never added together.
 */
async function recordUsage(
  ctx: HostContext,
  input: RunCallInput,
  options: {
    child: OwnedChild
    startedAt: Date
    failure: MexploreError | undefined
    detach: (() => void) | undefined
    /** ABSOLUTE epoch deadline shared by the drain, the fetch and the append. */
    deadlineMs: number
    /** Totals the call already fetched (the inspection's `session.get`). */
    knownTotals: { tokens?: TokenUsage; cost?: number } | undefined
    /** True once the call has read the session for its answer. */
    inspected: boolean
    completed: boolean
  },
): Promise<void> {
  const sink = input.usage
  const { child, detach } = options
  if (sink === undefined) {
    detach?.()
    return
  }
  let capture: UsageCapture | undefined
  try {
    capture = await sink.drain(
      child.sessionID,
      Math.min(sink.drainMs || DRAIN_MS, remaining(options.deadlineMs)),
    )
    // Freshest reading: an event can arrive just after the drain's own snapshot.
    capture = sink.read(child.sessionID) ?? capture

    // The core's own totals, reused when the call already fetched them; a fresh
    // `session.get` only when it did not, and bounded so it cannot stall.
    // A call that already read the session (inspection) NEVER reads it again: the
    // answer it got is the same snapshot, and a second unbounded `session.get`
    // is exactly what the review objected to (Lane B review #1).
    const authoritative =
      options.knownTotals ??
      (options.inspected
        ? undefined
        : await bounded(remaining(options.deadlineMs), () => crossCheck(ctx, child.sessionID)))

    if (options.completed && authoritative !== undefined) {
      // REPLACE, never add: the core's totals are the final word for a finished
      // run, whichever source the events came from.
      capture = {
        ...(capture ?? emptyCapture()),
        ...(authoritative.tokens === undefined ? {} : { tokens: authoritative.tokens, cumulative: true }),
        ...(authoritative.cost === undefined ? {} : { cost: authoritative.cost }),
      }
    } else if (capture !== undefined && capture.tokens === undefined && authoritative?.tokens !== undefined) {
      capture = { ...capture, tokens: authoritative.tokens, cumulative: true }
    }
  } catch {
    // Accounting never fails a memory call.
  }
  const outcome = outcomeOf(options.failure)
  const record: UsageRecord = {
    v: 1,
    // The SAME id the GraphCall was created with (Lane B, item 2).
    callId: child.callId,
    ts: options.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    authority: input.authority,
    outcome,
    latencyMs: Math.max(0, Date.now() - options.startedAt.getTime()),
    usageStatus: usageStatus({ capture, outcome }),
    tokens: capture?.tokens ?? null,
    // No pricing means no number: the contract forbids presenting $0 as spend.
    costUsd: capture?.cost !== undefined && capture.cost > 0 ? capture.cost : null,
    provider: input.model.providerID,
    model: input.model.id,
    modelSource: input.modelSource,
    steps: capture?.steps ?? 0,
    graphRoot: sink.graphRoot,
    pluginVersion: sink.pluginVersion,
  }
  // The APPEND gets whatever is left of the SAME deadline, so a slow write still
  // lands when the budget is large and is still bounded when it is small.
  await bounded(remaining(options.deadlineMs), () => sink.write(record)).catch(() => undefined)
  detach?.()
}

/**
 * Write the record for a call that never got a child (review #2-4).
 *
 * `session.create` can reject, its deadline can expire, or the provider
 * publication before it can fail — all before any session exists. Those are
 * real calls with a real cost of time, so they get a row like any other: the
 * same `callId`, the failure outcome, and explicitly NO usage (null tokens, zero
 * steps) rather than a missing row that reads as "never happened".
 */
async function recordChildlessUsage(
  input: RunCallInput,
  options: { startedAt: Date; failure: MexploreError | undefined; deadlineMs: number },
): Promise<void> {
  const sink = input.usage
  if (sink === undefined) return
  const record: UsageRecord = {
    v: 1,
    callId: input.call.callId,
    ts: options.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    authority: input.authority,
    outcome: outcomeOf(options.failure),
    latencyMs: Math.max(0, Date.now() - options.startedAt.getTime()),
    usageStatus: 'unknown',
    tokens: null,
    costUsd: null,
    provider: input.model.providerID,
    model: input.model.id,
    modelSource: input.modelSource,
    steps: 0,
    graphRoot: sink.graphRoot,
    pluginVersion: sink.pluginVersion,
  }
  await bounded(remaining(options.deadlineMs), () => sink.write(record)).catch(() => undefined)
}

/**
 * Run `body` with a deadline; a stall resolves to `undefined` rather than
 * hanging. Exported because the root-session walk (`src/index.ts`) must be
 * bounded by the same primitive: one behaviour for "the host never answered".
 */
export async function bounded<T>(ms: number, body: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(ms, 1))
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([body().catch(() => undefined), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function emptyCapture(): UsageCapture {
  return { tokens: undefined, cost: undefined, steps: 0, terminal: false, terminalType: undefined, cumulative: false }
}

/**
 * Read the child's own cumulative totals.
 *
 * Only reached when the call did not already fetch them: a completed run reads
 * the session during inspection and hands those totals over, which is what keeps
 * telemetry to zero extra host calls on the common path.
 */
async function crossCheck(
  ctx: HostContext,
  sessionID: string,
): Promise<{ tokens?: TokenUsage; cost?: number } | undefined> {
  const info = await ctx.session.get({ sessionID })
  const tokens = info.tokens === undefined ? undefined : normalizeTokens({
    input: info.tokens.input,
    output: info.tokens.output,
    reasoning: info.tokens.reasoning,
    cacheRead: info.tokens.cache?.read ?? 0,
    cacheWrite: info.tokens.cache?.write ?? 0,
  })
  const cost = typeof info.cost === 'number' && info.cost > 0 ? info.cost : undefined
  return tokens === undefined && cost === undefined ? undefined : { tokens, cost }
}

/** The contract's outcome vocabulary, from what the call ended with. */
function outcomeOf(failure: MexploreError | undefined): UsageRecord['outcome'] {
  if (failure === undefined) return 'ok'
  if (failure.code === 'TIMEOUT') return 'timeout'
  if (failure.code === 'ABORTED') return 'aborted'
  if (failure.code === 'NO_REPLY') return 'no_reply'
  return 'failed'
}

/** The lines and bytes a block of text occupies. */
function budgetOf(lines: readonly string[]): { lines: number; bytes: number } {
  if (lines.length === 0) return { lines: 0, bytes: 0 }
  return {
    lines: lines.length,
    bytes: byteLength(lines.join('\n')),
  }
}

/**
 * Cap the child's answer to the host's spill thresholds (SEC-004).
 *
 * The text is ALREADY sanitized, so the cap counts what is really sent. Lines
 * first, then bytes, always cutting on a line boundary so the result stays
 * readable and provably under both limits.
 */
export function capAnswer(
  text: string,
  reserved: { lines: number; bytes: number } = { lines: 0, bytes: 0 },
): { text: string; truncated: boolean } {
  // The footer (and the blank separator) is reserved up front, so the WHOLE
  // output — answer plus footer — stays inside both host limits.
  const maxLines = Math.max(MAX_ANSWER_LINES - reserved.lines, 0)
  const maxBytes = Math.max(MAX_ANSWER_BYTES - reserved.bytes, 0)
  if (text.length === 0) return { text: '', truncated: false }

  let truncated = false
  let kept = text.split('\n')
  if (kept.length > maxLines) {
    kept = kept.slice(0, maxLines)
    truncated = true
  }
  while (kept.length > 0 && byteLength(kept.join('\n')) > maxBytes) {
    // Drop the last line each round: a byte cut mid-line would split a
    // multi-byte character, and a line boundary is always safe.
    kept = kept.slice(0, -1)
    truncated = true
  }
  if (kept.length === 0 && text.length > 0) return { text: '', truncated: true }
  return { text: kept.join('\n'), truncated }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function timeoutMessage(timeoutMs: number): string {
  return `mexplore: the memory agent did not answer within ${formatDuration(timeoutMs)}; it was stopped. Try a narrower question, or raise the \`timeoutMs\` plugin option.`
}

/**
 * Describe a failure safely.
 *
 * With `categoricalErrors` set, the text may quote a key the plugin cannot
 * resolve, so only the provider error's TYPE and STATUS are kept — never its
 * body, and never the model's prose about it. Otherwise the ordinary sanitizer
 * runs.
 */
function describe(input: RunCallInput, text: string): string {
  if (input.categoricalErrors !== true) return input.sanitize.text(text)
  const shape = /\((?:HTTP\s*)?([45]\d\d)\)?/.exec(text)
  const status = shape?.[1] === undefined ? '' : ` (HTTP ${shape[1]})`
  const kind = /memory model failed/i.test(text) ? 'provider error' : 'run failed'
  return `${kind}${status} — the provider's message is omitted because its key could not be verified as absent`
}

function remaining(deadline: number): number {
  return Math.max(deadline - Date.now(), 0)
}

/**
 * `inspect`, bounded by the call's own remaining budget and abort-aware.
 *
 * Reading the child's final answer must not outlive the call: if the host stalls
 * on `get` or `context`, the deadline ends the read and the teardown still runs.
 */
async function inspectWithin(
  ctx: HostContext,
  sessionID: string,
  signal: AbortSignal,
  budget: number,
): Promise<{ text?: string; failure?: MexploreError; totals?: { tokens?: TokenUsage; cost?: number } }> {
  if (signal.aborted) return { failure: new MexploreAborted('mexplore: the call was aborted') }
  if (budget <= 0) return { failure: new MexploreError(timeoutMessage(0), 'TIMEOUT') }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<'aborted' | 'stalled'>((resolve) => {
    onAbort = () => resolve('aborted')
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => resolve('stalled'), Math.min(INSPECT_BOUND_MS, budget))
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    const raced = await Promise.race([inspect(ctx, sessionID), stop])
    if (raced === 'aborted') return { failure: new MexploreAborted('mexplore: the call was aborted') }
    if (raced === 'stalled') return { failure: new MexploreError(timeoutMessage(0), 'TIMEOUT') }
    return raced
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Await `call.settle()` but never longer than `ms`. dsh writes cannot be
 * cancelled, so a write that never resolves is reported as whatever it is: the
 * footer already holds every write that landed before the deadline.
 */
async function settleWithin(call: GraphCall, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([call.settle().then(() => true as const), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * REQ-020: `wait` ignores execution failures, so check the child's own outcome
 * and its last assistant message — the same test `subagent-job.ts:56-59` uses:
 * a message that EXISTS, is COMPLETED and carries no `error`. An abort during
 * this read ends the call as an abort, not as a missing answer.
 */
export async function inspect(
  ctx: HostContext,
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ text?: string; failure?: MexploreError; totals?: { tokens?: TokenUsage; cost?: number } }> {
  let info: { outcome?: string; tokens?: HostSessionInfo['tokens']; cost?: number }
  try {
    info = await ctx.session.get({ sessionID })
  } catch {
    // The child is gone already (interrupted/removed underneath us): no reply.
    if (signal?.aborted === true) return { failure: new MexploreAborted('mexplore: the call was aborted') }
    return { failure: new MexploreError('mexplore: the memory agent session ended without a reply', 'NO_REPLY') }
  }
  if (info.outcome === 'failed') {
    const messages = await safeContext(ctx, sessionID)
    const error = messages.map(errorOf).find((value) => value !== undefined)
    return {
      failure: new MexploreError(
        `mexplore: memory model failed: ${error ?? 'the run reported failure'}`,
        'MODEL_FAILED',
      ),
    }
  }
  if (info.outcome === 'interrupted') {
    return { failure: new MexploreAborted('mexplore: the memory agent run was interrupted') }
  }
  const messages = await safeContext(ctx, sessionID)
  const assistant = lastAssistant(messages)
  if (assistant === undefined) {
    return {
      failure: new MexploreError('mexplore: no assistant reply — the memory model produced no message', 'NO_REPLY'),
    }
  }
  const error = errorOf(assistant)
  if (error !== undefined) {
    return { failure: new MexploreError(`mexplore: memory model failed: ${error}`, 'MODEL_FAILED') }
  }
  if (assistant.time?.completed === undefined) {
    return {
      failure: new MexploreError('mexplore: no assistant reply — the memory model did not finish', 'NO_REPLY'),
    }
  }
  const text = textOf(assistant)
  // The totals this `session.get` already reported are handed back, so the usage
  // record never issues a second unbounded fetch (Lane B review #1/#6).
  const totals = totalsOf(info)
  if (text.length === 0) {
    return {
      failure: new MexploreError('mexplore: no assistant reply — the memory model produced no text', 'NO_REPLY'),
      ...(totals === undefined ? {} : { totals }),
    }
  }
  return { text, ...(totals === undefined ? {} : { totals }) }
}

/** A session's totals, from the `SessionInfo` the caller already holds. */
function totalsOf(info: { tokens?: HostSessionInfo['tokens']; cost?: number }): { tokens?: TokenUsage; cost?: number } | undefined {
  const tokens =
    info.tokens === undefined
      ? undefined
      : normalizeTokens({
          input: info.tokens.input,
          output: info.tokens.output,
          reasoning: info.tokens.reasoning,
          cacheRead: info.tokens.cache?.read ?? 0,
          cacheWrite: info.tokens.cache?.write ?? 0,
        })
  const cost = typeof info.cost === 'number' && info.cost > 0 ? info.cost : undefined
  return tokens === undefined && cost === undefined ? undefined : { tokens, cost }
}

async function safeContext(ctx: HostContext, sessionID: string): Promise<HostMessage[]> {
  try {
    return await ctx.session.context({ sessionID })
  } catch {
    return []
  }
}

function lastAssistant(messages: readonly HostMessage[]): HostMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.type === 'assistant') return message
  }
  return undefined
}

function textOf(message: HostMessage): string {
  const parts = message.content ?? []
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim()
}

function errorOf(message: HostMessage): string | undefined {
  const error = message.error
  if (error === undefined || error === null) return undefined
  if (typeof error.message === 'string' && error.message.length > 0) {
    return typeof error.type === 'string' ? `${error.type}: ${error.message}` : error.message
  }
  return 'the run reported an error'
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** `180000` → `3 minutes`, for a message a person reads. */
function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
  if (ms % 1000 === 0) return `${ms / 1000} seconds`
  return `${ms} ms`
}
