// Time-bucketing and statistics (REQ-008, REQ-012/AC aliases).
//
// Percentiles are nearest-rank: sorted[ceil(p * n) - 1], null when n = 0.
// Day buckets are server-local IANA days, applied half-open [from, to) to
// `tasks.created_at`.

import type { Authority, RunSummary, SeriesPoint, Stats, UsageSummary } from '../../shared/types.ts'
import { accumulateUsage, finalizeUsageTotals, type UsageKey } from './observation.ts'

export const DEFAULT_RANGE_DAYS = 7
export const DAY_MS = 24 * 60 * 60 * 1000

/** Nearest-rank percentile over an ascending-sorted copy. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  const n = sorted.length
  if (n === 0) return null
  const index = Math.ceil(p * n) - 1
  if (index < 0) return sorted[0] ?? null
  return sorted[Math.min(index, n - 1)] ?? null
}

export function percentileOf(values: readonly number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  return nearestRank(sorted, p)
}

export function emptyStats(): Stats {
  return {
    runs: 0,
    runsWithLatency: 0,
    usageRuns: { complete: 0, partial: 0, unknown: 0 },
    totals: {},
    tokensPerRun: { mean: null, p50: null, p95: null },
    latencyMs: { p50: null, p95: null, max: null },
  }
}

/**
 * Accumulate one population's Stats.
 *
 * Population coverage (#5): `totals` reports a component only when EVERY
 * contributing run (complete + partial; unknown runs contribute nothing) carried
 * that component. Two complete runs `{totalTokens, inputTokens}` and
 * `{totalTokens}` therefore give `{totalTokens}` — `inputTokens` is omitted
 * rather than presented as an exact sum that silently treated the missing
 * contribution as zero.
 */
export function computeStats(runs: readonly RunSummary[]): Stats {
  const stats = emptyStats()
  stats.runs = runs.length
  const latencies: number[] = []
  const completeTokens: number[] = []
  const rawTotals: Partial<Record<UsageKey, number>> = {}
  const coverage = new Map<UsageKey, number>()
  let contributing = 0

  for (const run of runs) {
    if (run.latencyMs !== null) latencies.push(run.latencyMs)
    if (run.usageStatus === 'complete') {
      stats.usageRuns.complete += 1
      const total = run.usage?.totalTokens
      if (typeof total === 'number') completeTokens.push(total)
    } else if (run.usageStatus === 'partial') {
      stats.usageRuns.partial += 1
    } else {
      stats.usageRuns.unknown += 1
    }
    if (run.usageStatus !== 'unknown') {
      contributing += 1
      accumulateUsage(rawTotals, coverage, run)
    }
  }
  stats.totals = finalizeUsageTotals(rawTotals as Record<UsageKey, number>, coverage, contributing)

  stats.runsWithLatency = latencies.length
  latencies.sort((a, b) => a - b)
  stats.latencyMs = {
    p50: nearestRank(latencies, 0.5),
    p95: nearestRank(latencies, 0.95),
    max: latencies.length === 0 ? null : (latencies[latencies.length - 1] as number),
  }

  if (completeTokens.length > 0) {
    const sum = completeTokens.reduce((a, b) => a + b, 0)
    stats.tokensPerRun = {
      mean: sum / completeTokens.length,
      p50: percentileOf(completeTokens, 0.5),
      p95: percentileOf(completeTokens, 0.95),
    }
  }
  return stats
}

/** `YYYY-MM-DD` for a UTC instant in an IANA zone. */
export function localDayKey(ms: number, tz: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA formats as YYYY-MM-DD; build explicitly to avoid ICU quirks.
  const parts = formatter.formatToParts(new Date(ms))
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

/** A DayKey plus the UTC instant its local midnight starts at. */
function dayStartMs(dayKey: string, tz: string): number {
  // Find the UTC instant whose local representation is that day's 00:00.
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  // Correct for the zone offset at that instant, iterating once for DST safety.
  let guess = naive
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMs(guess, tz)
    const corrected = naive - offset
    if (corrected === guess) break
    guess = corrected
  }
  return guess
}

function zoneOffsetMs(utcMs: number, tz: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(utcMs))
  const get = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - utcMs
}

/**
 * Hard ceiling on daily buckets. A range this long is refused by the endpoint
 * rather than aggregated-but-partially-charted (#14): the totals and the series
 * must always describe the SAME window.
 */
export const MAX_DAY_BUCKETS = 4000

/** Thrown when a requested range would exceed `MAX_DAY_BUCKETS`. */
export class RangeTooLargeError extends Error {
  readonly buckets: number
  constructor(buckets: number) {
    super(`range spans ${buckets} days; the maximum is ${MAX_DAY_BUCKETS} — narrow from/to`)
    this.name = 'RangeTooLargeError'
    this.buckets = buckets
  }
}

/** Number of local days the range covers, computed without materialising them. */
export function countDayBuckets(from: number, to: number, tz: string): number {
  if (!(to > from)) return 0
  // Whole days between the two local midnights, plus one for the partial first day.
  const first = dayStartMs(localDayKey(from, tz), tz)
  const last = dayStartMs(localDayKey(to, tz), tz)
  const days = Math.round((last - first) / DAY_MS)
  // `to` at exactly a local midnight does not open a new bucket.
  return last === to ? Math.max(days, 1) : days + 1
}

/**
 * Every local day key overlapping [from, to), oldest first — empty days
 * included. The day containing `from` is the first key; days are advanced on
 * the local calendar so DST transitions never duplicate or skip a bucket.
 *
 * Throws `RangeTooLargeError` past `MAX_DAY_BUCKETS`, so callers can never
 * aggregate a window they cannot chart.
 */
export function dayKeys(from: number, to: number, tz: string): string[] {
  if (!(to > from)) return []
  const count = countDayBuckets(from, to, tz)
  if (count > MAX_DAY_BUCKETS) throw new RangeTooLargeError(count)
  const keys: string[] = []
  let key = localDayKey(from, tz)
  // `count` IS the number of buckets in the window, computed on the local
  // calendar, so the loop needs no wall-clock guard.
  for (let i = 0; i < count; i++) {
    keys.push(key)
    key = addDays(key, 1)
  }
  return keys
}

function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const next = new Date(Date.UTC(year, month - 1, day + days))
  const y = next.getUTCFullYear()
  const m = `${next.getUTCMonth() + 1}`.padStart(2, '0')
  const d = `${next.getUTCDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface RangeQuery {
  from: number
  to: number
}

export function defaultRange(now = Date.now()): RangeQuery {
  return { from: now - DEFAULT_RANGE_DAYS * DAY_MS, to: now }
}

/** Parse ISO instants; null when absent or unparseable. */
export function parseInstant(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function inRange(run: RunSummary, from: number, to: number): boolean {
  const created = Date.parse(run.createdAt)
  if (Number.isNaN(created)) return false
  return created >= from && created < to
}

export interface BuildUsageOptions {
  runs: readonly RunSummary[]
  from: number
  to: number
  tz: string
  warnings?: string[]
  unavailable?: boolean
  now?: number
}

/** Aggregate read / manage / combined plus the per-day series (REQ-008). */
export function buildUsageSummary(options: BuildUsageOptions): UsageSummary {
  const { runs, from, to, tz } = options
  const inWindow = runs.filter((run) => inRange(run, from, to))

  const read = inWindow.filter((run) => run.authority === 'read')
  const manage = inWindow.filter((run) => run.authority === 'manage')
  const combined = inWindow

  const keys = dayKeys(from, to, tz)
  const buckets = new Map<string, { read: RunSummary[]; manage: RunSummary[]; combined: RunSummary[] }>()
  for (const key of keys) buckets.set(key, { read: [], manage: [], combined: [] })
  for (const run of inWindow) {
    const created = Date.parse(run.createdAt)
    if (Number.isNaN(created)) continue
    const bucket = buckets.get(localDayKey(created, tz))
    if (bucket === undefined) continue
    bucket.combined.push(run)
    if (run.authority === 'read') bucket.read.push(run)
    else bucket.manage.push(run)
  }

  const point = (population: readonly RunSummary[]): SeriesPoint => {
    const latencies: number[] = []
    let totalTokens = 0
    for (const run of population) {
      if (run.latencyMs !== null) latencies.push(run.latencyMs)
      // The chart is a trend over the window, so a partial bucket contributes
      // what it actually reported. The EXACT per-component figures live in
      // Stats.totals, which omits an incompletely covered component instead.
      if (run.usageStatus !== 'unknown') totalTokens += run.usage?.totalTokens ?? 0
    }
    return { totalTokens, p50LatencyMs: percentileOf(latencies, 0.5), runs: population.length }
  }

  const summary: UsageSummary = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    tz,
    read: computeStats(read),
    manage: computeStats(manage),
    combined: computeStats(combined),
    series: keys.map((key) => {
      const bucket = buckets.get(key) as { read: RunSummary[]; manage: RunSummary[]; combined: RunSummary[] }
      return {
        bucket: key,
        read: point(bucket.read),
        manage: point(bucket.manage),
        combined: point(bucket.combined),
      }
    }),
    warnings: options.warnings ?? [],
  }
  if (options.unavailable === true) {
    summary.unavailable = true
    summary.read = emptyStats()
    summary.manage = emptyStats()
    summary.combined = emptyStats()
    summary.series = []
  }
  return summary
}

export type { Authority }
