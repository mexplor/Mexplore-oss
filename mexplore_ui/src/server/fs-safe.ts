// Guarded filesystem access (SEC-003).
//
// Every graph and state read goes through a `SafeRoot`. A read is allowed only
// when ALL of these hold, and they are re-checked on EVERY read (not once at
// listing time):
//
//   1. every path component from the canonical root down to the leaf's parent is
//      a real directory — `lstat`ed, so a symlinked container (`.access` ->
//      /outside, a Node dir swapped for a symlink) is refused even when it points
//      somewhere inside the root;
//   2. the leaf is opened with `O_NOFOLLOW`, and is a regular file;
//   3. containment is judged on the CANONICAL path (`realpath`) BEFORE any byte is
//      trusted, and the opened descriptor's `(dev, ino)` must equal the stat of
//      that canonical path. A concurrent parent-directory swap therefore cannot
//      hand us an outside inode and restore the inside path in time: the
//      descriptor and the verified path would disagree and the read is refused.
//
// `record()` fires for every path this module is asked about, which lets tests
// assert the read allowlist (SEC-006).

import fs from 'node:fs'
import path from 'node:path'

export type SafeFailure =
  | 'missing'
  | 'symlink'
  | 'outside'
  | 'not-file'
  | 'not-dir'
  | 'too-large'
  | 'io-error'
  | 'inode-mismatch'
  /** The configured root path no longer resolves to the trusted canonical root. */
  | 'root-replaced'

export interface SafeStat {
  ok: boolean
  reason?: SafeFailure
  /** Canonical path, present only when ok. */
  path?: string
  size?: number
  mtimeMs?: number
  mode?: number
  /** Device + inode of the verified file (for tests and the swap check). */
  dev?: number
  ino?: number
}

export interface SafeRead extends SafeStat {
  text?: string
}

export interface DirListing {
  ok: boolean
  reason?: SafeFailure
  entries: fs.Dirent[]
}

export type FileAuditOp = 'stat' | 'read' | 'readdir'

export type OpenHook = (info: { absolute: string; fd: number; canonical: string }) => void

/** Called immediately before a directory listing; throwing simulates EACCES. */
export type ListingHook = (absolutePath: string) => void

let fileAudit: ((op: FileAuditOp, absolutePath: string) => void) | null = null
let openHook: OpenHook | null = null
let listingHook: ListingHook | null = null

/**
 * Install a hook called for every path this module is asked about, before any
 * syscall. Tests use it to assert the read allowlist; production leaves it null.
 */
export function setFileAudit(hook: ((op: FileAuditOp, absolutePath: string) => void) | null): void {
  fileAudit = hook
}

/**
 * Install a hook called AFTER the leaf open and BEFORE the inode/containment
 * verification. Tests use it to simulate a concurrent directory swap.
 */
export function setOpenHook(hook: OpenHook | null): void {
  openHook = hook
}

/**
 * Test seam: inject a listing failure (e.g. EACCES) at a chosen directory.
 * `listDirResult` must convert any such throw into `ok: false`, never an empty
 * listing — that distinction is what keeps an unreadable root from looking like a
 * healthy empty graph.
 */
export function setListingHook(hook: ListingHook | null): void {
  listingHook = hook
}

function record(op: FileAuditOp, absolutePath: string): void {
  fileAudit?.(op, absolutePath)
}

/** Map a filesystem errno to a reason: a permission error is NOT "missing". */
function reasonOf(error: unknown): SafeFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'ELOOP' || code === 'EMLINK') return 'symlink'
  if (code === 'EACCES' || code === 'EPERM') return 'io-error'
  return 'io-error'
}

function canonical(target: string): string | null {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/** Like \`canonical\`, but keeps the errno so a permission failure is not "missing". */
function canonicalReason(target: string): { path: string | null; reason: SafeFailure | null } {
  try {
    return { path: fs.realpathSync(target), reason: null }
  } catch (error) {
    return { path: null, reason: reasonOf(error) }
  }
}

/** True when `candidate` is `root` or below it. Both should be canonical. */
export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep
  return candidate === root || candidate.startsWith(normalizedRoot)
}

interface OpenedFile {
  ok: boolean
  reason?: SafeFailure
  fd?: number
  canonicalPath?: string
  size: number
  mtimeMs: number
  mode: number
  dev: number
  ino: number
}

/**
 * A root whose identity was pinned at startup: the canonical path plus the
 * directory's (dev, ino). Every later access re-checks that the CONFIGURED path
 * still resolves to exactly this identity and REFUSES otherwise (#1).
 *
 * Pinning is what stops a later redirection from redefining the trust boundary:
 * moving the graph root aside and replacing its pathname with a symlink to an
 * outside directory would otherwise make the next scan adopt the outside tree as
 * its "canonical" root, after which every container/inode check would validate
 * against the wrong boundary.
 */
export interface TrustedRoot {
  /** The path as configured (before canonicalisation). */
  readonly configured: string
  /** The canonical path resolved once, at startup. */
  readonly canonical: string
  readonly dev: number
  readonly ino: number
}

/** Pin a root's identity. Returns null when it is not a readable directory. */
export function pinTrustedRoot(configuredPath: string): TrustedRoot | null {
  const canonicalPath = canonical(configuredPath)
  if (canonicalPath === null) return null
  let info: fs.Stats
  try {
    info = fs.statSync(canonicalPath)
  } catch {
    return null
  }
  if (!info.isDirectory()) return null
  return { configured: configuredPath, canonical: canonicalPath, dev: info.dev, ino: info.ino }
}

/**
 * Verify a pinned root is still the same directory.
 *
 * Both checks matter:
 *   * the configured path must still canonicalise to the pinned path (a replaced
 *     pathname, e.g. root -> /outside, fails here);
 *   * the canonical path's (dev, ino) must be unchanged (a directory swapped at
 *     the same pathname, e.g. rename + recreate, fails here).
 */
export function trustedRootProblem(trusted: TrustedRoot): SafeFailure | null {
  let resolved: string
  try {
    resolved = fs.realpathSync(trusted.configured)
  } catch {
    return 'missing'
  }
  if (resolved !== trusted.canonical) return 'root-replaced'
  let info: fs.Stats
  try {
    info = fs.statSync(trusted.canonical)
  } catch {
    return 'missing'
  }
  if (info.dev !== trusted.dev || info.ino !== trusted.ino) return 'root-replaced'
  if (!info.isDirectory()) return 'not-dir'
  return null
}

/**
 * A canonical root directory. Construct once per scan; every accessor revalidates
 * the whole relative path on each call.
 */
export class SafeRoot {
  readonly canonical: string
  /** Non-null when this root was opened through a pinned identity (#1). */
  readonly trusted: TrustedRoot | null
  /** Set when an anchored open was refused because the root moved. */
  readonly refusal: SafeFailure | null

  private constructor(canonicalPath: string, trusted: TrustedRoot | null, refusal: SafeFailure | null = null) {
    this.canonical = canonicalPath
    this.trusted = trusted
    this.refusal = refusal
  }

  /**
   * Open a root, or null when it does not exist / is not a directory.
   *
   * Pass the pinned root to enforce it: the configured path is re-realpath'd and
   * must still equal the pinned canonical path with the same (dev, ino). A moved
   * or redirected root returns null (never the outside target).
   */
  static open(dir: string, trusted?: TrustedRoot | null): SafeRoot | null {
    if (trusted !== undefined && trusted !== null) {
      const problem = trustedRootProblem(trusted)
      if (problem !== null) return null
      // Use the PINNED canonical path, never a fresh realpath of the configured
      // one: the identity was already verified above.
      return new SafeRoot(trusted.canonical, trusted)
    }
    const real = canonical(dir)
    if (real === null) return null
    try {
      if (!fs.statSync(real).isDirectory()) return null
    } catch {
      return null
    }
    return new SafeRoot(real, null)
  }

  /**
   * Open a root, reporting WHY it was refused. Callers that need to distinguish
   * "moved aside" from "gone" use this; a pinned root that fails verification
   * returns `{ root: null, reason: 'root-replaced' }`.
   */
  static openChecked(
    dir: string,
    trusted?: TrustedRoot | null,
  ): { root: SafeRoot | null; reason: SafeFailure | null } {
    if (trusted !== undefined && trusted !== null) {
      const problem = trustedRootProblem(trusted)
      if (problem !== null) return { root: null, reason: problem }
      return { root: new SafeRoot(trusted.canonical, trusted), reason: null }
    }
    const root = SafeRoot.open(dir)
    return { root, reason: root === null ? 'missing' : null }
  }

  /** Absolute candidate for a relative path (lexical only; no disk access). */
  resolve(rel: string): string {
    return path.resolve(this.canonical, rel)
  }

  /** True when the (possibly non-canonical) path is lexically inside the root. */
  contains(rel: string): boolean {
    return isInside(this.canonical, this.resolve(rel))
  }

  /**
   * Split a relative path into safe segments, or null when it escapes lexically
   * (`..`), is absolute, or contains a NUL.
   */
  private segments(rel: string): string[] | null {
    if (rel.includes('\0')) return null
    if (path.isAbsolute(rel)) return null
    const normalized = path.normalize(rel)
    if (normalized === '.' || normalized === '') return []
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null
    const parts = normalized.split(path.sep).filter((part) => part !== '' && part !== '.')
    if (parts.some((part) => part === '..')) return null
    return parts
  }

  /**
   * Validate the first `count` segments as directories: each must be a real
   * directory, not a symlink. Re-run on every access, never cached from listing.
   */
  private verifyContainers(parts: readonly string[], count: number): SafeFailure | null {
    let current = this.canonical
    // Root itself: confirm it is still a directory, and — when this root was
    // pinned — that it is still the SAME directory. Re-checking here (not only in
    // open()) means a root redirected between scans is refused on every access.
    if (this.trusted !== null) {
      const problem = trustedRootProblem(this.trusted)
      if (problem !== null) return problem
    }
    try {
      const rootInfo = fs.lstatSync(current)
      if (!rootInfo.isDirectory()) return 'not-dir'
    } catch {
      return 'missing'
    }
    for (let i = 0; i < count; i++) {
      current = path.join(current, parts[i] as string)
      let info: fs.Stats
      try {
        info = fs.lstatSync(current)
      } catch (error) {
        return reasonOf(error)
      }
      // A symlinked container is exactly how a read escapes: refuse it even when
      // its target happens to be inside the root.
      if (info.isSymbolicLink()) return 'symlink'
      if (!info.isDirectory()) return 'not-dir'
    }
    return null
  }

  /**
   * Validate containers, canonicalise, and bind the result to the path: the
   * canonical path must be inside the root AND its stat must agree with the
   * component we inspected.
   */
  private verifyPath(
    rel: string,
  ): { ok: true; parts: string[]; absolute: string; canonicalPath: string; info: fs.Stats } | { ok: false; reason: SafeFailure } {
    const parts = this.segments(rel)
    if (parts === null) return { ok: false, reason: 'outside' }
    if (parts.length === 0) return { ok: false, reason: 'not-file' }
    const containerProblem = this.verifyContainers(parts, parts.length - 1)
    if (containerProblem !== null) return { ok: false, reason: containerProblem }

    const absolute = path.join(this.canonical, ...parts)
    if (!isInside(this.canonical, absolute)) return { ok: false, reason: 'outside' }

    // The leaf itself must not be a symlink: `lstat` sees the link, not its target.
    let info: fs.Stats
    try {
      info = fs.lstatSync(absolute)
    } catch (error) {
      return { ok: false, reason: reasonOf(error) }
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' }
    if (!info.isFile()) return { ok: false, reason: 'not-file' }

    // Containment via realpath BEFORE any bytes are trusted. Comparing identity
    // (dev/ino) rather than strings keeps this immune to case normalisation on a
    // case-insensitive filesystem.
    const resolvedReal = canonicalReason(absolute)
    if (resolvedReal.path === null) return { ok: false, reason: resolvedReal.reason ?? 'missing' }
    const canonicalPath = resolvedReal.path
    if (!isInside(this.canonical, canonicalPath)) return { ok: false, reason: 'outside' }
    let resolved: fs.Stats
    try {
      resolved = fs.statSync(canonicalPath)
    } catch {
      return { ok: false, reason: 'missing' }
    }
    if (resolved.dev !== info.dev || resolved.ino !== info.ino) {
      // Between `lstat` and `realpath` the path changed: a link or swap.
      return { ok: false, reason: 'symlink' }
    }
    return { ok: true, parts, absolute, canonicalPath, info }
  }

  /**
   * Open a leaf with O_NOFOLLOW and bind the descriptor to the verified path.
   * The descriptor's (dev, ino) must equal the verified canonical path's.
   */
  private openVerified(rel: string): OpenedFile {
    const verified = this.verifyPath(rel)
    const empty = { size: 0, mtimeMs: 0, mode: 0, dev: 0, ino: 0 }
    if (!verified.ok) return { ok: false, reason: verified.reason, ...empty }

    record('read', verified.absolute)
    const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
    let fd: number
    try {
      fd = fs.openSync(verified.absolute, fs.constants.O_RDONLY | O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'symlink', ...empty }
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing', ...empty }
      return { ok: false, reason: 'io-error', ...empty }
    }

    // Every failure inside this block must close the descriptor it holds.
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile()) {
        closeQuietly(fd)
        return { ok: false, reason: 'not-file', ...empty }
      }

      // Test hook: lets a suite simulate a swap between open and verification.
      openHook?.({ absolute: verified.absolute, fd, canonical: verified.canonicalPath })

      // Re-verify AFTER the open: containers may have changed in between, and the
      // descriptor must be the very file the guard just validated.
      const recheck = this.verifyPath(rel)
      if (!recheck.ok) {
        closeQuietly(fd)
        return { ok: false, reason: recheck.reason, ...empty }
      }
      if (recheck.info.dev !== info.dev || recheck.info.ino !== info.ino) {
        // The bytes we hold belong to a different file than the guarded path.
        closeQuietly(fd)
        return { ok: false, reason: 'inode-mismatch', ...empty }
      }

      return {
        ok: true,
        fd,
        canonicalPath: recheck.canonicalPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
        dev: info.dev,
        ino: info.ino,
      }
    } catch {
      closeQuietly(fd)
      return { ok: false, reason: 'io-error', ...empty }
    }
  }

  /** Stat a regular file inside the root. Refuses symlinks, escapes, dirs. */
  stat(rel: string): SafeStat {
    const candidate = this.resolve(rel)
    record('stat', candidate)
    if (!isInside(this.canonical, candidate)) return { ok: false, reason: 'outside' }
    const verified = this.verifyPath(rel)
    if (!verified.ok) return { ok: false, reason: verified.reason }
    return {
      ok: true,
      path: verified.canonicalPath,
      size: verified.info.size,
      mtimeMs: verified.info.mtimeMs,
      mode: verified.info.mode,
      dev: verified.info.dev,
      ino: verified.info.ino,
    }
  }

  /** Read a regular file inside the root as utf-8, refusing oversized files. */
  read(rel: string, maxBytes = Number.POSITIVE_INFINITY): SafeRead {
    const opened = this.openVerified(rel)
    if (!opened.ok || opened.fd === undefined) {
      return { ok: false, reason: opened.reason ?? 'io-error' }
    }
    const fd = opened.fd
    try {
      if (opened.size > maxBytes) return { ok: false, reason: 'too-large', size: opened.size, path: opened.canonicalPath }
      const buffer = Buffer.alloc(opened.size)
      let read = 0
      while (read < opened.size) {
        const chunk = fs.readSync(fd, buffer, read, opened.size - read, read)
        if (chunk === 0) break
        read += chunk
      }
      return {
        ok: true,
        path: opened.canonicalPath,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        mode: opened.mode,
        dev: opened.dev,
        ino: opened.ino,
        text: buffer.subarray(0, read).toString('utf8'),
      }
    } catch {
      return { ok: false, reason: 'io-error' }
    } finally {
      closeQuietly(fd)
    }
  }

  /**
   * Read a bounded byte window (attachments), refusing symlinks and escapes.
   *
   * `offset` reads from that byte position instead of the start — the JSONL run
   * source uses it to consume only the bytes appended since the last refresh.
   * The size cap applies to the WINDOW, not the whole file.
   */
  readBytes(rel: string, maxBytes: number, offset = 0): SafeStat & { bytes?: Buffer } {
    const opened = this.openVerified(rel)
    if (!opened.ok || opened.fd === undefined) {
      return { ok: false, reason: opened.reason ?? 'io-error' }
    }
    const fd = opened.fd
    try {
      const start = Math.min(Math.max(0, offset), opened.size)
      const length = Math.min(opened.size - start, maxBytes)
      const buffer = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const chunk = fs.readSync(fd, buffer, read, length - read, start + read)
        if (chunk === 0) break
        read += chunk
      }
      return {
        ok: true,
        path: opened.canonicalPath,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        mode: opened.mode,
        dev: opened.dev,
        ino: opened.ino,
        bytes: buffer.subarray(0, read),
      }
    } catch {
      return { ok: false, reason: 'io-error' }
    } finally {
      closeQuietly(fd)
    }
  }

  /**
   * List a directory inside the root, distinguishing failure from emptiness:
   * `ok: false` means the directory could not be listed (missing, symlinked,
   * outside, not a directory, or a permission error), which the callers must not
   * read as "no children".
   */
  listDirResult(rel: string): DirListing {
    const candidate = this.resolve(rel)
    record('readdir', candidate)
    if (!isInside(this.canonical, candidate)) return { ok: false, reason: 'outside', entries: [] }

    const parts = this.segments(rel)
    if (parts === null) return { ok: false, reason: 'outside', entries: [] }
    if (parts.length > 0) {
      const containerProblem = this.verifyContainers(parts, parts.length)
      if (containerProblem !== null) return { ok: false, reason: containerProblem, entries: [] }
    }
    const absolute = parts.length === 0 ? this.canonical : path.join(this.canonical, ...parts)
    let info: fs.Stats
    try {
      info = fs.lstatSync(absolute)
    } catch (error) {
      return { ok: false, reason: reasonOf(error), entries: [] }
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink', entries: [] }
    if (!info.isDirectory()) return { ok: false, reason: 'not-dir', entries: [] }
    const real = canonical(absolute)
    if (real === null) return { ok: false, reason: 'missing', entries: [] }
    if (!isInside(this.canonical, real)) return { ok: false, reason: 'outside', entries: [] }

    try {
      listingHook?.(absolute)
      return { ok: true, entries: fs.readdirSync(absolute, { withFileTypes: true }) }
    } catch {
      // EACCES on the directory itself: a real failure, never "empty".
      return { ok: false, reason: 'io-error', entries: [] }
    }
  }

  /** Convenience wrapper: entries, or [] for any failure. */
  listDir(rel: string): fs.Dirent[] {
    return this.listDirResult(rel).entries
  }

  /** Stat a real (non-symlink) directory inside the root. */
  statDir(rel: string): SafeStat {
    const candidate = this.resolve(rel)
    record('stat', candidate)
    if (!isInside(this.canonical, candidate)) return { ok: false, reason: 'outside' }

    const parts = this.segments(rel)
    if (parts === null) return { ok: false, reason: 'outside' }
    if (parts.length === 0) return { ok: true, path: this.canonical }
    const containerProblem = this.verifyContainers(parts, parts.length)
    if (containerProblem !== null) return { ok: false, reason: containerProblem }

    const absolute = path.join(this.canonical, ...parts)
    let info: fs.Stats
    try {
      info = fs.lstatSync(absolute)
    } catch (error) {
      return { ok: false, reason: reasonOf(error) }
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' }
    if (!info.isDirectory()) return { ok: false, reason: 'not-dir' }
    const real = canonical(absolute)
    if (real === null) return { ok: false, reason: 'missing' }
    if (!isInside(this.canonical, real)) return { ok: false, reason: 'outside' }
    return { ok: true, path: real, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, dev: info.dev, ino: info.ino }
  }

  /** True when `rel` names a real (non-symlink) directory inside the root. */
  isRealDir(rel: string): boolean {
    return this.statDir(rel).ok
  }
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    // ignore
  }
}
