// The plugin run source: the OpenCode plugin's at-rest usage log.
//
// One JSON line per `mexplore` call, appended by the plugin to
// `<usageDir>/usage-YYYY-MM.jsonl` (month of `ts` in UTC). The record shape is
// represented by the shared usage types; this module reads the plugin records.
//
// Reading strategy (Lane A, item 2):
//   * **closed months** (any file whose month is not the current UTC month) are
//     parsed once and cached against `(ino, size, mtimeMs)` — they cannot grow,
//     so a matching stat means the cache is still the truth;
//   * **the current month** is read INCREMENTALLY: the parser keeps the byte
//     offset just past the last newline it consumed and reads only the bytes
//     appended since, so a growing log costs O(new bytes) per poll;
//   * a **torn trailing line** (bytes after the last `\n`) is left unread — the
//     offset stops before it, so the next poll picks the completed line up. It is
//     never parsed, never cached as a record;
//   * records are **deduped by `callId`** (the id also passed to
//     `runtime.createCall`): a rewritten line replaces the earlier one rather
//     than double-counting a call;
//   * only records whose `graphRoot` is the graph THIS server serves are kept —
//     a user with several graphs must not see another graph's spend here.
//
// Token mapping is 1:1: input is non-cached input, output excludes reasoning,
// and cache read/write plus reasoning remain separate counters. The total is
// derived only when all five components are present. Folding cache into input
// or reasoning into output again would double-count.
//
// Missing data stays missing: a token field that is not a finite number is
// omitted from `usage` (never coerced to 0), so the population-level coverage
// rule in `stats.ts` can drop it rather than understate the sum.

import fs from 'node:fs'

import type { Authority, RunSummary, Usage, UsageStatus } from '../../shared/types.ts'
import { SafeRoot, type TrustedRoot } from '../fs-safe.ts'
import type { RunSource, RunSourceKind, RunSourceResult } from './source.ts'

/** `usage-YYYY-MM.jsonl` — the only file name shape this source reads. */
export const USAGE_FILE_RE = /^usage-\d{4}-\d{2}\.jsonl$/

/**
 * Hard read cap per file. One line is < 2 KB by contract, so this is tens of
 * thousands of calls; a file past it is reported (its tail is ignored) rather
 * than being silently half-read.
 */
export const MAX_USAGE_FILE_BYTES = 64 * 1024 * 1024

const TOKEN_KEYS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const
type TokenKey = (typeof TOKEN_KEYS)[number]

/** One parsed record, kept in its smallest useful form. */
interface FileEntry {
  callId: string
  run: RunSummary
}

interface FileState {
  /** (dev, ino) of the file the offset belongs to; a new inode restarts the read. */
  identity: string
  /** Size at the last successful pass, and its mtime — an in-place rewrite resets the read. */
  size: number
  mtimeMs: number
  /** Bytes consumed — always lands just past a `\n`. */
  offset: number
  entries: FileEntry[]
  /** Lines that were complete but not usable (malformed, foreign, wrong types). */
  skipped: number
}

export interface JsonlRunSourceOptions {
  /** Directory holding the monthly files (created by the caller). */
  usageDir: string
  /** Canonical graph root this server serves; records for other graphs are ignored. */
  graphRoot: string
  /** Pinned usage-dir identity, when the caller pinned one. */
  trust?: TrustedRoot | null
  /** Clock, injectable for the month-rollover test. */
  now?: () => number
}

/** `YYYY-MM` of an instant in UTC. */
export function monthKeyOf(ms: number): string {
  const at = new Date(ms)
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

function isAuthority(value: unknown): value is Authority {
  return value === 'read' || value === 'manage'
}

function isUsageStatus(value: unknown): value is UsageStatus {
  return value === 'complete' || value === 'partial' || value === 'unknown'
}

/**
 * `tokens` -> the UI's `Usage`. Every component is taken as-is (see the header
 * note on the token mapping); `totalTokens` exists only when all five components
 * do, because a sum over a partial set would present a shortfall as a number.
 */
export function usageOf(tokens: unknown): Partial<Usage> | null {
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  const source = tokens as Record<string, unknown>
  const usage: Partial<Usage> = {}
  const field: Record<TokenKey, keyof Usage> = {
    input: 'inputTokens',
    output: 'outputTokens',
    reasoning: 'reasoningTokens',
    cacheRead: 'cacheReadTokens',
    cacheWrite: 'cacheWriteTokens',
  }
  let complete = true
  let any = false
  for (const key of TOKEN_KEYS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      usage[field[key]] = value
      any = true
    } else {
      complete = false
    }
  }
  if (!any) return null
  if (complete) {
    usage.totalTokens =
      usage.inputTokens! + usage.outputTokens! + usage.reasoningTokens! + usage.cacheReadTokens! + usage.cacheWriteTokens!
  }
  return usage
}

/**
 * One parsed line -> a `RunSummary`, or null when the line is not a record this
 * server may show. `graphRoot` filtering happens in the caller so it can count
 * foreign records separately from unusable ones.
 */
export function summaryOf(raw: unknown): { run: RunSummary; graphRoot: string | null } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const callId = record['callId']
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 200) return null
  const ts = record['ts']
  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null
  if (!isAuthority(record['authority'])) return null

  const usage = usageOf(record['tokens'])
  let usageStatus: UsageStatus = isUsageStatus(record['usageStatus']) ? record['usageStatus'] : usage === null ? 'unknown' : 'partial'
  // A record that claims completeness but carries no token object contradicts
  // itself: there is nothing to be complete about, so it is `unknown` (the run
  // still appears in the table and in the run count, never in the token totals).
  if (usage === null) usageStatus = 'unknown'
  // A record claiming completeness without a complete total cannot supply the
  // run's exact token count, so it is reported as the lower bound it is.
  else if (usageStatus === 'complete' && usage.totalTokens === undefined) usageStatus = 'partial'

  const latency = record['latencyMs']
  const latencyMs = typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? latency : null

  return {
    run: {
      taskId: callId,
      authority: record['authority'],
      createdAt: new Date(ts).toISOString(),
      latencyMs,
      usage,
      usageStatus,
    },
    graphRoot: typeof record['graphRoot'] === 'string' ? record['graphRoot'] : null,
  }
}

/** Trim a trailing separator so `/a/graph/` and `/a/graph` are the same graph. */
function sameGraph(a: string, b: string): boolean {
  const strip = (value: string) => (value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value)
  return strip(a) === strip(b)
}

export class JsonlRunSource implements RunSource {
  readonly kind: RunSourceKind = 'plugin'
  readonly usageDir: string
  readonly graphRoot: string
  private readonly trust: TrustedRoot | null
  private readonly now: () => number
  /** Per-file incremental state, keyed by file name. */
  private readonly files = new Map<string, FileState>()
  private lastSignature = ''
  /** Metadata digest of the directory from the last `refresh()`. */
  private lastStatKey = ''

  constructor(options: JsonlRunSourceOptions) {
    this.usageDir = options.usageDir
    this.graphRoot = options.graphRoot
    this.trust = options.trust ?? null
    this.now = options.now ?? Date.now
  }

  /** Test hook: the byte offset currently consumed for one file name. */
  offsetOf(name: string): number | null {
    return this.files.get(name)?.offset ?? null
  }

  watchPath(): string | null {
    // The monthly files are created in this one directory; a new month or a new
    // file therefore arrives as a non-recursive watch event.
    return this.usageDir
  }

  refresh(): RunSourceResult {
    const opened = this.open()
    if (opened.root === null) {
      const warnings = opened.problem === null ? [] : [`usage directory is unusable (${opened.problem}): ${this.usageDir}`]
      this.lastSignature = opened.problem === null ? '' : 'unavailable'
      this.lastStatKey = opened.problem === null ? '' : 'unavailable'
      return { runs: [], orphanRunDirs: [], warnings, unavailable: opened.problem !== null, signature: this.lastSignature }
    }
    const root = opened.root

    const listing = root.listDirResult('.')
    if (!listing.ok) {
      const message = `usage directory could not be listed (${listing.reason ?? 'unknown'}): ${this.usageDir}`
      this.lastSignature = `listing-failed:${listing.reason ?? 'unknown'}`
      this.lastStatKey = this.lastSignature
      return { runs: [], orphanRunDirs: [], warnings: [message], unavailable: true, signature: this.lastSignature }
    }

    const currentMonth = monthKeyOf(this.now())
    const warnings: string[] = []
    const statParts: string[] = [currentMonth]
    // A DIRECTORY named `usage-YYYY-MM.jsonl` is not a monthly file: the listing's
    // own type decides, so such an entry is skipped without a warning instead of
    // being reported as an unusable log.
    const names = listing.entries
      .filter((entry) => USAGE_FILE_RE.test(entry.name) && !entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const live = new Set<string>(names)

    for (const name of names) {
      const stat = root.stat(name)
      if (!stat.ok) {
        // A symlinked or unreadable log is refused, never followed.
        warnings.push(`usage file refused (${stat.reason ?? 'unknown'}): ${name}`)
        statParts.push(`${name}:${stat.reason ?? 'unknown'}`)
        this.files.delete(name)
        continue
      }
      const size = stat.size ?? 0
      const mtimeMs = stat.mtimeMs ?? 0
      const identity = `${stat.dev ?? 0}:${stat.ino ?? 0}`
      statParts.push(`${name}:${identity}:${size}:${mtimeMs}`)

      const month = name.slice('usage-'.length, 'usage-'.length + 7)
      // A closed month cannot grow: if its identity did not move, the parse from
      // the last pass is the final answer. The current month is the only one read
      // incrementally, and only IT can be appended to while we watch.
      const isOpenMonth = month === monthKeyOf(this.now())
      const state = this.files.get(name)
      if (state !== undefined && state.identity === identity && state.offset === size && state.size === size && state.mtimeMs === mtimeMs) {
        // Untouched since the last pass: the parse still stands. (A closed month
        // that has not moved gets this answer for good.)
        continue
      }

      const parsed = this.readFile(root, name, {
        size,
        mtimeMs,
        identity,
        // Restart when this is a first read, a closed month's change, a new
        // inode, a shrunk file, or an in-place rewrite (the bytes before the old
        // offset no longer hold).
        fromStart:
          state === undefined ||
          !isOpenMonth ||
          state.identity !== identity ||
          state.offset > size ||
          size < state.size ||
          (size === state.size && state.mtimeMs !== mtimeMs),
        state,
      })
      if (parsed.warning !== null) warnings.push(parsed.warning)
      if (parsed.skippedThisPass > 0) warnings.push(`${parsed.skippedThisPass} usage line(s) skipped in ${name}`)
      this.files.set(name, parsed.state)
    }

    for (const name of [...this.files.keys()]) if (!live.has(name)) this.files.delete(name)

    // Dedupe by callId, last write wins, then order deterministically so the
    // signature is stable between identical refreshes.
    const byCall = new Map<string, RunSummary>()
    for (const name of names) {
      const state = this.files.get(name)
      if (state === undefined) continue
      for (const entry of state.entries) byCall.set(entry.callId, entry.run)
    }
    const runs = [...byCall.values()].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.taskId.localeCompare(right.taskId),
    )

    this.lastStatKey = statParts.join('|')
    this.lastSignature = `${this.lastStatKey}\n${JSON.stringify(runs)}`
    return { runs, orphanRunDirs: [], warnings, unavailable: false, signature: this.lastSignature }
  }

  /**
   * Metadata-only probe: every matching file's (dev, ino, size, mtime) plus the
   * directory listing. No bytes are parsed, so a poll on an idle log costs one
   * `readdir` and one `lstat` per file.
   */
  moved(): boolean {
    return this.statKey() !== this.lastStatKey
  }

  private statKey(): string {
    const opened = this.open()
    if (opened.root === null) return opened.problem === null ? '' : 'unavailable'
    const root = opened.root
    const listing = root.listDirResult('.')
    if (!listing.ok) return `listing-failed:${listing.reason ?? 'unknown'}`
    // The month boundary matters even when no file moves: crossing midnight UTC
    // on the 1st turns the newest file from "open" (appended, incremental) into
    // "closed" (parsed once), and the view must re-read it as such.
    const parts: string[] = [monthKeyOf(this.now())]
    for (const name of listing.entries
      .filter((entry) => USAGE_FILE_RE.test(entry.name) && !entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const stat = root.stat(name)
      parts.push(
        stat.ok
          ? `${name}:${stat.dev ?? 0}:${stat.ino ?? 0}:${stat.size ?? 0}:${stat.mtimeMs ?? 0}`
          : `${name}:${stat.reason ?? 'unknown'}`,
      )
    }
    return parts.join('|')
  }

  /**
   * Open the usage directory, distinguishing "not created yet" (empty, not
   * unavailable) from "refused" (a symlink or a non-directory).
   */
  private open(): { root: SafeRoot | null; problem: string | null } {
    let info: fs.Stats
    try {
      info = fs.lstatSync(this.usageDir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A fresh install has no usage directory yet: zero runs, no banner.
      if (code === 'ENOENT') return { root: null, problem: null }
      return { root: null, problem: code ?? 'io-error' }
    }
    if (info.isSymbolicLink()) return { root: null, problem: 'symlink' }
    if (!info.isDirectory()) return { root: null, problem: 'not-dir' }
    const root = SafeRoot.open(this.usageDir, this.trust)
    if (root === null) return { root: null, problem: 'unreadable' }
    return { root, problem: null }
  }

  /**
   * Read one file, either from the start (closed month, or a replaced/truncated
   * file) or from the byte just past the last complete line read.
   */
  private readFile(
    root: SafeRoot,
    name: string,
    options: { size: number; mtimeMs: number; identity: string; fromStart: boolean; state: FileState | undefined },
  ): { state: FileState; skippedThisPass: number; warning: string | null } {
    const previous = options.state
    const fresh: FileState = {
      identity: options.identity,
      size: options.size,
      mtimeMs: options.mtimeMs,
      offset: 0,
      entries: [],
      skipped: 0,
    }
    const base: FileState = options.fromStart || previous === undefined ? fresh : previous
    const entries = [...base.entries]

    if (options.size > MAX_USAGE_FILE_BYTES) {
      // Report rather than half-read: the remainder stays unread (never counted
      // as zero usage) and the file is named so the user can rotate it.
      return {
        state: { ...base, size: options.size, mtimeMs: options.mtimeMs, entries },
        skippedThisPass: 0,
        warning: `usage file exceeds ${MAX_USAGE_FILE_BYTES} bytes; the rest of ${name} is not read`,
      }
    }
    const remaining = Math.max(0, options.size - base.offset)
    if (remaining === 0) {
      return { state: { ...base, size: options.size, mtimeMs: options.mtimeMs, entries }, skippedThisPass: 0, warning: null }
    }

    const read = root.readBytes(name, remaining, base.offset)
    if (!read.ok || read.bytes === undefined) {
      // Unreadable now: keep what we had and retry on the next refresh, exactly
      // like `ObservationCache` (a failed read is never cached).
      return { state: { ...base, size: options.size, mtimeMs: options.mtimeMs, entries }, skippedThisPass: 0, warning: null }
    }
    const bytes = read.bytes
    // Only whole lines are consumed. Everything after the last `\n` is a torn
    // trailing write: the offset stops before it, so it is retried once complete.
    const lastNewline = bytes.lastIndexOf(0x0a)
    if (lastNewline < 0) {
      return { state: { ...base, size: options.size, mtimeMs: options.mtimeMs, entries }, skippedThisPass: 0, warning: null }
    }

    const complete = bytes.subarray(0, lastNewline + 1).toString('utf8')
    let skippedThisPass = 0
    for (const line of complete.split('\n')) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skippedThisPass += 1
        continue
      }
      const mapped = summaryOf(parsed)
      if (mapped === null) {
        skippedThisPass += 1
        continue
      }
      if (mapped.graphRoot === null || !sameGraph(mapped.graphRoot, this.graphRoot)) continue
      entries.push({ callId: mapped.run.taskId, run: mapped.run })
    }

    return {
      state: {
        identity: options.identity,
        size: options.size,
        mtimeMs: options.mtimeMs,
        offset: base.offset + lastNewline + 1,
        entries,
        skipped: base.skipped + skippedThisPass,
      },
      skippedThisPass,
      warning: null,
    }
  }

  get signature(): string {
    return this.lastSignature
  }
}
