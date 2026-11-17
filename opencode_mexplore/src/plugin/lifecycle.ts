/**
 * The owned-children map and the child lifecycle (REQ-002, REQ-003, REQ-004).
 *
 * The map is the plugin's whole notion of authority: a child session is "ours"
 * exactly while it is in this map. Two consumers read it —
 *
 *   - the executors, which refuse any graph-tool call whose `context.sessionID`
 *     is not owned, and any tool outside that child's tier (REQ-019);
 *   - the model-request hook, which shapes an owned child and hides the graph
 *     tools from everyone else (REQ-007).
 *
 * The lifecycle is `creating → running → settling → removed`. Four properties
 * make it correct rather than merely tidy:
 *
 *   - a child leaves the map only after `remove` actually succeeded (a real
 *     `NotFound` included), so a late hook call during teardown still sees it as
 *     owned, and a removal that FAILED keeps the child owned so `dispose` can
 *     retry it;
 *   - abort is handled by an explicit `context.signal` listener, not by a
 *     `finally` around `await wait()`: the Promise adapter stops awaiting on
 *     abort, so that `finally` may never run (spec REQ-004, `adapter.ts:255-264`);
 *   - an abort can land anywhere in the call — during `create`, during the
 *     prompt, during the wait, while the answer is read, while graph writes
 *     settle — and every one of those is a place this module listens or checks;
 *   - teardown is ONE 10 s budget for the interrupt plus the removal, not 10 s
 *     each, because AC-006 bounds the whole cleanup.
 *
 * @module mexplore/plugin/lifecycle
 */
import type { Authority, GraphCall } from '../graph/index'
import {
  GraphToolError,
  MANAGE_TOOL_NAMES,
  READ_TOOL_NAMES,
  TIER_REFUSAL_CODE,
} from '../graph/index'
import type { OwnedChild, ModelRef, ModelSource, ToolResultPayload } from './types'
import type { HostContext, HostSessionInfo } from './host'
import { CLEANUP_BOUND_MS } from './config'
import { PROVIDER_ID } from './config'
import { redact, redactSessionIDs } from './redact'

/** The child's fixed, human-visible title. It carries no id and no content. */
export const CHILD_TITLE = 'mexplore memory call'

/**
 * The child's agent (SP-1 decision): the built-in `summary` agent is hidden and
 * deny-all, and needs no undocumented API. Its tool set after deny-all is
 * `["skill"]`, hence the explicit allow rules below. Its own system prompt never
 * reaches the model: the `context` hook replaces it (REQ-009).
 */
export const CHILD_AGENT = 'summary'

/** A plugin-owned failure that reaches the model as a `tool.execution` error. */
export class MexploreError extends Error {
  readonly code: string
  constructor(message: string, code = 'MEXPLORE_ERROR') {
    super(message)
    this.name = 'MexploreError'
    this.code = code
  }
}

/** Thrown when the caller aborted, whether before or during the child's run. */
export class MexploreAborted extends MexploreError {
  constructor(message = 'mexplore: the call was aborted') {
    super(message, 'ABORTED')
  }
}

/**
 * A startup failure that still created the child (Lane B review #2).
 *
 * A prompt that throws, or an abort caught before prompting, happens AFTER the
 * session exists. `create` used to remove that child internally and throw a bare
 * error, so `runCall` never learned about it and wrote no usage record. Carrying
 * the child on the error lets the caller's ONE finalizer do the whole job:
 * drain, write the record, and remove.
 */
export class StartupFailure extends MexploreError {
  readonly child: OwnedChild | undefined
  constructor(message: string, code: string, child: OwnedChild | undefined) {
    super(message, code)
    this.name = 'StartupFailure'
    this.child = child
  }
}

/**
 * Thrown when the call's ONE deadline expired before an answer was available —
 * during startup, the prompt, or the wait (REQ-004, REQ-009's `timeoutMs`).
 * The message is filled in by `runCall`, which knows the configured budget.
 */
export class MexploreTimedOut extends MexploreError {
  constructor() {
    super('mexplore: the memory agent did not answer in time', 'TIMEOUT')
  }
}

/** The child permissions (REQ-008): deny everything, then allow this tier. */
export function childPermissions(
  authority: Authority,
): Array<{ action: string; resource: string; effect: 'allow' | 'deny' }> {
  const allowed = authority === 'manage' ? MANAGE_TOOL_NAMES : READ_TOOL_NAMES
  return [
    { action: '*', resource: '*', effect: 'deny' },
    ...allowed.map((name) => ({ action: name, resource: '*', effect: 'allow' as const })),
  ]
}

/** This process's identity: what a later instance needs to tell us apart. */
export interface OwnerIdentity {
  readonly pid: number
  /** Random per setup, so a reused PID is not mistaken for this instance. */
  readonly token: string
}

export function newOwnerIdentity(): OwnerIdentity {
  return { pid: process.pid, token: crypto.randomUUID() }
}

/** Metadata every child carries, so a later process can recognize and sweep it. */
export function childMetadata(owner: OwnerIdentity, now = Date.now()): Record<string, unknown> {
  return { mexploreChild: true, ownerPid: owner.pid, ownerToken: owner.token, createdAt: now }
}

export interface CreateChildInput {
  parentSessionID: string
  /**
   * Called the moment the child exists, BEFORE prompting, so usage capture is
   * already attached when its first step runs (Lane B review #2).
   */
  onCreated?: (child: OwnedChild) => void
  /**
   * The call's ONE id (Lane B, item 2): the same value passed to
   * `runtime.createCall`, so a dsh callId, a usage record and the child's
   * `OwnedChild` all name the same call. Minting a second UUID here made the
   * usage log's id unable to match anything else.
   */
  callId: string
  /**
   * The call's ONE deadline (REQ-004). Creation, provider publication and the
   * prompt all live inside it: a stalled host step must not buy extra time.
   */
  deadline: number
  /** The memory provider's endpoint right now, pinned for this child's lifetime. */
  currentBaseURL?: () => string
  authority: Authority
  model: ModelRef
  modelSource: ModelSource
  call: GraphCall
  /** The single prompt this call sends (REQ-002 step 3, REQ-009). */
  promptText: string
  signal: AbortSignal
}

export type WaitOutcome =
  | { status: 'completed' }
  | { status: 'timed-out' }
  | { status: 'aborted' }
  | { status: 'failed'; error: unknown }

/**
 * Run `body` with a hard deadline. `expired` is true when the deadline won, in
 * which case the caller must stop waiting — `body` may still be running, and
 * that is the point: nothing in the host can cancel a `remove` already sent.
 */
async function withDeadline<T>(
  ms: number,
  body: () => Promise<T>,
): Promise<{ expired: false; value: T } | { expired: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<{ expired: true }>((resolve) => {
    timer = setTimeout(() => resolve({ expired: true }), ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([body().then((value) => ({ expired: false as const, value })), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The owned-children registry plus every lifecycle operation that touches it.
 * One instance per plugin (per OpenCode process).
 */
export class ChildRegistry {
  private readonly ctx: HostContext
  private readonly children = new Map<string, OwnedChild>()
  private readonly timeoutMs: number
  /** Children whose `create` has not returned yet, so `dispose` can catch them. */
  private readonly creating = new Set<Promise<unknown>>()
  private readonly leases: ModelLeaseHooks
  private readonly reloadProvider: () => Promise<void>
  /** The endpoint each live child started against (REQ-021, AC-024). */
  private readonly endpoints = new Map<string, string>()
  /**
   * Sessions created after their call gave up waiting on them. They are not
   * owned by any call, so they are tracked here purely for cleanup, and a failed
   * removal leaves them here for `dispose` to retry.
   *
   * Each entry carries the LEASE RELEASE for its create (review round 3, major
   * 4): the lease must be dropped exactly once, on the removal that finally
   * confirms — whether that is the first attempt, a retry in `dispose`, or a
   * removal that completes after the timeout. It used to be dropped only by the
   * immediate attempt, so a failed first removal pinned the model for ever.
   */
  private readonly orphans = new Map<string, () => void>()
  private disposed = false

  /**
   * This plugin instance's identity, for the crash sweep (AC-022).
   *
   * A PID is not enough: PIDs are reused, and a long-lived sibling process (or a
   * call that legitimately runs past an hour) must never have its child deleted
   * by another instance. The token is fresh per setup, so "same pid, different
   * token" means "a previous process that had my pid", not "me".
   */
  readonly owner: OwnerIdentity

  constructor(
    ctx: HostContext,
    timeoutMs: number,
    leases: ModelLeaseHooks,
    reloadProvider: () => Promise<void>,
    /** Overridable so a test can model "this generation" against a fixed token. */
    owner: OwnerIdentity = newOwnerIdentity(),
  ) {
    this.ctx = ctx
    this.timeoutMs = timeoutMs
    this.leases = leases
    this.reloadProvider = reloadProvider
    this.owner = owner
  }

  /** The child serving this session, if this process owns it. */
  get(sessionID: string): OwnedChild | undefined {
    return this.children.get(sessionID)
  }

  isOwned(sessionID: string): boolean {
    return this.children.has(sessionID)
  }

  /** Every owned child's session ID. Diagnostics and tests only: never model-visible. */
  ownedSessionIDs(): string[] {
    return [...this.children.keys()]
  }

  /**
   * Run one graph tool for the OWNED child serving `sessionID` (REQ-019).
   * Refuses a non-owned caller and an out-of-tier tool before dsh is reached;
   * the A1 adapter re-checks the tier as well, belt to this brace.
   */
  async executeGraphTool(tool: string, args: unknown, sessionID: string): Promise<ToolResultPayload> {
    const child = this.children.get(sessionID)
    if (child === undefined) {
      throw new MexploreError(
        `mexplore: ${tool} is only available inside an mexplore call, and this session does not own one`,
        'NOT_OWNED',
      )
    }
    const tier = child.call.toolNames()
    if (!tier.includes(tool)) {
      throw new GraphToolError(
        `mexplore: ${tool} is not available to a ${child.authority} call (available: ${tier.join(', ')})`,
        TIER_REFUSAL_CODE,
      )
    }
    return child.call.execute(tool, args)
  }

  /**
   * REQ-002 steps 1-3: create the child, add it to the map BEFORE prompting (so
   * the model request the prompt wakes is already shaped), then send exactly one
   * prompt.
   *
   * The abort check is repeated after EVERY await, because an abort during
   * `create` or during `prompt` must still tear the child down — and any throw
   * from `prompt` removes the child here, since the caller never receives the
   * object it would need.
   */
  async create(input: CreateChildInput): Promise<OwnedChild> {
    if (this.disposed) throw new MexploreAborted('mexplore: the plugin unloaded before the call started')
    if (remaining(input.deadline) <= 0) throw new MexploreTimedOut()

    // Retained BEFORE `create`: a provider reload landing while the session is
    // being created must still find the model it is about to run on (REQ-021).
    // The endpoint this child is about to run against, captured BEFORE the
    // session exists: a later `/mexplore base-url` must not redirect it.
    const baseURL = input.model.providerID === PROVIDER_ID ? input.currentBaseURL?.() : undefined
    const leased = input.model.providerID === PROVIDER_ID
    if (leased) {
      this.leases.retain(input.model.id)
      // Publish the lease NOW: a `/mexplore model` or `/mexplore base-url`
      // reload may already have replayed the transform without this model, and
      // nothing else would replay it again before the child's first step.
      const published = await withDeadline(remaining(input.deadline), () =>
        this.reloadProvider().then(
          () => true,
          () => false,
        ),
      ).then((outcome) => (outcome.expired ? false : outcome.value))
      if (!published) {
        // No session was created, and nothing would ever release this lease:
        // dropping it keeps the model from being advertised for ever.
        this.leases.release(input.model.id)
        throw new MexploreError(
          'mexplore: could not register the memory model with OpenCode; the call was not started',
          'PROVIDER_RELOAD_FAILED',
        )
      }
    }
    const creating = this.ctx.session.create({
      parentID: input.parentSessionID,
      agent: CHILD_AGENT,
      model: input.model,
      title: CHILD_TITLE,
      permissions: childPermissions(input.authority),
      metadata: childMetadata(this.owner),
    })
    // Tracked until the create ACTUALLY SETTLES, not until we stop waiting for
    // it: a create that outlives the deadline still creates a session, and
    // `dispose` must be able to see that creation in flight (Major 5).
    const pending = this.track(creating, input, leased)
    let info: HostSessionInfo
    try {
      const started = await withDeadline(remaining(input.deadline), () => pending.settled)
      if (started.expired) {
        // The deadline won while the host was still creating the session. From
        // here nothing owns the result, so the tracking adopts and removes it —
        // including after `dispose`.
        pending.abandon()
        throw new MexploreTimedOut()
      }
      info = started.value
    } catch (error) {
      // A create that throws never made a session, so nothing pins the model.
      // The latch means this cannot double-release with the tracker's branch.
      if (error instanceof MexploreTimedOut) throw error
      pending.releaseLease()
      throw error
    }

    if (baseURL !== undefined) this.endpoints.set(info.id, baseURL)
    const child: OwnedChild = {
      sessionID: info.id,
      callId: input.callId,
      authority: input.authority,
      call: input.call,
      model: input.model,
      modelSource: input.modelSource,
      state: 'running',
    }
    this.children.set(info.id, child)

    // Register usage capture BEFORE prompting: the child's first step can fire
    // events while `prompt` is still pending, and a prompt that throws must
    // still be captured (Lane B review #2). The detach is handed out with the
    // child so the caller's finalizer owns it.
    input.onCreated?.(child)

    // Abort during create, or the plugin unloaded while it was in flight: the
    // child exists now and must go now — nothing was prompted. The caller owns
    // the removal (it is the one path that knows about the record).
    if (input.signal.aborted || this.disposed) {
      throw new StartupFailure(
        'mexplore: the call was aborted before it started',
        'ABORTED',
        child,
      )
    }

    try {
      await this.prompt(input.signal, info.id, input.promptText, input.deadline)
    } catch (error) {
      // The child exists but will never answer: keep its identity so the caller
      // can write its record AND remove it, instead of losing both.
      throw new StartupFailure(errorText(error), error instanceof MexploreError ? error.code : 'PROMPT_FAILED', child)
    }
    return child
  }

  /**
   * Track one in-flight creation until it SETTLES (Major 5).
   *
   * `settled` behaves exactly like the host call — resolves to the session,
   * rejects on failure — but the tracking outlives the caller's deadline:
   *
   *   - a late SUCCESS is a live session. If no call adopted it, it becomes an
   *     ORPHAN and is removed here, even after `dispose`, so it cannot leak;
   *   - a late FAILED removal keeps the orphan recorded, so `dispose` retries it;
   *   - a create that never produces a session releases the model lease, so a
   *     model is never left advertised for ever.
   */
  private track(
    creating: Promise<HostSessionInfo>,
    input: CreateChildInput,
    leased: boolean,
  ): { settled: Promise<HostSessionInfo>; abandon: () => void; releaseLease: () => void } {
    // ONE release per lease (review round 3, b1). `create` and this tracker can
    // both see the same failure — the tracker's rejection branch AND the catch
    // around `await settled` — and releasing twice drops the count to zero while
    // another concurrent call still holds the same model.
    let released = false
    const releaseLease = (): void => {
      if (!leased || released) return
      released = true
      this.leases.release(input.model.id)
    }
    // Set when the CALLER stops waiting. Only then may a late session be treated
    // as an orphan: a live call registers ownership right after its own await,
    // and microtask order is not something to rely on for a cleanup decision.
    let abandoned = false
    const settled = creating.then(
      (info) => info,
      (error: unknown) => {
        releaseLease()
        throw error
      },
    )
    // Kept until the host call settles, so `dispose` waits for the real thing.
    this.creating.add(creating)
    void creating.then(
      () => this.creating.delete(creating),
      () => this.creating.delete(creating),
    )
    void creating.then(
      (info) => {
        if (!abandoned) return
        if (this.children.has(info.id)) return
        // Recorded BEFORE removing, so a failed removal leaves it (and its
        // release) for `dispose` to retry (review round 3, major 4).
        this.orphans.set(info.id, releaseLease)
        void this.remove(info.id)
      },
      () => undefined,
    )
    return {
      settled,
      abandon: () => {
        abandoned = true
      },
      releaseLease,
    }
  }

  /**
   * Send the one prompt, giving up as soon as the caller aborts.
   *
   * The race is what makes an abort during `prompt` observable at all: `prompt`
   * returns an inbox item as soon as the host admits it, but a host that stalls
   * there must not be able to hold the call past an abort.
   */
  private async prompt(signal: AbortSignal, sessionID: string, text: string, deadline: number): Promise<void> {
    const sent = this.ctx.session.prompt({ sessionID, text })
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new MexploreAborted('mexplore: the call was aborted while starting'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      // The call's own deadline also bounds this wait: a prompt the host never
      // admits must not outlive the budget it was given.
      const timer = setTimeout(() => reject(new MexploreTimedOut()), remaining(deadline))
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
      // The listener outlives this call by design: `signal` belongs to the tool
      // call and is abandoned with it. Removing it on settle would need a
      // wrapper promise, and a stray no-op reject on an already-settled race is
      // impossible here because `aborted` is only observed by this race.
    })
    await Promise.race([sent, aborted])
  }

  /**
   * REQ-002 step 4 and REQ-004: wait, racing the timeout and an explicit abort
   * listener. Returns how it ended rather than throwing, because every ending
   * runs the same teardown.
   */
  async wait(child: OwnedChild, signal: AbortSignal, deadline = Date.now() + this.timeoutMs): Promise<WaitOutcome> {
    if (signal.aborted) return { status: 'aborted' }
    if (remaining(deadline) <= 0) return { status: 'timed-out' }
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: WaitOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = (): void => finish({ status: 'aborted' })
      // The CALL's remaining budget, not a fresh one: startup already spent part
      // of it (REQ-004).
      const timer = setTimeout(() => finish({ status: 'timed-out' }), remaining(deadline))
      // A short-lived test process must not wait on the timer; `unref` opts out.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
      signal.addEventListener('abort', onAbort, { once: true })
      this.ctx.session.wait({ sessionID: child.sessionID }).then(
        () => finish({ status: 'completed' }),
        (error: unknown) => finish({ status: 'failed', error }),
      )
    })
  }

  /**
   * Stop a running child WITHOUT removing it (Lane B review #1).
   *
   * The interrupt is what makes a timed-out or aborted child stop working, and
   * its terminal event is what the usage drain waits for — so it has to happen
   * before the record is written, and the removal after.
   */
  async interrupt(child: OwnedChild, deadline: number): Promise<void> {
    if (this.disposed) return
    // Bounded and swallowing: an interrupt that never settles must leave the
    // rest of the budget for the removal, which is what actually cleans up.
    await withDeadline(Math.min(interruptBudget(), remaining(deadline)), () =>
      this.ctx.session.interrupt({ sessionID: child.sessionID }).then(
        () => undefined,
        () => undefined,
      ),
    )
  }

  /**
   * REQ-004 teardown: ONE cleanup budget for everything.
   *
   * The interrupt goes first and is not awaited separately for a full bound —
   * both steps share {@link CLEANUP_BOUND_MS}, because AC-006 bounds the whole
   * cleanup, not each half of it.
   */
  async teardown(child: OwnedChild, options: { interrupt: boolean; deadline?: number }): Promise<void> {
    child.state = 'settling'
    // One deadline for the whole teardown, carried in from the caller so the
    // settlement wait and the cleanup share it instead of each taking a bound.
    const deadline = options.deadline ?? Date.now() + CLEANUP_BOUND_MS
    if (options.interrupt && !this.disposed) {
      // Bounded and swallowing: an interrupt that never settles must leave the
      // rest of the budget for the removal, which is what actually cleans up.
      await withDeadline(Math.min(interruptBudget(), remaining(deadline)), () =>
        this.ctx.session.interrupt({ sessionID: child.sessionID }).then(
          () => undefined,
          () => undefined,
        ),
      )
    }
    await this.remove(child.sessionID, remaining(deadline))
  }

  /**
   * Remove one session, idempotently, within `budgetMs`.
   *
   * "Idempotent" means a SECOND attempt is harmless — `NotFound` is success —
   * not that a failure is. A removal that failed for another reason keeps the
   * child owned, so `dispose` can try again and the leftover is logged instead
   * of silently forgotten.
   */
  async remove(sessionID: string, budgetMs = CLEANUP_BOUND_MS): Promise<boolean> {
    const attempt = this.ctx.session.remove({ sessionID }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // The host cannot cancel a `remove` already sent, so a late success is a
    // real removal: its continuation settles ownership even after the bound
    // expired, instead of leaving a model lease pinned to a child that is gone.
    void attempt.then((late) => {
      if (!late.ok && !isNotFound(late.error)) return
      // `settleRemoval` covers BOTH an owned child and an orphan: a removal that
      // completes after the call's bound still drops the orphan's lease, exactly
      // once (review round 3, major 4).
      this.settleRemoval(sessionID)
    })
    const outcome = await withDeadline(Math.max(budgetMs, 0), () => attempt)
    if (outcome.expired) {
      // The bound expired: stop waiting, but do NOT forget. The transcript is
      // still there, so ownership (and the model lease) stays, `dispose` can
      // retry, and the leftover is logged by its real id — a log is for the
      // operator, and the model never sees it.
      process.stderr.write(
        `mexplore: cleanup exceeded ${CLEANUP_BOUND_MS} ms; session ${sessionID} may remain\n`,
      )
      return false
    }
    const result = outcome.value
    if (result.ok || isNotFound(result.error)) {
      this.settleRemoval(sessionID)
      return true
    }
    // A real failure (transport, database): the transcript is still there, so
    // keep ownership and report it. `dispose` or the next teardown may succeed.
    process.stderr.write(
      `mexplore: could not remove session ${redactSessionIDs(sessionID)} (${redact(errorText(result.error))}); it is still owned\n`,
    )
    return false
  }

  /**
   * REQ-004 dispose: remove every child still owned, including one whose
   * `create` is still in flight.
   *
   * The in-flight creates get a BOUNDED wait, not an unbounded one: a stalled
   * `create` must not block the removal of children that are already owned. A
   * create that resolves after its bound is refused by the `disposed` check in
   * `create`, which removes the child it just made.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    // Bounded: a stalled create must not block removing what is already owned.
    // A create that settles later is adopted by `track`, which removes it even
    // though disposal has already finished.
    const inFlight = [...this.creating]
    await withDeadline(CLEANUP_BOUND_MS, () => Promise.allSettled(inFlight))
    // Remove what is owned now AND what a settling create made while we waited.
    const ids = new Set([...this.children.keys(), ...this.orphans.keys()])
    await Promise.all([...ids].map((id) => this.remove(id)))
  }

  /**
   * The endpoint a child must keep using, for the `model.request` hook
   * (REQ-021, AC-024).
   *
   * Pinning PER REQUEST is what lets a `/mexplore base-url` change apply to the
   * very next call: the provider can be reloaded immediately, because a running
   * child's endpoint is re-pointed on each of its own requests instead of being
   * held hostage by a pinned provider record.
   */
  endpointFor(sessionID: string): string | undefined {
    return this.endpoints.get(sessionID)
  }

  /**
   * A removal was CONFIRMED (or the session was already gone): settle everything
   * that removal was holding — the child's ownership, or an orphan's lease.
   *
   * Reachable from three places (immediate attempt, `dispose` retry, late
   * success after the bound), so it must be idempotent: the orphan entry is
   * deleted before its callback runs, and each callback is itself latched.
   */
  private settleRemoval(sessionID: string): void {
    const orphanRelease = this.orphans.get(sessionID)
    if (orphanRelease !== undefined) {
      this.orphans.delete(sessionID)
      orphanRelease()
    }
    if (this.children.has(sessionID)) this.release(sessionID)
  }

  /** Drop the child's model lease, once, as it leaves the map. */
  private release(sessionID: string): void {
    const child = this.children.get(sessionID)
    if (child === undefined) return
    this.children.delete(sessionID)
    this.endpoints.delete(sessionID)
    if (child.model.providerID !== PROVIDER_ID) return
    // Free the model slot, then replay the transform so a model that is no
    // longer held stops being advertised. The endpoint needs no replay: it is
    // already the current one, and each child pins its own per request.
    this.leases.release(child.model.id)
    void this.reloadProvider().catch(() => {})
  }

  /**
   * AC-022 crash sweep: children left behind by a process that died without
   * cleanup. A leftover is removed only when its owner PID is gone
   * (`process.kill(pid, 0)` throws ESRCH) or when it is older than
   * {a live owner — never merely because this process does not own it,
   * which would kill a sibling OpenCode process's live call.
   */
  async sweep(): Promise<number> {
    // Collect first, remove afterwards: removing while paging shifts the cursor
    // (the host's cursor is index-based over a live list).
    const leftovers: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.ctx.session.list(cursor === undefined ? { limit: 100 } : { limit: 100, cursor })
      for (const session of page.data) {
        if (this.children.has(session.id)) continue
        if (session.metadata?.mexploreChild !== true) continue
        if (!isDeadLeftover(session, Date.now(), this.owner)) continue
        leftovers.push(session.id)
      }
      const next = page.cursor?.next
      if (next === undefined || next === null) break
      cursor = next
    }
    for (const id of leftovers) await this.remove(id)
    return leftovers.length
  }
}

/** The model-lease bookkeeping the registry needs (never the provider itself). */
export interface ModelLeaseHooks {
  retain: (modelID: string) => void
  release: (modelID: string) => void
  /** Live leases (a model held by one child counts once per child). */
  size: () => number
}

/** How much of the budget the interrupt may use: half, so removal always has room. */
function interruptBudget(): number {
  return Math.floor(CLEANUP_BOUND_MS / 2)
}

function remaining(deadline: number): number {
  return Math.max(deadline - Date.now(), 0)
}

/**
 * Is this child safe to delete? (AC-022)
 *
 * **A live PID always vetoes deletion**, including our own. The sweep exists for
 * processes that died without running their cleanup, and nothing else:
 *
 *   - another project in the same server is a SIBLING plugin instance with the
 *     same pid and a different token (`core/src/plugin.ts` is Location-scoped,
 *     while session listing is not), so "same pid, different token" proves
 *     nothing about death — only the pid being alive does;
 *   - our own children are owned by the live registry, and `dispose` handles
 *     them.
 *
 * So age is never a reason on its own. Only a pid that no longer exists is.
 */
export function isDeadLeftover(
  session: HostSessionInfo,
  now = Date.now(),
  owner: OwnerIdentity = newOwnerIdentity(),
): boolean {
  void now
  void owner
  const pid = session.metadata?.ownerPid
  // No usable owner at all: nothing can ever come back for it.
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true
  return !isAlive(pid)
}

/** `process.kill(pid, 0)` probes liveness without signalling. ESRCH means gone. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another user: alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Does this removal failure mean the session is already gone? (AC-006)
 *
 * The host's own error is `Session.NotFoundError`, a TAGGED error, and when a
 * tag is present it is the whole answer. The text fallback exists only for an
 * untagged error, and it is deliberately NARROW: it must describe the SESSION
 * as absent — `Session <id> not found`, `no such session` — never merely contain
 * the words. A database error such as "session table not found" or "Session
 * removal failed: table not found" is a REAL failure, and treating it as
 * "already removed" would silently forget a session whose transcript survives.
 */
export function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const tag = (error as { _tag?: unknown })._tag
  if (tag === 'Session.NotFoundError') return true
  // A tagged error that is NOT NotFound is a real failure: never guess.
  if (typeof tag === 'string' && tag.length > 0) return false
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  if (/\bno\s+such\s+session\b/i.test(message)) return true
  // `session <id> not found` — the id is id-shaped, so "session table not found"
  // cannot match ("table" is not an id, and it is followed by "not found" only
  // by accident of the same shape, so the id shape is checked explicitly).
  const match = /\bsession\s+([\w-]+)\s+not\s+found\b/i.exec(message)
  return match !== null && /[0-9]/.test(match[1] ?? '')
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}
