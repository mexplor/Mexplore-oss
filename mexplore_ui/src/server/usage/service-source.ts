// The service run source: exactly the behaviour the Store had before the
// `RunSource` boundary existed.
//
// Rows come from `<stateDir>/memory-agent.sqlite` (`tasks`), usage from the
// newest `runs/<taskId>/run-*/observation.jsonl`, both read through `SafeRoot`
// and validated by `guard.ts` — see `tasks.ts` and `runs.ts` for the rules. This
// file is the adapter: it re-reads, reports a signature, and answers "did
// anything move?" from the same cheap probes the Store used.

import { trustedRootProblem, type TrustedRoot } from '../fs-safe.ts'
import { fingerprintRuns } from '../watch.ts'
import { ObservationCache, buildRunIndex, maxUpdatedAt } from './runs.ts'
import type { RunSource, RunSourceKind, RunSourceResult } from './source.ts'
import { readTasks, type TaskRow } from './tasks.ts'

export interface ServiceRunSourceOptions {
  stateDir: string
  /** Root identity pinned at startup; a replaced stateDir is refused (#1). */
  trust: TrustedRoot | null
}

/** `max(updated_at)|rowCount` — the allowlisted SELECT's whole information. */
function taskSignatureOf(rows: readonly TaskRow[], available: boolean): string {
  return available ? `${maxUpdatedAt(rows) ?? ''}|${rows.length}` : 'unavailable'
}

export class ServiceRunSource implements RunSource {
  readonly kind: RunSourceKind = 'service'
  readonly stateDir: string
  private readonly trust: TrustedRoot | null
  private readonly cache = new ObservationCache()
  /** Baselines recorded by the last `refresh()`. */
  private taskSignature = ''
  private runsFingerprintKey = ''
  private lastAvailable = false
  private lastSignature = ''

  constructor(options: ServiceRunSourceOptions) {
    this.stateDir = options.stateDir
    this.trust = options.trust
  }

  /** New run directories announce themselves here without walking run contents. */
  watchPath(): string | null {
    return `${this.stateDir}/runs`
  }

  /**
   * Test hook: the observation parse counters (#6). Exposed so a suite can prove
   * the store still satisfies the service-side caching contract (a repeated
   * refresh must not re-parse an unchanged capture).
   */
  get observationCounters(): Readonly<{ hits: number; misses: number; parses: number; failures: number }> {
    return this.cache.counters
  }

  /**
   * Re-read tasks + rebuild the runs index. A redirected state root makes every
   * read meaningless: report usage as unavailable instead of querying a tree that
   * is no longer ours (#1).
   */
  refresh(): RunSourceResult {
    const trustProblem = this.trust === null ? null : trustedRootProblem(this.trust)
    if (trustProblem !== null) {
      this.lastSignature = 'unavailable'
      this.lastAvailable = false
      this.taskSignature = 'unavailable'
      this.runsFingerprintKey = 'unavailable'
      return {
        runs: [],
        orphanRunDirs: [],
        warnings: [`state directory was replaced or is unavailable (${trustProblem}): ${this.stateDir}`],
        unavailable: true,
        signature: this.lastSignature,
      }
    }

    const tasksRead = readTasks(this.stateDir)
    this.lastAvailable = tasksRead.available
    this.taskSignature = taskSignatureOf(tasksRead.rows, tasksRead.available)
    this.runsFingerprintKey = fingerprintRuns(this.stateDir, this.trust).key

    const warnings = tasksRead.error === null ? [] : [`task database unavailable: ${tasksRead.error}`]
    if (tasksRead.rejectedTaskIds > 0) {
      warnings.push(`${tasksRead.rejectedTaskIds} task row(s) skipped: task_id is not a safe UUID`)
    }
    const index = buildRunIndex({
      stateDir: this.stateDir,
      tasks: tasksRead.rows,
      cache: this.cache,
      warnings,
      trust: this.trust,
    })

    this.lastSignature = [index.signature, JSON.stringify(index.runs), index.orphanRunDirs.join(',')].join('\n')
    return {
      runs: index.runs,
      orphanRunDirs: index.orphanRunDirs,
      warnings: index.warnings,
      unavailable: !tasksRead.available,
      signature: this.lastSignature,
    }
  }

  /**
   * Cheap probe: did the task signature (one indexed SELECT) or the runs
   * fingerprint (directory listings + observation stats) move since the last
   * `refresh()`? Reads metadata only, never parses a capture, and keeps no
   * baseline of its own — the caller's `refresh()` is what advances it.
   */
  moved(): boolean {
    const runsChanged = fingerprintRuns(this.stateDir, this.trust).key !== this.runsFingerprintKey
    if (runsChanged) return true
    const tasksRead = readTasks(this.stateDir)
    if (tasksRead.available !== this.lastAvailable) return true
    return taskSignatureOf(tasksRead.rows, tasksRead.available) !== this.taskSignature
  }

  get signature(): string {
    return this.lastSignature
  }
}
