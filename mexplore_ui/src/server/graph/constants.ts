import type { EdgeType } from '../../shared/types.ts'

/** Current access-log location under graphRoot (F57, #93). */
export const ACCESS_DIR = '.access'

/** Write-session provenance: `<graphRoot>/.provenance/<id>.jsonl` (#317). */
export const PROVENANCE_DIR = '.provenance'

export const EDGES_DIR = '__edges__'
export const EDGE_TYPES_FILE = '.edge-types'

/** Directed edge types; every other type is symmetric (Definitions §2). */
export const DIRECTED_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>(['supersedes', 'follows-from'])

export function isDirectedType(type: EdgeType): boolean {
  return DIRECTED_TYPES.has(type)
}

export function isEdgeType(value: string): value is EdgeType {
  return value === 'plain' || value === 'relates-to' || value === 'supersedes' || value === 'follows-from'
}
