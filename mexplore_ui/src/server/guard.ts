// Identifier and path guards (SEC-003).
//
// URL/DB-derived identifiers are validated here before they ever reach a path.
// Filesystem access itself goes through `fs-safe.ts`, which additionally
// refuses symlinked leaves and escapes.

import fs from 'node:fs'
import path from 'node:path'

import { isInside, SafeRoot } from './fs-safe.ts'

export { isInside }

/** Crockford base32 ULID, exactly as the graph helpers validate it. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isValidNodeId(id: string): boolean {
  return ULID_RE.test(id)
}

/**
 * A task id is a lower-case UUID as written by the service. Run directories are
 * joined from `tasks.task_id`, so anything else (a separator, `..`, a leading
 * dot, an absolute path) is refused before it reaches the filesystem.
 */
export const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id)
}

/** ONE path segment: no separators, not empty, not `.`/`..`, no NUL, bounded length. */
export function isSinglePathSegment(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

/**
 * An attachment name is one path segment AND not a dotfile: dotfiles are
 * framework bookkeeping, never attachments (Definitions §2 and `extraFiles()` in
 * dsh_plugin/lib/graph.js).
 */
export function isValidAttachmentName(name: string): boolean {
  return isSinglePathSegment(name) && !name.startsWith('.')
}

/**
 * Resolve `candidate` to a canonical path that is inside `root`, or null when it
 * escapes, is a symlink, does not exist, or is not a regular file.
 *
 * `root` may be given un-resolved; it is canonicalised here (macOS `/var` ->
 * `/private/var`).
 */
export function realFileInside(root: string, candidate: string): string | null {
  const safe = SafeRoot.open(root)
  if (safe === null) return null
  // Lexical relative path from the CALLER's root, so a `/var` -> `/private/var`
  // difference between the two strings is not mistaken for an escape.
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const stat = safe.stat(relative)
  return stat.ok ? (stat.path ?? null) : null
}

/** True when a path exists, is not a symlink, and is a regular file. */
export function isRealFile(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile()
  } catch {
    return false
  }
}
