// The server's in-memory state: one cached graph snapshot, one cached runs
// index, and the invalidation plumbing around them (REQ-007, GUD-002).
//
// Nothing here writes to disk. The filesystem interactions are reads plus two
// watchers: one recursive watch on graph.root, and a non-recursive watch on the
// run source's directory (new run directories in service mode, a new month's
// usage file in plugin mode). The database WAL is deliberately NOT watched — the
// service owns that file and a 2 s `SELECT max(updated_at)` poll is cheaper and
// less intrusive than reacting to its write traffic.
//
// WHICH history this store reads is not its business: `RunSource`
// (usage/source.ts) owns that, and the two implementations are the service's
// sqlite+observation pair and the plugin's monthly usage JSONL.

import fs from 'node:fs'
import path from 'node:path'

import type { RunSummary, RunSourceKind, SseEvent, SseKind } from '../shared/types.ts'
import { trustedRootProblem, type TrustedRoot } from './fs-safe.ts'
import { GRAPH_ROOT_UNAVAILABLE, buildGraphSnapshot, type GraphSnapshot } from './graph/build.ts'
import { PROVENANCE_DIR } from './graph/constants.ts'
import { isValidNodeId } from './guard.ts'
import type { RunIndex } from './usage/runs.ts'
import { ServiceRunSource } from './usage/service-source.ts'
import type { RunSource } from './usage/source.ts'
import { diffKeys, fingerprintGraph, type GraphFingerprint } from './watch.ts'

export interface StoreOptions {
  graphRoot: string
  /**
   * The service state directory. Required by the default (service) run source;
   * plugin mode passes a `runs` source explicitly and may omit it.
   */
  stateDir?: string
  /**
   * The history to read. Defaults to `ServiceRunSource({ stateDir, trust: stateTrust })`,
   * which is exactly what this class did before the boundary existed.
   */
  runs?: RunSource
  /** Which deployment is served; reported in `Meta`. Mirrors `runs.kind` when given. */
  source?: RunSourceKind
  /**
   * Root identities pinned at startup (config load). When present, every scan
   * re-verifies them, so a root moved aside and replaced by a symlink is refused
   * instead of being adopted as a new trust boundary (SEC-003, pass-3 #1).
   */
  graphTrust?: TrustedRoot | null
  stateTrust?: TrustedRoot | null
  /** Debounce for watch bursts (ms). */
  debounceMs?: number
  /** Full graph fingerprint reconcile interval (ms). */
  reconcileMs?: number
  /** Cheap run-source poll interval (ms). */
  taskPollMs?: number
  /** Heartbeat interval for SSE comment lines (ms). */
  heartbeatMs?: number
  /** Clock, injectable for tests. */
  now?: () => number
}

export type SseSink = (event: SseEvent) => void

export class Store {
  readonly graphRoot: string
  readonly stateDir: string | null
  readonly runSource: RunSource
  readonly source: RunSourceKind
  private readonly graphTrust: TrustedRoot | null
  private readonly stateTrust: TrustedRoot | null
  /** Non-null when the pinned state root no longer resolves to itself (#1). */
  private stateTrustError: string | null = null
  readonly debounceMs: number
  readonly reconcileMs: number
  readonly taskPollMs: number
  readonly heartbeatMs: number

  private snapshot: GraphSnapshot
  private runIndex: RunIndex
  private tasksAvailable = true
  /** Availability as of the last refresh, for change detection. */
  private lastAvailable = true
  private fingerprint: GraphFingerprint
  private lastRunSignature = ''
  private generation = 0
  /** Non-null while the last rebuild failed; surfaced as an API warning. */
  private rebuildError: string | null = null

  private readonly subscribers = new Map<number, SseSink>()
  private nextSubscriberId = 1

  private watcher: fs.FSWatcher | null = null
  private runsWatcher: fs.FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** When the current debounce window opened; the cap is measured from here. */
  private debounceStartedAt = 0
  /** Longest a rebuild may be postponed by a stream of watch events (REQ-007 ~2 s). */
  private readonly maxDebounceWaitMs = 1000
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private taskPollTimer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private pendingKinds = new Set<SseKind>()
  /** Node ids whose `.provenance/<id>.jsonl` changed; flushed as node hints, never as a rescan. */
  private pendingProvenance = new Set<string>()
  private provenanceTimer: ReturnType<typeof setTimeout> | null = null

  private readonly now: () => number

  constructor(options: StoreOptions) {
    this.graphRoot = options.graphRoot
    this.stateDir = options.stateDir ?? null
    this.runSource =
      options.runs ??
      new ServiceRunSource({
        // A default (service) source without a state dir can only come from a
        // programming error; fail loudly at construction, like before.
        stateDir: requireStateDir(options.stateDir),
        trust: options.stateTrust ?? null,
      })
    this.source = options.runs === undefined ? (options.source ?? 'service') : this.runSource.kind
    if (options.runs !== undefined && options.source !== undefined && options.source !== this.runSource.kind) {
      // A caller that passes an explicit source and a contradicting `source`
      // would label the dashboard with the wrong deployment, so the source wins
      // and the discrepancy is reported rather than silently ignored.
      throw new Error(
        `Store: options.source ${options.source} does not match the run source's kind ${this.runSource.kind}`,
      )
    }
    this.graphTrust = options.graphTrust ?? null
    this.stateTrust = options.stateTrust ?? null
    this.debounceMs = options.debounceMs ?? 300
    this.reconcileMs = options.reconcileMs ?? 10_000
    this.taskPollMs = options.taskPollMs ?? 2_000
    this.heartbeatMs = options.heartbeatMs ?? 5_000
    this.now = options.now ?? Date.now

    this.snapshot = buildGraphSnapshot(this.graphRoot, 0, this.graphTrust)
    this.fingerprint = fingerprintGraph(this.graphRoot, undefined, this.graphTrust)
    this.runIndex = { runs: [], orphanRunDirs: [], warnings: [], signature: '' }
    this.refreshRuns()
    this.lastRunSignature = this.runSignatureOf(this.runIndex)
  }

  // ---- reads -------------------------------------------------------------

  get currentGeneration(): number {
    return this.generation
  }

  graph(): GraphSnapshot {
    return this.snapshot
  }

  runs(): RunIndex {
    return this.runIndex
  }

  runsUnavailable(): boolean {
    return !this.tasksAvailable
  }

  /** Warnings from the last failed rebuild, if any (recovery clears it). */
  healthWarnings(): string[] {
    return this.rebuildError === null ? [] : [this.rebuildError]
  }

  private runSignatureOf(index: RunIndex): string {
    return [index.signature, JSON.stringify(index.runs), index.orphanRunDirs.join(',')].join('\n')
  }

  /** Re-read the run source. Returns true when the index it produced changed. */
  private refreshRuns(): boolean {
    // A redirected state root makes every read below meaningless: report usage as
    // unavailable instead of querying a tree that is no longer ours (#1). Plugin
    // mode has no state root, so the check simply does not apply there.
    const trustProblem = this.stateTrust === null ? null : trustedRootProblem(this.stateTrust)
    if (trustProblem !== null) {
      this.stateTrustError = `state directory was replaced or is unavailable (${trustProblem}): ${this.stateDir ?? ''}`
      this.tasksAvailable = false
      this.runIndex = {
        runs: [],
        orphanRunDirs: [],
        warnings: [this.stateTrustError],
        signature: 'unavailable',
      }
      this.lastRunSignature = this.runSignatureOf(this.runIndex)
      return true
    }
    this.stateTrustError = null

    const result = this.runSource.refresh()
    this.tasksAvailable = !result.unavailable
    this.runIndex = {
      runs: result.runs,
      orphanRunDirs: result.orphanRunDirs,
      warnings: result.warnings,
      signature: result.signature,
    }

    const signature = this.runSignatureOf(this.runIndex)
    const availabilityMoved = this.tasksAvailable !== this.lastAvailable
    this.lastAvailable = this.tasksAvailable
    const indexMoved = signature !== this.lastRunSignature
    this.lastRunSignature = signature
    return availabilityMoved || indexMoved
  }

  /**
   * Rebuild what was asked for and emit SSE invalidations.
   *
   * A full graph rescan per invalidation is explicitly allowed (GUD-002) as long
   * as it never happens per request. A rebuild failure keeps the last good
   * snapshot and records a warning instead of escaping (#9).
   */
  refresh(reason: { graph?: boolean; emitRun?: boolean } = {}): void {
    if (this.closed) return
    const wantsGraph = reason.graph !== false
    const hinted = new Set<SseKind>(this.pendingKinds)
    this.pendingKinds.clear()

    // This pass consumes any queued watch hints, so a failure can never leave
    // them stuck and re-firing forever.
    const runsMoved = this.refreshRuns()
    if (wantsGraph) {
      const previous = this.snapshot
      const healthBefore = this.rebuildError
      try {
        const next = buildGraphSnapshot(this.graphRoot, this.generation + 1, this.graphTrust)
        const unavailableWarning = next.warnings.find((warning) => warning.startsWith(GRAPH_ROOT_UNAVAILABLE))
        if (unavailableWarning !== undefined && previous.nodes.length > 0) {
          // Keep the last good snapshot: an unmounted volume, a moved root or a
          // root we cannot list must not blank the UI. The warning says it is stale.
          this.rebuildError = unavailableWarning
        } else {
          this.generation += 1
          this.snapshot = next
          this.fingerprint = fingerprintGraph(this.graphRoot, undefined, this.graphTrust)
          this.rebuildError = unavailableWarning ?? null
          this.emitGraphDiff(previous, next, hinted)
        }
      } catch (error) {
        // Keep the last good snapshot: a transient permission error or a
        // half-removed directory must not empty the UI.
        this.rebuildError = `graph rebuild failed: ${(error as Error).message}`
      }
      // A HEALTH change is a graph change as far as the client is concerned: it
      // must refetch /api/graph to see (or stop seeing) the stale-root warning.
      // Without this, an outage whose only symptom is a retained snapshot emits
      // nothing at all and the warning stays invisible (#4).
      if (this.rebuildError !== healthBefore) this.emit({ kind: 'graph' })
    } else {
      for (const kind of hinted) this.emit({ kind })
    }
    if (runsMoved || reason.emitRun === true) this.emit({ kind: 'run' })
  }

  private emitGraphDiff(previous: GraphSnapshot, next: GraphSnapshot, hinted: Set<SseKind> = new Set()): void {
    const previousIds = new Set(previous.nodes.map((node) => node.id))
    const nextIds = new Set(next.nodes.map((node) => node.id))
    const changed: string[] = []
    for (const node of next.nodes) {
      const old = previous.nodeById.get(node.id)
      if (old === undefined) {
        changed.push(node.id)
        continue
      }
      if (old.description !== node.description || old.degree !== node.degree || old.visitCount !== node.visitCount) {
        changed.push(node.id)
      }
    }
    for (const id of previousIds) if (!nextIds.has(id)) changed.push(id)

    const accessMoved =
      previous.edges.length !== next.edges.length ||
      previous.nodes.some((node, index) => next.nodes[index]?.visitCount !== node.visitCount) ||
      previous.edges.some((edge, index) => next.edges[index]?.accessCount !== edge.accessCount)

    // Kinds: node-level hints first, then one graph-level invalidation. Clients
    // treat every event as "refetch", so the granularity is a courtesy, not a
    // correctness requirement (REQ-007).
    if (changed.length > 0 && changed.length <= 50) {
      for (const id of new Set(changed)) this.emit({ kind: 'node', id })
    }
    if (accessMoved) this.emit({ kind: 'access' })
    let emittedGraph = false
    for (const kind of hinted) {
      if (kind === 'access' && accessMoved) continue
      if (kind === 'run') continue
      if (kind === 'graph') {
        if (!emittedGraph) {
          this.emit({ kind: 'graph' })
          emittedGraph = true
        }
        continue
      }
      this.emit({ kind })
    }
    // Always finish with a graph-level hint: it is the clients' primary signal.
    if (!emittedGraph) this.emit({ kind: 'graph' })
  }

  // ---- invalidation plumbing --------------------------------------------

  start(): void {
    this.startWatch()
    this.startReconcile()
    this.startTaskPoll()
  }

  close(): void {
    this.closed = true
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    if (this.provenanceTimer !== null) clearTimeout(this.provenanceTimer)
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
    if (this.taskPollTimer !== null) clearInterval(this.taskPollTimer)
    this.debounceTimer = null
    this.provenanceTimer = null
    this.reconcileTimer = null
    this.taskPollTimer = null
    for (const watcher of [this.watcher, this.runsWatcher]) {
      try {
        watcher?.close()
      } catch {
        // already closed
      }
    }
    this.watcher = null
    this.runsWatcher = null
    this.subscribers.clear()
  }

  private startWatch(): void {
    try {
      this.watcher = fs.watch(this.graphRoot, { persistent: false, recursive: true }, (eventType, filename) => {
        if (this.closed) return
        this.scheduleRefresh(filename === null ? null : String(filename), eventType)
      })
      this.watcher.on('error', () => {
        // A watcher failure must never take the server down; the reconcile poll
        // becomes the only signal, which is still eventually correct.
        try {
          this.watcher?.close()
        } catch {
          // ignore
        }
        this.watcher = null
      })
    } catch {
      this.watcher = null
    }

    // Non-recursive: the run source's own directory. In service mode a new
    // `run-*` directory announces itself without walking run contents or
    // touching the SQLite WAL (#4); in plugin mode it is the directory the
    // monthly usage files appear in.
    const watchDir = this.runSource.watchPath()
    try {
      if (watchDir === null) throw new Error('no run-source directory to watch')
      this.runsWatcher = fs.watch(watchDir, { persistent: false }, () => {
        if (this.closed) return
        this.scheduleRefresh('__runs__', 'change')
      })
      this.runsWatcher.on('error', () => {
        try {
          this.runsWatcher?.close()
        } catch {
          // ignore
        }
        this.runsWatcher = null
      })
    } catch {
      // A missing runs/ or usage/ dir is normal for a fresh install.
      this.runsWatcher = null
    }
  }

  /**
   * Coalesce watch bursts without letting them starve the rebuild (#11).
   *
   * Two rules keep the ~2 s live-update target reachable under sustained write
   * traffic:
   *   * an event for a path that changes nothing (dotfiles other than the ones
   *     that matter, unrelated cache files) returns WITHOUT touching the timer,
   *     so a stream of such events cannot postpone an already-scheduled rebuild;
   *   * any queued rebuild fires at the latest `maxDebounceWaitMs` after the
   *     window opened, however many events keep arriving in between.
   *
   * A null filename means the event was coalesced or the watched root itself
   * changed — treat it as a full-graph invalidation.
   */
  scheduleRefresh(filename: string | null, eventType: string = 'change'): void {
    if (this.closed) return
    if (filename === '__runs__') {
      // A runs-side change: refresh the run index; the graph need not rescan.
      this.scheduleRebuild()
      return
    }
    if (filename !== null && filename.startsWith(PROVENANCE_DIR + path.sep)) {
      this.scheduleProvenanceHint(filename.slice(PROVENANCE_DIR.length + 1))
      return
    }
    if (!this.scheduleRefreshKinds(filename, eventType)) return
    this.scheduleRebuild()
  }

  /**
   * Record what a watch event implies. Returns false when the event carries no
   * possible snapshot change, so the caller can leave the debounce untouched.
   */
  private scheduleRefreshKinds(filename: string | null, eventType: string): boolean {
    if (filename === null) {
      // Coalesced / root-level event: assume a full graph invalidation.
      this.pendingKinds.add('graph')
      return true
    }
    const [first, second] = filename.split(path.sep)
    if (first === undefined) {
      this.pendingKinds.add('graph')
      return true
    }
    if (first === '.access') {
      // A log append: strength and recent-access only.
      this.pendingKinds.add('access')
      return true
    }
    if (first.startsWith('.')) {
      // .locks/, .advisories*, .DS_Store, .duplicates: never part of a snapshot and
      // never a reason to rescan. Only a staging directory signals a new Node.
      if (first.startsWith('.staging')) {
        this.pendingKinds.add('graph')
        return true
      }
      // Genuinely irrelevant: do NOT touch the debounce timer.
      return false
    }
    if (first === 'MAP.md') {
      this.pendingKinds.add('graph')
      return true
    }
    if (second === 'node.md') {
      this.pendingKinds.add('node')
      return true
    }
    if (first.includes('__edges__') || second === '__edges__') {
      this.pendingKinds.add('graph')
      return true
    }
    if (eventType === 'rename') {
      // A Node directory or attachment appeared/disappeared.
      this.pendingKinds.add('graph')
      return true
    }
    // An in-place edit inside a Node directory: the file's metadata moved, not
    // the Node's own mtime, so the snapshot can change.
    this.pendingKinds.add('graph')
    return true
  }

  /**
   * (Re)arm the coalescing timer, capped so a continuous event stream still
   * rebuilds within ~1 s of the first event.
   */
  private scheduleRebuild(): void {
    if (this.closed) return
    const now = Date.now()
    if (this.debounceTimer === null) this.debounceStartedAt = now
    // Fire `debounceMs` after the LAST event, but never later than
    // `maxDebounceWaitMs` after the FIRST one: the wait is the smaller of the
    // two, and the cap can shrink it to zero under a sustained stream.
    const elapsed = now - this.debounceStartedAt
    const remaining = Math.max(0, Math.min(this.debounceMs, this.maxDebounceWaitMs - elapsed))
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.debounceStartedAt = 0
      this.refresh({ graph: true })
    }, remaining)
    // Do not hold the process open just for a pending refresh in tests.
    ;(this.debounceTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * A `.provenance/<id>.jsonl` append (#319 P2). The writer appends it AFTER
   * publishing node.md, so it can land after the content refresh already went
   * out; the open panel would then keep the old write history. It is not part of
   * the snapshot, so it never rescans: it only re-sends the node hint, debounced,
   * which makes the client refetch `/api/node/:id` (read per request). Anything
   * that is not a known Node's file is dropped here without touching a timer.
   */
  private scheduleProvenanceHint(name: string): void {
    const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : ''
    if (!isValidNodeId(id) || !this.snapshot.nodeById.has(id)) return
    this.pendingProvenance.add(id)
    if (this.provenanceTimer !== null) return
    this.provenanceTimer = setTimeout(() => {
      this.provenanceTimer = null
      const ids = [...this.pendingProvenance]
      this.pendingProvenance.clear()
      for (const pending of ids) this.emit({ kind: 'node', id: pending })
    }, this.debounceMs)
    ;(this.provenanceTimer as unknown as { unref?: () => void }).unref?.()
  }

  /** Full graph fingerprint, every 10 s by default. */
  private startReconcile(): void {
    this.reconcileTimer = setInterval(() => {
      if (this.closed) return
      try {
        this.reconcile()
      } catch {
        // never let a poll failure kill the interval
      }
    }, this.reconcileMs)
    ;(this.reconcileTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Cheap runs-side poll, every 2 s by default.
   *
   * It does two cheap things and one expensive thing NOT at all:
   *   * asks the run source whether anything moved (service mode: `SELECT
   *     max(updated_at), count(*) FROM tasks` plus the runs fingerprint;
   *     plugin mode: the usage-file stats) — metadata only, no parsing;
   *   * refreshes the run index when it did — this is what catches a LATE OR
   *     APPENDED capture/log line, which no task row records (#4);
   *   * it never rebuilds the graph. That stays on the 10 s reconcile.
   *
   * The WAL itself is never watched or polled for frame changes: the service owns
   * that file and reacting to its write traffic would be both expensive and
   * intrusive.
   */
  private startTaskPoll(): void {
    this.taskPollTimer = setInterval(() => {
      if (this.closed) return
      try {
        this.pollRunsSide()
      } catch {
        // a poll failure must not kill the interval
      }
    }, this.taskPollMs)
    ;(this.taskPollTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Ask the run source whether anything moved (metadata only) and refresh the
   * index when it did. Never rescans the graph.
   */
  pollRunsSide(): boolean {
    if (!this.runSource.moved()) return false
    this.refresh({ graph: false })
    return true
  }

  /**
   * Probe the run source WITHOUT rebuilding; true when it moved.
   *
   * In service mode this is the task signature `(max updated_at, row count)` —
   * both derived from the ONE allowlisted SELECT, so no extra query is needed.
   * Row count matters: a task whose `updated_at` happens to equal the current
   * maximum would otherwise be invisible until some later row moved the maximum.
   * Plugin mode has no database: its probe is the usage file stat.
   */
  taskSignatureMoved(): boolean {
    return this.runSource.moved()
  }

  /** Probe + rebuild the runs side. Returns true when it moved. */
  pollTasks(): boolean {
    const moved = this.runSource.moved()
    if (moved) this.refresh({ graph: false })
    return moved
  }

  reconcile(): void {
    if (this.closed) return
    const nextGraph = fingerprintGraph(this.graphRoot, undefined, this.graphTrust)
    const graphChanged = nextGraph.key !== this.fingerprint.key
    const runsChanged = this.runSource.moved()

    if (!graphChanged && !runsChanged) {
      // The run source can still have moved without any graph change.
      this.pollTasks()
      return
    }
    if (graphChanged && this.pendingKinds.size === 0) {
      // Attribute the change so a pure log append reports `access`.
      const nodeChanges = diffKeys(this.fingerprint.nodes, nextGraph.nodes)
      const logChanges = diffKeys(this.fingerprint.logs, nextGraph.logs)
      if (logChanges.length > 0 && nodeChanges.length === 0) this.pendingKinds.add('access')
    }
    this.refresh({ graph: graphChanged })
  }

  // ---- SSE ---------------------------------------------------------------

  subscribe(sink: SseSink): () => void {
    const id = this.nextSubscriberId++
    this.subscribers.set(id, sink)
    return () => {
      this.subscribers.delete(id)
    }
  }

  private emit(event: SseEvent): void {
    for (const sink of this.subscribers.values()) {
      try {
        sink(event)
      } catch {
        // a broken client must not break the fan-out
      }
    }
  }

  /** Test hook: current subscriber count (leak detection). */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** Test hook: force a rebuild without waiting for a timer. */
  rebuildNow(): void {
    this.refresh({ graph: true })
  }

  /** Test hook (#11): is a rebuild currently scheduled? */
  hasPendingRebuild(): boolean {
    return this.debounceTimer !== null
  }

  /** Test hook (#11): how many invalidation kinds the pending rebuild will emit. */
  pendingKindCount(): number {
    return this.pendingKinds.size
  }

  /**
   * Test hook: restart the timers at different intervals. Used by the AC-010
   * concurrency test, which must exercise real `readTasks` refreshes while a
   * writer subprocess is inserting.
   */
  setIntervalsForTests(intervals: { taskPollMs?: number; reconcileMs?: number }): void {
    if (this.taskPollTimer !== null) clearInterval(this.taskPollTimer)
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
    this.taskPollTimer = null
    this.reconcileTimer = null
    if (intervals.taskPollMs !== undefined) {
      this.taskPollTimer = setInterval(() => {
        if (this.closed) return
        try {
          this.pollRunsSide()
        } catch {
          // a poll failure must not kill the interval
        }
      }, intervals.taskPollMs)
      ;(this.taskPollTimer as unknown as { unref?: () => void }).unref?.()
    }
    if (intervals.reconcileMs !== undefined) {
      this.reconcileTimer = setInterval(() => {
        if (this.closed) return
        try {
          this.reconcile()
        } catch {
          // a poll failure must not kill the interval
        }
      }, intervals.reconcileMs)
      ;(this.reconcileTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /** Test hook: close the filesystem watchers so a change must be caught by reconcile. */
  stopWatching(): void {
    for (const watcher of [this.watcher, this.runsWatcher]) {
      try {
        watcher?.close()
      } catch {
        // already closed
      }
    }
    this.watcher = null
    this.runsWatcher = null
  }
}

export function isNodeId(value: string): boolean {
  return isValidNodeId(value)
}

/**
 * The default (service) run source needs a state directory; a caller that
 * passes neither `runs` nor `stateDir` has a bug, and silently serving an empty
 * dashboard would hide it.
 */
function requireStateDir(stateDir: string | undefined): string {
  if (stateDir === undefined) {
    throw new Error('Store: stateDir is required unless an explicit run source is given')
  }
  return stateDir
}

export type { RunSummary }
