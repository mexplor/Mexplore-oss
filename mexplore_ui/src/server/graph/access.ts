// Access-log reading (Definitions §2, dsh_plugin/lib/graph.js:488-501).
//
// One event per line: `<dst-ULID> <ISO-8601 UTC>`. A node's log is
// `<graphRoot>/.access/<id>.log`; a legacy in-node `<id>/accessed.log` with the
// same format is still read and merged. A self-line (dst == id) records a
// direct read of that node: it counts as a visit, never as edge strength.
//
// Both files are read through `SafeRoot`, so a log that is a symlink out of the
// graph (or an alias of a forbidden file) is never opened.

import path from 'node:path'

import type { SafeRoot } from '../fs-safe.ts'
import { ACCESS_DIR } from './constants.ts'

export interface AccessLine {
  /** Node named by the line (equals the owner for a self-line / visit). */
  dst: string
  /** The node whose log carried the line. */
  src: string
  /** ISO-8601 timestamp exactly as written. */
  at: string
  /** Parsed epoch ms (NaN when unparseable). */
  ms: number
}

export interface AccessRead {
  lines: AccessLine[]
  malformed: number
  /** Log files skipped because they were symlinks or escaped the root. */
  skipped: string[]
}

const ULID_LINE = /^[0-9A-HJKMNP-TV-Z]{26}$/
/** Access logs are append-only line files; anything this big is not one. */
const MAX_ACCESS_LOG_BYTES = 32 * 1024 * 1024

/** Parse one log file's text into lines for `owner`. Malformed lines are dropped. */
export function parseAccessLog(text: string, owner: string, sink: AccessLine[]): number {
  let malformed = 0
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const fields = trimmed.split(/\s+/) // awk field semantics, as graph-maintain
    const dst = fields[0]
    const at = fields[1]
    if (dst === undefined || at === undefined || !ULID_LINE.test(dst) || Number.isNaN(Date.parse(at))) {
      malformed += 1
      continue
    }
    sink.push({ dst, src: owner, at, ms: Date.parse(at) })
  }
  return malformed
}

/**
 * Every access line for `owner`, merged across `.access/<id>.log` and the
 * legacy `<id>/accessed.log`. Never throws.
 */
export function readAccessLines(graphRoot: SafeRoot, owner: string): AccessRead {
  const lines: AccessLine[] = []
  let malformed = 0
  const skipped: string[] = []
  for (const rel of [
    path.posix.join(ACCESS_DIR, `${owner}.log`),
    path.posix.join(owner, 'accessed.log'),
  ]) {
    const read = graphRoot.read(rel, MAX_ACCESS_LOG_BYTES)
    if (!read.ok) {
      // `missing` is the normal case; anything else means a link we refuse.
      if (read.reason !== undefined && read.reason !== 'missing') skipped.push(`${rel}:${read.reason}`)
      continue
    }
    malformed += parseAccessLog(read.text ?? '', owner, lines)
  }
  return { lines, malformed, skipped }
}
