// The run-source boundary (Lane A, item 2).
//
// The Store used to read exactly one kind of history: the memory agent's
// `memory-agent.sqlite` task table joined with each run's `observation.jsonl`.
// The OpenCode plugin deployment has neither — its history is a set of monthly
// usage JSONL files (`usage-YYYY-MM.jsonl`, one line per `mexplore` call). Both
// shapes reduce to the same `RunSummary` rows, so the Store talks to one of
// these sources instead of knowing either format.
//
// The contract of a source:
//   * `refresh()` re-reads and returns the WHOLE index (runs, warnings,
//     availability, a signature);
//   * `moved()` is a CHEAP probe (metadata only, no parsing) used by the 2 s poll
//     and the 10 s reconcile before anything expensive happens;
//   * `watchPath()` is a directory a non-recursive `fs.watch` can sit on.
//
// Nothing here writes to disk.

import type { RunSummary } from '../../shared/types.ts'

export type RunSourceKind = 'service' | 'plugin'

export interface RunSourceResult {
  runs: RunSummary[]
  /** Run directories with no owning row — service sources only; warnings only. */
  orphanRunDirs: string[]
  warnings: string[]
  /** True when the source could not be read at all (the UI shows a banner). */
  unavailable: boolean
  /** Digest of what was read, so the Store can tell whether a `run` hint is due. */
  signature: string
}

export interface RunSource {
  readonly kind: RunSourceKind
  /** Re-read everything. Never throws: an unreadable source reports `unavailable`. */
  refresh(): RunSourceResult
  /** Metadata-only probe: true when anything changed since the last refresh. */
  moved(): boolean
  /** Directory to watch non-recursively for new files, or null when none helps. */
  watchPath(): string | null
}
