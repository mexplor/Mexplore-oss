// Runs index: `<stateDir>/runs/<taskId>/run-<taskId>-<uuid>/observation.jsonl`.
//
// Rows come from `tasks`; the run directory is optional (a task cancelled while
// queued has none, so its usageStatus is `unknown`). Only observation.jsonl is
// ever opened — never run-config.json, receipts.jsonl, sufficiency.json,
// completion.json or runtime-diagnostics.json (SEC-006).
//
// `observation.jsonl` is read through `SafeRoot` rooted at stateDir, so a run
// file that is a symlink (out of stateDir, or at a forbidden sibling) is refused
// rather than opened. Task ids are validated UUIDs before they become path
// components (SEC-003).
//
// The cache holds the REDUCED aggregate per capture, never the event list (#6):
// one small object per run, so a 10,000-run index does not retain tens of
// millions of event objects. The task's terminal state is applied at index time.

import path from 'node:path'

import type { RunSummary, Usage, UsageStatus } from '../../shared/types.ts'
import { SafeRoot, type SafeStat, type TrustedRoot } from '../fs-safe.ts'
import { isValidTaskId } from '../guard.ts'
import {
  MAX_OBSERVATION_BYTES,
  aggregateObservation,
  parseObservationText,
  unknownAggregate,
  withTaskState,
  type UsageAggregate,
} from './observation.ts'
import type { TaskRow } from './tasks.ts'

export const RUNS_DIR = 'runs'
export const OBSERVATION_FILE = 'observation.jsonl'

export interface RunIndex {
  /** One row per task; ordering is applied by the API layer. */
  runs: RunSummary[]
  /** Orphan run directories (no matching task) — warnings only, never rows. */
  orphanRunDirs: string[]
  warnings: string[]
  /** Digest of every run-dir listing and observation stat; changes when runs change. */
  signature: string
}

interface RunDirChoice {
  /** `<taskId>/<runDir>`, relative to stateDir. */
  rel: string
  mtimeMs: number
}

/** Cached REDUCED aggregate keyed by (path, mtimeMs, size) — never the events. */
interface CacheEntry {
  mtimeMs: number
  size: number
  aggregate: UsageAggregate
}

/** Counters a test hook can read to prove the cache avoids re-parsing. */
export interface CacheStats {
  hits: number
  misses: number
  parses: number
  /** Reads refused after the metadata probe (never cached — #5). */
  failures: number
}

export class ObservationCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly stats: CacheStats = { hits: 0, misses: 0, parses: 0, failures: 0 }

  /**
   * Resolve one capture's aggregate. `stat` comes from a guarded probe and
   * `read` performs the guarded read itself (so the size cap applies to the OPEN,
   * not to an earlier stat — #6).
   *
   * Only a SUCCESSFUL parse is cached (#5). A failed read is reported with its
   * reason and deliberately not cached: the failure leaves (mtime, size) unchanged,
   * so caching it would pin "unknown" until the bytes happened to move. The next
   * refresh retries instead.
   */
  get(rel: string, stat: SafeStat, read: () => { ok: boolean; reason?: string; text?: string }): UsageAggregate {
    if (!stat.ok) {
      // The metadata probe itself failed. A MISSING capture is the normal case
      // (a task cancelled while queued has no run directory): silently unknown.
      // Any other failure is reported so the UI can say WHY, and is never cached
      // so the next refresh retries (#5).
      this.entries.delete(rel)
      if (stat.reason === 'missing') return unknownAggregate()
      this.stats.failures += 1
      return unknownAggregate([`observation_unreadable:${stat.reason ?? 'io-error'}`])
    }
    const cached = this.entries.get(rel)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.stats.hits += 1
      return cached.aggregate
    }
    this.stats.misses += 1

    const result = read()
    if (!result.ok) {
      // Transient (or permanent) read failure: never cached, always reported.
      this.entries.delete(rel)
      this.stats.failures += 1
      // A capture above the byte cap is reported distinctly from an I/O failure.
      const reason = result.reason === 'too-large'
        ? `observation_too_large:${MAX_OBSERVATION_BYTES}`
        : `observation_unreadable:${result.reason ?? 'io-error'}`
      return unknownAggregate([reason])
    }
    const text = result.text ?? ''
    this.stats.parses += 1
    const aggregate = aggregateObservation(parseObservationText(text))
    this.entries.set(rel, { mtimeMs: stat.mtimeMs ?? 0, size: stat.size ?? 0, aggregate })
    // Bound the cache against a long-lived process over many runs.
    if (this.entries.size > 20000) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    return aggregate
  }

  /** Drop entries for files that no longer exist (called on each rebuild). */
  prune(live: Set<string>): void {
    for (const key of [...this.entries.keys()]) if (!live.has(key)) this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }

  /** Test hook: parse counters since construction. */
  get counters(): Readonly<CacheStats> {
    return { ...this.stats }
  }
}

/** `run-*` directories under `<runs>/<taskId>/`, newest mtime first. */
function listRunDirs(stateRoot: SafeRoot, taskId: string, warnings: string[]): RunDirChoice[] {
  const dirs: RunDirChoice[] = []
  const parentRel = path.posix.join(RUNS_DIR, taskId)
  const listing = stateRoot.listDirResult(parentRel)
  if (!listing.ok) {
    if (listing.reason !== 'missing') warnings.push(`run directory listing failed (${listing.reason}): ${parentRel}`)
    return dirs
  }
  for (const entry of listing.entries) {
    if (!entry.name.startsWith('run-')) continue
    if (!entry.isDirectory()) continue
    const rel = path.posix.join(parentRel, entry.name)
    const stat = stateRoot.statDir(rel)
    if (!stat.ok) {
      warnings.push(`run directory unusable (${stat.reason ?? 'unknown'}): ${rel}`)
      continue
    }
    dirs.push({ rel, mtimeMs: stat.mtimeMs ?? 0 })
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1))
  return dirs
}

/** Every `run-*` directory as `<taskId>/<runDir>` (for orphan warnings and the signature). */
function listAllRunDirs(stateRoot: SafeRoot, warnings: string[]): string[] {
  const found: string[] = []
  const listing = stateRoot.listDirResult(RUNS_DIR)
  if (!listing.ok) {
    if (listing.reason !== 'missing') warnings.push(`runs directory listing failed (${listing.reason}): ${RUNS_DIR}`)
    return found
  }
  for (const taskDir of listing.entries) {
    if (!taskDir.isDirectory()) continue
    for (const run of stateRoot.listDir(path.posix.join(RUNS_DIR, taskDir.name))) {
      if (run.isDirectory() && run.name.startsWith('run-')) found.push(`${taskDir.name}/${run.name}`)
    }
  }
  return found.sort()
}

export interface BuildRunIndexOptions {
  /** Canonical stateDir. */
  stateDir: string
  tasks: TaskRow[]
  cache: ObservationCache
  /** Warnings already detected elsewhere, carried through. */
  warnings?: string[]
  /** Root identity pinned at startup; a replaced stateDir is refused (#1). */
  trust?: TrustedRoot | null
}

export function buildRunIndex(options: BuildRunIndexOptions): RunIndex {
  const { stateDir, tasks, cache } = options
  const warnings: string[] = [...(options.warnings ?? [])]
  const runs: RunSummary[] = []
  const live = new Set<string>()
  const signatureParts: string[] = []
  const stateRoot = SafeRoot.open(stateDir, options.trust ?? null)

  const rejected = tasks.filter((task) => !isValidTaskId(task.taskId))
  if (rejected.length > 0) warnings.push(`${rejected.length} task row(s) with an invalid task_id skipped`)
  const safeTasks = tasks.filter((task) => isValidTaskId(task.taskId))

  if (stateRoot === null) {
    warnings.push(`state directory is unavailable: ${stateDir}`)
    return { runs: [], orphanRunDirs: [], warnings, signature: 'unavailable' }
  }

  for (const task of safeTasks) {
    const dirs = listRunDirs(stateRoot, task.taskId, warnings)
    let usage: Partial<Usage> | null = null
    let usageStatus: UsageStatus = 'unknown'

    const chosen = dirs[0]
    if (chosen === undefined) {
      // A task with no run directory (e.g. cancelled while queued) stays a row
      // with unknown usage — runs are never dropped (REQ-010).
      usageStatus = 'unknown'
    } else {
      if (dirs.length > 1) {
        const names = dirs.map((entry) => entry.rel.slice(entry.rel.lastIndexOf('/') + 1)).join(', ')
        warnings.push(`multiple run directories for task ${task.taskId}; using newest (${names})`)
      }
      const rel = path.posix.join(chosen.rel, OBSERVATION_FILE)
      live.add(rel)
      const stat = stateRoot.stat(rel)
      if (!stat.ok && stat.reason !== 'missing') {
        warnings.push(`observation.jsonl refused (${stat.reason}): ${rel}`)
      }
      const cached = cache.get(rel, stat, () => {
        // The CAP is enforced by the guarded read itself, so a file that grows
        // between the probe and the open is still refused (#6).
        const read = stateRoot.read(rel, MAX_OBSERVATION_BYTES)
        return read.ok
          ? { ok: true, text: read.text ?? '' }
          : { ok: false, reason: read.reason ?? 'io-error' }
      })
      // Terminal state is applied HERE, from the cached capture aggregate (#6).
      const aggregate = withTaskState(cached, task.terminal)
      usage = aggregate.usage
      usageStatus = aggregate.usageStatus
      if (aggregate.reasons.length > 0) {
        warnings.push(`task ${task.taskId}: ${usageStatus} usage (${aggregate.reasons.join(', ')})`)
      }
      signatureParts.push(`${rel}:${stat.ok ? `${stat.mtimeMs}:${stat.size}` : (stat.reason ?? 'missing')}`)
    }

    runs.push({
      taskId: task.taskId,
      authority: task.authority,
      createdAt: task.createdAt,
      latencyMs: task.terminal ? task.latencyMs : null,
      usage,
      usageStatus,
    })
  }

  const known = new Set(safeTasks.map((task) => task.taskId))
  const allRunDirs = listAllRunDirs(stateRoot, warnings)
  for (const rel of allRunDirs) signatureParts.push(`dir:${rel}`)
  const orphanRunDirs = allRunDirs.filter((key) => !known.has(key.split('/')[0] ?? ''))
  for (const orphan of orphanRunDirs) warnings.push(`orphan run directory (no task): ${orphan}`)

  cache.prune(live)
  return { runs, orphanRunDirs, warnings, signature: signatureParts.join('\n') }
}

/** Highest `updated_at` seen, used as the reconcile-poll signature for tasks. */
export function maxUpdatedAt(tasks: readonly TaskRow[]): string | null {
  let max: string | null = null
  for (const task of tasks) {
    const value = task.updatedAt
    if (value === null) continue
    if (max === null || value > max) max = value
  }
  return max
}
