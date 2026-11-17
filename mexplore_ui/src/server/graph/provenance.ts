// Write-session provenance reading (#317, design.md "Storage").
//
// The engine appends one JSON object per line to `<graphRoot>/.provenance/<id>.jsonl`
// for every mutation made through the memory tools. This module reads that file
// for the node panel and nothing else: it is never part of the graph snapshot,
// never a watcher trigger, and never written.
//
// Reads go through `SafeRoot` (SEC-003): the id must be a ULID, a symlinked
// `.provenance` directory or leaf is refused, only regular files are opened, and
// the bytes read are capped. A file larger than the cap is read as its newest
// tail plus its first line (the creation record), so the panel can still say who
// created the node and what changed last.
//
// Every line is projected onto the known fields with type and length checks, so
// an unexpected field (a path, a payload) never reaches a response.

import path from 'node:path'

import type {
  NodeProvenance,
  ProvenanceActor,
  ProvenanceEntry,
  ProvenanceHost,
  ProvenanceReason,
} from '../../shared/types.ts'
import type { SafeRoot } from '../fs-safe.ts'
import { isSinglePathSegment, isValidNodeId } from '../guard.ts'
import { PROVENANCE_DIR } from './constants.ts'

/** Newest bytes read from a provenance file. */
export const MAX_PROVENANCE_BYTES = 512 * 1024
/** Bytes read from the start of an oversized file to recover its first line. */
export const PROVENANCE_HEAD_BYTES = 4096
/** Newest lines returned. */
export const MAX_PROVENANCE_LINES = 1000

const ACTORS: ReadonlySet<string> = new Set<ProvenanceActor>(['chat', 'import', 'unknown'])
const HOSTS: ReadonlySet<string> = new Set<ProvenanceHost>(['dsh', 'opencode', 'unknown'])
const REASONS: ReadonlySet<string> = new Set<ProvenanceReason>([
  'no-resolver',
  'root-unverified',
  'walk-failed',
  'import',
  'resolver-error',
])
const OP_RE = /^[a-z][a-z-]{0,31}$/
const MAX_ID_CHARS = 200

export function emptyProvenance(unreadable = false): NodeProvenance {
  return { entries: [], first: null, truncated: false, skipped: 0, unreadable }
}

/** A short printable token (no control characters), or undefined. */
function token(value: unknown, max = MAX_ID_CHARS): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > max) return undefined
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value
}

/** Parse one line into an entry, or null when it is torn, malformed or not a v1-shaped record. */
export function parseProvenanceLine(line: string): ProvenanceEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const ts = token(record.ts, 64)
  const op = token(record.op, 32)
  if (ts === undefined || Number.isNaN(Date.parse(ts)) || op === undefined || !OP_RE.test(op)) return null

  const session = token(record.session) ?? null
  const entry: ProvenanceEntry = {
    ts,
    op,
    actor: typeof record.actor === 'string' && ACTORS.has(record.actor) ? (record.actor as ProvenanceActor) : 'unknown',
    host: typeof record.host === 'string' && HOSTS.has(record.host) ? (record.host as ProvenanceHost) : 'unknown',
    session,
  }
  if (session === null && typeof record.reason === 'string' && REASONS.has(record.reason)) {
    entry.reason = record.reason as ProvenanceReason
  }
  const call = token(record.call)
  if (call !== undefined) entry.call = call
  if (typeof record.peer === 'string' && isValidNodeId(record.peer)) entry.peer = record.peer
  // An attachment name only: anything with a separator could be a path.
  const file = token(record.file, 255)
  if (file !== undefined && isSinglePathSegment(file)) entry.file = file
  const type = token(record.type, 32)
  if (type !== undefined && OP_RE.test(type)) entry.type = type
  return entry
}

/** Parse a block of lines; returns the entries and how many lines were skipped. */
function parseLines(lines: readonly string[]): { entries: ProvenanceEntry[]; skipped: number } {
  const entries: ProvenanceEntry[] = []
  let skipped = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    const entry = parseProvenanceLine(line)
    if (entry === null) skipped += 1
    else entries.push(entry)
  }
  return { entries, skipped }
}

/**
 * The provenance lines for one node. Never throws; a missing file is the normal
 * empty state (nodes written before #317, by `bin/` helpers or older plugins).
 */
export function readProvenance(graphRoot: SafeRoot | null, id: string): NodeProvenance {
  if (!isValidNodeId(id)) return emptyProvenance()
  if (graphRoot === null) return emptyProvenance(true)
  const rel = path.posix.join(PROVENANCE_DIR, `${id}.jsonl`)

  const stat = graphRoot.stat(rel)
  if (!stat.ok) return emptyProvenance(stat.reason !== 'missing')
  const size = stat.size ?? 0
  const offset = Math.max(0, size - MAX_PROVENANCE_BYTES)

  // A window that starts mid-file also reads the byte before it, so the leading
  // segment is either empty (the window starts on a line) or a fragment of a
  // longer line; both are dropped.
  const start = offset > 0 ? offset - 1 : 0
  const tail = graphRoot.readBytes(rel, size - start, start)
  if (!tail.ok || tail.bytes === undefined) return emptyProvenance(tail.reason !== 'missing')

  const lines = tail.bytes.toString('utf8').split('\n')
  if (offset > 0) lines.shift()
  const parsed = parseLines(lines)
  let truncated = offset > 0
  let entries = parsed.entries
  if (entries.length > MAX_PROVENANCE_LINES) {
    entries = entries.slice(-MAX_PROVENANCE_LINES)
    truncated = true
  }

  let first: ProvenanceEntry | null = null
  if (offset > 0) {
    const head = graphRoot.readBytes(rel, PROVENANCE_HEAD_BYTES, 0)
    const text = head.ok && head.bytes !== undefined ? head.bytes.toString('utf8') : ''
    const newline = text.indexOf('\n')
    if (newline > 0) first = parseProvenanceLine(text.slice(0, newline))
  } else if (truncated) {
    first = parsed.entries[0] ?? null
  }

  return { entries, first, truncated, skipped: parsed.skipped, unreadable: false }
}
