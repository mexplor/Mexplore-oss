// Full-graph snapshot builder.
//
// This is the one place that reads the graph tree. It is called on startup and
// on a (debounced) invalidation — never per request (GUD-002). Every read is
// defensive: a half-written file, a dangling symlink or a malformed sidecar
// becomes a warning, never an exception (GUD-001).
//
// All reads go through `SafeRoot` (SEC-003): a `node.md`, `.edge-types` or
// `accessed.log` that is a symlink — out of the graph, or aliasing another
// (possibly forbidden) file — is refused, not followed.

import fs from 'node:fs'
import path from 'node:path'

import type { AccessEvent, Attachment, EdgeType, GraphEdge, GraphNode, Neighbour } from '../../shared/types.ts'
import { SafeRoot, type TrustedRoot } from '../fs-safe.ts'
import { isValidAttachmentName, isValidNodeId } from '../guard.ts'
import { readAccessLines, type AccessLine } from './access.ts'
import { EDGES_DIR, isDirectedType } from './constants.ts'
import { isOpenHandoff, parseNodeFile, type ParsedNodeFile } from './frontmatter.ts'
import { readEdgeTypes, resolveEdgeType, type Sidecar } from './sidecar.ts'

/** Warning prefix the store treats as "keep the last good snapshot". */
export const GRAPH_ROOT_UNAVAILABLE = 'graph root is unavailable'

export interface SnapshotNode extends GraphNode {
  body: string
  frontmatter: Record<string, string>
  attachments: Attachment[]
  neighbours: Neighbour[]
  recentAccess: AccessEvent[]
  /** Lowercased description + body, precomputed for /api/search. */
  searchText: string
}

export interface GraphSnapshot {
  generation: number
  builtAt: number
  nodes: SnapshotNode[]
  /** The GraphNode subset handed to /api/graph (no bodies or attachment lists). */
  publicNodes: GraphNode[]
  edges: GraphEdge[]
  openHandoffs: string[]
  warnings: string[]
  nodeById: Map<string, SnapshotNode>
  /** MAP.md row order, for tests and diagnostics. */
  mapOrder: string[]
}

export const RECENT_ACCESS_LIMIT = 50
/** node.md files above this are refused rather than read whole. */
const MAX_NODE_MD_BYTES = 4 * 1024 * 1024
const MAX_MAP_BYTES = 8 * 1024 * 1024

interface HalfRecord {
  src: string
  dst: string
}

/**
 * Every non-dot ULID directory under root (graph-maintain:163-169).
 *
 * A listing FAILURE is not an empty graph (#9): it throws, so the store keeps its
 * last good snapshot and reports the root as unavailable instead of publishing a
 * healthy-looking empty graph.
 */
function listNodeIds(graphRoot: SafeRoot, warnings: string[]): string[] {
  const listing = graphRoot.listDirResult('.')
  if (!listing.ok) {
    throw new Error(`graph root could not be listed (${listing.reason ?? 'unknown'}): ${graphRoot.canonical}`)
  }
  const entries = listing.entries
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!isValidNodeId(entry.name)) continue
    if (entry.isSymbolicLink()) {
      // A symlinked node dir is not a Node, and must never be traversed.
      warnings.push(`node ${entry.name} is a symlink; skipped`)
      continue
    }
    if (!entry.isDirectory()) continue
    ids.push(entry.name)
  }
  ids.sort()
  return ids
}

/**
 * Attachments: regular files inside a Node directory except `node.md`, legacy
 * `accessed.log` and every dotfile — mirrors `extraFiles()` (graph.js:632-636).
 */
function listAttachments(graphRoot: SafeRoot, id: string, warnings: string[]): Attachment[] {
  const entries = graphRoot.listDir(id)
  const attachments: Attachment[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.')) continue
    if (name === 'node.md' || name === 'accessed.log') continue
    if (entry.isDirectory()) continue
    if (!isValidAttachmentName(name)) continue
    const rel = path.posix.join(id, name)
    if (entry.isSymbolicLink()) {
      // A symlinked "attachment" may point outside the graph or at a forbidden
      // sibling; it is not served and not counted.
      warnings.push(`attachment is a symlink; skipped: ${rel}`)
      continue
    }
    const stat = graphRoot.stat(rel)
    if (!stat.ok) {
      warnings.push(`attachment unreadable: ${rel}`)
      continue
    }
    attachments.push({ name, size: stat.size ?? 0, mtime: new Date(stat.mtimeMs ?? 0).toISOString() })
  }
  attachments.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return attachments
}

/**
 * ULID-named symlinks in `<id>/__edges__/` only; anything else is not an edge.
 *
 * The symlink TARGET is validated too (#6): it must be exactly `../../<dst>` and
 * `<dst>` must be a real Node directory inside the root. A link pointing at a
 * third node, an absolute path or an escaping `../..` is a malformed edge, not a
 * relationship — it is skipped with a warning.
 */
function listEdgeHalves(graphRoot: SafeRoot, id: string, warnings: string[]): HalfRecord[] {
  const edgesRel = path.posix.join(id, EDGES_DIR)
  if (!graphRoot.isRealDir(edgesRel)) return []
  const entries = graphRoot.listDir(edgesRel)
  const halves: HalfRecord[] = []
  for (const entry of entries) {
    const name = entry.name
    if (!isValidNodeId(name)) continue // .edge-types, ..edge-types.tmp-*, junk
    const rel = path.posix.join(edgesRel, name)
    if (!entry.isSymbolicLink()) {
      // Not an edge (the engine and graph-maintain agree): typically a
      // hand-made directory. graph-maintain reports it, and its --apply turns
      // an empty one into the edge symlink.
      warnings.push(`edge entry is not a symlink: ${rel} (not counted as an edge; run graph-maintain --apply to repair an empty one)`)
      continue
    }
    let target: string
    try {
      target = fs.readlinkSync(graphRoot.resolve(rel))
    } catch {
      warnings.push(`edge symlink unreadable: ${rel}`)
      continue
    }
    // Exactly the layout edge-add writes, nothing else.
    if (target !== `../../${name}`) {
      warnings.push(`malformed edge target: ${rel} -> ${target} (want ../../${name})`)
      continue
    }
    if (!graphRoot.isRealDir(name)) {
      warnings.push(`dangling edge: ${id} -> ${name}`)
      continue
    }
    halves.push({ src: id, dst: name })
  }
  return halves
}

interface MapIndex {
  order: string[]
  rank: Map<string, number>
  header: string[]
}

/**
 * MAP.md is used ONLY for mapRank: the order of column-0 `<ULID> — …` rows.
 * The pinned open-handoff lines are indented, so they never match.
 */
export function parseMapOrder(text: string): MapIndex {
  const rank = new Map<string, number>()
  const order: string[] = []
  const header: string[] = []
  const rowRe = /^([0-9A-HJKMNP-TV-Z]{26}) — /
  for (const line of text.split('\n')) {
    const found = rowRe.exec(line)
    if (found?.[1] !== undefined) {
      const id = found[1]
      if (rank.has(id)) continue
      rank.set(id, order.length)
      order.push(id)
    } else if (order.length === 0 && line.trim() !== '') {
      header.push(line)
    }
  }
  return { order, rank, header }
}

function readMapIndex(graphRoot: SafeRoot, warnings: string[]): MapIndex {
  const read = graphRoot.read('MAP.md', MAX_MAP_BYTES)
  if (!read.ok) {
    // A missing MAP.md is normal (a graph that never ran graph-maintain).
    if (read.reason !== undefined && read.reason !== 'missing') {
      warnings.push(`MAP.md not read (${read.reason}); mapRank unavailable`)
    }
    return { order: [], rank: new Map(), header: [] }
  }
  return parseMapOrder(read.text ?? '')
}

const EMPTY_PARSED: ParsedNodeFile = parseNodeFile('')

function readNodeMd(graphRoot: SafeRoot, id: string, warnings: string[]): ParsedNodeFile {
  const rel = path.posix.join(id, 'node.md')
  const read = graphRoot.read(rel, MAX_NODE_MD_BYTES)
  if (!read.ok) {
    if (read.reason === 'symlink') warnings.push(`node.md is a symlink; refused: ${rel}`)
    else if (read.reason === 'too-large') warnings.push(`node.md too large, skipped: ${rel}`)
    else if (read.reason === 'outside') warnings.push(`node.md escapes the graph root; refused: ${rel}`)
    else warnings.push(`missing or unreadable node.md: ${rel}`)
    return EMPTY_PARSED
  }
  const parsed = parseNodeFile(read.text ?? '')
  if (parsed.warning !== null) warnings.push(`${parsed.warning}: ${rel}`)
  return parsed
}

interface PairAccess {
  count: number
  lastMs: number
  lastAt: string
}

/**
 * Build the complete snapshot. Synchronous by design: one consistent pass.
 *
 * `trust` is the root identity pinned at startup. When given, the configured path
 * must still resolve to that exact directory; a moved-aside-and-replaced root is
 * refused (SEC-003, pass-3 #1) instead of being adopted as the new boundary.
 */
export function buildGraphSnapshot(
  graphRootPath: string,
  generation: number,
  trust?: TrustedRoot | null,
): GraphSnapshot {
  const opened = SafeRoot.openChecked(graphRootPath, trust)
  const graphRoot = opened.root
  if (graphRoot === null) {
    // The root vanished, is unreadable, or was replaced. This is a warning-bearing
    // empty snapshot (never a throw) so a watcher callback cannot terminate the
    // process; the store recognises the `unavailable` prefix and keeps its last
    // good snapshot.
    const detail = opened.reason === 'root-replaced' ? 'was replaced' : 'is unavailable'
    return {
      generation,
      builtAt: Date.now(),
      nodes: [],
      publicNodes: [],
      edges: [],
      openHandoffs: [],
      warnings: [`${GRAPH_ROOT_UNAVAILABLE}: ${graphRootPath} (${detail})`],
      nodeById: new Map(),
      mapOrder: [],
    }
  }

  const warnings: string[] = []
  const ids = listNodeIds(graphRoot, warnings)
  const idSet = new Set(ids)
  const mapIndex = readMapIndex(graphRoot, warnings)

  // --- node files ----------------------------------------------------------
  const parsedById = new Map<string, ParsedNodeFile>()
  for (const id of ids) parsedById.set(id, readNodeMd(graphRoot, id, warnings))

  // --- sidecars + symlink halves ------------------------------------------
  const sidecars = new Map<string, Sidecar>()
  const halves: HalfRecord[] = []
  for (const id of ids) {
    const { types, malformed, refused } = readEdgeTypes(graphRoot, id)
    sidecars.set(id, types)
    if (refused !== null) warnings.push(`.edge-types is a symlink or escapes; refused: ${refused}`)
    if (malformed > 0) warnings.push(`malformed .edge-types line(s) in ${id} (${malformed})`)
    halves.push(...listEdgeHalves(graphRoot, id, warnings))
  }
  const halfKeys = new Set(halves.map((h) => `${h.src}\t${h.dst}`))
  for (const [owner, types] of sidecars) {
    for (const dst of types.keys()) {
      if (!idSet.has(dst)) warnings.push(`edge type names unknown node: ${owner} -> ${dst}`)
    }
  }

  // --- access logs ---------------------------------------------------------
  const pairAccess = new Map<string, PairAccess>()
  const visitCount = new Map<string, number>()
  const recentByNode = new Map<string, AccessLine[]>()
  const pushRecent = (id: string, line: AccessLine): void => {
    const list = recentByNode.get(id)
    if (list === undefined) recentByNode.set(id, [line])
    else list.push(line)
  }
  const malformedLogs: string[] = []
  const refusedLogs: string[] = []
  for (const id of ids) {
    const { lines, malformed, skipped } = readAccessLines(graphRoot, id)
    if (malformed > 0) malformedLogs.push(id)
    refusedLogs.push(...skipped)
    for (const line of lines) {
      if (line.dst === line.src) {
        // Self-line: a direct read of the node — a visit, never edge strength.
        if (idSet.has(line.src)) {
          visitCount.set(line.src, (visitCount.get(line.src) ?? 0) + 1)
          pushRecent(line.src, line)
        }
        continue
      }
      const key = `${line.src}\t${line.dst}`
      const prev = pairAccess.get(key)
      if (prev === undefined) pairAccess.set(key, { count: 1, lastMs: line.ms, lastAt: line.at })
      else {
        prev.count += 1
        if (line.ms > prev.lastMs) {
          prev.lastMs = line.ms
          prev.lastAt = line.at
        }
      }
      if (idSet.has(line.src)) pushRecent(line.src, line)
      if (idSet.has(line.dst)) pushRecent(line.dst, line)
    }
  }
  if (malformedLogs.length > 0) warnings.push(`malformed access-log line(s) in ${malformedLogs.length} node log(s)`)
  if (refusedLogs.length > 0) {
    warnings.push(`access log refused (symlink or outside root): ${refusedLogs.length} file(s)`)
  }
  const pairAccessOf = (src: string, dst: string): PairAccess | undefined => pairAccess.get(`${src}\t${dst}`)

  // --- logical edges -------------------------------------------------------
  const edges: GraphEdge[] = []
  const incident = new Map<string, number>()
  const bump = (id: string): void => {
    incident.set(id, (incident.get(id) ?? 0) + 1)
  }
  const consumed = new Set<string>() // half keys already represented by an edge

  // 1. Directed edges: the sidecar line is the record, so it decides direction
  //    (a retyped plain pair keeps its reverse symlink — that half belongs to
  //    this edge and is never a separate plain edge).
  for (const src of ids) {
    const types = sidecars.get(src)
    if (types === undefined) continue
    for (const [dst, type] of types) {
      if (!isDirectedType(type)) continue
      if (!idSet.has(dst)) continue // already warned above
      const forward = halfKeys.has(`${src}\t${dst}`)
      const reverse = halfKeys.has(`${dst}\t${src}`)
      if (!forward && !reverse) {
        warnings.push(`directed edge ${type} has no valid symlink: ${src} -> ${dst}`)
        continue
      }
      if (!forward) warnings.push(`directed edge ${type} is missing its forward symlink: ${src} -> ${dst}`)
      const acc = pairAccessOf(src, dst)
      edges.push({
        source: src,
        target: dst,
        type,
        directed: true,
        halves: forward && reverse ? 2 : 1,
        accessCount: acc?.count ?? 0,
        lastAccess: acc?.lastAt ?? null,
      })
      consumed.add(`${src}\t${dst}`)
      if (reverse) consumed.add(`${dst}\t${src}`)
      bump(src)
      bump(dst)
    }
  }

  // 2. Symmetric edges: one logical edge per unordered pair, however many
  //    symlinks store it (graph-maintain F54). Access strength sums both
  //    directions (REQ-004).
  const seenSymmetric = new Set<string>()
  for (const half of halves) {
    const { src, dst } = half
    if (consumed.has(`${src}\t${dst}`)) continue
    if (!idSet.has(dst)) {
      warnings.push(`dangling edge: ${src} -> ${dst}`)
      continue
    }
    // A half whose PEER carries a directed line rides with that directed edge
    // even when the directed side lost its own symlink.
    const peerType = resolveEdgeType(sidecars, dst, src)
    if (peerType !== undefined && isDirectedType(peerType)) continue

    const lo = src < dst ? src : dst
    const hi = src < dst ? dst : src
    const pairKey = `${lo}\t${hi}`
    if (seenSymmetric.has(pairKey)) continue
    seenSymmetric.add(pairKey)

    const type: EdgeType = resolveEdgeType(sidecars, lo, hi) ?? 'plain'
    const forward = pairAccessOf(lo, hi)
    const backward = pairAccessOf(hi, lo)
    const accessCount = (forward?.count ?? 0) + (backward?.count ?? 0)
    let lastAt: string | null = null
    if (forward !== undefined && (backward === undefined || forward.lastMs >= backward.lastMs)) lastAt = forward.lastAt
    else if (backward !== undefined) lastAt = backward.lastAt

    const bothHalves = halfKeys.has(`${lo}\t${hi}`) && halfKeys.has(`${hi}\t${lo}`)
    edges.push({ source: lo, target: hi, type, directed: false, halves: bothHalves ? 2 : 1, accessCount, lastAccess: lastAt })
    bump(lo)
    bump(hi)
    if (!bothHalves && type === 'plain') {
      warnings.push(`half edge (single symlink, no type): ${lo} <-> ${hi}`)
    }
  }
  edges.sort((a, b) => (a.source === b.source ? (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) : a.source < b.source ? -1 : 1))

  // --- supersede banner vs sidecar agreement (AC-003) ----------------------
  for (const edge of edges) {
    if (!edge.directed || edge.type !== 'supersedes') continue
    const banner = parsedById.get(edge.target)?.supersededBy ?? null
    if (banner === null) warnings.push(`supersedes without banner: ${edge.source} -> ${edge.target}`)
    else if (banner !== edge.source) {
      warnings.push(`supersede disagreement: ${edge.source} supersedes ${edge.target}, but ${edge.target} names ${banner}`)
    }
  }
  for (const id of ids) {
    const banner = parsedById.get(id)?.supersededBy
    if (banner === undefined || banner === null) continue
    if (!idSet.has(banner)) {
      warnings.push(`supersede banner names unknown node: ${id} -> ${banner}`)
      continue
    }
    if (resolveEdgeType(sidecars, banner, id) !== 'supersedes') {
      warnings.push(`banner without supersedes sidecar: ${id} superseded by ${banner}`)
    }
  }

  // --- nodes ---------------------------------------------------------------
  const nodes: SnapshotNode[] = []
  for (const id of ids) {
    const parsed = parsedById.get(id) ?? EMPTY_PARSED
    const attachments = listAttachments(graphRoot, id, warnings)
    const recentAccess = (recentByNode.get(id) ?? [])
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .slice(0, RECENT_ACCESS_LIMIT)
      .map((line) => ({ dst: line.dst, src: line.src, at: line.at }))
    nodes.push({
      id,
      description: parsed.description,
      type: parsed.type,
      created: parsed.created,
      updated: parsed.updated,
      superseded: parsed.supersededBy !== null,
      supersededBy: parsed.supersededBy,
      openHandoff: isOpenHandoff(parsed.type, parsed.supersededBy),
      degree: incident.get(id) ?? 0,
      attachmentCount: attachments.length,
      mapRank: mapIndex.rank.get(id) ?? null,
      visitCount: visitCount.get(id) ?? 0,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      attachments,
      neighbours: [],
      recentAccess,
      searchText: `${parsed.description}\n${parsed.body}`.toLowerCase(),
    })
  }

  // --- neighbours ----------------------------------------------------------
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (a === undefined || b === undefined) continue
    if (edge.directed) {
      a.neighbours.push({ id: b.id, description: b.description, edgeType: edge.type, direction: 'out' })
      b.neighbours.push({ id: a.id, description: a.description, edgeType: edge.type, direction: 'in' })
    } else {
      a.neighbours.push({ id: b.id, description: b.description, edgeType: edge.type, direction: 'both' })
      b.neighbours.push({ id: a.id, description: a.description, edgeType: edge.type, direction: 'both' })
    }
  }
  for (const node of nodes) node.neighbours.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

  const openHandoffs = nodes
    .filter((node) => node.openHandoff)
    .sort((a, b) => {
      const la = a.updated ?? a.created ?? ''
      const lb = b.updated ?? b.created ?? ''
      if (la !== lb) return la < lb ? 1 : -1
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })
    .map((node) => node.id)

  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    generation,
    builtAt: Date.now(),
    nodes,
    publicNodes: nodes.map((node) => ({
      id: node.id,
      description: node.description,
      type: node.type,
      created: node.created,
      updated: node.updated,
      superseded: node.superseded,
      supersededBy: node.supersededBy,
      openHandoff: node.openHandoff,
      degree: node.degree,
      attachmentCount: node.attachmentCount,
      mapRank: node.mapRank,
      visitCount: node.visitCount,
    })),
    edges,
    openHandoffs,
    warnings,
    nodeById: byId,
    mapOrder: mapIndex.order,
  }
}
