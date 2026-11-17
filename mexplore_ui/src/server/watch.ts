// Cheap change detection for the reconcile poll (REQ-007).
//
// The watch on graph.root is the fast path; these fingerprints are the safety
// net for anything FSEvents coalesced away. They read metadata only — never file
// contents — and every traversal is routed through `SafeRoot`, so a symlinked
// container (`<id>/`, `.access/`, a node directory, a run directory) is never
// followed. `lstat` alone would not be enough: walking through a symlinked parent
// is exactly how a fingerprint would describe files outside the graph.

import path from 'node:path'

import { ACCESS_DIR, EDGES_DIR, EDGE_TYPES_FILE } from './graph/constants.ts'
import { SafeRoot, type TrustedRoot } from './fs-safe.ts'
import { isValidNodeId } from './guard.ts'

export interface GraphFingerprint {
  /** Opaque digest of everything below. */
  key: string
  /** Per-node digest: dir, node.md, __edges__, .edge-types, attachments. */
  nodes: Map<string, string>
  /** Per-log digest for `.access/<id>.log` and legacy `<id>/accessed.log`. */
  logs: Map<string, string>
  /** MAP.md digest (mapRank order changes when it is rewritten). */
  map: string
  /** Set when the root could not be listed; the snapshot is then stale, not empty. */
  rootFailure: string | null
}

export interface RunsFingerprint {
  key: string
  /** Per-run-dir digest: the directory entry plus its observation.jsonl stat. */
  dirs: Map<string, string>
  /** Set when `runs/` could not be listed. */
  runsUnavailable: boolean
}

/** `mtime:size` for a guarded file, or '-' when it is absent/refused. */
function statKey(root: SafeRoot, rel: string): string {
  const stat = root.stat(rel)
  return stat.ok ? `${stat.mtimeMs}:${stat.size}` : '-'
}

function dirStamp(root: SafeRoot, rel: string): string {
  const stat = root.statDir(rel)
  return stat.ok ? `${stat.mtimeMs}` : 'missing'
}

/**
 * Digest of the files directly under one node directory that the attachment
 * listing would show. Their mtime/size can change without moving the directory's
 * own mtime (in-place edit), so each is stat'ed individually — through the root,
 * so a symlinked "attachment" is refused here as well.
 */
function attachmentsKey(graphRoot: SafeRoot, id: string): string {
  const parts: string[] = []
  for (const entry of graphRoot.listDir(id)) {
    const name = entry.name
    // The same exclusions as the attachment listing; dotfiles never count.
    if (name.startsWith('.') || name === 'node.md' || name === 'accessed.log') continue
    if (entry.isDirectory()) continue
    parts.push(`${name}=${statKey(graphRoot, path.posix.join(id, name))}`)
  }
  parts.sort()
  return parts.join(',')
}

export function fingerprintGraph(
  graphRootPath: string,
  accessDirName = ACCESS_DIR,
  trust?: TrustedRoot | null,
): GraphFingerprint {
  const nodes = new Map<string, string>()
  const logs = new Map<string, string>()
  const opened = SafeRoot.openChecked(graphRootPath, trust)
  const root = opened.root
  if (root === null) {
    return {
      key: 'unavailable',
      nodes,
      logs,
      map: '-',
      rootFailure:
        opened.reason === 'root-replaced'
          ? `graph root was replaced: ${graphRootPath}`
          : `graph root is unavailable: ${graphRootPath}`,
    }
  }

  const listing = root.listDirResult('.')
  if (!listing.ok) {
    // A root we cannot list is NOT an empty graph: report the failure so the
    // store keeps its last good snapshot instead of replacing it (#9).
    return {
      key: `root-failure:${listing.reason ?? 'unknown'}`,
      nodes,
      logs,
      map: '-',
      rootFailure: `graph root could not be listed (${listing.reason ?? 'unknown'}): ${graphRootPath}`,
    }
  }

  const rootEntries = listing.entries.map((entry) => entry.name).sort()
  for (const entry of listing.entries) {
    const name = entry.name
    if (name.startsWith('.') || !isValidNodeId(name)) continue
    // A symlinked node dir is skipped by the builder; keep it out of the
    // fingerprint's per-node map too so it cannot mask a real change.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    nodes.set(
      name,
      [
        dirStamp(root, name),
        statKey(root, path.posix.join(name, 'node.md')),
        dirStamp(root, path.posix.join(name, EDGES_DIR)),
        statKey(root, path.posix.join(name, EDGES_DIR, EDGE_TYPES_FILE)),
        attachmentsKey(root, name),
      ].join('|'),
    )
    const legacyKey = statKey(root, path.posix.join(name, 'accessed.log'))
    if (legacyKey !== '-') logs.set(`${name}/accessed.log`, legacyKey)
  }

  for (const entry of root.listDir(accessDirName)) {
    const name = entry.name
    if (!name.endsWith('.log')) continue
    logs.set(name, statKey(root, path.posix.join(accessDirName, name)))
  }

  const map = statKey(root, 'MAP.md')
  const key = [
    rootEntries.filter((name) => !name.startsWith('.')).join(','),
    ...[...nodes].map(([id, value]) => `${id}=${value}`),
    ...[...logs].map(([id, value]) => `${id}=${value}`),
    `map=${map}`,
  ].join('\n')

  return { key, nodes, logs, map, rootFailure: null }
}

/**
 * Digest of `stateDir/runs`: the per-task run-dir listings and every
 * observation.jsonl stat. A late capture, an appended usage line or a new run
 * directory changes this even when `tasks.updated_at` does not move.
 */
export function fingerprintRuns(stateDir: string, trust?: TrustedRoot | null): RunsFingerprint {
  const dirs = new Map<string, string>()
  const root = SafeRoot.open(stateDir, trust)
  if (root === null) return { key: 'unavailable', dirs, runsUnavailable: true }

  const stateListing = root.listDirResult('.')
  if (!stateListing.ok) return { key: 'root-failure', dirs, runsUnavailable: true }

  const runsListing = root.listDirResult('runs')
  if (!runsListing.ok) {
    // A missing runs/ dir is normal for a fresh state dir; anything else is a
    // real failure and must not read as "no runs changed".
    return {
      key: `runs-${runsListing.reason ?? 'unknown'}`,
      dirs,
      runsUnavailable: runsListing.reason !== 'missing',
    }
  }

  for (const taskDir of runsListing.entries) {
    const name = taskDir.name
    if (name.startsWith('.')) continue
    if (taskDir.isSymbolicLink() || !taskDir.isDirectory()) continue
    const taskRel = path.posix.join('runs', name)
    const runNames = root.listDir(taskRel).map((entry) => entry.name)
    runNames.sort()
    dirs.set(`listing:${name}`, runNames.join(','))
    for (const runName of runNames) {
      if (!runName.startsWith('run-')) continue
      const runRel = path.posix.join(taskRel, runName)
      dirs.set(`${name}/${runName}`, dirStamp(root, runRel))
      dirs.set(`${name}/${runName}/observation.jsonl`, statKey(root, path.posix.join(runRel, 'observation.jsonl')))
    }
  }
  const key = [...dirs].map(([id, value]) => `${id}=${value}`).join('\n')
  return { key, dirs, runsUnavailable: false }
}

export function diffKeys(previous: Map<string, string>, next: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [id, value] of next) if (previous.get(id) !== value) changed.push(id)
  for (const id of previous.keys()) if (!next.has(id)) changed.push(id)
  return changed
}

/** Stable digest for a run index, used to decide whether a `run` hint is warranted. */
export function runSignature(index: { runs: unknown[]; orphanRunDirs: string[]; signature?: string }): string {
  return [index.signature ?? '', JSON.stringify(index.runs), index.orphanRunDirs.join(',')].join('\n')
}
