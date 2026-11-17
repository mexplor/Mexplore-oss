/**
 * The usage log writer (Shared contract, "Usage record").
 *
 * One JSON line per `mexplore` call, appended to
 * `<usageDir>/usage-YYYY-MM.jsonl` where the month is that of `ts` in UTC.
 *
 * The storage rules are the contract's, and they are about not leaking or
 * corrupting a user's state directory:
 *
 *   - `usageDir` is `$XDG_STATE_HOME/mexplore` (a RELATIVE `XDG_STATE_HOME` is
 *     ignored, per the XDG spec) or `~/.local/state/mexplore`;
 *   - directory `0700`, file `0600` — created that way, and re-checked, because
 *     `~/.local/state` is commonly shared;
 *   - a SYMLINKED file or directory is refused rather than followed: an attacker
 *     who can plant a link could otherwise redirect an append into a file they
 *     control;
 *   - ONE `appendFile` per line, so a line is a single `O_APPEND` write and
 *     concurrent OpenCode processes interleave at line boundaries, not inside a
 *     record.
 *
 * A failure to log is NEVER a failure of the memory call: usage accounting is
 * telemetry, and the writer reports (once) rather than throwing.
 *
 * @module mexplore/plugin/usage-log
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { UsageStatus, TokenUsage } from './usage-capture'

/** The contract's record shape, version 1. */
export interface UsageRecord {
  v: 1
  callId: string
  ts: string
  finishedAt: string
  authority: 'read' | 'manage'
  outcome: 'ok' | 'failed' | 'timeout' | 'aborted' | 'no_reply'
  latencyMs: number
  usageStatus: UsageStatus
  tokens: TokenUsage | null
  costUsd: number | null
  provider: string
  model: string
  modelSource: 'default' | 'selected' | 'parent-fallback'
  steps: number
  graphRoot: string
  pluginVersion: string
}

/** A record is one short line; the contract caps it well below this. */
export const MAX_LINE_BYTES = 2_048

/** Resolve the usage directory: `$XDG_STATE_HOME/mexplore`, else `~/.local/state/mexplore`. */
export function resolveUsageDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const stateHome = env.XDG_STATE_HOME
  const usable =
    typeof stateHome === 'string' && stateHome.trim().length > 0 && path.isAbsolute(expandHome(stateHome))
      ? expandHome(stateHome)
      : path.join(os.homedir(), '.local', 'state')
  return path.resolve(usable, 'mexplore')
}

/** `usage-YYYY-MM.jsonl` for the month `at` falls in, in UTC. */
export function usageFileFor(dir: string, at: Date): string {
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  return path.join(dir, `usage-${month}.jsonl`)
}

/**
 * Append one record. Returns the file it wrote, or `undefined` when the write
 * was refused or failed — the caller logs and moves on, never fails a call.
 */
export async function appendUsage(
  dir: string,
  record: UsageRecord,
): Promise<{ file: string } | { error: string }> {
  const at = new Date(record.ts)
  const file = usageFileFor(dir, Number.isNaN(at.getTime()) ? new Date() : at)
  const line = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return { error: `usage record exceeds ${MAX_LINE_BYTES} bytes` }
  }
  let pinned: PinnedDirectory
  try {
    pinned = await ensureDirectory(dir)
  } catch (error) {
    return { error: describe(error) }
  }
  try {
    return await appendInto(pinned, dir, file, line)
  } finally {
    await pinned.handle.close().catch(() => undefined)
  }
}

/**
 * Append through a PINNED directory descriptor (review round 3, major 1).
 *
 * Every mutation is bound to the inode we validated, never to a pathname that a
 * same-user attacker can swap between two syscalls:
 *
 *   - the directory is opened once with `O_DIRECTORY|O_NOFOLLOW` and its mode is
 *     applied with `fchmod` on THAT descriptor;
 *   - on Linux the file is opened relative to it (`/proc/self/fd/<dirfd>/<name>`
 *     with `O_NOFOLLOW`), so swapping the DIRECTORY's path is irrelevant — the
 *     leaf resolves inside the inode we pinned;
 *   - elsewhere Node/Bun expose no `openat`, so the leaf is opened by path with
 *     `O_NOFOLLOW` and then VERIFIED against the pinned directory (same device,
 *     still the same dev/ino at that path, name present in the pinned listing)
 *     before a single byte is written.
 *
 * Creating a file is itself a mutation, so the path open that carries `O_CREAT`
 * first re-verifies the pinned directory: a swap noticed at that point creates
 * nothing.
 *
 * Residual risk (macOS/BSD only): the leaf open is path-based, so an attacker who
 * swaps the directory for a symlink *and* swaps it back between our open and our
 * post-open verification can redirect one append. Closing that needs `openat`,
 * which neither Node nor Bun expose; the window is two adjacent syscalls and the
 * threat model here is a same-user attacker who could already read the file.
 */
async function appendInto(
  pinned: PinnedDirectory,
  dir: string,
  file: string,
  line: string,
): Promise<{ file: string } | { error: string }> {
  const changed = (): { error: string } => ({
    error: `refusing to write: the usage directory changed during the append (${dir})`,
  })
  let handle: fsp.FileHandle
  try {
    handle = await openUsageFile(pinned, dir, file)
  } catch (error) {
    // ELOOP is `O_NOFOLLOW` refusing a symlink: report it as the refusal it is.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') return { error: `refusing to write through symlinked usage file ${file}` }
    return { error: describe(error) }
  }
  try {
    // The descriptor is what everything else goes through: the regular-file check
    // and the mode are applied to THAT inode, not to a path.
    const stat = await handle.stat()
    if (!stat.isFile()) return { error: `refusing to write to a non-regular usage file ${file}` }
    if (!(await verifyPinned(pinned, dir, stat, file))) return changed()
    // fchmod THROUGH the descriptor: a path-based chmod could land on a swapped
    // target even after every check above passed.
    await handle.chmod(0o600).catch(() => undefined)
    await handle.write(line)
  } finally {
    await handle.close().catch(() => undefined)
  }
  return { file }
}

/**
 * Is `stat` (the descriptor we are about to write) the file inside the pinned
 * directory? Returns false rather than throwing: callers report a refusal.
 */
async function verifyPinned(
  pinned: PinnedDirectory,
  dir: string,
  stat: { dev: number; ino: number },
  file: string,
): Promise<boolean> {
  // A descriptor-relative open (Linux) already binds the leaf to the pinned
  // inode, so the pathname cannot matter — but the device still must match.
  if (stat.dev !== pinned.dev) return false
  if (process.platform === 'linux') return true
  // Path-based open: the path must STILL be the directory we pinned…
  const now = await fsp.lstat(dir).catch(() => undefined)
  if (now === undefined || now.isSymbolicLink() || now.dev !== pinned.dev || now.ino !== pinned.ino) {
    return false
  }
  // …and the NAME we opened must resolve, right now, to the very inode the
  // descriptor points at. Node exposes no directory-relative read either
  // (`FileHandle.readdir` does not exist, and `/dev/fd/<fd>/x` is not traversable
  // on macOS), so this leg is path-based too — the documented residual race.
  const leaf = await fsp.lstat(file).catch(() => undefined)
  if (leaf === undefined || leaf.isSymbolicLink()) return false
  return leaf.dev === stat.dev && leaf.ino === stat.ino
}

/** Open `file` inside the pinned directory, creating it only after a re-check. */
async function openUsageFile(pinned: PinnedDirectory, dir: string, file: string): Promise<fsp.FileHandle> {
  if (__dirTestHooks.beforeFileOpen !== undefined) await __dirTestHooks.beforeFileOpen(dir)
  const target = leafPath(pinned, file)
  const flags = (fsp.constants.O_WRONLY ?? 0) | (fsp.constants.O_APPEND ?? 0) | O_NOFOLLOW
  try {
    return await fsp.open(target, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  // CREATION is a mutation: re-verify the pin first, so a directory swapped for
  // a symlink cannot even get an empty file planted in its target.
  const now = await fsp.lstat(dir).catch(() => undefined)
  if (now === undefined || now.isSymbolicLink() || now.dev !== pinned.dev || now.ino !== pinned.ino) {
    throw new Error(`refusing to write: the usage directory changed during the append (${dir})`)
  }
  return await fsp.open(target, flags | (fsp.constants.O_CREAT ?? 0), 0o600)
}

/** The leaf's path: descriptor-relative where the platform allows it. */
function leafPath(pinned: PinnedDirectory, file: string): string {
  if (process.platform !== 'linux') return file
  const fd = (pinned.handle as unknown as { fd?: number }).fd
  if (typeof fd !== 'number') return file
  return path.join('/proc/self/fd', String(fd), path.basename(file))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What the rest of an append is bound to: the directory's descriptor plus the
 * identity (dev/ino) it was opened at. The caller owns the descriptor and must
 * close it.
 */
export interface PinnedDirectory {
  handle: fsp.FileHandle
  dev: number
  ino: number
}

const O_NOFOLLOW = fsp.constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = fsp.constants.O_DIRECTORY ?? 0

/**
 * Test-only seams (review round 3, major 1). Production code never sets these;
 * they exist so a test can swap the directory for a symlink at exactly the
 * moment between two syscalls, which is otherwise impossible to reach.
 */
export const __dirTestHooks: {
  beforePinOpen?: (dir: string) => void | Promise<void>
  beforeFileOpen?: (dir: string) => void | Promise<void>
} = {}

/**
 * Open `dir` as a DIRECTORY, never through a symlink, and prove it is one we may
 * protect: a real directory owned by the current uid.
 *
 * This is the pin every other operation goes through (`fchmod` on this
 * descriptor, a descriptor-relative leaf open). `O_NOFOLLOW` makes the kernel
 * refuse a symlink instead of resolving it, so the check-then-use window the
 * earlier `lstat`-then-`chmod` code had is gone.
 */
export async function openPinnedDirectory(dir: string): Promise<PinnedDirectory> {
  if (__dirTestHooks.beforePinOpen !== undefined) await __dirTestHooks.beforePinOpen(dir)
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(dir, (fsp.constants.O_RDONLY ?? 0) | O_DIRECTORY | O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error(`refusing to use the usage directory ${dir}: it is a symlink`)
    if (code === 'ENOTDIR') throw new Error(`refusing to use the usage directory ${dir}: it is not a directory`)
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isDirectory()) {
      throw new Error(`refusing to use the usage directory ${dir}: it is not a directory`)
    }
    // Ownership, not permissions: protecting a directory that belongs to someone
    // else would be changing another user's state directory's mode.
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`refusing to use the usage directory ${dir}: it is owned by uid ${stat.uid}, not ${uid}`)
    }
    return { handle, dev: stat.dev, ino: stat.ino }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * Create `dir` as 0700 if needed, refusing to follow a symlinked directory, and
 * return the pinned descriptor the rest of the append binds to.
 *
 * The mode is applied with `fchmod` on the pinned descriptor: the path-based
 * `chmod` this used to do could be pointed at an unrelated file by swapping the
 * directory for a symlink between the `lstat` and the `chmod` (review round 3).
 */
async function ensureDirectory(dir: string): Promise<PinnedDirectory> {
  if (await isSymlink(dir)) throw new Error(`refusing to use symlinked usage directory ${dir}`)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const pinned = await openPinnedDirectory(dir)
  try {
    // `mkdir`'s mode is filtered by the umask; tighten an existing dir too.
    await pinned.handle.chmod(0o700).catch(() => undefined)
  } catch (error) {
    await pinned.handle.close().catch(() => undefined)
    throw error
  }
  return pinned
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(target)
    return stat.isSymbolicLink()
  } catch {
    return false
  }
}

function expandHome(value: string): string {
  const input = value.trim()
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

/**
 * Read every record from the usage directory whose month is within `days` of
 * `now`, newest month first. Malformed lines (a torn tail, a hand edit) are
 * skipped rather than failing the summary.
 */
export async function readUsage(
  dir: string,
  options: { days: number; now?: Date; graphRoot?: string },
): Promise<UsageRecord[]> {
  const now = options.now ?? new Date()
  const since = now.getTime() - options.days * 24 * 60 * 60 * 1000
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const records: UsageRecord[] = []
  for (const name of names) {
    if (!/^usage-\d{4}-\d{2}\.jsonl$/.test(name)) continue
    let raw: string
    try {
      raw = await fsp.readFile(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A torn trailing line is expected: a crash mid-append.
        continue
      }
      const record = parsed as UsageRecord
      if (record === null || typeof record !== 'object' || typeof record.ts !== 'string') continue
      const at = Date.parse(record.ts)
      if (Number.isNaN(at) || at < since) continue
      // A summary is about the graph being served: another graph's spend is not
      // this user's answer.
      if (options.graphRoot !== undefined && record.graphRoot !== options.graphRoot) continue
      records.push(record)
    }
  }
  return records.sort((left, right) => right.ts.localeCompare(left.ts))
}

/** Token totals for one authority, plus whether anything reported them. */
interface Totals {
  calls: number
  withTokens: number
  /** Records marked `partial`: their numbers are real but may be incomplete. */
  partial: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

function emptyTotals(): Totals {
  return { calls: 0, withTokens: 0, partial: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function accumulate(target: Totals, record: UsageRecord): void {
  target.calls += 1
  if (record.usageStatus === 'partial') target.partial += 1
  const tokens = record.tokens
  if (tokens === null || tokens === undefined) return
  target.withTokens += 1
  target.input += tokens.input ?? 0
  target.output += tokens.output ?? 0
  target.reasoning += tokens.reasoning ?? 0
  target.cacheRead += tokens.cacheRead ?? 0
  target.cacheWrite += tokens.cacheWrite ?? 0
}

/**
 * Render one authority's token line.
 *
 * **Unknown is never printed as zero** (Lane B review #10). If no call reported
 * tokens, the line says so rather than "in 0 / out 0"; if only some did, the
 * total is marked a LOWER BOUND, because the missing calls could be anything.
 */
function tokenLine(label: string, totals: Totals): string {
  if (totals.calls === 0) return `${label}: no calls`
  if (totals.withTokens === 0) return `${label}: no token data (${totals.calls} call${totals.calls === 1 ? '' : 's'})`
  const sum = totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite
  const details: string[] = []
  if (totals.reasoning > 0) details.push(`reasoning ${totals.reasoning}`)
  if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
    details.push(`cache read ${totals.cacheRead} / write ${totals.cacheWrite}`)
  }
  // A LOWER BOUND whenever any contributing call is incomplete — either it
  // reported no tokens at all, or it is `partial` (a timed-out capture can omit
  // usage that happened after its last event). Review #2-7: a single partial
  // record used to print an exact-looking total.
  const missing = totals.calls - totals.withTokens
  const inexact = missing > 0 || totals.partial > 0
  const bound = inexact ? '≥' : ''
  const notes: string[] = []
  if (missing > 0) notes.push(`${missing} without data`)
  if (totals.partial > 0) notes.push(`${totals.partial} partial`)
  const coverage = notes.length === 0 ? '' : `, ${notes.join(', ')}`
  return `${label}: in ${totals.input} / out ${totals.output}${
    details.length === 0 ? '' : ` (${details.join(', ')})`
  }, ${bound}${sum} total${coverage}`
}

/**
 * The one-line summary `/mexplore usage` prints (Lane B item 4, review #10).
 *
 * Call counts and TOKEN totals are separate facts, and each authority gets its
 * own token total — "read 3 / manage 1" used to be the only read/manage figure,
 * which said nothing about where the tokens went. Coverage is spelled out, so a
 * missing number reads as missing and never as zero.
 */
export function summarizeUsage(records: readonly UsageRecord[], days: number): string {
  if (records.length === 0) {
    return `mexplore usage (last ${days} days): no calls recorded.`
  }
  const read = emptyTotals()
  const manage = emptyTotals()
  const all = emptyTotals()
  let partial = 0
  let unknown = 0
  let cost = 0
  let costKnown = false
  for (const record of records) {
    accumulate(record.authority === 'manage' ? manage : read, record)
    accumulate(all, record)
    if (record.usageStatus === 'partial') partial += 1
    if (record.usageStatus === 'unknown') unknown += 1
    // Only counted when a real price produced it: `$0` from "no pricing" is not
    // spend, and the contract forbids presenting it as such.
    if (record.costUsd !== null && record.costUsd !== undefined) {
      cost += record.costUsd
      costKnown = true
    }
  }
  const calls = `mexplore usage (last ${days} days): ${records.length} call${records.length === 1 ? '' : 's'}`
    + ` (read ${read.calls}, manage ${manage.calls})`
  const parts = [calls, tokenLine('read tokens', read), tokenLine('manage tokens', manage)]
  if (read.calls > 0 && manage.calls > 0) parts.push(tokenLine('all tokens', all))
  if (partial > 0) parts.push(`partial ${partial}`)
  if (unknown > 0) parts.push(`unknown ${unknown}`)
  if (costKnown) parts.push(`cost $${cost.toFixed(4)}`)
  return `${parts.join(' · ')}.`
}
