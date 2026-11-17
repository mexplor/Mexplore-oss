// Edge-type sidecars (Definitions §2).
//
// `<src>/__edges__/.edge-types` holds one `<dst-ULID> <type>` line per typed
// edge. The effective type between two nodes is the plugin's `edgeTypeOf`
// (dsh_plugin/lib/graph.js:2435-2440): the source's own line wins; otherwise
// the peer's line counts, but only for a symmetric type — a directed line over
// there describes the peer's own outgoing edge and is never inverted onto us.

import path from 'node:path'

import type { EdgeType } from '../../shared/types.ts'
import type { SafeRoot } from '../fs-safe.ts'
import { EDGES_DIR, EDGE_TYPES_FILE, isDirectedType, isEdgeType } from './constants.ts'

export type Sidecar = Map<string, EdgeType>

/** One node's sidecar, parsed defensively (malformed lines ignored). */
export function parseEdgeTypes(text: string): { types: Sidecar; malformed: number } {
  const types: Sidecar = new Map()
  let malformed = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const fields = line.split(/\s+/)
    const [dst, type] = fields
    if (dst === undefined || type === undefined || !isEdgeType(type)) {
      malformed += 1
      continue
    }
    types.set(dst, type)
  }
  return { types, malformed }
}

export interface SidecarRead {
  types: Sidecar
  malformed: number
  /** Non-null when a symlinked/escaping `.edge-types` was refused. */
  refused: string | null
}

export function readEdgeTypes(graphRoot: SafeRoot, id: string): SidecarRead {
  const read = graphRoot.read(path.posix.join(id, EDGES_DIR, EDGE_TYPES_FILE))
  if (!read.ok) {
    const refused =
      read.reason === undefined || read.reason === 'missing'
        ? null
        : `${id}/${EDGES_DIR}/${EDGE_TYPES_FILE}:${read.reason}`
    return { types: new Map(), malformed: 0, refused }
  }
  const { types, malformed } = parseEdgeTypes(read.text ?? '')
  return { types, malformed, refused: null }
}

/** Pure form of `edgeTypeOf`: undefined when neither side records a type. */
export function resolveEdgeType(sidecars: Map<string, Sidecar>, src: string, dst: string): EdgeType | undefined {
  const own = sidecars.get(src)?.get(dst)
  if (own !== undefined) return own
  const peer = sidecars.get(dst)?.get(src)
  if (peer !== undefined && !isDirectedType(peer)) return peer
  return undefined
}
