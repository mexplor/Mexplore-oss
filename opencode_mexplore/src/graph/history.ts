/**
 * The per-call dsh execution context (REQ-010).
 *
 * dsh_plugin reads three things off `exec`:
 *
 *   - `agent.id` (via `sessionKeyOf`), which keys the read-before-write,
 *     blind-rewrite and attachment guards. It is the CALL ID, so two mexplore
 *     calls never share authorization state — a read in call A cannot authorize
 *     an update in call B;
 *   - `agent.session.deriveMessages()` (F79 `promptingTurn`, F88
 *     `conversationWindow`, `userTurns`), the trusted history. It carries the
 *     caller's `message` and `evidence` ONLY: never the child's own output, or
 *     the model could vouch for its own invention by narrating it first;
 *   - `agent.phase.turn` (the blind-rewrite reset), which is absent here — a
 *     mexplore call is one turn, so the guard correctly never resets mid-call.
 *
 * The exec value must be FRESH per invocation, not one per GraphCall: dsh's
 * audited-refusal proof is per-(definition, exec) and an overlapping pair of
 * calls on one exec object poisons the epoch, which would turn a provable
 * pre-mutation refusal into an uncertain write and latch the fence. A fresh
 * object each time, carrying the same `agent.id`, keeps both properties.
 *
 * `provenance` is stamped here too, but it is NOT an authorization key: it says
 * which root chat the call belongs to (or why that could not be proved). The
 * engine reads it, never `agent.id`, for attribution (write-session provenance
 * #317, rule 3). It is never model-visible (rule 5).
 *
 * @module mexplore/graph/history
 */
import type { Evidence } from './types'

/**
 * Why a call has no root session. Closed set, shared with the engine: anything
 * outside it would be rejected as `resolver-error`.
 */
export type ProvenanceReason =
  | 'no-resolver'
  | 'root-unverified'
  | 'walk-failed'
  | 'import'
  | 'resolver-error'

/**
 * Where this call came from, as the host adapter proved it.
 *
 * `session` is the ROOT chat's own id — the top-level conversation the user
 * typed into — or `null` when the host has no positive proof (`reason` then
 * says why). It is never the immediate caller, an intermediate ancestor, the
 * child or the call id: a wrong id is worse than a missing one (rule 2).
 */
export interface CallOrigin {
  session: string | null
  reason?: ProvenanceReason
}

/** The value the engine reads off `exec.provenance`. */
export interface ExecProvenance {
  actor: 'chat'
  host: 'opencode'
  session: string | null
  /** Present only when `session` is null. */
  reason?: ProvenanceReason
}

/** One dsh history message, in the shape `deriveMessages()` returns. */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  source: { kind: 'user' | 'model' | 'tool' | 'plugin' }
  content: Array<{ type: 'text'; text: string }>
}

/** The exec contract dsh's tools consume. */
export interface DshExec {
  sessionId: string
  agent: {
    id: string
    session: { deriveMessages: () => HistoryMessage[] }
  }
  /**
   * The host's id for THIS call, recorded on a provenance line's `call` field
   * (#317 item 2). Attribution only — never an authorization key: the guards
   * key on `agent.id`, and dsh's audited-refusal epoch is keyed on the exec
   * object itself, not on any field of it.
   */
  callId: string
  /**
   * Read by the engine's provenance resolver (never by `sessionKeyOf`, and never
   * by dsh's guards). Optional because a test or a tool-exec shape may omit it;
   * the engine then falls back to its own resolver chain.
   */
  provenance?: ExecProvenance
}

function textMessage(role: HistoryMessage['role'], kind: HistoryMessage['source']['kind'], text: string): HistoryMessage {
  return { role, source: { kind }, content: [{ type: 'text', text }] }
}

/**
 * Build the trusted history: evidence first (the exchange preceding the
 * request), then the caller's message as the LAST user turn.
 *
 * That order is what dsh's checks expect. `promptingTurn` takes the last
 * `role:'user'` message with `source.kind:'user'` — the caller's message — and
 * `conversationWindow` ends at that same message, so the evidence is the
 * "conversation so far" an attachment may legitimately restate.
 *
 * Source kinds are chosen for what dsh does with them, not for decoration:
 * `source.kind:'tool'` is excluded from the traceability window (a tool result
 * never vouches for an attachment), and `'plugin'` is dsh's own injected
 * context. Caller-supplied evidence is neither, so every non-tool role maps to
 * a vouchable kind while keeping its own `role` verbatim.
 */
export function buildHistory(message: string, evidence: readonly Evidence[]): HistoryMessage[] {
  const history: HistoryMessage[] = []
  for (const entry of evidence) {
    history.push(textMessage(roleOf(entry.role), kindOf(entry.role), entry.content))
  }
  history.push(textMessage('user', 'user', message))
  return history
}

function roleOf(role: Evidence['role']): HistoryMessage['role'] {
  return role === 'user' || role === 'tool' ? 'user' : 'assistant'
}

function kindOf(role: Evidence['role']): HistoryMessage['source']['kind'] {
  if (role === 'tool') return 'tool'
  if (role === 'user') return 'user'
  // `assistant` and `system` evidence is context ABOUT the exchange, never the
  // human turn: mapping it to a model turn keeps `userTurns` (the search-depth
  // ordinal) and `promptingTurn` (the raw observation) counting only the
  // caller's own message.
  return 'model'
}

/**
 * A fresh exec for ONE tool invocation, carrying the call's identity.
 *
 * `callId` stays `sessionId` AND `agent.id`: they are the per-call
 * authorization keys the guards derive from, so the root session must never
 * travel in either (rule 3). It travels only in `provenance`.
 *
 * `callId` is ALSO copied onto the exec's own `callId` field, which is not an
 * authorization key: the engine reads it for the one thing it can say about a
 * call that `agent.id` cannot — the `call` on a provenance line (#317). dsh
 * itself reads `exec.callId` the same way, for receipts and the memory agent's
 * prompt-side caller block; no guard, session key or audited-refusal epoch
 * consults it.
 *
 * The provenance object is rebuilt per invocation (a fresh object, like the
 * exec itself), and `reason` is carried only when there is no session — the
 * engine's line schema forbids a reason beside a proven id.
 */
export function makeExec(
  callId: string,
  history: () => HistoryMessage[],
  origin: CallOrigin = { session: null, reason: 'no-resolver' },
): DshExec {
  const provenance: ExecProvenance = {
    actor: 'chat',
    host: 'opencode',
    session: origin.session,
    ...(origin.session === null ? { reason: origin.reason ?? 'root-unverified' } : {}),
  }
  return {
    sessionId: callId,
    agent: {
      id: callId,
      session: {
        // A copy each call: dsh hands the array around freely, and a shared
        // mutable history would let one reader's error mutate another's.
        deriveMessages: () => history().map((message) => ({ ...message, content: [...message.content] })),
      },
    },
    callId,
    provenance,
  }
}
