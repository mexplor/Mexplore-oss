// API contract shared by the Bun server (src/server) and the React UI (src/web).
// Shared API contracts for graph, usage and run data.
// Changing a shape here is a contract change for both lanes.

export type EdgeType = 'plain' | 'relates-to' | 'supersedes' | 'follows-from'
export type Authority = 'read' | 'manage'
export type UsageStatus = 'complete' | 'partial' | 'unknown'

/**
 * Where the run rows come from — the two deployments of this server:
 *   * `service`  — the memory agent's SQLite task table + run captures (the
 *     original `--config` mode);
 *   * `plugin`   — the OpenCode plugin's monthly usage JSONL (no database).
 * The UI needs this only to word the "usage unavailable" message correctly.
 */
export type RunSourceKind = 'service' | 'plugin'

export interface Meta {
  /** Absent in plugin mode: there is no config file. */
  configPath?: string
  graphRoot: string
  /** Absent in plugin mode: there is no service state directory. */
  stateDir?: string
  nodeCount: number
  runCount: number
  serverTime: string
  tz: string
  /** Defaults to `service` when a server predates this field. */
  source?: RunSourceKind
  /** Human-readable source label, e.g. `opencode plugin`. */
  label?: string
}

export interface GraphNode {
  id: string
  description: string
  type: string | null
  created: string | null
  updated: string | null
  superseded: boolean
  supersededBy: string | null
  openHandoff: boolean
  degree: number
  attachmentCount: number
  /** 0-based position in MAP.md; null when the Node is not listed there. */
  mapRank: number | null
  /** Self-lines (dst == id) across .access/<id>.log + legacy accessed.log. */
  visitCount: number
}

export interface GraphEdge {
  /** For directed edges: source -> target. For symmetric edges: lexicographically smaller id first. */
  source: string
  target: string
  type: EdgeType
  directed: boolean
  halves: 1 | 2
  accessCount: number
  lastAccess: string | null
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  openHandoffs: string[]
  warnings: string[]
  /** Monotonic rebuild counter; changes whenever the server's graph snapshot changes. */
  generation: number
}

export interface Attachment {
  name: string
  size: number
  mtime: string
}

export interface Neighbour {
  id: string
  description: string
  edgeType: EdgeType
  /** out = this node -> neighbour (directed), in = neighbour -> this node (directed), both = symmetric. */
  direction: 'out' | 'in' | 'both'
}

export interface AccessEvent {
  /** Target node of the traversal; equals the node's own id for a direct read (visit). */
  dst: string
  /** Node whose log contains the line. */
  src: string
  at: string
}

export type ProvenanceActor = 'chat' | 'import' | 'unknown'
export type ProvenanceHost = 'dsh' | 'opencode' | 'unknown'
/** Why `session` is null (closed set; present only when it is). */
export type ProvenanceReason = 'no-resolver' | 'root-unverified' | 'walk-failed' | 'import' | 'resolver-error'

/** One line of `.provenance/<id>.jsonl`, projected to known fields (unknown fields are dropped). */
export interface ProvenanceEntry {
  ts: string
  /** create | update | attach | annotate | supersede | superseded-by | merge | merged-into | restore | edge (kept verbatim). */
  op: string
  actor: ProvenanceActor
  host: ProvenanceHost
  /** Root chat session id (`session-<uuid>` on DSH, `ses_…` on OpenCode), or null with a reason. */
  session: string | null
  reason?: ProvenanceReason
  /** Tool call id. */
  call?: string
  /** The other Node of a supersede, merge or edge line. */
  peer?: string
  /** Attachment name (a single path segment). */
  file?: string
  /** Edge type. */
  type?: string
}

/** Who wrote this Node: the write-session provenance lines, read-only. */
export interface NodeProvenance {
  /** File order (append order), oldest first; the newest lines only when `truncated`. */
  entries: ProvenanceEntry[]
  /** The file's first line, when truncation dropped it from `entries` (normally the `create`). */
  first: ProvenanceEntry | null
  truncated: boolean
  /** Torn or unparseable lines that were skipped. */
  skipped: number
  /** A provenance file exists but was refused (symlink, not a regular file, read error). */
  unreadable: boolean
}

export interface NodeDetail extends GraphNode {
  body: string
  frontmatter: Record<string, string>
  attachments: Attachment[]
  /** One entry per edge; opposite directed edges to the same peer appear twice. */
  neighbours: Neighbour[]
  /** Newest first, at most 50: outgoing lines from this node's logs plus incoming lines naming it. */
  recentAccess: AccessEvent[]
  /** Read at request time from `.provenance/<id>.jsonl`; empty when nothing was recorded. */
  provenance: NodeProvenance
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface RunSummary {
  taskId: string
  authority: Authority
  createdAt: string
  latencyMs: number | null
  usage: Partial<Usage> | null
  usageStatus: UsageStatus
}

export interface RunsPage {
  total: number
  offset: number
  limit: number
  runs: RunSummary[]
  /** true when the task database could not be opened; runs is then empty. */
  unavailable?: boolean
}

export interface Stats {
  runs: number
  runsWithLatency: number
  usageRuns: { complete: number; partial: number; unknown: number }
  /** complete + partial runs (partial = lower bound). */
  totals: Partial<Usage>
  /** complete runs only, over totalTokens. */
  tokensPerRun: { mean: number | null; p50: number | null; p95: number | null }
  /** non-null latency only. Percentiles are nearest-rank: sorted[ceil(p*n)-1], null when n = 0. */
  latencyMs: { p50: number | null; p95: number | null; max: number | null }
}

export interface SeriesPoint {
  totalTokens: number
  p50LatencyMs: number | null
  runs: number
}

export interface UsageSummary {
  from: string
  to: string
  tz: string
  read: Stats
  manage: Stats
  combined: Stats
  /** One entry per local day in [from, to), oldest first; bucket = YYYY-MM-DD in tz. */
  series: { bucket: string; read: SeriesPoint; manage: SeriesPoint; combined: SeriesPoint }[]
  warnings: string[]
  /** true when the task database could not be opened. Stats are then zero and series empty. */
  unavailable?: boolean
}

/** GET /api/search?q=… — case-insensitive substring match over description and body (REQ-006). */
export interface SearchResponse {
  q: string
  ids: string[]
}

export type SseKind = 'graph' | 'node' | 'access' | 'run'
export interface SseEvent {
  kind: SseKind
  id?: string
}
