// Usage aggregation for one run's `observation.jsonl` (SEC-006, REQ-010).
//
// Content minimisation by construction: parsing keeps ONLY `type`, `seq`,
// `requestId` and `usage` from each line, and the result of a parse is a REDUCED
// aggregate (`aggregateObservation`) rather than an event list — so a long-lived
// process holds one small object per run instead of every event (#6).
//
// Coverage rule (#4, #5): the denominator is ALL first `request_end`s, including
// those that carry no usage at all. A component is present in the run's usage
// only when EVERY first request end reported it. `totalTokens` decides the
// status: incompletely covered → `partial` (so the run leaves exact token stats).

import type { Usage, UsageStatus } from '../../shared/types.ts'

export const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const

export type UsageKey = (typeof USAGE_KEYS)[number]

/** Per-component report count, used to judge coverage. */
export type UsageCoverage = Partial<Record<UsageKey, number>>

export interface ObservationEvent {
  type: string
  seq: number | null
  requestId: string | null
  usage: Partial<Usage> | null
}

export interface ObservationParse {
  /** Absent file / unreadable / no events at all. */
  present: boolean
  /** The file exceeded `MAX_OBSERVATION_BYTES` and was not parsed. */
  tooLarge: boolean
  events: ObservationEvent[]
  /** True when the last line was incomplete (torn write) and was skipped. */
  tornLastLine: boolean
  /** Unparseable complete lines. */
  malformedLines: number
}

/** Refuse to parse a capture above this; an oversized file is `unknown` (#6). */
export const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024

export const EMPTY_PARSE: ObservationParse = {
  present: false,
  tooLarge: false,
  events: [],
  tornLastLine: false,
  malformedLines: 0,
}

function pickUsage(raw: unknown): Partial<Usage> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const usage: Partial<Usage> = {}
  let found = false
  for (const key of USAGE_KEYS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      usage[key] = value
      found = true
    }
  }
  return found ? usage : null
}

/** One raw line -> the minimised event, or undefined when the line carries nothing we keep. */
export function minimiseEvent(raw: unknown): ObservationEvent | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const type = typeof obj['type'] === 'string' ? obj['type'] : ''
  if (type === '') return undefined
  const seq = typeof obj['seq'] === 'number' && Number.isInteger(obj['seq']) ? obj['seq'] : null
  const requestId = typeof obj['requestId'] === 'string' ? obj['requestId'] : null
  return { type, seq, requestId, usage: pickUsage(obj['usage']) }
}

/**
 * Parse observation JSONL text. A torn final line (no trailing newline and not
 * valid JSON) is skipped rather than counted as malformed.
 */
export function parseObservationText(text: string): ObservationParse {
  const events: ObservationEvent[] = []
  let malformedLines = 0
  let tornLastLine = false
  // Split on \n; a trailing \n yields a final empty element we must ignore.
  const lines = text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim()
    const isLast = i === lines.length - 1
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (isLast && !endsWithNewline) tornLastLine = true
      else malformedLines += 1
      continue
    }
    const event = minimiseEvent(parsed)
    if (event !== undefined) events.push(event)
    else malformedLines += 1
  }
  return { present: true, tooLarge: false, events, tornLastLine, malformedLines }
}

// Parse observation TEXT only. There is deliberately no `readObservationFile(path)`
// export: every read goes through `SafeRoot` in runs.ts, so a symlinked capture
// can never be opened and this module stays pure.

/**
 * Everything the run index needs from one capture, with no event list retained.
 *
 * `usageStatus` here is the CAPTURE-side verdict; `runs.ts` applies the task's
 * terminal state on top (#6), so a cached aggregate stays valid while the task is
 * still running and becomes correct the moment it terminates.
 */
export interface UsageAggregate {
  /** Present only for fully covered components. */
  usage: Partial<Usage> | null
  /** Capture-side status: `unknown` (nothing readable) or `partial`/`complete`. */
  usageStatus: UsageStatus
  /** Degradations found in the capture (not the task state). */
  reasons: string[]
  /** Number of first request ends seen, and how many reported each component. */
  requestEnds: number
  coverage: UsageCoverage
  /** True when every component in `usage` was reported by every first request end. */
  complete: boolean
}

/** A capture that could not be read at all. */
export function unknownAggregate(reasons: string[] = []): UsageAggregate {
  return { usage: null, usageStatus: 'unknown', reasons, requestEnds: 0, coverage: {}, complete: false }
}

/**
 * Reduce a parse to the run's usage aggregate.
 *
 * Sums over the FIRST `request_end` per requestId (duplicates ignored, REQ-010).
 * The coverage denominator counts supply-carrying AND usage-free ends: a request
 * that ended without usage leaves an unknown contribution, not a zero.
 */
export function aggregateObservation(parse: ObservationParse): UsageAggregate {
  const reasons: string[] = []
  if (!parse.present) return unknownAggregate(reasons)
  if (parse.tooLarge) return unknownAggregate([`observation_too_large:${MAX_OBSERVATION_BYTES}`])

  let sawCapped = false
  let sawSinkError = false

  const endedIds = new Set<string>()
  const startedIds = new Set<string>()
  const totals: Record<UsageKey, number> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  /** First request ends — the coverage denominator, with or without usage. */
  let requestEnds = 0
  const coverage: UsageCoverage = {}

  // seq gap detection: the wrapper emits 1-based contiguous seq.
  let expectedSeq: number | null = null
  let seqGap = false

  for (const event of parse.events) {
    if (event.seq !== null) {
      if (expectedSeq === null) {
        if (event.seq > 1) seqGap = true
      } else if (event.seq !== expectedSeq) {
        seqGap = true
      }
      expectedSeq = event.seq + 1
    }

    if (event.type === 'capped') {
      sawCapped = true
      continue
    }
    if (event.type === 'sink_error') {
      sawSinkError = true
      continue
    }
    if (event.type === 'request_start') {
      if (event.requestId !== null) startedIds.add(event.requestId)
      continue
    }
    if (event.type === 'request_end') {
      const requestId = event.requestId
      if (requestId === null) continue
      // Duplicates are ignored: only the FIRST end of a request counts, both for
      // the sum and for the coverage denominator (REQ-010).
      if (endedIds.has(requestId)) continue
      endedIds.add(requestId)
      requestEnds += 1
      const usage = event.usage
      // A request that ended without usage counts in the denominator but adds no
      // number: its contribution is unknown, never zero.
      if (usage === null) continue
      for (const key of USAGE_KEYS) {
        const value = usage[key]
        if (value === undefined) continue
        totals[key] += value
        coverage[key] = (coverage[key] ?? 0) + 1
      }
    }
  }

  // Nothing usable at all: no first request end, or none carrying usage.
  let anyUsage = false
  for (const key of USAGE_KEYS) if ((coverage[key] ?? 0) > 0) anyUsage = true
  if (requestEnds === 0 || !anyUsage) return unknownAggregate(reasons)

  if (sawCapped) reasons.push('capped')
  if (sawSinkError) reasons.push('sink_error')
  if (seqGap) reasons.push('seq_gap')
  if (parse.tornLastLine) reasons.push('torn_line')
  if (parse.malformedLines > 0) reasons.push('malformed_lines')
  let openRequest = false
  for (const id of startedIds) {
    if (!endedIds.has(id)) {
      openRequest = true
      break
    }
  }
  if (openRequest) reasons.push('request_start_without_end')

  // A component is present only when EVERY first request end reported it.
  const usage: Partial<Usage> = {}
  const omitted: UsageKey[] = []
  for (const key of USAGE_KEYS) {
    const reports = coverage[key] ?? 0
    if (reports === 0) continue
    if (reports === requestEnds) usage[key] = totals[key]
    else omitted.push(key)
  }

  // The total is what the exact token statistics are computed over, so an
  // incompletely covered total degrades the run. A merely missing secondary
  // component (typically cacheReadTokens on a run that never hit the cache) only
  // drops that component.
  const totalIncomplete = omitted.includes('totalTokens')
  if (totalIncomplete) {
    const others = omitted.filter((key) => key !== 'totalTokens')
    reasons.push(
      others.length === 0
        ? 'incomplete_components:totalTokens'
        : `incomplete_components:totalTokens,${others.join(',')}`,
    )
  }

  const complete =
    !sawCapped && !sawSinkError && !seqGap && !parse.tornLastLine && parse.malformedLines === 0 && !openRequest && !totalIncomplete
  return {
    usage,
    usageStatus: complete ? 'complete' : 'partial',
    reasons,
    requestEnds,
    coverage,
    complete,
  }
}

/**
 * Apply the task's terminal state to a cached capture aggregate (#6). A capture
 * that is otherwise complete is `partial` while the task is still running, and
 * becomes `complete` the moment the task terminates — without re-parsing.
 */
export function withTaskState(aggregate: UsageAggregate, taskTerminal: boolean): UsageAggregate {
  if (aggregate.usageStatus === 'unknown') return aggregate
  if (taskTerminal) {
    // The capture side decides; a running task is never `complete`.
    return { ...aggregate, usageStatus: aggregate.complete ? 'complete' : 'partial' }
  }
  return {
    ...aggregate,
    usageStatus: 'partial',
    complete: false,
    reasons: aggregate.reasons.includes('task_not_terminal')
      ? aggregate.reasons
      : [...aggregate.reasons, 'task_not_terminal'],
  }
}

/**
 * Add one run's usage into a population total, tracking per-component coverage
 * (#5). A component survives into the population total only when EVERY
 * contributing run reported it; otherwise the key is omitted rather than summed
 * as if the missing contributions were zero.
 */
export function accumulateUsage(
  totals: Partial<Usage>,
  coverageCount: Map<UsageKey, number>,
  run: { usage: Partial<Usage> | null; usageStatus: UsageStatus },
): void {
  if (run.usageStatus === 'unknown') return
  for (const key of USAGE_KEYS) {
    const value = run.usage?.[key]
    if (value === undefined) continue
    totals[key] = (totals[key] ?? 0) + value
    coverageCount.set(key, (coverageCount.get(key) ?? 0) + 1)
  }
}

/** Drop population components not reported by every contributing run. */
export function finalizeUsageTotals(
  totals: Partial<Usage>,
  coverageCount: Map<UsageKey, number>,
  contributingRuns: number,
): Partial<Usage> {
  const complete: Partial<Usage> = {}
  for (const key of USAGE_KEYS) {
    if ((coverageCount.get(key) ?? 0) === contributingRuns && contributingRuns > 0) complete[key] = totals[key]
  }
  return complete
}
