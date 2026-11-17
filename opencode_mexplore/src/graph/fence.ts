/**
 * The per-call write fence (REQ-011).
 *
 * A turn's writes are all-or-nothing only in the sense the model must know:
 * once a write's effect is UNCERTAIN (it threw after it may have started) or
 * KNOWN-PARTIAL (the node landed, its attachment or a link did not), no later
 * write can be vouched for, so later writes are refused instead of stacking on
 * top of it. Reads are never fenced — a fence that blocked reads would take
 * away the one thing the model still needs to report the partial effect.
 *
 * Two write failures must NOT latch, because dsh proves the graph was never
 * touched:
 *
 *   - a schema/semantic rejection from the definition's own trusted
 *     preparation (`trustedPreparationFor`), where `execute` is never called;
 *   - an audited pre-mutation refusal (`consumeAuditedRefusal`: `update_unread`,
 *     `supersede_unread`, `attach_overwrite_unseen`, …), where the handler threw
 *     at a branch the source audit established runs before any mutation.
 *
 * The model can then read and retry, which is the whole point of those codes.
 *
 * @module mexplore/graph/fence
 */
import type { DshPreparation, DshToolModule } from './load'

/** Tools whose outcome can latch the fence. Closed. */
export const WRITE_TOOLS: readonly string[] = Object.freeze(['memory_write', 'memory_attach'])

/** The only tools whose handler can mint an audited pre-mutation refusal. */
export const AUDITED_REFUSAL_TOOLS: readonly string[] = Object.freeze(['memory_write', 'memory_attach'])

/**
 * The closed set of audited refusal codes (mirrors the wrapper's own copy, so a
 * plugin that grows a new code cannot reach here unvetted).
 */
export const AUDITED_REFUSAL_CODES: readonly string[] = Object.freeze([
  'update_unread',
  'update_stale',
  'update_contradicted_figure',
  'update_target_missing',
  'attach_overwrite_unseen',
  'supersede_unread',
  'supersede_stale',
  'supersede_target_missing',
  'link_target_missing',
])

/** Stable categorical identity of a fence refusal. Never carries raw detail. */
export const WRITE_FENCE_CODE = 'WRITE_FENCE_LATCHED'

/**
 * The model-visible refusal text: the code as a prefix (every consumer that
 * recognizes the refusal still does) plus a fixed remedy. Without the remedy a
 * fence reads as a retryable error, and a retry can never succeed for the rest
 * of the call.
 */
export const WRITE_FENCE_MESSAGE =
  `${WRITE_FENCE_CODE} — the write fence is latched for the rest of this call: an earlier write or attachment had an uncertain or partial effect, so no further memory_write or memory_attach can succeed (reads still work). Do not retry; finish by reporting what was written, what failed, and what remains pending.`

/** Refused before dsh runs: the tool is not in this call's authority tier. */
export const TIER_REFUSAL_CODE = 'TIER_REFUSED'

/** Refused before dsh runs: `memory_attach.from_path` is never reachable here. */
export const FROM_PATH_REFUSAL_CODE = 'FROM_PATH_REFUSED'

/** An executor error carrying the categorical code the caller may key on. */
export class GraphToolError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GraphToolError'
    this.code = code
  }
}

export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.includes(tool)
}

/**
 * Does this SUCCESSFUL write result report a KNOWN partial mutation?
 *
 * Exactly two documented surfaces, as in the wrapper: an `attach_failed` string
 * (the node write landed, its inline attachment did not) and a `links[]` entry
 * with `status: 'failed'` (an edge was not created). Everything else — an
 * absent field, an empty array, an unrelated advisory — is a clean write.
 */
export function knownPartialMutation(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  if (typeof record.attach_failed === 'string' && record.attach_failed.length > 0) return true
  if (!Array.isArray(record.links)) return false
  return record.links.some(
    (link) => link !== null && typeof link === 'object' && (link as Record<string, unknown>).status === 'failed',
  )
}

/** Three distinct results of the trusted-preparation precheck, as in the wrapper. */
export type Precheck =
  | { kind: 'unknown' }
  /** `args` is the COERCED value dsh's own `execute` would prepare — the only
   * form any argument-driven decision may be taken on (a serialized `attach`
   * string is parsed by dsh's `coerce`, and a guard reading the raw input would
   * miss it entirely). */
  | { kind: 'admitted'; args: unknown }
  | { kind: 'rejected'; violations: string[] }
  | { kind: 'uncertain'; error: Error }

/**
 * Run the definition's OWN trusted preparation (coerce + validate) without
 * touching the graph. `unknown` means the definition is not one `defineTool`
 * built (a legacy or hand-made definition): nothing is proven either way, so
 * the ordinary execute path runs.
 */
export function precheckArguments(definition: unknown, args: unknown, toolModule: DshToolModule): Precheck {
  const prepare = toolModule.trustedPreparationFor(definition)
  if (typeof prepare !== 'function') return { kind: 'unknown' }
  let prepared: DshPreparation
  try {
    prepared = prepare(args)
  } catch (error) {
    // Preparation did not complete (a `coerce` threw). Nothing is proven — and
    // it is never retried through execute, which could turn a one-shot throw
    // into a clean result nobody observed.
    return { kind: 'uncertain', error: toError(error) }
  }
  if (prepared === null || typeof prepared !== 'object') {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned no result') }
  }
  const violations = prepared.violations
  if (!Array.isArray(violations)) {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned no violation list') }
  }
  if (violations.length === 0) return { kind: 'admitted', args: prepared.args }
  if (!violations.every((violation) => typeof violation === 'string')) {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned malformed violations') }
  }
  return { kind: 'rejected', violations }
}

/**
 * The audited refusal code this thrown error carries for this exact
 * (definition, exec, error), or undefined when there is no proof. The proof is
 * the tool module's, never the error's text, class or shape.
 */
export function auditedRefusalCode(
  definition: unknown,
  exec: unknown,
  error: unknown,
  toolModule: DshToolModule,
): string | undefined {
  const consumed = toolModule.consumeAuditedRefusal(definition, exec, error)
  return typeof consumed === 'string' && AUDITED_REFUSAL_CODES.includes(consumed) ? consumed : undefined
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : String(value))
}

/**
 * The fence itself: one latch per GraphCall, owned there and never cleared.
 * A throwing check fails CLOSED (treated as latched), as in the wrapper.
 */
export class WriteFence {
  private latched = false

  latch(): void {
    this.latched = true
  }

  isLatched(): boolean {
    return this.latched
  }
}
