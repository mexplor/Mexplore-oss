// GENERATED from mexplore_graph/src/graph.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * Filesystem memory graph: directories are Nodes, symlinks are Edges.
 *
 * This is the same on-disk contract the `bin/` shell helpers implement
 * (ULID node directories, `node.md` frontmatter, `__edges__/<dst>` symlinks
 * pointing at `../../<dst>` — a plain edge is ONE logical edge stored as a
 * symlink in BOTH node dirs, only supersedes/follows-from stay one-way (F54,
 * #90) — append-only access logs under `.access/`, and a one-deep
 * `.node.md.prev` snapshot of the last body-changing rewrite). Writes stage
 * and rename so a Node or a `node.md` is never observable half-written.
 *
 * @module dsh-mexplore/graph
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Crockford base32, the ULID alphabet: no I, L, O, or U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A node id is exactly 26 Crockford base32 characters. Also blocks path traversal. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Reject anything that is not a well-formed node id before it reaches a filesystem path. */
export function assertId(id, label = 'node id') {
  if (typeof id !== 'string' || !ULID_RE.test(id)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(id)}`)
  }
  return id
}

/** A lock older than this is assumed abandoned by a crashed reader or writer (ADR-0013, F68/#126). */
export const STALE_LOCK_MS = 30_000

const LOCK_POLL_MS = 25

/**
 * Test-only fault injection (F68, #132): SIGKILL this process when the
 * harness names this exact point. Production pays only one string compare
 * against an environment variable that is normally unset.
 */
export function crashAt(label) {
  if (process.env.MEMGRAPH_CRASH_AT === label) process.kill(process.pid, 'SIGKILL')
}

/**
 * Run one critical section while holding every requested per-Node access lock.
 * ADR-0013 uses atomic lock-directory creation so shell writers and JS readers
 * and writers share one dependency-free protocol (F68, #126). Sorting unique
 * ids prevents multi-Node callers from deadlocking; stale directories are the
 * crash-recovery tradeoff, safe because these single-Node access sections
 * normally last only milliseconds. Acquisition cleanup and reverse-order
 * release live here so a caller cannot leak a lock when its critical section
 * throws.
 *
 * @param root - graph root containing the shared `.locks/` directory.
 * @param ids - Node ids whose access the critical section guards.
 * @param fn - async critical section, called only after every lock is held.
 * @returns whatever `fn` returns.
 */
export async function withNodeLocks(root, ids, fn) {
  if (!Array.isArray(ids)) throw new Error('node ids must be an array')
  const ordered = [...new Set(ids.map((id) => assertId(id)))].sort()
  const lockRoot = path.join(root, '.locks')
  const acquired = []
  await fsp.mkdir(lockRoot, { recursive: true })
  try {
    for (const id of ordered) {
      const lockDir = path.join(lockRoot, `${id}.lock`)
      for (;;) {
        try {
          await fsp.mkdir(lockDir)
          acquired.push(lockDir)
          break
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          try {
            const stat = await fsp.stat(lockDir)
            if (Date.now() - stat.mtime.getTime() > STALE_LOCK_MS) {
              try {
                await fsp.rmdir(lockDir)
              } catch (removeError) {
                if (removeError.code !== 'ENOENT') throw removeError
              }
            }
          } catch (statError) {
            if (statError.code !== 'ENOENT') throw statError
          }
          await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
        }
      }
    }
    crashAt('held-lock-before-write')
    return await fn()
  } finally {
    let releaseError
    for (const lockDir of acquired.reverse()) {
      try {
        await fsp.rmdir(lockDir)
      } catch (error) {
        releaseError ??= error
      }
    }
    if (releaseError !== undefined) throw releaseError
  }
}

/**
 * Mint a ULID: 10 characters of millisecond timestamp, 16 of randomness.
 * @param now - epoch milliseconds to encode.
 * @returns the 26-character id.
 */
export function ulid(now = Date.now()) {
  let num = Math.floor(now)
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[num % 32] + out
    num = Math.floor(num / 32)
  }
  for (const byte of randomBytes(16)) out += CROCKFORD[byte % 32]
  return out
}

/**
 * The memory-type taxonomy (F14, #23). An optional `type:` frontmatter line
 * classifies a node so downstream policy (staleness, supersede rules, dating)
 * can differ by kind. Absent is always valid; a present value must be one of
 * these.
 */
export const NODE_TYPES = ['identity', 'preference', 'decision', 'gotcha', 'journal', 'thread', 'trivia', 'handoff']

/**
 * The edge-type taxonomy (F3, #12). An optional type names *why* the edge
 * exists so downstream reasoning can tell "supersedes" from a mere "relates-to".
 * The type is stored out-of-band in a per-node sidecar (see {@link edgeTypes})
 * so an untyped edge stays byte-identical to what it always was.
 */
export const EDGE_TYPES = ['supersedes', 'relates-to', 'follows-from']

/**
 * The types whose DIRECTION carries meaning (F54, #90). A `supersedes` or
 * `follows-from` edge stays a single one-way symlink plus a sidecar line on
 * its source — inverting either would state the opposite of what was stored.
 * Everything else — a plain untyped edge, and `relates-to` — is symmetric:
 * one logical edge stored as two symlinks, one in each node's `__edges__/`.
 * The v3 dossier replays showed writers cannot pick a direction consistently
 * (reverse-dup pairs in 3/4 sessions), so an arrow on a plain edge was noise
 * pretending to be signal; storing the pair by construction kills the
 * reverse-dup class outright and makes "what points here" a directory read.
 */
export const DIRECTED_EDGE_TYPES = ['supersedes', 'follows-from']

/**
 * The Node ids whose `.edge-types` sidecars a typed {@link addEdge} call may
 * rewrite. Untyped edges touch symlinks only; directed types write the source
 * and may clear a stale symmetric line on the peer; symmetric types have one
 * canonical owner, the lexicographically smaller endpoint.
 */
export function edgeSidecarOwners(src, dst, type) {
  if (type === undefined) return []
  if (DIRECTED_EDGE_TYPES.includes(type)) return [src, dst]
  return [src < dst ? src : dst]
}

/**
 * Validate an edge type. Unlike node types there is no "absent" sentinel here:
 * an edge with no type simply has no sidecar line, so this is only ever called
 * with a value the caller intends to store, and a non-enum value throws loudly.
 */
export function assertEdgeType(type) {
  if (typeof type !== 'string' || !EDGE_TYPES.includes(type)) {
    throw new Error(`edge type must be one of ${EDGE_TYPES.join('|')} (got ${JSON.stringify(type)})`)
  }
  return type
}

/** Frontmatter keys this layer owns; every other key is preserved verbatim. */
const KNOWN_KEYS = new Set(['description', 'created', 'updated', 'type'])

/** Split `node.md` into its frontmatter fields and its body. */
export function parseNode(text) {
  const lines = text.split('\n')
  const fields = {}
  // Frontmatter keys this layer does not own, kept as `[key, value]` pairs in
  // their original order so a round-trip through render never drops what an
  // agent or shell wrote (e.g. a `type:` line, or any future field).
  const extra = []
  let body = text
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const at = line.indexOf(':')
        if (at > 0) {
          const key = line.slice(0, at).trim()
          const value = line.slice(at + 1).trim()
          if (KNOWN_KEYS.has(key)) fields[key] = value
          else extra.push([key, value])
        }
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  return { description: fields.description ?? '', created: fields.created ?? '', updated: fields.updated ?? '', type: fields.type ?? '', extra, body: body.replace(/^\n+/, '') }
}

/**
 * Render `node.md` from its fields. `description` must already be a single line.
 * `updated` is emitted only when set, so a node that was never revised (and one
 * written by `bin/node-new`, which omits it) stays free of an empty field.
 * `extra` carries frontmatter keys this layer does not own; they are re-emitted
 * after the known keys, in their original order, so a write never drops them.
 */
export function renderNode({ description, created, updated, type, extra, body }) {
  const revised = updated ? `\nupdated: ${updated}` : ''
  const typed = type ? `\ntype: ${type}` : ''
  const rest = (extra ?? []).map(([key, value]) => `\n${key}: ${value}`).join('')
  return `---\ndescription: ${description}\ncreated: ${created}${revised}${typed}${rest}\n---\n\n${body ?? ''}`
}

/**
 * Validate an optional memory type. Absent (undefined, null, or empty string)
 * is allowed and returns `undefined` — the caller then writes no `type:` line.
 * A present value must be one of {@link NODE_TYPES}, else this throws loudly.
 */
function assertType(type) {
  if (type === undefined || type === null || type === '') return undefined
  if (typeof type !== 'string' || !NODE_TYPES.includes(type)) {
    throw new Error(`type must be one of ${NODE_TYPES.join('|')} (got ${JSON.stringify(type)})`)
  }
  return type
}

/**
 * The pairs one layer of unescaping resolves. Anything else after a backslash
 * — `\d` in a regex, a Windows path, a LaTeX macro — is left as the two
 * characters it arrived as: this undoes one escaping layer, it does not parse
 * a string literal.
 */
const ESCAPE_PAIRS = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

/**
 * Every character that ends a line for someone: LF, a bare CR (still a line
 * break to a Mac-classic-era writer and to half of what reads node.md), and
 * U+2028/2029, which terminate a line on the JS side. One definition, because
 * the two places that ask "is this really one line?" — the description guard
 * and {@link normalizeBody}'s trigger — must agree.
 */
const LINE_SEPARATOR = /[\r\n\u2028\u2029]/

/**
 * Undo one layer of escaping on a body the model meant as multi-line text
 * (F63, #108). The dossier replay of 2026-08-25 stored `原话："…"\n\n- 最卡的是…`
 * as literal backslash-n characters — the model emitted an escaped string and
 * every read since renders the noise.
 *
 * The trigger is the COMBINATION, never a literal `\n` on its own: escapes
 * present AND not one real newline in the whole body is a multi-line string
 * that arrived escaped. A body that legitimately discusses `\n` is prose about
 * it, and prose has line breaks of its own — so the regression case (a
 * multi-line body quoting `\n` as text) never matches and is stored verbatim.
 *
 * Tab escapes ride along with that newline evidence rather than triggering on
 * their own: a body with `\t` and no `\n` is one line either way, so real tabs
 * buy nothing, while "a Makefile needs a real tab, not \t" is a gotcha worth
 * keeping exactly as written.
 *
 * Only INTERIOR newlines count as that evidence: a trailing (or leading) one
 * is whitespace the caller's string happened to carry, not structure, and it
 * must not shield the rest of the body from the repair. "Newline" is every
 * {@link LINE_SEPARATOR} and not LF alone (codex review of #111): a body
 * broken on bare CRs is already multi-line prose, so a literal `\n` it
 * discusses must not read as an escaped payload and be rewritten — this
 * repair is not reversible.
 *
 * Exactly one layer comes off, so a doubly-escaped `\\n` unescapes to the two
 * characters `\n` rather than to a line break. That also makes this NOT
 * idempotent by design — decode once, at the moment a body is persisted.
 *
 * Accepted false positive (codex review of this change): a body that is ONE
 * line and quotes `\n` as syntax — `write \n in the config` — reads exactly
 * like an escaped two-line body, and this repairs it. The single line is the
 * whole ambiguity; anything with prose around the escape keeps its own breaks
 * and is left alone, and bulk verbatim payloads belong in an attachment, which
 * this never touches.
 */
export function normalizeBody(body) {
  if (typeof body !== 'string' || LINE_SEPARATOR.test(body.trim()) || !body.includes('\\n')) return body
  return body.replace(/\\(.)/g, (pair, char) => ESCAPE_PAIRS[char] ?? pair)
}

/**
 * The one-line description rule, as a PURE predicate (#253).
 *
 * Exported because the plugin's trusted preparation enforces the same rule
 * before its handler runs: a description the storage layer rejects is a pure
 * shape error, and letting it throw from `createNode`/`updateNode` made it
 * indistinguishable — to every receipt — from a failure that may already have
 * written. That is the manage fence's unknown outcome, i.e. quarantine. This
 * function is the single authority for the rule; {@link assertDescription}
 * throws from it, so the two cannot drift.
 *
 * No graph, filesystem, session, clock or config read — string reasoning only.
 *
 * @param description - the raw `description` argument.
 * @returns the violation text, or undefined when the description is admissible.
 */
export function descriptionProblem(description) {
  if (typeof description !== 'string' || description.trim().length === 0) {
    return 'description must be a non-empty string'
  }
  // Every character that would break the one-line frontmatter field, not just
  // LF (codex review of this change): a bare CR splits the line for half the
  // readers of node.md, and U+2028/2029 do for the JS side.
  if (LINE_SEPARATOR.test(description)) return 'description must be a single line (no newlines)'
  // The escaped-string defect {@link normalizeBody} repairs, in the one field
  // that cannot be repaired: a description has no real newlines to weigh the
  // escape against, so nothing here distinguishes an escaped line break from a
  // description that means those two characters. Reject instead of guessing —
  // the escape is noise in every index row and search hit it renders into, and
  // a named error is what the model retries against.
  if (/\\[nrt]/.test(description)) {
    return 'description carries a literal escape sequence (\\n, \\r or \\t) — pass the line as real text; if the characters themselves are the point, name them in words and keep the detail in the body'
  }
  const trimmed = description.trim()
  // The description is rendered into every session prompt via the index — an
  // unbounded one lets a single node bloat every future context.
  if (trimmed.length > 500) return `description too long (${trimmed.length} chars, max 500) — put detail in the body`
  return undefined
}

/** A description is one frontmatter line, so newlines are rejected rather than escaped. */
function assertDescription(description) {
  const problem = descriptionProblem(description)
  if (problem !== undefined) throw new Error(problem)
  return description.trim()
}

/**
 * Today as `YYYY-MM-DD` in the machine's own timezone, matching what
 * `bin/node-new` writes (`date +%Y-%m-%d`, always local). A UTC slice used to
 * stand in for this and disagreed with the shell helper — and with the user —
 * for the hours either side of local midnight: at 00:30 in UTC+8 it dated
 * everything yesterday, which is the exact one-day-off failure ledger #20 is
 * about.
 */
export function today(now = Date.now()) {
  const at = new Date(now)
  // A UTC ISO slice used to throw on a bad timestamp; keep that fail-fast rather
  // than persisting `NaN-NaN-NaN` into frontmatter, banners and merge provenance.
  if (Number.isNaN(at.getTime())) throw new Error(`invalid timestamp: ${JSON.stringify(now)}`)
  const pad = (part, width = 2) => String(part).padStart(width, '0')
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The weekday of a `YYYY-MM-DD` stamp, as an English day name. F67 (#121): the
 * model resolves weekday-name phrases ("上周四", "next Wednesday") off by one
 * when it has to guess the anchor's weekday — QA pass 7 measured +1 on 3 of 3
 * weekday-name resolutions while plain offsets were correct 3/3. Annotating
 * the anchors removes the guess. Date-only arithmetic in UTC on purpose: the
 * stamp is a calendar day, not an instant, so no timezone may shift it.
 */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export function weekdayName(stamp) {
  const parsed = Date.parse(`${stamp}T00:00:00Z`)
  // Round-trip, not just NaN: V8 normalizes an impossible ISO day into the
  // next month ('2026-02-30' → March 2nd) instead of rejecting it, so a bare
  // NaN check would hand back a confident weekday for a date that does not
  // exist — the codex catch on #123, and the same guard contextDate uses.
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== stamp) {
    throw new Error(`invalid calendar date: ${JSON.stringify(stamp)}`)
  }
  return WEEKDAY_NAMES[new Date(parsed).getUTCDay()]
}

/**
 * Parse a `YYYY-MM-DD` stamp back into the local calendar day {@link today}
 * wrote. `Date.parse` reads a bare date as UTC midnight, which drifts against a
 * locally-stamped date by the machine's offset — small against a 180-day
 * recency window, but wrong, and unbounded as the window shrinks. Anything not
 * of that exact shape yields `NaN`, which callers treat as "no date".
 */
export function parseCalendarDate(stamp) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof stamp === 'string' ? stamp.trim() : '')
  if (!parts) return Number.NaN
  // setFullYear, not the constructor: `new Date(1, ...)` means 1901, so a
  // four-digit stamp under year 100 would score as the 1900s.
  const at = new Date(2000, Number(parts[2]) - 1, Number(parts[3]))
  at.setFullYear(Number(parts[1]))
  return at.getTime()
}

/**
 * Longest name a SIBLING file may have — a path `<dir>/<name>` derived from an
 * existing attachment's own name (`.<name>.prev` for the snapshot, a
 * `.<name>.tmp-…` staging file for an atomic write). `NAME_MAX` is 255 bytes on
 * ext4 and APFS, so 200 leaves room for the suffixes below and for a filesystem
 * that reserves a few bytes of its own. The bound exists because the derivation
 * ADDS bytes: a 255-byte attachment name (legacy, or written out of band) plus
 * `.prev` is 260 bytes and `ENAMETOOLONG` — which made exactly the file the
 * snapshot exists to protect the one file that could not be replaced (#255).
 */
const SIBLING_NAME_MAX_BYTES = 200

/**
 * Namespace for the BOUNDED derivations, and the reason they cannot collide with
 * a plain one (#255 review 1).
 *
 * A plain derivation is always `.` + `<name>` + suffix, and
 * {@link assertAttachmentName} forbids a name that starts with a dot — so a path
 * beginning with TWO dots is unreachable by any plain derivation. That
 * disjointness is load-bearing, not cosmetic: with hashed names built as
 * `.` + truncated-head + `~` + hash + `.prev`, the 196-byte name `a` and the
 * 194-byte name `b = prevAttachmentFile(a).slice(1, -5)` produced the SAME
 * snapshot path, so overwriting both left one file's recovery copy holding the
 * other's prior bytes. Hashed names now carry no caller-controlled prefix at
 * all, only `..attach-prev-<hash>.prev` / `..attach-tmp-<hash>-<pid>-<nonce>`.
 */
const DERIVED_NAME_PREFIX = '..attach-'

/** A short, stable digest of an attachment name, for a bounded derived name. */
function nameDigest(name) {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The staging sibling {@link writeAtomic} writes before renaming into place.
 * Bounded by {@link SIBLING_NAME_MAX_BYTES} rather than derived verbatim from
 * the target's name: a long attachment must stay overwritable, and the plain
 * `.${name}.tmp-…` form pushed a 255-byte name past `NAME_MAX` (#255). A name
 * that fits keeps the readable form; a long one moves into the two-dot
 * {@link DERIVED_NAME_PREFIX} namespace, where no plain form can reach it.
 */
function atomicStagingFile(file) {
  const base = path.basename(file)
  const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`
  if (Buffer.byteLength(base, 'utf8') <= SIBLING_NAME_MAX_BYTES - 1 - Buffer.byteLength(`.tmp-${nonce}`, 'utf8')) {
    return path.join(path.dirname(file), `.${base}.tmp-${nonce}`)
  }
  return path.join(path.dirname(file), `${DERIVED_NAME_PREFIX}tmp-${nameDigest(base)}-${nonce}`)
}

/** Write `file` by staging a sibling temp file and renaming it into place. */
async function writeAtomic(file, content) {
  const tmp = atomicStagingFile(file)
  // The staging write is INSIDE the cleanup scope, like attachFromPath's: a
  // write the filesystem refuses late (ENOSPC, ENAMETOOLONG) must not leave a
  // partial `.tmp-*` in the node directory (#255).
  try {
    await fsp.writeFile(tmp, content, 'utf8')
    crashAt('writeatomic-before-rename')
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }
}

/** Where `graph-maintain --apply` moves archived Nodes; siblings of the live graph. */
export const ARCHIVE_DIR = '.archive'

/**
 * Where per-node access bookkeeping lives (F57, #93): `<root>/.access/<id>.log`,
 * one graph-level dot-directory instead of a file inside each node dir. The old
 * in-node `accessed.log` masqueraded as an attachment to every consumer that
 * lists node files — the dossier replay harness reported it under `files` on
 * every node that was ever read, corrupting attachment counts for exactly the
 * most-used nodes. The line format (`<dst-id> <ISO-8601Z>` per line) and every
 * ranking signal built on the log are unchanged; only the address moved.
 */
export const ACCESS_DIR = '.access'

/** The access log of one node under the current layout. */
function accessLogFile(root, id) {
  return path.join(root, ACCESS_DIR, `${id}.log`)
}

/**
 * One node's access-log lines, merged across the current location and the
 * legacy in-node `accessed.log` (F57, #93). Readers take both so a graph
 * written before the move ranks exactly as it did — `graph-maintain --apply`
 * consolidates legacy files into `.access/`, but no reader waits for that.
 * `legacyDir` is the node's own directory (live, or under `.archive/`), where
 * the old layout kept the log. Sync reads on purpose — same trade as loadAll.
 */
function readAccessLines(root, id, legacyDir) {
  const lines = []
  for (const file of [accessLogFile(root, id), path.join(legacyDir, 'accessed.log')]) {
    let log
    try {
      log = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    lines.push(...log.split('\n'))
  }
  return lines
}

/**
 * The per-node write-provenance logs (issue #317): `<root>/.provenance/<id>.jsonl`,
 * one JSON object per line, append-only. Out-of-node like `.access/` on purpose
 * — node directories hold content a reader shows, and this is bookkeeping about
 * WHO wrote it, never part of the node. Nothing prunes these files and nothing
 * ranks by them; a node keeps its log through archive, restore and merge.
 */
export const PROVENANCE_DIR = '.provenance'

/**
 * Append a block of lines to one node's file under a graph-level bookkeeping
 * directory, creating the directory on first use. Generalized from the access
 * log so both write the same way:
 *
 *   - the id is validated by {@link ULID_RE} before it reaches a path (no
 *     traversal, no filename that is not a node);
 *   - a symlinked directory, or a symlinked leaf, is refused rather than
 *     followed, so a planted link cannot redirect bookkeeping outside the graph
 *     (or expose a session id to a file the graph does not own);
 *   - every line goes out in ONE write on ONE descriptor, so a concurrent
 *     writer's lines can never land inside this call's block.
 *
 * Lock-free by contract: `withNodeLocks` is deliberately non-reentrant, and a
 * bookkeeping append must never be able to deadlock a write it describes.
 */
async function appendBookkeeping(root, dir, id, lines, suffix = '.log') {
  assertId(id)
  if (lines.length === 0) return
  const folder = path.join(root, dir)
  const file = path.join(folder, `${id}${suffix}`)
  await fsp.mkdir(folder, { recursive: true })
  // The DIRECTORY: `mkdir` recursed first, so a planted link is now the thing
  // on disk to judge. lstat (never stat) sees the link itself, and the realpath
  // check pins it to `<root>/<dir>` — a link swapped in after the lstat but
  // before the open is a window this cannot close without openat emulation
  // (see the note on the open below); failures are caught by the tool layer.
  const dirStat = await fsp.lstat(folder)
  if (!dirStat.isDirectory()) throw new Error(`refusing to append into a non-directory: ${folder}`)
  if ((await fsp.realpath(folder)) !== path.join(await fsp.realpath(root), dir)) {
    throw new Error(`refusing to append through a redirecting directory: ${folder}`)
  }
  // The LEAF: opened with O_NOFOLLOW so a symlink at the final component is
  // refused at open time rather than followed; O_NONBLOCK so a FIFO planted in
  // the slot cannot block the open while a mutation that already landed waits
  // on it. The DESCRIPTOR is then fstat'd and must be a regular file — the same
  // defensive pattern `attachFromPath` uses on the source it reads — because
  // O_NONBLOCK alone only stops the block, and a reader on the other end would
  // send the block through a pipe instead of storing it. O_APPEND keeps the
  // block one write. Anything but a regular file is closed and refused, and the
  // tool layer turns that into one stderr warning.
  //
  // Residual, documented rather than papered over: a directory component
  // swapped between the realpath check above and this open is not closed here —
  // closing it needs openat-style emulation, and the exposure is a link a local
  // process must already be able to plant inside the graph root.
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  const handle = await fsp.open(file, flags, 0o666)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error(`refusing to append into a non-regular file: ${file}`)
    await handle.writeFile(lines.join(''), 'utf8')
  } finally {
    await handle.close()
  }
}

/** Append one `<dst> <ts>` line to a node's access log, creating `.access/` on first use. */
async function appendAccess(root, id, line) {
  await appendBookkeeping(root, ACCESS_DIR, id, [line])
}

/**
 * Record what one tool call did to one node (reviews of #317): the owning root
 * chat session, the operation, and the peer/file it touched. `records` are the
 * plain line objects of the v1 schema; each is stringified here so callers
 * never spell JSON themselves, and one append carries the whole block.
 *
 * Throws on a bad id or a symlinked log — the tool layer catches and warns,
 * because a write that already landed must never fail over its bookkeeping.
 */
export async function appendProvenance(root, id, records) {
  if (!Array.isArray(records) || records.length === 0) return
  await appendBookkeeping(root, PROVENANCE_DIR, id, records.map((record) => `${JSON.stringify(record)}\n`), '.jsonl')
}

/** Every node id present in the graph, in directory order. */
export async function listIds(root) {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries.filter((e) => e.isDirectory() && ULID_RE.test(e.name)).map((e) => e.name)
}

/** Load one node's `node.md`, or `undefined` when the node does not exist. */
export async function loadNode(root, id) {
  assertId(id)
  try {
    return parseNode(await fsp.readFile(path.join(root, id, 'node.md'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Every node with its parsed content, skipping unreadable entries. */
export async function loadAll(root) {
  const ids = await listIds(root)
  // Sync reads on purpose: one threadpool round-trip per node makes the async
  // path ~25x slower at thousands of nodes (1.3s vs 50ms at 5k). Blocking the
  // event loop for tens of milliseconds is the better trade for a single-user
  // agent process. ponytail: revisit with a persistent index if graphs reach 50k.
  const nodes = []
  for (const id of ids) {
    try {
      nodes.push({ id, ...parseNode(fs.readFileSync(path.join(root, id, 'node.md'), 'utf8')) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return nodes
}

/**
 * Every archived node with its parsed content, each tagged `archived: true`.
 * Reads `$GRAPH_ROOT/.archive/` — a directory that only exists once something
 * has been pruned, so a graph that never archived returns `[]` at no I/O cost
 * beyond one `readdir`. Only search reaches for these, and only when asked.
 */
export async function loadArchived(root) {
  const base = path.join(root, ARCHIVE_DIR)
  let entries
  try {
    entries = await fsp.readdir(base, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  // Sync reads on purpose — same trade as loadAll.
  const nodes = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ULID_RE.test(entry.name)) continue
    try {
      nodes.push({ id: entry.name, archived: true, ...parseNode(fs.readFileSync(path.join(base, entry.name, 'node.md'), 'utf8')) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return nodes
}

/**
 * Move an archived Node back into the live graph, the recovery path for a
 * memory that pruning set aside. A plain `mv` is the whole operation: the
 * Node's own outgoing symlinks resolve again once its depth is restored, and
 * any that still dangle (target gone or itself archived) stay dangling exactly
 * as {@link readNode} already labels them. Restoring an id that is not archived
 * — an active node, or nothing at all — is an error, since there is nothing to
 * recover; the ULID guard also blocks path traversal before any fs path forms.
 */
export async function restoreNode(root, id) {
  assertId(id)
  const from = path.join(root, ARCHIVE_DIR, id)
  const to = path.join(root, id)
  let archived = false
  try {
    archived = (await fsp.stat(from)).isDirectory()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!archived) throw new Error(`node is not archived: ${id}`)
  // Never clobber a live node that already holds this id.
  let occupied = true
  try {
    await fsp.access(to)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    occupied = false
  }
  if (occupied) throw new Error(`cannot restore ${id}: a live node with this id already exists`)
  await fsp.rename(from, to)
  // A restored node's access history is by definition stale — that is why it
  // was archived. Record the restore as a fresh self-access so the very next
  // `graph-maintain --apply` does not immediately archive it again.
  //
  // Access bookkeeping — a restore whose touch cannot be logged is not a failed
  // restore; the next graph-maintain --apply may re-archive it. Same posture as
  // `memory_read`'s own touch (index.js). The rename above stays the LAST
  // fallible step of the restore itself.
  try {
    await touchRead(root, id)
  } catch { /* best-effort; the node is live either way */ }
}

/**
 * Whether `<root>/<src>/__edges__/<name>` is an edge. An edge is exactly what
 * addEdge writes: a symlink named by a node id whose target is `../../<name>`
 * (ADR-0001, ADR-0012). Anything else under that name — a directory, a regular
 * file, a symlink pointing anywhere else — is NOT an edge: every reader skips
 * it, so the engine, `graph-maintain` and the graph panel count the same
 * edges, and `graph-maintain` reports it (`--apply` repairs an empty one). A
 * well-formed symlink whose target node is gone still is an edge: a dangling
 * one, which readNode marks and `graph-maintain` reports separately.
 */
export function isEdgeEntrySync(root, src, name) {
  if (!ULID_RE.test(name)) return false
  try {
    return fs.readlinkSync(path.join(root, src, '__edges__', name)) === `../../${name}`
  } catch {
    // EINVAL: not a symlink. ENOENT: removed since the listing.
    return false
  }
}

/** Async form of {@link isEdgeEntrySync}. */
export async function isEdgeEntry(root, src, name) {
  if (!ULID_RE.test(name)) return false
  try {
    return (await fsp.readlink(path.join(root, src, '__edges__', name))) === `../../${name}`
  } catch {
    return false
  }
}

/** Outgoing edge ids of one node: the edge symlinks under `__edges__/` (see isEdgeEntrySync). */
export async function outEdges(root, id) {
  let entries
  try {
    entries = await fsp.readdir(path.join(root, id, '__edges__'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const names = entries.filter((name) => ULID_RE.test(name))
  const ok = await Promise.all(names.map((name) => isEdgeEntry(root, id, name)))
  return names.filter((_name, i) => ok[i])
}

/**
 * Non-reserved files a node carries, so an agent can see its own attachments.
 * `accessed.log` is excluded even though the framework no longer writes it
 * there (F57, #93): a legacy graph may still hold one until `graph-maintain
 * --apply` migrates it, and bookkeeping must never masquerade as an attachment.
 */
export async function extraFiles(root, id) {
  try {
    const entries = await fsp.readdir(path.join(root, id), { withFileTypes: true })
    return entries.filter((e) => !e.isDirectory() && e.name !== 'node.md' && e.name !== 'accessed.log' && !e.name.startsWith('.')).map((e) => e.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Names a node directory reserves for the framework — an attachment may never
 * claim one. `__edges__/` is a directory (attachments are always files, so it
 * cannot collide in practice) but is listed for a clear error if one is tried;
 * `MAP.md` is only reserved at `$GRAPH_ROOT`, blocked inside nodes too so the
 * name never carries a misleading meaning.
 */
// Kept lowercase and compared case-insensitively: on a case-insensitive
// filesystem (default macOS APFS) `NODE.md` aliases `node.md`, so a case
// variant would silently overwrite framework-owned data. `accessed.log` stays
// reserved even though access logs now live in `.access/` (F57, #93): a legacy
// graph may still hold the in-node file, and an attachment wearing its name
// would be hidden by the listing exclusions either way.
export const RESERVED_FILES = new Set(['node.md', 'accessed.log', '__edges__', 'map.md'])

/**
 * Cap on an attachment's byte size. Set well above the 50k body-render window
 * (finding #4) on purpose: an attachment exists precisely to hold transcripts
 * and long summaries that a node body should not carry, so mirroring the render
 * cap as a *storage* cap would make attachments strictly less capable than the
 * body they offload. This is a storage ceiling that bounds any single write so
 * no one tool call can dump an unbounded file into the graph; the 50k render
 * precedent still governs *display* — a node view shows only a one-line summary
 * per attachment, never the whole file.
 */
export const ATTACH_MAX_BYTES = 512 * 1024

/** How much of an attachment we read to summarize it — one short line, no more. */
const ATTACH_SUMMARY_BYTES = 200

/**
 * Validate an attachment file name: a plain basename, never a path, a dotfile,
 * or a reserved framework name. Rejecting path separators and `..` blocks
 * traversal out of the node directory before any filesystem path is built; the
 * leading-dot rule keeps attachments out of the dot-prefixed space `extraFiles`
 * hides (staging temp files live there).
 */
export function assertAttachmentName(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('filename must be a non-empty string')
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`filename must be a plain name with no path separators: ${JSON.stringify(name)}`)
  }
  if (name === '.' || name === '..') throw new Error('filename must not be "." or ".."')
  if (name.startsWith('.')) throw new Error(`filename must not start with a dot: ${JSON.stringify(name)}`)
  // Deliberately narrow, and NOT folded (#255 review 2): this function also
  // gates every READ, where a file that is legitimately distinct on a
  // case-sensitive filesystem (Linux) must stay readable — `acceſſed.log` is a
  // real, separate file there. The broader fold belongs to
  // {@link agentAttachmentNameViolation}, which gates WRITES only.
  if (RESERVED_FILES.has(name.toLowerCase())) throw new Error(`filename is reserved by the framework: ${name}`)
  return name
}

/**
 * The comparison key two attachment-name spellings share when a case- and
 * normalization-insensitive filesystem resolves them to ONE file (default APFS;
 * HFS+ likewise). Names must be compared through it, never with `toLowerCase()`
 * alone: `toLowerCase` misses the folds that change a character's identity —
 * LONG S (U+017F, `ſ`) uppercases to `S`, so `obſervation.txt` is the SAME inode
 * as `observation.txt` while being a different string — and it misses canonical
 * equivalence, where a composed and a decomposed spelling are the same file.
 *
 * The mapping is deliberately generous: canonical decomposition (NFD), then a
 * full upper/lower round-trip (which also folds KELVIN SIGN, U+212A, to `k`
 * through its canonical `K`), then NFD again. Over-folding can only REFUSE a
 * name the filesystem would have kept distinct — the safe direction, since the
 * caller's remedy is to rename — while under-folding is the data-loss direction
 * this exists to close.
 *
 * WRITE-SIDE ONLY (#255 review 2). {@link assertAttachmentName} keeps its narrow
 * `toLowerCase()` comparison on purpose, because it also gates reads: a name that
 * is a separate file on a case-sensitive filesystem must stay openable. This key
 * is for deciding what an agent may CREATE, where refusing is cheap.
 */
export function attachmentNameKey(name) {
  if (typeof name !== 'string') return name
  return name.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD')
}

/**
 * The name the F79 observation is auto-captured under (F79/#180, `index.js`'s
 * `OBSERVATION_FILE`). It is NOT in {@link RESERVED_FILES} on purpose: that set
 * gates every attachment route including the framework's own autosave and the
 * read path, and the autosave must keep landing while an existing
 * `observation.txt` stays readable (`memory_read_file`). What agents may not do
 * is AUTHOR it — see {@link agentAttachmentNameViolation}.
 */
export const OBSERVATION_FILENAME = 'observation.txt'

/** The folded identity of {@link OBSERVATION_FILENAME}, computed once. */
const OBSERVATION_NAME_KEY = attachmentNameKey(OBSERVATION_FILENAME)

/**
 * Longest attachment filename an AGENT-facing write may supply, in UTF-8 BYTES
 * (#255). `NAME_MAX` is 255 bytes, and every write derives a sibling from the
 * name (`.prev`, `.tmp-…`), so a name near the limit is only writable if the
 * derivations are bounded — which they are, but a cap here keeps the model's
 * own input inside a range the whole pipeline (staging, snapshot, moves that
 * prefix a short id) can carry. Bytes, not characters: `周报…` at 60 characters
 * is already 180 bytes. Never applied to READS: a legacy file with a longer
 * name must stay openable.
 */
export const MAX_AGENT_ATTACHMENT_NAME_BYTES = 200

/**
 * Why an agent-supplied attachment filename is not allowed on a write route, or
 * `undefined` when it is (#255). Pure — no graph, filesystem, session or clock
 * access — so the tool layer can run it in `defineTool`'s trusted `semantic`
 * preparation, where a violation proves the handler never ran (and therefore
 * that nothing was written and the graph is not quarantined).
 *
 * Two rules, both about what the WRITER may choose:
 *   - `observation.txt` is the framework's own capture of the prompting turn
 *     (F79, #180). An agent-authored file under that name is destroyed without
 *     a copy: the Session that wrote it is recorded as having authored it, so
 *     the next qualifying write's autosave passes `snapshot: false` and no
 *     `.observation.txt.prev` is taken. Refusing it here is the only place that
 *     closes that hole without breaking reads or the autosave itself. Compared
 *     through {@link attachmentNameKey}, not by lowercasing: a case- and
 *     normalization-insensitive filesystem resolves `Observation.txt`,
 *     `obſervation.txt` (LONG S) and an NFD spelling to the very same inode, so
 *     a plain `toLowerCase()` check was bypassable (#255 review 1).
 *   - a name past {@link MAX_AGENT_ATTACHMENT_NAME_BYTES} cannot be staged or
 *     snapshotted on a filesystem whose `NAME_MAX` is 255.
 *   - a RESERVED name (#255 review 2) is refused through {@link attachmentNameKey}
 *     as well, so an alias like `acceſſed.log` cannot create a file that a
 *     case-insensitive filesystem resolves to the framework's own. The read path
 *     keeps the narrow comparison — see {@link attachmentNameKey}.
 *
 * @param name - the filename as the caller supplied it (or the source basename
 *   a `from_path` attach would land under).
 * @returns a violation string in `validate()`'s shape, or undefined.
 */
export function agentAttachmentNameViolation(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const key = attachmentNameKey(name)
  if (key === OBSERVATION_NAME_KEY) {
    return `${JSON.stringify(name)} is reserved: ${OBSERVATION_FILENAME} is the framework's own capture of the prompting turn (F79), and an agent-written one is overwritten on the next qualifying write with no copy kept — nothing was written; store this content under a name that says what it holds`
  }
  if (RESERVED_FILES.has(key)) {
    return `${JSON.stringify(name)} is reserved by the framework — nothing was written; store this content under a name that says what it holds`
  }
  const bytes = Buffer.byteLength(name, 'utf8')
  if (bytes > MAX_AGENT_ATTACHMENT_NAME_BYTES) {
    return `filename is ${bytes} UTF-8 bytes, over the ${MAX_AGENT_ATTACHMENT_NAME_BYTES}-byte limit — nothing was written; shorten it to a name that still says what the file holds`
  }
  return undefined
}

/**
 * One file's current bytes, read through a single handle opened without
 * following a final symlink (#247). Every state a caller must tell apart, because
 * each implies a different action:
 *   - `missing` — there is no such path: a new filename, nothing to protect;
 *   - `nonregular` — a symlink, FIFO, socket or directory sits under the name:
 *     never followed, never overwritten, never snapshotted;
 *   - `ok` — a regular file within `maxBytes`, with its size.
 * A regular file past `maxBytes` is `tooLarge` rather than a truncated read: a
 * caller that snapshots the bytes must not silently keep half of them.
 * A file whose read ends before its own `fstat` size is `shortRead` (#255) — its
 * bytes shrank under us, so they are not the file's content and no caller may
 * snapshot them or treat them as knowledge that authorizes a replacement. An
 * explicit state, never `ok` with a rewritten size: a silent size rewrite is
 * exactly the "this is the whole file" lie the guard depends on.
 *
 * `dev` and `ino` come from the FSTAT OF THAT HANDLE, not from the pathname, so
 * they name the exact file whose bytes are being handed back. The per-Session
 * record of what has been read is keyed by that identity (#247 review 2): a
 * name is just a spelling — on a case-insensitive filesystem two spellings are
 * one file, and on a case-sensitive one they are two — while the inode is the
 * file itself, and a stage-and-rename publish always changes it.
 */
export async function inspectFileBytes(file, { maxBytes = ATTACH_MAX_BYTES } = {}) {
  let link
  try {
    link = await fsp.lstat(file)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing', size: 0 }
    throw error
  }
  if (!link.isFile()) return { state: 'nonregular', size: link.size }
  let handle
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  } catch (error) {
    // Swapped for a symlink after the lstat (ELOOP/EMLINK), or vanished.
    if (error.code === 'ELOOP' || error.code === 'EMLINK' || error.code === 'ENXIO') return { state: 'nonregular', size: link.size }
    if (error.code === 'ENOENT') return { state: 'missing', size: 0 }
    throw error
  }
  try {
    // The identity comes from THIS handle, so it names the file the bytes came
    // from even if the pathname was swapped between the lstat and the open.
    const stats = await handle.stat()
    const identity = { dev: stats.dev, ino: stats.ino }
    if (!stats.isFile()) return { state: 'nonregular', size: stats.size, ...identity }
    if (stats.size > maxBytes) return { state: 'tooLarge', size: stats.size, ...identity }
    const buffer = Buffer.alloc(stats.size)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    if (filled < stats.size) {
      // The handle's fstat promised `stats.size` and the read hit EOF first:
      // another writer truncated the file between the two (#255). `size` is
      // what was actually read, `expected` what the fstat claimed — the caller
      // must refuse rather than rewrite one into the other.
      return { state: 'shortRead', size: filled, expected: stats.size, ...identity }
    }
    return { state: 'ok', size: stats.size, ...identity, bytes: buffer }
  } finally {
    await handle.close()
  }
}

/**
 * The identity of the file currently published under a node path — the key the
 * per-Session record is kept under (#247 review 2). `lstat`, so a name that a
 * symlink sits under is reported as the link, never as its target; `undefined`
 * when nothing is there.
 */
export async function fileIdentity(file) {
  try {
    const link = await fsp.lstat(file)
    return { dev: link.dev, ino: link.ino, regular: link.isFile() }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Where the one-deep pre-overwrite copy of an attachment lives (#247). Dot-
 * prefixed, so every listing surface already hides it and
 * {@link assertAttachmentName} refuses the name as an attachment of its own;
 * `moveExtraFiles` therefore never chases it to a successor (a known gap, see
 * #247's follow-ups).
 *
 * Bounded (#255): `.<name>.prev` adds six bytes to a name the filesystem may
 * already have at its limit, so a 255-byte attachment could not be snapshotted —
 * and an unsnapshottable target is exactly what this file exists to protect.
 * A name whose sibling still fits keeps the readable form (every reader and the
 * operator's `cat` expect it); a longer one moves into the two-dot
 * {@link DERIVED_NAME_PREFIX} namespace, which no plain `.<name>.prev` can
 * produce — a truncated-head-plus-hash name used to collide with the plain form
 * of the name built from it (#255 review 1). Every writer of `.prev` goes
 * through this function.
 */
export function prevAttachmentFile(name) {
  const plain = `.${name}.prev`
  if (Buffer.byteLength(plain, 'utf8') <= SIBLING_NAME_MAX_BYTES) return plain
  return `${DERIVED_NAME_PREFIX}prev-${nameDigest(name)}.prev`
}

/** The prior bytes an overwrite is about to destroy, or undefined when the target is new. */
async function snapshotPriorBytes(file, name, maxBytes) {
  const prior = await inspectFileBytes(file, { maxBytes })
  if (prior.state === 'missing') return undefined
  if (prior.state === 'nonregular') {
    throw new Error(`refusing to replace ${name}: it is not a regular file, so its prior content cannot be kept — nothing was written`)
  }
  if (prior.state === 'tooLarge') {
    throw new Error(`refusing to replace ${name} (${prior.size} bytes, over the ${maxBytes}-byte attachment cap): the prior content could not be copied aside, so this overwrite would destroy it — nothing was written; store the replacement under a new filename`)
  }
  if (prior.state === 'shortRead') {
    throw new Error(`refusing to replace ${name}: it shrank while its prior content was being read (${prior.size} of ${prior.expected} bytes), so that content could not be copied aside — nothing was written; try again`)
  }
  return prior.bytes
}

/**
 * Write an agent-space file into a node directory (F1, #10). The node must
 * exist — attaching to a missing node would leave an orphan directory the graph
 * never reads. The write is atomic (stage-and-rename), so a reader never sees a
 * half-written attachment, and overwrite is allowed: agent space is the agent's
 * own, so a re-attach replaces in place and the result says which happened.
 *
 * #247: an overwrite first copies the prior bytes to `.<name>.prev` (the sibling
 * of `node.md`'s own one-deep snapshot), written atomically and BEFORE the
 * replacement. A failed snapshot aborts the overwrite with the target untouched.
 * `snapshot: false` is for the tool layer, which passes it when no copy is owed:
 * this Session authored the bytes now on disk and either created the file (no
 * prior to keep) or already holds the copy. While that in-memory session record
 * survives, a `.prev` this Session wrote stays on the version from before its
 * own first authorized overwrite instead of chasing this Session's later ones.
 * Across separate tasks (a fresh dsh process, an evicted session entry) there is
 * no record to consult, so the next overwrite copies what is on disk and `.prev`
 * holds the version before the last authorized overwrite.
 *
 * @returns `{ file, bytes, status }` where `status` is `'created'` or
 *   `'overwritten'`.
 */
export async function attach(root, id, filename, content, { maxBytes = ATTACH_MAX_BYTES, snapshot = true } = {}) {
  assertId(id)
  const name = assertAttachmentName(filename)
  if (typeof content !== 'string') throw new Error('content must be a string')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) throw new Error(`content too large (${bytes} bytes, max ${maxBytes}) — attachments are capped; split or trim`)
  const dir = path.join(root, id)
  let exists = false
  try {
    exists = (await fsp.stat(path.join(dir, 'node.md'))).isFile()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!exists) throw new Error(`node does not exist: ${id}`)
  const file = path.join(dir, name)
  let status = 'created'
  let priorBytes = 0
  try {
    // lstat, matching how attachment metadata sizes files: a symlink dropped
    // into agent space out-of-band must not let an empty write judge itself
    // against the target it points at.
    priorBytes = (await fsp.lstat(file)).size
    status = 'overwritten'
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Ledger #21: an agent that wants to read an attachment used to reach for the
  // only tool that took a filename — this one — and pass empty content. That
  // silently destroyed a meeting transcript in the round-4 simulation.
  // `memory_read_file` now exists (F22, #42), but an empty write can never be
  // the point of an overwrite either way, so refuse it and name the mistake.
  if (status === 'overwritten' && bytes === 0 && priorBytes > 0) {
    throw new Error(`refusing to replace ${name} (${priorBytes} bytes) with empty content — pass the full replacement text; to read this file, use memory_read_file`)
  }
  if (snapshot && status === 'overwritten') {
    const incoming = Buffer.from(content, 'utf8')
    const prior = await snapshotPriorBytes(file, name, maxBytes)
    // By the time `snapshotPriorBytes` returns, a concurrent writer's identical
    // bytes need no copy — nothing would be lost by the replacement.
    if (prior !== undefined && !prior.equals(incoming)) await writeAtomic(path.join(dir, prevAttachmentFile(name)), prior)
  }
  await writeAtomic(file, content)
  return { file: name, bytes, status }
}

/**
 * System locations a `from_path` source may never come from, whatever the
 * deployment's allowed roots say — a root of `/` or `/root` must not reopen
 * them. Both spellings of the macOS `/etc` → `/private/etc` alias are listed,
 * and each entry is also compared after `realpath` at check time.
 */
export const ATTACH_SOURCE_DENY = Object.freeze([
  '/etc', '/private/etc', '/proc', '/sys', '/dev', '/boot', '/run', '/var/run', '/private/var/run',
  '/root/.ssh', '/var/root/.ssh', '/private/var/root/.ssh',
])

/** Credential directories refused wherever they sit in the real path, even above an allowed root. */
const SECRET_DIR_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store'])

/** True when `child` is `parent` or lies under it — by path.relative, never by string prefix. */
function isWithin(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

async function realpathOrUndefined(target) {
  try {
    return await fsp.realpath(target)
  } catch {
    return undefined
  }
}

/**
 * Copy an existing file on disk into a node's agent space (F30, #50). Every
 * verbatim capture through `attach` is paid for twice in tokens and is one
 * paraphrase away from lossy; when the bulk already exists as a file, capture
 * it by reference instead. COPY, never move: the source path is chosen by the
 * model, and a writer running with broad filesystem rights (root on a server)
 * must never be able to delete, rename, truncate or otherwise alter a file it
 * was only asked to remember (security review: `from_path` used to unlink its
 * source, so a hallucinated or injected `/root/.ssh/authorized_keys` would
 * have been consumed). The source is opened read-only and left exactly as it
 * was — same bytes, same size, same mtime.
 *
 * Because the path is model-chosen, the source is also confined (security
 * review, 2026-10-19), checked in this order:
 *   1. `realpath` the source itself, so every symlink is resolved and the
 *      checks below judge the file that would actually be read;
 *   2. it must not already live in the graph (it travels with its node);
 *   3. it must lie under one of `allowedRoots` (each also real-pathed),
 *      compared with `path.relative`;
 *   4. no path component BELOW that root may start with a dot (`.ssh`,
 *      `.aws`, `.env`, `.git`, `.config`, …) — and the credential
 *      directories in SECRET_DIR_NAMES are refused anywhere in the path;
 *   5. never under ATTACH_SOURCE_DENY (`/etc`, `/proc`, `/sys`, `/dev`,
 *      `/root/.ssh`, …), even when a root would include it;
 *   6. `lstat` on the real path must show a regular file (a FIFO, socket,
 *      device or directory is refused without ever being opened) within the
 *      size cap.
 * The file is then opened ONCE (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`), the
 * handle is `fstat`-ed and must still be the same regular file (same
 * device and inode) under the cap, and the bytes are read from that handle —
 * so a swap between the checks and the read is refused rather than followed.
 *
 * Same caps and guards as `attach`: size-capped, and an empty source never
 * replaces a non-empty attachment. The bytes land in a fresh staging file
 * next to the destination (created exclusively) and are renamed into place,
 * so a reader never sees a half-written attachment.
 *
 * @param allowedRoots - directories a source may come from; required, and an
 *   empty list refuses every source.
 * @param authorize - optional `async ({file, data}) => {snapshot?}` guard, run
 *   on the exact validated Buffer this call will publish, before the snapshot
 *   and before the destination is touched (#247). It may throw to refuse.
 * @returns `{ file, bytes, status }` as `attach` does.
 */
export async function attachFromPath(root, id, srcPath, filename, { maxBytes = ATTACH_MAX_BYTES, allowedRoots, snapshot = true, authorize } = {}) {
  assertId(id)
  if (typeof srcPath !== 'string' || srcPath.length === 0) throw new Error('from_path must be a non-empty string')
  if (!Array.isArray(allowedRoots) || allowedRoots.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('attachFromPath: `allowedRoots` must be an array of directory paths')
  }
  const name = assertAttachmentName(filename ?? path.basename(srcPath))
  const dir = path.join(root, id)
  let exists = false
  try {
    exists = (await fsp.stat(path.join(dir, 'node.md'))).isFile()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!exists) throw new Error(`node does not exist: ${id}`)
  // 1. The file that would actually be read.
  let realSrc
  try {
    realSrc = await fsp.realpath(srcPath)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error(`from_path does not exist: ${srcPath}`)
    throw error
  }
  // 2. A source already under the graph root is not a loose file — it is
  // either an attachment that already travels with its node, or framework
  // metadata like node.md that is not the agent's to duplicate. Judged on the
  // source's real path, so neither a symlinked graph root nor an outside
  // link pointing into the graph gets past it.
  const rootReal = await fsp.realpath(root)
  if (isWithin(rootReal, realSrc)) {
    throw new Error(`from_path is inside the memory graph: ${srcPath} — it already travels with a node; attach only files from outside the graph`)
  }
  // 3 + 4. Under an allowed root, with no hidden component below that root.
  // A source under several roots (the working directory inside home) passes
  // when ANY containing root sees no hidden component beneath it.
  const roots = (await Promise.all(allowedRoots.map((entry) => realpathOrUndefined(path.resolve(entry))))).filter((entry) => entry !== undefined)
  const containing = roots.filter((entry) => isWithin(entry, realSrc))
  if (containing.length === 0) {
    throw new Error(`from_path is not under an allowed source directory: ${srcPath} — this deployment accepts files only from ${allowedRoots.length === 0 ? 'nowhere (no source directories are configured)' : allowedRoots.join(', ')}`)
  }
  const hiddenBelow = (base) => path.relative(base, realSrc).split(path.sep).some((part) => part.startsWith('.'))
  if (containing.every(hiddenBelow) || realSrc.split(path.sep).some((part) => SECRET_DIR_NAMES.has(part))) {
    throw new Error(`from_path is a hidden file or inside a hidden directory: ${srcPath} — dotfiles and dot-directories (.ssh, .env, .git, .config, …) are never attached`)
  }
  // 5. System locations, whatever the roots say.
  for (const denied of ATTACH_SOURCE_DENY) {
    const deniedReal = await realpathOrUndefined(denied)
    if (isWithin(denied, realSrc) || (deniedReal !== undefined && isWithin(deniedReal, realSrc))) {
      throw new Error(`from_path is in a protected system location: ${srcPath} — files under ${denied} are never attached`)
    }
  }
  // 6. A regular file, judged without following anything and without opening
  // it — a FIFO opened for reading would block the tool call.
  const src = await fsp.lstat(realSrc)
  if (!src.isFile()) throw new Error(`from_path is not a regular file: ${srcPath}`)
  // Fast reject on the lstat size so a multi-GB file is never read at all;
  // the handle below re-checks authoritatively.
  if (src.size > maxBytes) throw new Error(`content too large (${src.size} bytes, max ${maxBytes}) — attachments are capped; split or trim`)
  const file = path.join(dir, name)
  let status = 'created'
  let priorBytes = 0
  try {
    priorBytes = (await fsp.lstat(file)).size
    status = 'overwritten'
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Open once and read from that handle: O_NOFOLLOW refuses a final
  // component swapped for a symlink after the checks, O_NONBLOCK keeps a
  // component swapped for a FIFO from hanging the open, and the fstat must
  // still name the same regular file the checks approved.
  const changed = () => new Error(`from_path changed while it was being attached: ${srcPath} — nothing was stored`)
  let handle
  try {
    handle = await fsp.open(realSrc, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOENT' || error.code === 'ENXIO') throw changed()
    throw error
  }
  let data
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== src.ino || opened.dev !== src.dev) throw changed()
    if (opened.size > maxBytes) throw new Error(`content too large (${opened.size} bytes, max ${maxBytes}) — attachments are capped; split or trim`)
    // Read up to one byte past the cap so a file that grew since the fstat
    // is still caught by the staged-size check below.
    const buffer = Buffer.alloc(maxBytes + 1)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    data = buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
  // Same staging discipline as writeAtomic: land next to the destination,
  // rename into place, and never leave the temp file behind on failure. The
  // size and empty-overwrite guards judge the bytes actually read. `wx`: the
  // staging name is fresh, so an existing file there is never ours to
  // overwrite. Every write, rename and cleanup below touches only the staging
  // file and the destination, both inside the node directory — never the
  // source.
  const bytes = data.length
  if (bytes > maxBytes) throw new Error(`content too large (more than ${maxBytes} bytes) — attachments are capped; split or trim`)
  if (status === 'overwritten' && bytes === 0 && priorBytes > 0) {
    throw new Error(`refusing to replace ${name} (${priorBytes} bytes) with empty ${srcPath} — to read this attachment, use memory_read_file`)
  }
  // #247: the caller's authorization, on the exact Buffer this call is about to
  // publish — the bytes read once from the validated handle above, never a
  // second read of the pathname. That is what closes the race a caller-side
  // pre-read leaves open: the loose source is not protected by the node lock, so
  // bytes that matched an unread destination a moment ago can be different ones
  // by the time the copy is made. Runs after the source is fully read and
  // validated, and BEFORE the snapshot or the destination is touched, so a
  // refusal here writes nothing at all.
  //
  // `authorize` may throw (refuse the overwrite) or return `{ snapshot: false }`
  // when the caller already holds the bytes from before this Session aside.
  let keepSnapshot = snapshot
  if (typeof authorize === 'function') {
    const verdict = await authorize({ file: name, data })
    if (verdict?.snapshot === false) keepSnapshot = false
  }
  // #247's pre-overwrite copy, from the same data the attach is about to land:
  // the target is only replaced after the prior bytes are safely aside.
  if (keepSnapshot && status === 'overwritten') {
    const prior = await snapshotPriorBytes(file, name, maxBytes)
    if (prior !== undefined && !prior.equals(data)) await writeAtomic(path.join(dir, prevAttachmentFile(name)), prior)
  }
  const staging = path.join(dir, `.attach-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await fsp.writeFile(staging, data, { flag: 'wx' })
    await fsp.rename(staging, file)
  } catch (error) {
    // EEXIST is the exclusive-create refusal: that staging file is not ours.
    if (error.code !== 'EEXIST') await fsp.rm(staging, { force: true })
    throw error
  }
  return { file: name, bytes, status }
}

/**
 * How much of an attachment one read returns. Mirrors the 50k body-render
 * window (finding #4) on purpose: the same context budget governs whichever
 * surface the text arrives through, and an attachment may be ten times that.
 */
export const ATTACH_READ_BYTES = 50_000

/**
 * Where a read window may end without splitting a UTF-8 character: the largest
 * `n <= len` such that `buffer[0..n)` holds no truncated multi-byte sequence.
 * Scanning back at most three bytes finds the last lead byte; if its sequence
 * runs past `len`, the window ends before it and those bytes go to the next
 * page. Bytes that are not valid UTF-8 to begin with are left where they are —
 * this defers a split character, it never repairs a malformed file.
 */
function utf8SafeEnd(buffer, len) {
  for (let back = 1; back <= 3 && back <= len; back++) {
    const at = len - back
    const byte = buffer[at]
    if ((byte & 0xc0) === 0x80) continue // a continuation byte: keep walking back to its lead
    const need = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1
    return at + need <= len ? len : at
  }
  return len
}

/**
 * Where a window read from the middle of a file safely starts: the first byte
 * that is not a UTF-8 continuation byte. The mirror of {@link utf8SafeEnd} —
 * a tail window opens mid-character as easily as a head window closes
 * mid-character, and a partial sequence decodes to the U+FFFD that the
 * attachment scan reads as "this is binary" (F42, #69).
 */
function utf8SafeStart(buffer) {
  let at = 0
  while (at < buffer.length && at < 3 && (buffer[at] & 0xc0) === 0x80) at++
  return at
}

/** The shared argument checks of every attachment read. */
function assertReadWindow(offset, maxBytes) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got ${JSON.stringify(offset)}`)
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer, got ${JSON.stringify(maxBytes)}`)
  }
}

/**
 * Cut one read window out of bytes already known to belong to ONE version of a
 * file (#247). Pure, so both readers below — the windowed handle read and the
 * whole-file read that also hashes what it returned — share one implementation
 * and therefore one set of semantics: `next_offset` is present exactly when
 * bytes remain past the window, and a window that would split a multi-byte
 * character stops before it and defers those bytes to the next page, so
 * following `next_offset` reassembles the file exactly.
 *
 * `window` holds the bytes starting at `offset` (as many as were actually read,
 * which may be fewer than asked for); `size` is the file's size.
 */
function sliceAttachmentWindow(name, window, size, offset, maxBytes) {
  const bytesRead = window.length
  // Only trim mid-file: at EOF there is no next page to defer to, and an
  // incomplete sequence there belongs to the file. Never trim to zero — a
  // window too small to hold one character must still advance, or a caller
  // following `next_offset` would loop on the same offset forever.
  const safe = offset + bytesRead < size ? utf8SafeEnd(window, bytesRead) : bytesRead
  const usable = safe > 0 ? safe : bytesRead
  const content = window.subarray(0, usable).toString('utf8')
  const end = offset + usable
  return { file: name, size, offset, bytes: usable, content, ...(end < size ? { next_offset: end } : {}) }
}

/**
 * Read one attachment back out of a node (F22, #42). Attachments were
 * write-only: `memory_search` advertised them, a node view listed them, and
 * nothing returned their content — so an agent that needed a fact stored in one
 * either guessed or destroyed the file trying to read it through `attach`.
 *
 * Reads a window of at most `maxBytes` starting at `offset`, so a 512KB
 * transcript is walked in pages instead of flooding one call; see
 * {@link sliceAttachmentWindow} for the window's exact semantics.
 *
 * Regular files only — the same rule {@link attachments} summarizes under: a
 * FIFO blocks until a writer appears, and a symlink dropped into agent space
 * out-of-band may point anywhere.
 *
 * @returns `{ file, size, offset, bytes, content }` plus `next_offset` when the
 *   file continues past this window.
 */
export async function readAttachment(root, id, filename, { offset = 0, maxBytes = ATTACH_READ_BYTES } = {}) {
  assertId(id)
  const name = assertAttachmentName(filename)
  assertReadWindow(offset, maxBytes)
  const file = path.join(root, id, name)
  // One handle decides everything: open with O_NOFOLLOW, then stat and read
  // THAT handle. An lstat-then-open pair leaves a window in which the checked
  // path is replaced — a symlink swapped in redirects the read out of the node
  // directory, and an atomic re-attach between the two steps reports a size the
  // read never saw. O_NONBLOCK keeps the open itself from hanging on a FIFO,
  // which would otherwise wait forever for a writer; fstat then rejects it.
  let handle
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`no such file on node ${id}: ${name} — memory_read lists the files a node carries`)
    // What O_NOFOLLOW raises on a symlink: ELOOP on Linux, EMLINK on some BSDs.
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw new Error(`not a regular file on node ${id}: ${name}`)
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`not a regular file on node ${id}: ${name}`)
    const size = stats.size
    const want = Math.max(0, Math.min(maxBytes, size - offset))
    let bytesRead = 0
    let buffer = Buffer.alloc(0)
    if (want > 0) {
      buffer = Buffer.alloc(want)
      ;({ bytesRead } = await handle.read(buffer, 0, want, offset))
    }
    return sliceAttachmentWindow(name, buffer.subarray(0, bytesRead), size, offset, maxBytes)
  } finally {
    await handle.close()
  }
}

/**
 * One attachment window AND the hash of the version it came from, from a single
 * read (#247, review finding 4).
 *
 * `memory_read_file` records what a Session has been shown, and that record is
 * later used to authorize REPLACING the file — so the window and the hash must
 * describe the same bytes. Reading the window through one handle and hashing the
 * pathname afterwards leaves a window in which an out-of-band `rename(2)` swaps
 * the file: the caller is shown the old content and credits it to the new file's
 * hash, and for same-sized one-page files the range would even cover it. One
 * read of one version closes that.
 *
 * The whole file is read once, capped at `hashCap` (the attachment cap). A
 * larger file — only possible outside this graph, since every write path caps —
 * is served by the windowed read with `sha: undefined`, as is a file that shrank
 * mid-read (#255): a partial view must never be treated as knowledge of the
 * whole file, and such a file cannot be replaced through the tools anyway.
 *
 * @returns `readAttachment`'s result plus `sha` (SHA-256 hex of the whole file),
 *   or `sha: undefined` for the over-cap fallback.
 */
export async function readAttachmentWithHash(root, id, filename, { offset = 0, maxBytes = ATTACH_READ_BYTES, hashCap = ATTACH_MAX_BYTES } = {}) {
  assertId(id)
  const name = assertAttachmentName(filename)
  assertReadWindow(offset, maxBytes)
  const file = path.join(root, id, name)
  const evidence = await inspectFileBytes(file, { maxBytes: hashCap })
  if (evidence.state === 'missing') throw new Error(`no such file on node ${id}: ${name} — memory_read lists the files a node carries`)
  if (evidence.state === 'nonregular') throw new Error(`not a regular file on node ${id}: ${name}`)
  // Neither of these can authorize a replacement: a file over the cap is never
  // read whole, and a file that shrank mid-read handed back bytes that are not
  // its content (#255). Serve the window from a fresh read — whose own
  // size/offset come from THAT version — and withhold the hash, so
  // `memory_read_file` never records a sighting a later overwrite could not
  // honour.
  if (evidence.state === 'tooLarge' || evidence.state === 'shortRead') {
    return { ...(await readAttachment(root, id, name, { offset, maxBytes })), sha: undefined }
  }
  const size = evidence.size
  const want = Math.max(0, Math.min(maxBytes, size - offset))
  const window = evidence.bytes.subarray(offset, offset + want)
  return {
    ...sliceAttachmentWindow(name, window, size, offset, maxBytes),
    sha: createHash('sha256').update(evidence.bytes).digest('hex'),
    // The identity the window and the hash both belong to (#247 review 2).
    dev: evidence.dev,
    ino: evidence.ino,
  }
}

/**
 * Attachment metadata for a node view (F2, #11): each non-reserved file with
 * its byte size and a one-line summary — the file's first line, read at most
 * {@link ATTACH_SUMMARY_BYTES} bytes so a huge attachment costs one short read.
 * Binary-safe: a file whose leading bytes are not printable text, or whose
 * first line runs past the read window (oversized), gets name + size only and
 * no summary, so a node view never dumps control bytes or a runaway line.
 */
export async function attachments(root, id) {
  const dir = path.join(root, id)
  const out = []
  for (const name of await extraFiles(root, id)) {
    const file = path.join(dir, name)
    let stats
    try {
      stats = await fsp.lstat(file)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const size = stats.size
    // Only regular files get their first line read: opening a FIFO blocks
    // until a writer appears (hanging memory_read forever), and a symlink may
    // point anywhere — including out of the node dir. Metadata only for those.
    if (!stats.isFile()) {
      out.push({ name, size })
      continue
    }
    let summary
    try {
      const handle = await fsp.open(file, 'r')
      try {
        const buffer = Buffer.alloc(ATTACH_SUMMARY_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, ATTACH_SUMMARY_BYTES, 0)
        const chunk = buffer.subarray(0, bytesRead)
        const newline = chunk.indexOf(0x0a)
        // No newline while the whole window filled up means the first line runs
        // past what we read — oversized, so summarize nothing rather than guess.
        if (!(newline === -1 && bytesRead === ATTACH_SUMMARY_BYTES)) {
          const line = (newline === -1 ? chunk : chunk.subarray(0, newline)).toString('utf8').replace(/\r$/, '').trim()
          // Reject control bytes (bar tab) and the U+FFFD a bad decode yields:
          // that is our binary-vs-text signal.
          if (line.length > 0 && !/[\u0000-\u0008\u000b-\u001f\uFFFD]/.test(line)) summary = line
        }
      } finally {
        await handle.close()
      }
    } catch { /* unreadable first line — fall back to name + size only */ }
    out.push(summary === undefined ? { name, size } : { name, size, summary })
  }
  return out
}

/**
 * The FLOOR on how much of one attachment the search scan reads (F81, #182 —
 * before F81 this was the ceiling as well). The point is to find the node, not
 * to rank on the whole file, and the agent opens it with `memory_read_file`
 * once found.
 *
 * A node that carries few files gets more than this each: the real window is a
 * fair share of {@link ATTACH_SCAN_TOTAL_BYTES}, floored here, so the one-file
 * node — which is exactly the shape F79's auto-attached `observation.txt`
 * creates — is indexed WHOLE up to the node budget instead of head-and-tail
 * around an unread middle. See {@link attachmentText} for why that middle was
 * the measured failure.
 *
 * Spent as a head window AND a tail window on a file that exceeds its share
 * (F42, #69).
 */
export const ATTACH_SEARCH_BYTES = 64 * 1024

/**
 * How much an attachment hit is worth against a description hit (3) and a body
 * hit (1). Deliberately the smallest of the three: an attachment is bulk detail
 * the agent was told to move OUT of the searchable surface, so it should break
 * a tie and surface an otherwise-invisible node, never outrank a node whose own
 * description is about the query.
 */
const ATTACH_WEIGHT = 0.5

/**
 * Per node, how many attachments the search scan opens and how many bytes it
 * keeps in total. The per-file cap alone bounds nothing: a node holding
 * hundreds of files would still cost hundreds of reads on every query. Twenty
 * files matches the node view's own display cap; 256KB is four floor-sized
 * windows. This is the ONLY per-node cost bound, and F81 left it untouched:
 * widening the per-file window redistributes this budget, it never raises it,
 * so a whole-graph query costs exactly what it did before.
 */
const ATTACH_SCAN_FILES = 20
export const ATTACH_SCAN_TOTAL_BYTES = 256 * 1024

/**
 * How much of a matched attachment a search row quotes back (F81, #182), and
 * how many files it quotes from. A row used to say only WHICH file matched, so
 * a model that issues one search — 89 of 104 failed reference-replay answers issued
 * exactly one — saw a body snippet that does not contain the fact and an
 * instruction to make a second call it never made. The window is wide enough to
 * carry the neighbours of the hit, because the failure shape is an enumeration
 * (a menu's six links, a table's four columns) whose members sit on adjacent
 * lines of the observation.
 */
const EXCERPT_CHARS = 240
const EXCERPT_FILES = 3

/**
 * Lowercased text of a node's attachments, for the search scan (F29, #49).
 * F21 tells the agent to move transcripts and meeting notes into attachments;
 * every fact it moved used to leave the index entirely, so the answer sat one
 * file away from a confident fabrication.
 *
 * Bounded on every axis that could make a whole-graph scan expensive: regular
 * files only (O_NOFOLLOW, so a symlink into agent space is never followed), a
 * per-file window ({@link ATTACH_SEARCH_BYTES} at minimum), {@link
 * ATTACH_SCAN_FILES} files and {@link ATTACH_SCAN_TOTAL_BYTES} bytes per node,
 * and nothing that does not decode as text. Files are taken in directory order
 * — a node past the caps is partially indexed, never skipped, and its body and
 * description still rank it.
 *
 * A file over its window is read as a head window plus a tail window of half
 * the budget each (F42, #69). The cap bounds cost and that is right, but the
 * FIRST bytes are the wrong bytes for a transcript: a day-long meeting records
 * its decision at the END, so the one line that answers the question used to sit
 * past the cap while the morning's small talk was indexed.
 *
 * F81 (#182) made the window a fair SHARE of the node budget instead of a fixed
 * 64KB slice of it, because F79 changed the shape of what nodes carry. Measured
 * on a reference-replay failure: an auto-attached 168KB `observation.txt` holding
 * `link 'View all comments'` at byte 84188 fell in the unread middle between a
 * 32KB head and a 32KB tail, and search reported those words as `unmatched` —
 * telling the answer turn to reword the terms the node held verbatim. A node's
 * only attachment now gets the whole node budget, so nothing under 256KB has an
 * unread middle at all; the middle of a file larger than the share still does,
 * and F22's `memory_read_file` reads the rest.
 *
 * Segments carry their file byte OFFSET, so a row can quote the hit and say
 * where in the file to resume reading (F81) — a head/tail read makes string
 * position and file position different numbers, and a caller handed the wrong
 * one pages into the wrong part of a half-megabyte file.
 *
 * ponytail: this is a linear rescan on every query, same trade as loadAll. It
 * is the first thing to move into a persistent index, now that backlinks no
 * longer scan (F54, #90).
 */
function attachmentText(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Which files the scan may open, settled BEFORE any read so the per-file
  // window can be a fair share of the node budget (F81, #182). isFile(), not
  // extraFiles' !isDirectory(): a symlink is not searched, the same refusal
  // readAttachment makes when asked to open one. `accessed.log` is a legacy
  // exclusion — see extraFiles (F57, #93).
  //
  // The pre-pass settles the DIVISOR only. ATTACH_SCAN_FILES still caps files
  // successfully indexed, in the loop below exactly where it always did (codex
  // review of #182): capping candidates instead would let twenty tiny binary
  // files stop the scan before the text file behind them, which the old lazy
  // loop would have reached with budget to spare.
  const names = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'node.md' || entry.name === 'accessed.log' || entry.name.startsWith('.')) continue
    names.push(entry.name)
  }
  if (names.length === 0) return []
  // An equal share of the node budget, never below the floor. One file takes the
  // whole 256KB — the F79 `observation.txt` shape — while four or more files
  // fall back to exactly the window they had before F81, so no node that was
  // fully indexed loses coverage and the per-node byte cost is unchanged. The
  // floor is what makes a many-file node identical to its pre-F81 self: divide
  // 256KB by thirty and the share would be smaller than the window those files
  // already had.
  const share = Math.max(ATTACH_SEARCH_BYTES, Math.floor(ATTACH_SCAN_TOTAL_BYTES / names.length))
  const out = []
  let budget = ATTACH_SCAN_TOTAL_BYTES
  for (const name of names) {
    if (out.length >= ATTACH_SCAN_FILES || budget <= 0) break
    const want = Math.min(share, budget)
    let parts
    try {
      const fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      try {
        const size = fs.fstatSync(fd).size
        const tail = want - (want >> 1)
        // One window for a file that fits under the share, head + tail for one
        // that does not. Same total bytes either way, so the per-node budget is
        // unchanged. Keyed to the share and not to `want`: with the per-node
        // budget nearly spent `want` can be a handful of bytes, and slicing a
        // short file into a first byte and a last two helps nobody — under the
        // share, a small file keeps the plain prefix read it always had.
        const windows = size > share ? [[want >> 1, 0], [tail, size - tail]] : [[want, 0]]
        parts = windows.map(([length, position]) => {
          const buffer = Buffer.alloc(length)
          return { position, bytes: buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position)) }
        })
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      continue
    }
    budget -= parts.reduce((total, part) => total + part.bytes.length, 0)
    if (parts.some((part) => part.bytes.includes(0))) continue
    // Drop the characters the window boundaries split, then treat any remaining
    // U+FFFD as the binary signal — the same text-vs-bytes test a node view's
    // attachment summary uses. A NUL check alone passes NUL-free binary through
    // as words. Only the internal cuts need trimming: the head window's end and
    // the tail window's start. Head and tail stay SEPARATE segments, so they can
    // never fuse into a word that is in neither and each keeps its own file
    // offset.
    const segments = parts.map((part, index) => {
      const from = index === 0 ? 0 : utf8SafeStart(part.bytes)
      const to = parts.length > 1 && index === 0 ? utf8SafeEnd(part.bytes, part.bytes.length) : part.bytes.length
      const text = part.bytes.subarray(from, to).toString('utf8')
      return { offset: part.position + from, text, lower: foldInPlace(text) }
    })
    if (segments.some((segment) => segment.text.includes('�'))) continue
    out.push({ name, segments })
  }
  return out
}

/**
 * Case-fold a string WITHOUT changing its length, so an index into the folded
 * copy is also an index into the original (codex review of #182). Plain
 * `toLowerCase` is not index-preserving: U+0130 (İ) lowercases to two code
 * units, and every position after it in the folded text then names different
 * characters in the source — the excerpt quotes unrelated text and the byte
 * offset points somewhere the match never was.
 *
 * The length check is the whole cost for ordinary text (all ASCII, all CJK, all
 * accented Latin fold in place). Only when a string contains one of the handful
 * of expanding characters do we fold code point by code point and leave those
 * few unfolded — losing a case-insensitive match on İ is a far smaller error
 * than answering from the wrong part of a file.
 */
function foldInPlace(text) {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ''
  for (const ch of text) {
    const low = ch.toLowerCase()
    out += low.length === ch.length ? low : ch
  }
  return out
}

/** Whether `text[at]` is the second half of a surrogate pair — never a safe cut. */
function isLowSurrogate(text, at) {
  const code = text.charCodeAt(at)
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * The character range an excerpt centred on `index` covers (F81, #182).
 * Separated from {@link excerptAt} so the passage CHOOSER below scores exactly
 * the range the quote will show, rather than a range that merely resembles it.
 *
 * The matched token's own length is clamped to {@link EXCERPT_CHARS} before it
 * widens anything (codex review round 2). `tokenize` splits on non-alphanumerics,
 * so a pasted URL, a base64 blob or a long hex id is ONE token — and a window
 * sized to hold it whole returned that entire token as the "excerpt", hundreds
 * of KB per file and up to three files on every row. The quote is a pointer into
 * the file, never a copy of it: past the clamp it shows the head of the match and
 * the trailing `…` sends the reader to `memory_read_file`.
 *
 * Widened to whitespace so the quote never opens or closes mid-word — bounded,
 * because a file with no whitespace at all must not walk the whole segment
 * looking for some. Both bounds are then pushed off the inside of a surrogate
 * pair (codex review of #182): the walk is bounded, so it can stop between the
 * halves of an astral character, and a lone surrogate makes `Buffer.byteLength`
 * count a replacement character — which moves the reported offset into the
 * middle of a UTF-8 sequence and renders the first character as U+FFFD.
 */
function excerptRange(text, index, length) {
  const span = Math.min(length, EXCERPT_CHARS)
  const pad = Math.max(0, EXCERPT_CHARS - span) >> 1
  let start = Math.max(0, index - pad)
  let end = Math.min(text.length, index + span + pad)
  for (let i = 0; i < 40 && start > 0 && !/\s/.test(text[start - 1]); i++) start--
  for (let i = 0; i < 40 && end < text.length && !/\s/.test(text[end]); i++) end++
  if (start > 0 && isLowSurrogate(text, start)) start -= 1
  if (end < text.length && isLowSurrogate(text, end)) end += 1
  return { start, end }
}

/**
 * A readable quote of the matched region of an attachment, and the file byte
 * offset it starts at (F81, #182).
 *
 * Whitespace runs collapse to single spaces on purpose: an accessibility tree
 * is one short indented node per line, and the answer to "what are the six
 * account-menu links" is the RUN of lines around the hit, not the one line that
 * happened to carry the query term.
 */
function excerptAt(segment, index, length) {
  const text = segment.text
  const { start, end } = excerptRange(text, index, length)
  const quote = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return {
    offset: segment.offset + Buffer.byteLength(text.slice(0, start), 'utf8'),
    excerpt: `${start > 0 ? '…' : ''}${quote}${end < text.length ? '…' : ''}`,
  }
}

/**
 * Pick which of a file's hits to quote, and quote it (F81, #182, review round 2).
 *
 * Quoting the first query term's first occurrence was wrong in the ordinary
 * multi-term case: a term that also appears in an unrelated earlier passage
 * pinned the quote there for good, so the row reported every term matched while
 * showing text that answers none of them — a row asserting more than its own
 * evidence supports, which is the failure this whole feature exists to remove,
 * one level up.
 *
 * So score each candidate passage by how many DISTINCT query terms fall inside
 * the very range the quote will show, and take the best. Ties keep the earliest
 * candidate, which is query order then file order — so a single-term query, and
 * any query whose terms all live in one passage, quote exactly what they did
 * before. `segment.lower` is index-aligned with `segment.text` by construction
 * (see {@link foldInPlace}), so the range computed on one slices the other.
 *
 * Bounded: at most one candidate per query term, each scored against at most one
 * {@link EXCERPT_CHARS}-sized slice per term.
 */
function bestExcerpt(hits, tokens) {
  let best = hits[0]
  let bestCover = -1
  for (const hit of hits) {
    const { start, end } = excerptRange(hit.segment.text, hit.at, hit.token.length)
    const around = hit.segment.lower.slice(start, end)
    let cover = 0
    for (const token of tokens) if (around.includes(token)) cover += 1
    if (cover > bestCover) {
      bestCover = cover
      best = hit
    }
  }
  return excerptAt(best.segment, best.at, best.token.length)
}

/**
 * Count how many recorded traversals landed on each node, for ranking. With
 * `includeArchived`, logs inside `.archive/` count too, so an archived hit
 * surfaced by search ranks on its real history instead of a false zero.
 */
export async function accessCounts(root, { includeArchived = false } = {}) {
  // Each source is a node whose log may exist in `.access/<id>.log` and — on a
  // legacy graph — in the node's own dir (live or archived). An archived node's
  // `.access/` log is read only under the flag, preserving the pre-F57 rule
  // that a log follows its owner out of the default scan.
  const sources = (await listIds(root)).map((id) => ({ id, legacyDir: path.join(root, id) }))
  if (includeArchived) {
    try {
      for (const entry of await fsp.readdir(path.join(root, ARCHIVE_DIR), { withFileTypes: true })) {
        if (entry.isDirectory() && ULID_RE.test(entry.name)) sources.push({ id: entry.name, legacyDir: path.join(root, ARCHIVE_DIR, entry.name) })
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const counts = new Map()
  // Sync reads on purpose — same trade as loadAll.
  for (const { id, legacyDir } of sources) {
    for (const line of readAccessLines(root, id, legacyDir)) {
      const dst = line.slice(0, 26)
      if (ULID_RE.test(dst)) counts.set(dst, (counts.get(dst) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Create a Node. Builds in a staging directory and renames it into place, so a
 * half-created Node is never observable.
 *
 * `attachment` ({@link attach}'s `{filename, content}`, F74/#163) is written
 * into the staging directory too, so the node is PUBLISHED COMPLETE: body and
 * file arrive in the same rename, and there is no visible state where the gist
 * exists without the payload it names. Attaching after the rename instead
 * (codex review round 2 of #165) left three defects behind it — a peer could
 * update the freshly discoverable node before the file landed, a `supersedes`
 * create would overwrite an inherited file of the same name because the
 * collision-safe move in {@link supersede} had already run, and the rollback
 * that unpublishes a gated reject had to guess which files were its own. All
 * three are gone when the file is part of what is renamed into place.
 *
 * @returns the new node's id.
 */
export async function createNode(root, { description, body = '', type, attachment, now = Date.now() }) {
  const desc = assertDescription(description)
  const nodeType = assertType(type)
  // Validated BEFORE any staging exists, so a bad attachment leaves no
  // directory to clean up — same reason the description and type are.
  let attachmentName
  if (attachment !== undefined) {
    attachmentName = assertAttachmentName(attachment.filename)
    if (typeof attachment.content !== 'string') throw new Error('attachment content must be a string')
    const bytes = Buffer.byteLength(attachment.content, 'utf8')
    if (bytes > ATTACH_MAX_BYTES) throw new Error(`content too large (${bytes} bytes, max ${ATTACH_MAX_BYTES}) — attachments are capped; split or trim`)
  }
  await fsp.mkdir(root, { recursive: true })
  let id = ulid(now)
  // Regenerate on the (practically impossible) collision.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.access(path.join(root, id))
      id = ulid(now)
    } catch {
      break
    }
  }
  const staging = path.join(root, `.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
  await fsp.rm(staging, { recursive: true, force: true })
  // Every staging write sits inside the cleanup scope, not just the rename
  // (codex pre-merge review of #165): a payload that the filesystem refuses
  // late — a name past NAME_MAX, ENOSPC — would otherwise abandon a hidden
  // `.staging-*` holding node.md and a partial file, once per failed attempt.
  try {
    await fsp.mkdir(path.join(staging, '__edges__'), { recursive: true })
    await fsp.writeFile(path.join(staging, 'node.md'), renderNode({ description: desc, created: today(now), type: nodeType, body: normalizeBody(body) }), 'utf8')
    // Inside staging, so it needs no stage-and-rename of its own: the node's own
    // publication rename is what makes it visible, together with the body.
    if (attachmentName !== undefined) await fsp.writeFile(path.join(staging, attachmentName), attachment.content, 'utf8')
    crashAt('createnode-before-rename')
    await fsp.rename(staging, path.join(root, id))
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true })
    throw error
  }
  return id
}

/**
 * The one-deep pre-rewrite snapshot a body change leaves behind (F59, #103).
 * QA pass 6 / ledger #33 counted three live losses in one pass through the
 * in-place `memory_write`+`id`+`body` path — a wrong-target update conflating
 * two threads, a retraction rewritten in place, two ignored `dropped_body`
 * advisories — and an in-place write keeps no history, so nothing could be
 * put back. The F47 advisories stay the model-facing surface; this file is
 * the operator's safety net: the full prior `node.md`, one deep, overwritten
 * on the next body change. Dot-prefixed on purpose — every listing surface
 * already hides dotfiles ({@link extraFiles}, the search scan, the bash
 * helpers) and {@link assertAttachmentName} rejects leading dots, so no
 * attachment can claim the name and `moveExtraFiles` never chases it to a
 * successor. Archive and merge move the node dir wholesale, so the snapshot
 * lives and dies with its node. Concurrent updates keep the same
 * last-writer-wins posture every node.md write already accepts (ledger #9,
 * single-user process): the last body change's prior is the snapshot that
 * survives.
 */
export const PREV_NODE_FILE = '.node.md.prev'

/**
 * Replace a Node's description and/or body, leaving `created` and its edges
 * alone. A content change stamps `updated` with today so time-of-change
 * questions have an anchor that `created` (frozen at birth) cannot give; a
 * links-only call — where neither field is passed — leaves `updated` untouched.
 * A body change first snapshots the prior `node.md` to {@link PREV_NODE_FILE};
 * description-only, type-only, and no-op calls write no snapshot.
 */
export async function updateNode(root, id, { description, body, type }, now = Date.now()) {
  assertId(id)
  // Read the raw BYTES rather than loadNode: on a body change the snapshot
  // below must be byte-identical to what was on disk, and neither a re-render
  // nor a decode round-trip is that — parseNode strips the body's leading
  // newlines and normalizes frontmatter an external writer may have shaped
  // differently, and decoding invalid UTF-8 mints U+FFFD, so a hand-damaged
  // byte would survive in NEITHER file. The Buffer passes through writeAtomic
  // untouched (fs ignores an encoding when given a Buffer); only the parse
  // for this update's own logic decodes.
  let raw
  try {
    raw = await fsp.readFile(path.join(root, id, 'node.md'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (raw === undefined) throw new Error(`node does not exist: ${id}`)
  const current = parseNode(raw.toString('utf8'))
  const nextDescription = description === undefined ? current.description : assertDescription(description)
  // Incoming bodies only (F63, #108): what is already on disk is left exactly
  // as it is, so an omitted `body` — or a legacy node stored before this guard
  // — never rewrites itself under a links-only or type-only call, and never
  // burns the one-deep snapshot on a change the caller did not ask for.
  const nextBody = body === undefined ? current.body : normalizeBody(body)
  // A `type` argument is opt-in: absent leaves the stored classification alone;
  // an empty string clears it; any other value must be a valid enum member.
  const nextType = type === undefined ? current.type : (assertType(type) ?? '')
  // Compare resolved values, not argument presence: an idempotent replay that
  // passes the existing content must not falsify the change date.
  const changed = nextDescription !== current.description || nextBody !== current.body || nextType !== current.type
  const next = {
    description: nextDescription,
    created: current.created,
    updated: changed ? today(now) : current.updated,
    type: nextType,
    // Preserve frontmatter keys this layer does not own — a write that dropped
    // them would silently lose anything an agent or shell added to node.md.
    extra: current.extra,
    body: nextBody,
  }
  // Snapshot BEFORE the node.md write, and strictly — a snapshot failure fails
  // the update (F59, #103). The write is atomic in the same directory, so a
  // crash between the two leaves the old node.md intact plus a redundant
  // snapshot: never a lost body. Body changes only — a description or type
  // edit destroys nothing the F47/F52 loss class is about.
  if (nextBody !== current.body) {
    await writeAtomic(path.join(root, id, PREV_NODE_FILE), raw)
  }
  await writeAtomic(path.join(root, id, 'node.md'), renderNode(next))
  return next
}

/**
 * Non-destructively mark an old node as superseded by a new one (F4, #13).
 *
 * The old body is left intact — a one-line banner (`Superseded by <new-id> on
 * <date>.`) is prepended above it via {@link updateNode}, so `updated:` stamps
 * and any frontmatter this layer does not own survives. The banner date is the
 * same date {@link updateNode} stamps into `updated:`, derived from one clock
 * reading (`now`) so the two can never disagree. Idempotent per new id: a
 * banner already naming `newId` is a no-op, but a banner for a *different*
 * new id does not block adding this one — a node can be superseded more than
 * once, each supersession on record.
 *
 * Attachments FOLLOW the supersession (F41, #61): the old node's agent-space
 * files move into the successor's dir, collision-safe, exactly as
 * {@link mergeNodes} moves them — bulk detail must live on the node a reader
 * is steered toward, not stay stranded behind a deranked `[superseded by …]`
 * marker (round-4 #23's failed lookup was against exactly such a file). The
 * move runs on the `already` path too, so a file attached to the old node
 * after its banner still catches up with the live head on the next call —
 * and ONLY the live head: re-running an older supersession moves nothing.
 *
 * Locking contract: the caller must hold one top-level
 * `withNodeLocks(root, sorted([oldId, newId]))` scope. This low-level
 * primitive performs no locking of its own.
 *
 * `receipts`, when given, is the caller's per-invocation receipt: one record
 * per real transition THIS call committed, pushed the moment the durable write
 * returns (never derived from a later disk read, which another writer can
 * invalidate in between). Two shapes, one per exit:
 *
 *   - `{kind: 'banner'}` — the banner `updateNode` above returned, so the old
 *     node's body now names this successor. Pushed BEFORE `moveExtraFiles`,
 *     because the banner is the transition a caller records; a later move
 *     failure rolls the moved files back but never un-writes the banner.
 *   - `{kind: 'already'}` — the `already` path's own exit, pushed BEFORE its
 *     (fallible) late-file move: nothing transitioned, so a caller logs
 *     nothing, but a caller must not mistake the move's throw for "supersede
 *     never returned" and record the call's edge-their receipts (#321 review).
 *
 * @returns `{ status, files_moved }` on an idempotent no-op, or additionally
 *   `oldNode` — the exact Node written — when a banner is added. `status` is
 *   `'banner-added'` when the banner was written, `'already'` when one naming
 *   `newId` was present; `files_moved` counts attachments moved to the successor.
 */
export async function supersede(root, oldId, newId, now = Date.now(), receipts) {
  assertId(oldId, 'superseded node id')
  assertId(newId, 'superseding node id')
  if (oldId === newId) throw new Error(`a node cannot supersede itself: ${oldId}`)
  const old = await loadNode(root, oldId)
  if (old === undefined) throw new Error(`cannot supersede: node does not exist: ${oldId}`)
  // Guard direct callers too: a banner must never point at a successor that
  // is not actually in the graph.
  if (await loadNode(root, newId) === undefined) throw new Error(`cannot supersede: successor does not exist: ${newId}`)
  const banner = `Superseded by ${newId} on ${today(now)}.`
  // Idempotent on the (old, new) pair: a banner already naming this new id is a
  // no-op regardless of its date, so a re-run never stacks a second copy. A
  // banner naming a *different* new id may coexist — a node can be superseded
  // more than once, and each supersession stays on record.
  const prefix = `Superseded by ${newId} on `
  const already = old.body.split('\n').some((line) => line.trim().startsWith(prefix))
  if (already) {
    // Nothing transitioned, and that is final: report it BEFORE the late-file
    // move below, which can throw and would otherwise read to a caller as
    // "supersede never returned" (#321 review).
    receipts?.push({ kind: 'already' })
    // Late files chase only the LIVE head: re-running an OLDER supersession
    // must not drag attachments to a stale successor when a newer banner names
    // the current one (codex review of this change).
    const moved = supersededBy(old.body) === newId ? await moveExtraFiles(root, oldId, newId) : 0
    return { status: 'already', files_moved: moved }
  }
  const body = old.body.length > 0 ? `${banner}\n\n${old.body}` : banner
  const oldNode = await updateNode(root, oldId, { body }, now)
  // The banner is durable from here on: report it before the attachment move,
  // which can fail and roll itself back but never un-writes the banner.
  receipts?.push({ kind: 'banner' })
  // Exact Node this call wrote, so callers can hash it without re-reading disk
  // after the mutation (F68, #129). Never surface this internal field to a model.
  return { status: 'banner-added', files_moved: await moveExtraFiles(root, oldId, newId), oldNode }
}

/**
 * Move one node's agent-space files into another's dir, collision-safe (F17's
 * merge rule, shared with F41's supersede): a name already present in the
 * destination — its own file, or one an earlier move brought in — is stored as
 * `<from-shortid8>_<name>`, bumping a numeric suffix until the path is free.
 * Near-in-time ULIDs share their first 8 chars, so the plain prefix alone can
 * still collide; never rename onto a live path.
 *
 * @returns how many files moved.
 */
async function moveExtraFiles(root, fromId, toId) {
  const exists = async (p) => {
    try {
      await fsp.access(p)
      return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  }
  const toDir = path.join(root, toId)
  // All-or-nothing: a mid-move failure renames the already-moved files back,
  // so a caller's failure cleanup (memory_write removes a just-created
  // successor when supersede throws) can never delete files that had already
  // left the old node (codex review of this change). A file whose roll-back
  // itself fails survives at its destination — never deleted either way.
  const done = []
  try {
    for (const name of await extraFiles(root, fromId)) {
      let target = path.join(toDir, name)
      if (await exists(target)) {
        const prefix = fromId.slice(0, 8)
        target = path.join(toDir, `${prefix}_${name}`)
        for (let n = 1; await exists(target); n++) target = path.join(toDir, `${prefix}_${n}_${name}`)
      }
      const from = path.join(root, fromId, name)
      await fsp.rename(from, target)
      done.push([from, target])
    }
  } catch (error) {
    for (const [from, target] of done.reverse()) {
      try { await fsp.rename(target, from) } catch { /* survives at target */ }
    }
    throw error
  }
  return done.length
}

/** How far into a body a supersede banner may hide. Deep enough for several
 * stacked banners, shallow enough to cost nothing on a huge body. */
const BANNER_SCAN_LINES = 10

/**
 * The id that superseded this node, read back off its banner (F24, #44), or
 * `undefined` for a node nothing replaced.
 *
 * {@link supersede} prepends `Superseded by <id> on <date>.` and leaves the
 * rest of the body alone, so the newest banner is at the top; a node superseded
 * more than once carries the older ones below it. Only the first
 * {@link BANNER_SCAN_LINES} lines are read — banners live at the top by
 * construction, and a 200KB body must not be walked to answer this on every
 * search row and every index line.
 */
export function supersededBy(body) {
  const lines = (body ?? '').split('\n', BANNER_SCAN_LINES)
  for (const line of lines) {
    const found = /^Superseded by ([0-9A-HJKMNP-TV-Z]{26}) on /.exec(line.trim())
    if (found) return found[1]
  }
  return undefined
}

/**
 * How much a superseded node's rank is cut, in search and in the injected
 * index (F24, #44). A superseded node stays reachable — keeping it readable is
 * the entire point of superseding rather than overwriting — but it must not
 * compete with its own replacement on equal footing in every future prompt.
 */
const SUPERSEDED_PENALTY = 0.5

/**
 * How many times {@link mergeNodes} will re-scan and re-lock a widening
 * third-party set before proceeding with the locks it already holds. A merge
 * that keeps discovering new incoming edges must still terminate; a newcomer
 * left un-repointed becomes a dangling/half edge graph-maintain can heal,
 * never a lock-ordering violation (codex review of #130).
 */
const MERGE_LOCK_ATTEMPTS = 3

/**
 * Node ids beyond `keepId`/`absorbId` whose `.edge-types` sidecar or out-edges
 * {@link mergeNodes} may need to rewrite while repointing: absorb's live
 * out-edge targets (step 2) and every node currently pointing at `absorbId`
 * (step 3). A lock-free scan by design — it exists only to size the single
 * lock request mergeNodes makes before entering its critical section;
 * {@link mergeNodes} re-derives this AFTER locks land, since the graph can move
 * in the gap between this scan and the lock actually being granted (codex
 * review of #130).
 */
async function mergeThirdPartyIds(root, keepId, absorbId) {
  const ids = new Set()
  for (const dst of await outEdges(root, absorbId)) {
    if (dst === keepId) continue
    let dstIsNode = false
    try {
      dstIsNode = (await fsp.stat(path.join(root, dst))).isDirectory()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (dstIsNode) ids.add(dst)
  }
  for (const b of await listIds(root)) {
    if (b === absorbId || b === keepId) continue
    if ((await outEdges(root, b)).includes(absorbId)) ids.add(b)
  }
  return ids
}

/**
 * Merge the `absorb` node into `keep` (F17, #26): fold one duplicate memory into
 * another, then archive the absorbed one. Provenance is bidirectional and
 * durable — a "Merged from" note appended to keep's body, and a "Merged into"
 * banner prepended to the archived absorb's body.
 *
 * Steps, in order:
 *  1. keep's body gains `\n\n---\nMerged from <absorb> on <date>:\n\n<absorb body>`
 *     via {@link updateNode}, so `updated:` stamps.
 *  2. keep inherits absorb's outgoing edges (with their types), skipping any it
 *     already has and never wiring a keep→keep self-edge.
 *  3. every live node pointing at absorb is repointed at keep (preserving that
 *     edge's type), and its old edge to absorb is detached. keep pointing at
 *     absorb is just dropped — no self-edge.
 *  4. absorb's agent-space files move into keep's dir; a name collision is
 *     stored as `<absorb-shortid8>_<name>` so nothing is overwritten.
 *  5. absorb gets a `Merged into <keep> on <date>.` banner and is moved into
 *     `.archive/` exactly as `graph-maintain` archives.
 *
 * No live keep→absorb edge is created on purpose: absorb is archived in the same
 * call, so such an edge would immediately dangle. The "Merged from" note in keep
 * and the "Merged into" banner on the archived absorb are the durable link.
 *
 * Locking contract: mergeNodes acquires every lock it needs itself in one
 * internally-sorted {@link withNodeLocks} call, sized by an unlocked pre-scan
 * and re-verified after the locks land. If the set widens in that gap, it
 * releases and retries up to {@link MERGE_LOCK_ATTEMPTS} times. Callers must
 * NOT pre-lock keepId, absorbId, or any other node before calling mergeNodes;
 * that would reintroduce the nested acquisition this contract prevents.
 *
 * `receipts`, when given, is the caller's per-invocation receipt: one record
 * per real transition THIS merge committed, pushed the moment the durable write
 * returns (never from a re-read of disk). Two shapes, in commit order:
 *
 *   - `{kind: 'merge-keep'}` — keep's body gained the `Merged from` block;
 *   - `{kind: 'merge-absorb'}` — absorb's body gained the `Merged into` banner,
 *     pushed BEFORE the archive rename: the banner is on disk either way, so a
 *     rename failure leaves a live, bannered absorb that is still reported.
 *
 * A merge that throws before keep's `updateNode` returns pushes nothing; one
 * that throws between the two lands `merge-keep` alone (a partial merge whose
 * note really is in keep's body — its retry double-appends, which the caller's
 * own partial-state handling reports). Edge repoints on third-party nodes are
 * NOT reported: the design logs a merge as the two node lines, and a repointed
 * edge's own halves follow from them. `minted` is deliberately not threaded
 * into performMerge's internal `addEdge` calls for the same reason.
 *
 * @returns `{ keep_id, absorb_id, merged: true, edges_repointed, files_moved,
 *   keepNode }`, where `edges_repointed` counts incoming edges moved onto keep
 *   and `keepNode` is the exact Node written for caller-side hashing.
 */
export async function mergeNodes(root, keepId, absorbId, now = Date.now(), receipts) {
  assertId(keepId, 'keep node id')
  assertId(absorbId, 'absorb node id')
  if (keepId === absorbId) throw new Error('cannot merge a node into itself')
  // loadNode only finds LIVE nodes (archived ones live under .archive/), so a
  // missing-or-archived id fails here before anything is mutated.
  const keep = await loadNode(root, keepId)
  if (keep === undefined) throw new Error(`cannot merge: keep node does not exist (or is archived): ${keepId}`)
  const absorb = await loadNode(root, absorbId)
  if (absorb === undefined) throw new Error(`cannot merge: absorb node does not exist (or is archived): ${absorbId}`)

  let held = new Set([keepId, absorbId, ...(await mergeThirdPartyIds(root, keepId, absorbId))])
  for (let attempt = 1; attempt <= MERGE_LOCK_ATTEMPTS; attempt++) {
    const outcome = await withNodeLocks(root, [...held], async () => {
      const current = new Set([keepId, absorbId, ...(await mergeThirdPartyIds(root, keepId, absorbId))])
      const grew = [...current].some((id) => !held.has(id))
      if (grew && attempt < MERGE_LOCK_ATTEMPTS) return { retry: current }
      return { result: await performMerge(root, keepId, absorbId, keep, absorb, held, now, receipts) }
    })
    if (outcome.result !== undefined) return outcome.result
    held = outcome.retry
  }

  // Unreachable: the loop always returns on its final attempt regardless of
  // whether the re-scan grew. Fail loudly if a future loop change breaks that.
  throw new Error('mergeNodes: exhausted lock-set retries without completing')
}

/** Perform a merge while `held` describes the one complete lock snapshot. */
async function performMerge(root, keepId, absorbId, keep, absorb, held, now, receipts) {
  const when = today(now)

  // (1) Concatenate bodies with a provenance divider; updateNode stamps updated.
  const mergedBody = `${keep.body}\n\n---\nMerged from ${absorbId} on ${when}:\n\n${absorb.body}`
  const keepNode = await updateNode(root, keepId, { body: mergedBody }, now)
  // Keep's body is durable from here on: report it before anything else can
  // throw (a partial merge keeps this note, so it must keep its receipt).
  receipts?.push({ kind: 'merge-keep' })

  // (2) keep inherits absorb's out-edges (with type), skipping ones it has.
  // Types resolve through edgeTypeOf, so a symmetric `relates-to` whose
  // canonical line lives on the peer's side is inherited too (F54, #90).
  const keepOut = new Set(await outEdges(root, keepId))
  const absorbOut = await outEdges(root, absorbId)
  for (const dst of absorbOut) {
    if (dst === keepId || keepOut.has(dst)) continue
    // A dangling out-edge (its target node was deleted) carries nothing to
    // inherit, and addEdge would throw ("target node does not exist"). Since
    // step (1) has already appended provenance to keep, that abort would leave
    // a half-merged keep whose retry double-appends the note — so skip a dst
    // whose node dir is gone and keep the merge all-or-nothing.
    let dstIsNode = false
    try {
      dstIsNode = (await fsp.stat(path.join(root, dst))).isDirectory()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!dstIsNode) continue
    if (!held.has(dst)) continue
    const type = await edgeTypeOf(root, absorbId, dst)
    await addEdge(root, keepId, dst, { type })
  }

  // (3) Repoint every live incoming edge B→absorb to B→keep, then detach B's
  // edge to absorb. keep→absorb is only dropped — a keep→keep edge is nonsense.
  // Still a whole-graph scan on purpose: a legacy single-direction edge and a
  // directed typed edge point at absorb without appearing in absorb's own
  // `__edges__/`, and a merge must repoint those too. Merge is a rare,
  // explicitly-invoked operation; the hot read path no longer scans (F54).
  let edges_repointed = 0
  for (const b of await listIds(root)) {
    if (b === absorbId) continue // absorb's own edges are handled above / archived with it
    if (!(await outEdges(root, b)).includes(absorbId)) continue
    if (!held.has(b)) continue
    if (b !== keepId) {
      const type = await edgeTypeOf(root, b, absorbId)
      await addEdge(root, b, keepId, { type })
      edges_repointed++
    }
    // When absorb is the LARGER id, the pair's canonical symmetric line lives
    // on B — the live peer whose half is about to be detached. Copy it onto
    // absorb first (only if absorb holds the reverse symlink to carry it, and
    // only into an empty slot), so the archived node keeps its own typed
    // record and a later restore returns the edge typed, not stripped (codex
    // review of #119). Directed lines on B are B's own edges, never copied.
    const peerLine = (await edgeTypes(root, b)).get(absorbId)
    if (peerLine !== undefined && !DIRECTED_EDGE_TYPES.includes(peerLine)
      && absorbOut.includes(b) && !(await edgeTypes(root, absorbId)).has(b)) {
      await setEdgeType(root, absorbId, b, peerLine)
    }
    // Detach only B's half: absorb's own symlinks and sidecar lines archive
    // WITH absorb (see detachHalf) — they are its record, dangling or not.
    await detachHalf(root, b, absorbId)
  }

  crashAt('merge-after-repoint-before-move')

  // (4) Move absorb's agent-space files into keep — collision-safe via the
  // shared helper (see moveExtraFiles; supersede uses the same rule).
  const files_moved = await moveExtraFiles(root, absorbId, keepId)

  crashAt('merge-after-move-before-archive')

  // (5) Banner the absorbed node and archive it. Its own outgoing symlinks are
  // left as-is; they dangle from the archive exactly like any archived node's.
  await updateNode(root, absorbId, { body: `Merged into ${keepId} on ${when}.${absorb.body.length > 0 ? `\n\n${absorb.body}` : ''}` }, now)
  // The banner is durable: report it BEFORE the archive rename, so an archive
  // failure leaves a live absorb whose banner is still on disk and logged.
  receipts?.push({ kind: 'merge-absorb' })
  await fsp.mkdir(path.join(root, ARCHIVE_DIR), { recursive: true })
  await fsp.rename(path.join(root, absorbId), path.join(root, ARCHIVE_DIR, absorbId))

  // Exact Node this call wrote, so callers can hash it without re-reading disk
  // after the mutation (F68, #129). Never surface this internal field to a model.
  // `absorbedBody`/`keptBody` are the two halves as they stood BEFORE the
  // append (F72, #152; codex pre-merge review of #162): the merge advisory
  // needs the boundary, and re-finding it by scanning the merged body for
  // the divider picks the wrong one when an absorbed body quotes an older
  // `Merged from …` header of its own. Bookkeeping for the caller, like
  // `keepNode` — not part of the tool result.
  return { keep_id: keepId, absorb_id: absorbId, merged: true, edges_repointed, files_moved, keepNode, keptBody: keep.body, absorbedBody: absorb.body }
}

/**
 * The name of the per-node edge-type sidecar (F3, #12). It lives inside a
 * node's `__edges__/` beside the edge symlinks, one line per typed edge:
 * `<dst-id> <type>\n`. A dotfile on purpose: every existing reader filters edge
 * names by {@link ULID_RE} and `graph-maintain` skips `.`-prefixed entries, so
 * the sidecar is invisible to them and the on-disk format stays back-compat —
 * an absent line means the edge is untyped.
 */
const EDGE_TYPES_FILE = '.edge-types'

/**
 * The types of one node's outgoing edges, as `Map<dst, type>`. Parses the
 * `.edge-types` sidecar; a node with no typed edges (no sidecar) yields an
 * empty Map at the cost of one `ENOENT`. Malformed and non-enum lines are
 * skipped rather than thrown on, so a hand-edited or partially-written sidecar
 * degrades to "untyped" for the offending edge instead of breaking a read;
 * `graph-maintain` is the surface that reports such lines as integrity issues.
 */
export async function edgeTypes(root, src) {
  assertId(src, 'source node id')
  const map = new Map()
  let text
  try {
    text = await fsp.readFile(path.join(root, src, '__edges__', EDGE_TYPES_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return map
    throw error
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const dst = line.slice(0, sp)
    const type = line.slice(sp + 1).trim()
    // Skip anything that is not a well-formed `<ulid> <known-type>` pair: the
    // consumers below feed this straight back into assertEdgeType/addEdge, so a
    // bad value must never enter the Map.
    if (!ULID_RE.test(dst) || !EDGE_TYPES.includes(type)) continue
    map.set(dst, type)
  }
  return map
}

/**
 * Upsert the type of the edge `src -> dst` in the `.edge-types` sidecar. The
 * whole sidecar is rewritten atomically (stage-and-rename) from the parsed Map,
 * so a reader never observes a half-written file and a re-set of the same edge
 * replaces its line in place. Ids and the type are validated first; the sidecar
 * is written with its lines sorted by dst for a stable, diff-friendly layout.
 *
 * Low-level, side-blind on purpose: it writes exactly where it is pointed.
 * {@link addEdge} is the writer that knows the F54 topology — directed types
 * on the source, symmetric `relates-to` on the lexicographically smaller side
 * — so edges are typed through it; a direct call that puts a `relates-to`
 * line on the larger side creates the wrong-side residue `graph-maintain`
 * exists to move.
 */
export async function setEdgeType(root, src, dst, type) {
  assertId(src, 'source node id')
  assertId(dst, 'target node id')
  assertEdgeType(type)
  const map = await edgeTypes(root, src)
  map.set(dst, type)
  const edges = path.join(root, src, '__edges__')
  await fsp.mkdir(edges, { recursive: true })
  const body = [...map.keys()].sort().map((id) => `${id} ${map.get(id)}`).join('\n')
  await writeAtomic(path.join(edges, EDGE_TYPES_FILE), `${body}\n`)
}

/**
 * Remove ONE half of an edge: the `src -> dst` symlink and any matching
 * `.edge-types` line on `src`'s side, so a detached half leaves no orphan
 * type behind. One-sided ON PURPOSE (opus review of F54, #90): the only
 * caller is {@link mergeNodes}, detaching a live node's edge to the absorbed
 * node — the absorbed node's OWN symlinks and sidecar lines are part of what
 * archives with it (they dangle from `.archive/`, exactly as any archived
 * node's do), and scrubbing them here would make a later `memory_restore`
 * come back with less than was stored. Tolerates an already-gone symlink
 * (rm -f semantics). The sidecar is rewritten sorted (or deleted when it
 * would be empty) exactly as {@link setEdgeType} writes it.
 */
async function detachHalf(root, src, dst) {
  await fsp.rm(path.join(root, src, '__edges__', dst), { force: true })
  await dropTypeLine(root, src, dst)
}

/**
 * Remove `owner`'s `.edge-types` line for `peer`, if any — the sidecar is
 * rewritten sorted, or deleted when it would be empty, exactly as
 * {@link setEdgeType} writes it. The line-removal half of {@link detachHalf},
 * also used on its own when a directed type supplants a symmetric line that
 * lives on the other endpoint.
 */
async function dropTypeLine(root, owner, peer) {
  const types = await edgeTypes(root, owner)
  if (!types.has(peer)) return
  types.delete(peer)
  const file = path.join(root, owner, '__edges__', EDGE_TYPES_FILE)
  if (types.size === 0) {
    await fsp.rm(file, { force: true })
    return
  }
  const body = [...types.keys()].sort().map((id) => `${id} ${types.get(id)}`).join('\n')
  await writeAtomic(file, `${body}\n`)
}

/**
 * Connect `src` and `dst`. Idempotent: an already-correct edge is a no-op, a
 * wrong target or a non-symlink occupant is an error rather than a silent fix.
 *
 * A plain edge — and a `relates-to` one — is ONE logical edge stored as TWO
 * symlinks (F54, #90): `src/__edges__/dst` and `dst/__edges__/src`, each
 * targeting `../../<peer>`. Writing A→B when B→A already exists completes the
 * pair and reports `'exists'` — the reverse-duplicate class dies by
 * construction, not by guard. The two symlink() calls are not atomic together;
 * a crash between them leaves a half-edge that `graph-maintain` detects and
 * completes (the intent to link was recorded — see the F54 ADR).
 *
 * A {@link DIRECTED_EDGE_TYPES} type keeps its direction: a single one-way
 * symlink plus a sidecar line on the source, exactly as before.
 *
 * With `{ type }` the edge is recorded in the `.edge-types` sidecar (F3, #12)
 * once the symlinks are known to exist. For the symmetric `relates-to` the
 * line lives on the LEXICOGRAPHICALLY SMALLER id's side only — one canonical
 * home, so the two sides can never disagree. The type is validated up front so
 * a bad value never leaves a symlink with no matching sidecar line behind it.
 *
 * `minted`, when given, is the caller's per-invocation receipt: `addEdge`
 * pushes one record per real mutation THIS call made, and nothing for a no-op:
 *
 *   - `{src, dst}` — a symlink half this call created. The only way a caller
 *     can tell a half-edge repair ('exists', but a real mutation) from a no-op,
 *     and it is what provenance logs — never a before/after guess, which
 *     another writer can invalidate between the two reads;
 *   - `{src, dst, type, previous}` — an `.edge-types` slot this call actually
 *     changed, on the side that changed (`src` owns the slot, `dst` is the
 *     peer, `previous` is what it held before). Both halves already existing
 *     does not make a retype a no-op: the sidecar IS the edge's type record, so
 *     a plain pair that becomes `follows-from` is a real mutation with no
 *     symlink to show for it.
 *
 * @returns `'created'` when the logical edge is new, `'exists'` when either
 *   half was already present (including a pair completed by this call).
 */
export async function addEdge(root, src, dst, { type, minted } = {}) {
  assertId(src, 'source node id')
  assertId(dst, 'target node id')
  if (src === dst) throw new Error('an edge from a node to itself carries no information')
  if (type !== undefined) assertEdgeType(type)
  for (const [id, label] of [[src, 'source'], [dst, 'target']]) {
    try {
      const stat = await fsp.stat(path.join(root, id))
      if (!stat.isDirectory()) throw new Error(`${label} node is not a directory: ${id}`)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${label} node does not exist: ${id}`)
      throw error
    }
  }
  // Ensure one half — `from/__edges__/to -> ../../to` — exists and is correct.
  // Returns whether this call created it.
  const ensureHalf = async (from, to) => {
    const edges = path.join(root, from, '__edges__')
    await fsp.mkdir(edges, { recursive: true })
    const link = path.join(edges, to)
    const want = `../../${to}`
    let existing
    try {
      existing = await fsp.readlink(link)
    } catch (error) {
      if (error.code === 'EINVAL') throw new Error(`non-symlink already occupies edge slot: ${from} -> ${to} (not an edge; graph-maintain reports it, and --apply repairs an empty one)`)
      if (error.code !== 'ENOENT') throw error
    }
    if (existing !== undefined) {
      if (existing !== want) throw new Error(`edge exists with wrong target: ${from} -> ${existing} (want ${want})`)
      return false
    }
    await fsp.symlink(want, link)
    minted?.push({ src: from, dst: to })
    return true
  }
  const directed = type !== undefined && DIRECTED_EDGE_TYPES.includes(type)
  const createdForward = await ensureHalf(src, dst)
  // The reverse half of a symmetric edge. Forward first, so a crash between
  // the two leaves the caller's own stated direction on disk for the repair
  // pass to complete.
  let createdReverse = false
  if (!directed) {
    crashAt('addedge-between-symlinks')
    createdReverse = await ensureHalf(dst, src)
  }
  const status = directed
    ? (createdForward ? 'created' : 'exists')
    : (createdForward && createdReverse ? 'created' : 'exists')
  // Only record the type once the edge symlinks are known to exist — the
  // sidecar is meaningful only for an edge that is actually present.
  // `recordType` is the one place that both writes a slot and reports it on the
  // receipt, and it writes only when the slot's VALUE actually changes: an
  // identical repeated typed link is still a no-op with nothing to report.
  const recordType = async (owner, peer, next) => {
    const previous = (await edgeTypes(root, owner)).get(peer)
    if (previous === next) return
    await setEdgeType(root, owner, peer, next)
    minted?.push({ src: owner, dst: peer, type: next, previous })
  }
  if (type !== undefined) {
    if (directed) {
      await recordType(src, dst, type)
      // A directed type REPLACES any symmetric record of the same pair, on
      // whichever side it lives. When `src` is the smaller id the upsert
      // above already replaced it; when `src` is the LARGER, the canonical
      // `relates-to` line sits on the peer — leaving it there would let the
      // two endpoints report different types for one edge while maintain
      // says clean (codex review of #119). Only a SYMMETRIC line is cleared:
      // a directed line over there is a separate reverse directed edge.
      const peerHeld = (await edgeTypes(root, dst)).get(src)
      if (peerHeld !== undefined && !DIRECTED_EDGE_TYPES.includes(peerHeld)) {
        await dropTypeLine(root, dst, src)
        // The dropped line was a real change to the PEER's record too.
        minted?.push({ src: dst, dst: src, type: undefined, previous: peerHeld })
      }
    } else {
      // Symmetric type: canonical home is the lexicographically smaller id.
      const [lo, hi] = src < dst ? [src, dst] : [dst, src]
      const held = (await edgeTypes(root, lo)).get(hi)
      // A directed line already in the canonical slot is the more specific
      // record (e.g. lo already supersedes hi) — leave it; the pair is
      // connected either way and `relates-to` adds nothing a reader needs.
      if (!(held !== undefined && DIRECTED_EDGE_TYPES.includes(held))) {
        await recordType(lo, hi, type)
      }
    }
  }
  return status
}

/**
 * The effective type of the edge between `src` and `dst`, seen from `src`.
 * `src`'s own sidecar wins (a directed type is always recorded there, and so
 * is a canonical `relates-to` when `src` is the smaller id); otherwise the
 * peer's sidecar is consulted for the SYMMETRIC types only — a directed line
 * over there describes the peer's outgoing edge, never this one, so it is
 * never inverted onto `src` (F54, #90). Tolerates a legacy sidecar line still
 * sitting on the non-canonical side, so a graph mid-migration reads the same.
 */
export async function edgeTypeOf(root, src, dst) {
  const own = (await edgeTypes(root, src)).get(dst)
  if (own !== undefined) return own
  const peer = (await edgeTypes(root, dst)).get(src)
  return peer !== undefined && !DIRECTED_EDGE_TYPES.includes(peer) ? peer : undefined
}

/** Record that `src -> dst` was actually traversed; access history drives ranking. */
export async function touchEdge(root, src, dst, now = Date.now()) {
  assertId(src, 'source node id')
  assertId(dst, 'target node id')
  const link = path.join(root, src, '__edges__', dst)
  let target
  try {
    target = await fsp.readlink(link)
  } catch {
    throw new Error(`no such edge: ${src} -> ${dst}`)
  }
  if (target !== `../../${dst}`) throw new Error(`malformed edge target: ${src} -> ${dst}`)
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await appendAccess(root, src, `${dst} ${stamp}\n`)
}

/**
 * Record a direct read — a node opened without arriving from another node.
 *
 * The line goes in the node's OWN access log with itself as the target
 * (`<id> <ts>`): a self-reference is the reserved marker for a direct read,
 * structurally impossible for a traversal since self-edges are forbidden. It
 * keeps the `<target> <ts>` shape both writers' log readers require, so it
 * counts toward the node's own rank and latest-visit timestamp — making the
 * strongest usage signal (this memory answered a question) visible to ranking,
 * staleness, and archive policy — while wiring no edge and touching no other
 * node. A well-formed edge is never a prerequisite, so no self-edge is created.
 */
export async function touchRead(root, id, now = Date.now()) {
  assertId(id)
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await appendAccess(root, id, `${id} ${stamp}\n`)
}

/**
 * One node with everything an agent needs to decide where to go next.
 *
 * `edges` lists each logical edge ONCE, as peers: symmetric edges (plain and
 * `relates-to`) have their reverse symlink in this node's own `__edges__/` by
 * construction (F54, #90), so "what points here" and "what does this point
 * at" are the same directory read — the O(n) whole-graph backlink scan this
 * function used to run (the known scaling limit: ~640ms projected at 50k
 * nodes) is gone, and with it the separate `backlinks` list: on a migrated
 * graph it named exactly the peers already listed. What a directory read
 * cannot see — a directed edge pointing here (`supersedes`, whose banner on
 * this node's body already names the successor, or a `follows-from`), and a
 * legacy single-direction edge `graph-maintain --apply` has not yet
 * symmetrized — is the accepted residue, visible from the pointing node.
 *
 * A typed edge resolves its type through the sidecar on either side: this
 * node's own first (directed types and canonical `relates-to` when this id is
 * the smaller), then the peer's for the symmetric types only — a directed
 * type is never inverted onto the node it points at.
 */
export async function readNode(root, id) {
  const node = await loadNode(root, id)
  if (node === undefined) throw new Error(`node does not exist: ${id}`)
  const outs = await outEdges(root, id)
  // Read the own-side sidecar once for the whole edge set (F3, #12) rather
  // than per edge; an untyped node has no sidecar and this is a cheap ENOENT.
  const types = await edgeTypes(root, id)
  const edges = []
  for (const dst of outs) {
    let description
    try {
      description = parseNode(fs.readFileSync(path.join(root, dst, 'node.md'), 'utf8')).description
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      description = '(dangling edge)'
    }
    let type = types.get(dst)
    if (type === undefined) {
      // The symmetric `relates-to` lives on the lexicographically smaller
      // side only; when this node is the larger, the line is the peer's. The
      // lookup fires in BOTH orders on purpose: pre-migration, a legacy line
      // may still sit on the wrong (larger) side, and read-side tolerance of
      // both forms is the contract — one cheap ENOENT per untyped edge is the
      // price. A dangling peer reads as an empty sidecar. Directed types over
      // there describe the peer's own outgoing edge and are never shown here.
      const peer = (await edgeTypes(root, dst)).get(id)
      if (peer !== undefined && !DIRECTED_EDGE_TYPES.includes(peer)) type = peer
    }
    // Omit the `type` key entirely for an untyped edge, so an untyped node's
    // edge objects stay byte-identical to the pre-typed-edges output shape.
    edges.push(type === undefined ? { id: dst, description } : { id: dst, description, type })
  }
  // `extra` is an internal round-trip detail, not part of the node view.
  const { extra, ...view } = node
  return { id, ...view, edges, files: await attachments(root, id) }
}

/** Lowercase word tokens, used for both the query and the searched text. */
export function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter((t) => t.length > 0)
}

/**
 * Rank nodes against a free-text query. A description hit (3) weighs more than
 * a body hit (1), which weighs more than an attachment hit (0.5); an empty
 * query returns the whole graph ranked by recorded use and reads no
 * attachments. A row names the attachments it matched in `matched_in`, QUOTES
 * them in `file_matches` (F81, #182 — text plus the byte offset to resume a
 * `memory_read_file` at), and names the query terms it answered in `matched`;
 * terms no node carried at all come back in `unmatched`. A score the other
 * signals cannot separate breaks NEWEST first, so the tie never costs the most
 * recent node its slot in the `limit` slice (F83 follow-up, #198).
 *
 * `includeArchived` folds the pruned `.archive/` shadow graph into the scan;
 * its hits carry `archived: true` so callers can flag them. It is off by
 * default, and the default path never touches `.archive/` — the extra cost is
 * paid only when the flag is set.
 *
 * `includeAttachments` turns the attachment scan off. The write-time duplicate
 * and link-candidate advisories run through this same scorer, and there a node
 * that merely stores the new node's vocabulary inside a transcript is not
 * related to it — surfacing one would crowd a genuinely related node out of a
 * three-row block.
 */
export async function search(root, query, limit, { includeArchived = false, includeAttachments = true } = {}) {
  const nodes = await loadAll(root)
  if (includeArchived) nodes.push(...await loadArchived(root))
  const counts = await accessCounts(root, { includeArchived })
  const tokens = tokenize(query ?? '')
  const scored = nodes.map((node) => {
    const description = node.description.toLowerCase()
    const body = node.body.toLowerCase()
    // An empty query lists the whole graph by use, so no token can match a
    // file — read no attachment CONTENT rather than score the graph's every
    // attachment zero. (The returned rows still get one readdir each, bounded
    // by `limit`, to advertise the names — that is F2, and predates this.)
    const base = node.archived === true ? path.join(root, ARCHIVE_DIR) : root
    const files = tokens.length === 0 || !includeAttachments ? [] : attachmentText(path.join(base, node.id))
    const matchedIn = []
    // Per matched file, where each query term first landed in it (F81, #182,
    // review round 2). Collected across the WHOLE token loop and resolved after
    // it: which passage best answers the query is not knowable while only the
    // first term has been looked at. See EXCERPT_CHARS for why naming the file
    // was not enough, and bestExcerpt for how one of these becomes the quote.
    const fileHits = new Map()
    // Which query terms this row actually answered (F36, #56). Without it the
    // agent could not see WHY a row came back, so a query that missed was
    // reworded blind — three searches for one question in the round-4 trace.
    const matched = []
    let score = 0
    let hitTokens = 0
    for (const token of tokens) {
      const inDesc = description.includes(token)
      const inBody = body.includes(token)
      let inFile = false
      for (const file of files) {
        let hit
        for (const segment of file.segments) {
          const at = segment.lower.indexOf(token)
          if (at !== -1) { hit = { segment, at, token }; break }
        }
        if (hit === undefined) continue
        inFile = true
        if (!matchedIn.includes(file.name)) matchedIn.push(file.name)
        // One candidate passage per term per file — the raw material the
        // chooser scores once the whole query has been seen.
        const seen = fileHits.get(file.name)
        if (seen === undefined) fileHits.set(file.name, [hit])
        else seen.push(hit)
      }
      if (inDesc) score += 3
      if (inBody) score += 1
      // Once per token, however many files carry it: a term repeated across
      // five attachments is one piece of evidence, not five.
      if (inFile) score += ATTACH_WEIGHT
      if (inDesc || inBody || inFile) {
        hitTokens += 1
        // A term repeated in the query is one term on the row.
        if (!matched.includes(token)) matched.push(token)
      }
    }
    // Now that every term has been placed, quote the passage that answers most
    // of them — in matchedIn order, so the row still leads with the file the
    // earliest query term hit (F81, #182, review round 2).
    const fileMatches = []
    for (const name of matchedIn) {
      if (fileMatches.length >= EXCERPT_FILES) break
      fileMatches.push({ file: name, ...bestExcerpt(fileHits.get(name), tokens) })
    }
    // A node its own replacement made obsolete keeps its rank cut, so the
    // settled decision outranks the one it replaced (F24, #44).
    const supersededBy_ = supersededBy(node.body)
    if (supersededBy_ !== undefined) score *= SUPERSEDED_PENALTY
    return { id: node.id, description: node.description, score, full: hitTokens === tokens.length, uses: counts.get(node.id) ?? 0, body: node.body, archived: node.archived === true, matchedIn, fileMatches, matched, supersededBy: supersededBy_ }
  })
  const hits = tokens.length === 0 ? scored : scored.filter((entry) => entry.score > 0)
  // Nodes matching every query token rank strictly above partial matches — a
  // shared-vocabulary graph otherwise drowns the exact hit in one-token noise.
  // Superseded loses every tie the score did not already settle: an untouched
  // score of 0 (the whole-graph listing) must still put the current node first.
  // The last clause breaks an EXACT tie on descending id — newest first, since
  // a ULID's leading 10 chars are its creation time (F83 follow-up, #198).
  // Exact ties are common at scale (coarse-grained scores, `uses` 0 on most
  // nodes), and oldest-first handed the slice's last slots to the stalest node.
  // The id tie is the index's own comparator (code units, newest first — see
  // compareIdsNewestFirst for why localeCompare would silently invert it).
  hits.sort((a, b) => (b.full - a.full) || b.score - a.score || ((a.supersededBy !== undefined) - (b.supersededBy !== undefined)) || b.uses - a.uses || compareIdsNewestFirst(a.id, b.id))
  // Advertise attachments (F2, #11) only for the matches actually returned —
  // one readdir per row, bounded by `limit` — never a whole-graph file scan.
  // An archived hit's files live under `.archive/<id>`, so resolve its base.
  const top = hits.slice(0, limit)
  const matches = []
  for (const entry of top) {
    const base = entry.archived ? path.join(root, ARCHIVE_DIR) : root
    const files = await extraFiles(base, entry.id)
    matches.push({
      id: entry.id,
      description: entry.description,
      score: entry.score,
      uses: entry.uses,
      // F86 (#201): the snippet is the bulk of a search row's bytes, so the
      // first-non-empty line is capped at 120 rather than 200 — enough to place
      // the node, half the cost. First-line behaviour is unchanged.
      snippet: entry.body.split('\n').find((line) => line.trim().length > 0)?.slice(0, 120) ?? '',
      // Present only when the node carries attachments, so a match with none
      // stays byte-for-byte what it was before this field.
      ...(files.length > 0 ? { files } : {}),
      // Which attachments the query actually hit (F29, #49) — the signal to
      // open the file rather than answer from the body snippet, which may not
      // contain the matched term at all.
      ...(entry.matchedIn.length > 0 ? { matched_in: entry.matchedIn } : {}),
      // What those attachments actually SAY around the hit, with the byte
      // offset to resume a `memory_read_file` at (F81, #182). `matched_in`
      // alone told the model a second call existed; it did not make it, and
      // answered from a body snippet that does not contain the fact.
      ...(entry.fileMatches.length > 0 ? { file_matches: entry.fileMatches } : {}),
      // Which query terms this row answered (F36, #56). Absent on a
      // whole-graph listing, which has no terms to report.
      ...(entry.matched.length > 0 ? { matched: entry.matched } : {}),
      // Only present on archived hits — the default scan never sets it, so a
      // live-graph match stays byte-for-byte what it was before this flag.
      ...(entry.archived ? { archived: true } : {}),
      // The successor's id, present only on a node something replaced (F24,
      // #44). The banner naming it lives in the body, which no search row and
      // no index line shows — so a stale description competed with the settled
      // decision on equal footing in every prompt.
      ...(entry.supersededBy === undefined ? {} : { superseded_by: entry.supersededBy }),
    })
  }
  // Query terms no node in the GRAPH carried, not merely none of the returned
  // rows (F36, #56). A term that matched nothing is the single most useful
  // thing to know before rewording — it names the word to change, instead of
  // leaving the agent to guess differently and search again.
  const everMatched = new Set()
  for (const entry of hits) for (const token of entry.matched) everMatched.add(token)
  const unmatched = []
  for (const token of tokens) if (!everMatched.has(token) && !unmatched.includes(token)) unmatched.push(token)
  return {
    total: hits.length,
    // Zero tokens vacuously "match every term"; report 0 so the render can
    // tell a whole-graph listing apart from a query where everything hit.
    full: tokens.length === 0 ? 0 : hits.filter((entry) => entry.full).length,
    tokens: tokens.length,
    // Present only when some term found nothing, so a fully-matched query's
    // result stays what it was.
    ...(unmatched.length > 0 ? { unmatched } : {}),
    matches,
  }
}

/**
 * Default weights for the blended index ranking (F20, #29). Traversal-dominant
 * on purpose: a node earns its place mostly by being reached from other nodes,
 * with direct reads and recency as tie-breakers that lift a freshly-useful note
 * without letting churn reshuffle the whole index. Exported so the tool layer's
 * config validation and the standalone `graph-maintain` can share the numbers.
 * `recencyWindowDays` is the age at which the recency term decays to zero.
 * `degree` (F84, #194) is the one structural term: edges exist the moment a node
 * is written, so a hub ranks before anyone has read it — in a reference replay 405 of 465
 * nodes carried no access at all and the access terms alone left them tied.
 */
export const DEFAULT_RANK_WEIGHTS = { traversal: 3, read: 2, recency: 1, degree: 1, recencyWindowDays: 180 }

/**
 * Linear recency term for a node, in [0,1]: 1 the day of `latest`, falling to 0
 * at `windowDays` old and staying there. `latest` is a `YYYY-MM-DD` string
 * (updated else created); an empty or unparseable date, or a non-positive
 * window, contributes nothing. `now` is passed in (epoch ms) so the score is a
 * pure function of its inputs — never a hidden `Date.now()` — keeping ranking
 * deterministic and testable.
 */
function recencyDecay(latest, now, windowDays) {
  if (!(windowDays > 0)) return 0
  const ms = parseCalendarDate(latest)
  if (Number.isNaN(ms)) return 0
  const ageDays = (now - ms) / 86_400_000
  // Clamp BOTH bounds: a future `latest` (negative ageDays) would otherwise
  // exceed 1 and let a mis-dated node outweigh a genuinely fresh one.
  return Math.max(0, Math.min(1, 1 - ageDays / windowDays))
}

/**
 * The index tie-break for two node ids: NEWEST first (F83, #193). Exported so
 * the ordering is testable on its own — the ranking tests reach it through
 * whole graphs, where descending `localeCompare` looks identical.
 *
 * Compares code units on purpose. `localeCompare` collates in the process
 * default locale, which is not ULID order: Czech sorts "CH" as one letter
 * after "H", so an older `…CH…` prefix lands after a newer `…D0…` one and a
 * descending sort then keeps the OLDER node. `graph-maintain` compares code
 * points, so this form is also what keeps MAP.md and the injected index in
 * agreement whatever locale the process runs under.
 */
export function compareIdsNewestFirst(a, b) {
  return b < a ? -1 : b > a ? 1 : 0
}

/**
 * Rank loaded nodes into index lines by a blended score (F20, #29; F84, #194):
 * `traversal*traversals + read*reads + recency*recencyDecay(latest) + degree*edges`.
 * `signals` separates the ranking inputs — `{ traversals, reads, degrees }` Maps
 * keyed by node id — so a direct read (F10 self-line), a traversal from
 * elsewhere and the node's edge count carry their own weights. Pure (score
 * depends only on its args and `now`), so both IO shells share it.
 *
 * Ties break NEWEST first (F83, #193). A ULID's first ten chars are its
 * creation time, so descending id is descending creation order — to the
 * minting clock's resolution (ms here, whole seconds in the bash CLI's
 * node-new, where one second's creates fall back to the random suffix). See
 * `compareIdsNewestFirst` for why the comparison is on code units. The old
 * ascending tie-break meant that once a graph outgrew `maxEntries` with most
 * nodes tied at zero signal, the index filled with the OLDEST unread nodes and
 * the newest — the ones a session is most likely to need — were the ones that
 * vanished from every prompt.
 */
function rankIndex(nodes, signals, maxEntries, weights, now, budget) {
  const { traversals, reads, degrees } = signals
  const degreeWeight = weights.degree ?? 0
  const scoreOf = (node) => {
    const t = traversals.get(node.id) ?? 0
    const r = reads.get(node.id) ?? 0
    // `latest` is the most recent content date: updated if the node was revised,
    // else created. parseNode gives '' for a missing field, which decays to 0.
    const latest = node.updated || node.created
    return weights.traversal * t + weights.read * r + weights.recency * recencyDecay(latest, now, weights.recencyWindowDays) + degreeWeight * (degrees?.get(node.id) ?? 0)
  }
  // The supersede banner lives in the body, which the index never shows — so a
  // replaced node's stale description sat in every prompt next to the decision
  // that replaced it, with nothing to tell them apart (F24, #44).
  const scored = nodes.map((node) => {
    const replacedBy = supersededBy(node.body)
    return { node, replacedBy, score: scoreOf(node) * (replacedBy === undefined ? 1 : SUPERSEDED_PENALTY) }
  })
  scored.sort((a, b) => b.score - a.score || ((a.replacedBy !== undefined) - (b.replacedBy !== undefined)) || compareIdsNewestFirst(a.node.id, b.node.id))
  const shown = scored.slice(0, maxEntries)
  // The growth policy (#263 W2.2), when the deployment opted in: the same rank
  // order, rendered in tiers. Absent, the untiered index below is byte-identical
  // to what every deployment has always received.
  const resolved = resolveIndexBudget(budget)
  if (resolved !== undefined) return renderBudgetedIndex(rowsOf(shown), scored, resolved)
  // Truncate defensively: external writers (bash CLI, hand edits) bypass the
  // write-time cap, and one oversized line would bloat every session prompt.
  const lines = shown.map(({ node, replacedBy }) => `${node.id} — ${node.description.length > 500 ? node.description.slice(0, 500).replace(/[\uD800-\uDBFF]$/, '') + '…' : node.description}${replacedBy === undefined ? '' : ` [superseded by ${replacedBy}]`}`)
  if (scored.length > shown.length) lines.push(`… ${scored.length - shown.length} more nodes; call memory_search to reach them.`)
  return lines
}

/**
 * The index growth policy (#263 W2.2): how the index spends its characters.
 *
 * The index is re-sent on EVERY call — ~6 calls per read run, ~6.5–7 per manage
 * run — so its size is a per-run multiplier, not a one-off. On the test_1 graph
 * (58 nodes, 15 Oct–2 Nov 2026) the untiered index was 22,223 characters and
 * 7,360 cl100k tokens, a quarter to a third of the whole system prompt. The
 * node count only goes up, so a cap on the NUMBER of rows (`maxIndexEntries`,
 * default 200) does not bound anything real: at 200 rows the same shape is
 * ~25k characters, and an uncapped graph reaches it with ordinary use.
 *
 * So the policy bounds the INDEX, not the node count, with three tiers over the
 * SAME rank order (rank is what makes the index useful — it is a discovery
 * surface, not a catalogue):
 *
 *   tier 1  `tier1` rows with the full description — the strongest rows, which
 *           are the ones a session actually opens without searching;
 *   tier 2  the next `tier2` rows with the description clipped at a word
 *           boundary to `clipChars` — enough to RECOGNISE a node and decide to
 *           open it (`memory_search` prints 200-char snippets, so a shorter
 *           index line is not a new loss of precision);
 *   beyond  nothing, and one footer line saying how many nodes are not shown and
 *           that `memory_search` reaches them.
 *
 * Two invariants:
 *
 *  - OPEN WORK STATE IS NEVER LOST. `handoff` nodes are rendered by their own
 *    uncapped banner ABOVE the index (`computeHandoffs` in index.js), so no
 *    budget can drop one. `thread` nodes — the other live work-state kind — have
 *    no separate surface, so EVERY live (not superseded) thread row that falls
 *    outside tiers 1–2 is retained in a trailing group, uncapped, in rank order,
 *    clipped like tier 2. Retention is deliberately NOT a fixed slot count: a
 *    cap would silently drop exactly the open threads the guarantee exists for
 *    (codex review of this change reproduced it with the 4th thread). Its rows
 *    are drawn from the FULL ranked set, not from the `maxIndexEntries` window,
 *    so an outer cap cannot hide a thread the tiers would otherwise rescue.
 *
 *    This means the lever's size guarantee is on the TIERS, not on the whole
 *    section: a thread-heavy graph can render LARGER than untiered, because every
 *    thread is retained at up to `clipChars`. Cost grows linearly with the
 *    open-thread count. Keeping one open handoff per thread and closing finished
 *    threads bounds this in practice, but the plugin does not enforce it.
 *
 *  - RANK ORDER IS PRESERVED inside and across the tiers. Tier 2 is the same
 *    list continued, never a re-sort.
 *
 * The constants below are the whole policy: full rows, clipped rows and the
 * maximum clipped-description length. Retained work-state rows add context
 * beyond that budget; the tiers never cap open work.
 *
 * `undefined` (the default) means the untiered index every deployment has always
 * received. `indexBudget` is opt-in and never implied: absent must stay
 * byte-identical.
 */
export const INDEX_BUDGET = Object.freeze({
  /** Rows rendered with the full description. */
  tier1: 15,
  /** Rows rendered with a clipped description, continuing the same rank order. */
  tier2: 25,
  /** The longest a tier-2 description may be, clipped at a word boundary. */
  clipChars: 80,
})

/** Fill in any field a caller left out of an `indexBudget` value. */
function resolveIndexBudget(budget) {
  if (budget === true) return INDEX_BUDGET
  if (budget === false || budget === undefined) return undefined
  if (typeof budget !== 'object' || budget === null) {
    throw new Error(`memory-graph: \`indexBudget\` must be a boolean or an object, got ${JSON.stringify(budget)}`)
  }
  return {
    tier1: budget.tier1 ?? INDEX_BUDGET.tier1,
    tier2: budget.tier2 ?? INDEX_BUDGET.tier2,
    clipChars: budget.clipChars ?? INDEX_BUDGET.clipChars,
  }
}

/** One rank row as the two renderers need it: the id, its type, description, marker. */
function rowOf({ node, replacedBy }) {
  return { id: node.id, type: node.type, description: node.description, replacedBy }
}

/** The same, for a slice of the ranked set. */
function rowsOf(shown) {
  return shown.map(rowOf)
}

/**
 * The id-plus-description line for one row, with the description capped at
 * `limit` characters (`undefined` = the 500-character defensive cap the
 * untiered index uses).
 *
 * The supersede marker is appended AFTER the cap and is never clipped: a reader
 * who cannot see `[superseded by …]` would take a retired decision for current.
 */
function indexRow(row, limit) {
  const cap = limit ?? 500
  const description = row.description.length > cap
    ? `${row.description.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '')}…`
    : row.description
  return `${row.id} — ${description}${row.replacedBy === undefined ? '' : ` [superseded by ${row.replacedBy}]`}`
}

/**
 * Clip a description for a tier-2 row, at a word boundary and never mid
 * surrogate pair.
 *
 * The cut backtracks to the LAST space inside the budget, wherever it falls —
 * not only when it is past the halfway point. An earlier version required the
 * space to be beyond `limit/2`, which cut inside the second token of
 * `"alpha " + "b"*90` at limit 80 despite a perfectly good boundary at
 * character 5 (codex review). The halfway floor was meant to stop a single
 * short word plus a very long token from collapsing the line, but that case is
 * better served by the fallback below: a description with NO space at all is
 * clipped at the character, since a single unbroken token (a path, a hostname,
 * a branch name) has no boundary to find and shrinking to nothing would be
 * worse than a mid-token cut.
 */
export function clipDescription(description, limit) {
  if (description.length <= limit) return description
  const cut = description.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  const body = space > 0 ? cut.slice(0, space) : cut
  return `${body.replace(/[\uD800-\uDBFF]$/, '')}…`
}

/** The tier-2 form of a row: clipped description, supersede marker intact. */
function clippedRow(row, limit) {
  const suffix = row.replacedBy === undefined ? '' : ` [superseded by ${row.replacedBy}]`
  // When the marker is present the clip must leave room for it, or a row's
  // `limit` would be silently doubled. The marker is the load-bearing half.
  return `${row.id} — ${clipDescription(row.description, limit)}${suffix}`
}

/**
 * Render the budgeted index: tier 1 full, tier 2 clipped, the rest omitted, plus
 * a trailing group of every live `thread` row the tiers would otherwise drop.
 *
 * `rows` is the `maxIndexEntries` window (the ranked head); `scored` is the FULL
 * ranked set, which retention draws from. Two consequences, both deliberate:
 *
 *  - an outer cap cannot hide a thread the tiers would have rescued, because
 *    retention never reads the capped window for candidates; and
 *  - the footer counts what the section does not show across the WHOLE graph —
 *    the outer cap's exclusions plus the tiers' own.
 */
function renderBudgetedIndex(rows, scored, budget) {
  const tier1 = rows.slice(0, budget.tier1)
  const tier2 = rows.slice(budget.tier1, budget.tier1 + budget.tier2)
  const renderedIds = new Set([...tier1, ...tier2].map((row) => row.id))
  // Retention is drawn from `scored`, never from `rows`: an open thread outside
  // `maxIndexEntries` is exactly the case that must still surface.
  //
  // `thread` only, and never a superseded one. `handoff` is rendered by its own
  // uncapped banner above the index (re-listing it would duplicate it), and a
  // thread carrying a supersede banner is history, not open work — listing it
  // under "still current" would assert stale pending work, the exact lie the
  // close-out discipline exists to prevent.
  const keptWorkState = scored
    .filter((row) => row.node.type === 'thread' && row.replacedBy === undefined)
    .map(rowOf)
    .filter((row) => !renderedIds.has(row.id))
  const keptIds = new Set(keptWorkState.map((row) => row.id))
  const shownCount = renderedIds.size + keptIds.size
  const omitted = scored.length - shownCount
  const lines = [
    ...tier1.map((row) => indexRow(row)),
    ...tier2.map((row) => clippedRow(row, budget.clipChars)),
  ]
  if (keptWorkState.length > 0) {
    // Its own heading, because it is NOT rank-contiguous with the tiers above
    // it: without a label a reader would take the group for the next ranks.
    lines.push(
      `Open work state below the cut — still current, read it before touching the thread:`,
      ...keptWorkState.map((row) => `  ${clippedRow(row, budget.clipChars)}`),
    )
  }
  if (omitted > 0) {
    // Singular on purpose: `1 more nodes` reads as a template, and this line is
    // the section's only explanation of what it hid.
    lines.push(`… ${omitted} more node${omitted === 1 ? '' : 's'}; call memory_search to reach them.`)
  }
  return lines
}

/**
 * Separated access signals for ranking: for every `<dst> <ts>` line in a node's
 * own log, a self-line (`dst == owner`) is a direct read (F10) and any other is
 * a traversal that landed on `dst`. Returns `{ traversals, reads, degrees }`
 * Maps keyed by node id; `degrees` is each node's edge count (F84, #194), left
 * empty when `withDegrees` is false so a deployment that zeroes the weight pays
 * no readdir for a term it does not use. Sync reads on purpose — same trade as
 * loadAll.
 */
function accessSignals(root, ids, withDegrees) {
  const traversals = new Map()
  const reads = new Map()
  const degrees = new Map()
  for (const id of ids) {
    for (const line of readAccessLines(root, id, path.join(root, id))) {
      const dst = line.slice(0, 26)
      if (!ULID_RE.test(dst)) continue
      const bucket = dst === id ? reads : traversals
      bucket.set(dst, (bucket.get(dst) ?? 0) + 1)
    }
    if (withDegrees) degrees.set(id, edgeDegreeSync(root, id))
  }
  return { traversals, reads, degrees }
}

/**
 * A node's edge count: its edge symlinks (isEdgeEntrySync). Plain edges are
 * symmetric (ADR 0012), so this is the node's degree; typed one-way edges
 * count on the side that holds them. `.edge-types` and other dotfiles are not
 * edges, and neither is a directory, a regular file or a mispointed symlink
 * wearing a node id: degree counts exactly the edges outEdges lists. One
 * readlink per edge; the synchronous caller runs only when the index cache is
 * cold (indexCacheMs), and the orphan census on the same path already reads
 * every link. A missing dir is degree 0, never an error — `graph-maintain`
 * reports that separately.
 */
function edgeDegreeSync(root, id) {
  try {
    return fs.readdirSync(path.join(root, id, '__edges__')).filter((name) => isEdgeEntrySync(root, id, name)).length
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 0
    throw error
  }
}

/** The whole-graph index: `<id> — <description>`, highest blended score first. */
/**
 * The graph's islands: live nodes with no edges out and none in (F40, #60).
 * Write-time link suggestions fire once, at the moment the agent is least
 * interested — and in the dossier replay 12 of 73 nodes (16%) ended up
 * orphaned, concentrated in young graphs where a node arrives before any
 * plausible neighbor exists. This census is what re-surfaces them once
 * neighbors do exist. Returns `{ total, shown }` with `shown` the most recent
 * `limit` orphans (`updated`/`created` desc, then newer id), each
 * `{ id, description }`. Sync reads on purpose — same trade as loadAll; called
 * on the prompt-assembly path, which cannot wait.
 */
export function orphanCensus(root, limit) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { total: 0, shown: [] }
    throw error
  }
  const ids = entries.filter((entry) => entry.isDirectory() && ULID_RE.test(entry.name)).map((entry) => entry.name)
  const live = new Set(ids)
  const hasOut = new Set()
  const hasIn = new Set()
  for (const id of ids) {
    let names
    try {
      names = fs.readdirSync(path.join(root, id, '__edges__'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      continue
    }
    for (const name of names) {
      if (!ULID_RE.test(name)) continue
      // A dangling edge (target archived or gone) is not evidence of
      // connection for anyone: it gives the SOURCE an out-edge only when the
      // target is live, and the target is not here to receive the in-mark.
      if (!live.has(name)) continue
      // The name alone is not the edge: the contract is a symlink whose
      // target is exactly `../../<name>`. A regular file or a mispointed
      // symlink wearing a live id must not hide two genuine orphans
      // (codex review of this change); graph-maintain flags such entries.
      if (!isEdgeEntrySync(root, id, name)) continue
      hasOut.add(id)
      hasIn.add(name)
    }
  }
  const orphans = []
  for (const id of ids) {
    if (hasOut.has(id) || hasIn.has(id)) continue
    // Read node.md only for the orphans themselves — the census needs their
    // description and recency, and orphans are the graph's minority.
    try {
      const node = parseNode(fs.readFileSync(path.join(root, id, 'node.md'), 'utf8'))
      orphans.push({ id, description: node.description, latest: node.updated || node.created })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  orphans.sort((a, b) => b.latest.localeCompare(a.latest) || b.id.localeCompare(a.id))
  return { total: orphans.length, shown: orphans.slice(0, limit).map(({ id, description }) => ({ id, description })) }
}

/**
 * The node types that carry WORK STATE — an open ledger of what is pending,
 * blocked on what, the next step, what is owed (F45, #74). `handoff` is what
 * the next session must pick up; `thread` is ongoing state inside one. Both
 * are surfaced open, and both are swept for stale pending items (F61, #106).
 */
export const WORK_STATE_TYPES = ['handoff', 'thread']

/**
 * Open work-state nodes: live nodes of the given types that nothing has
 * superseded, newest first (`updated` else `created`, then id), bodies
 * included. `.archive/` is not scanned at all — an archived node is not open.
 *
 * One scan serves both readers: the pinned-handoff banner (F38, #58) takes the
 * `handoff` rows and shows their descriptions, and the close-out sweep (F61,
 * #106) reads the bodies looking for a pending item this write just resolved.
 * Bodies ride along because the same `parseNode` already produced them —
 * carrying them costs nothing and saves the sweep a second pass over the graph.
 * Sync reads on purpose — same trade as loadAll; the banner is called on the
 * prompt-assembly path, which cannot wait.
 */
export function openWorkState(root, types = WORK_STATE_TYPES) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const open = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ULID_RE.test(entry.name)) continue
    let node
    try {
      node = parseNode(fs.readFileSync(path.join(root, entry.name, 'node.md'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      continue
    }
    if (!types.includes(node.type) || supersededBy(node.body) !== undefined) continue
    open.push({ id: entry.name, type: node.type, description: node.description, body: node.body, latest: node.updated || node.created })
  }
  // Code units for the id tie, never localeCompare — see compareIdsNewestFirst
  // (F83, #193): graph-maintain sorts these same rows by code point, and a
  // locale-collated tie would pin the handoffs in a different order there.
  open.sort((a, b) => b.latest.localeCompare(a.latest) || compareIdsNewestFirst(a.id, b.id))
  return open.map(({ id, type, description, body }) => ({ id, type, description, body }))
}

/**
 * Open handoffs: live `type: handoff` nodes nothing has superseded (F38, #58).
 * A handoff is a note from one session to its successor — what is pending,
 * blocked on what, the next step. Round 4 showed the write side working and
 * the find side failing: a genuinely good handoff attachment plus a pointer
 * node, and the very next session opened neither. These are surfaced ABOVE
 * the index until closed, so continuing a thread does not depend on ranking
 * or on the user remembering a file exists. Closing is explicit: supersede
 * the handoff, or retype it (journal/thread or '') when the work concluded —
 * a mid-write read must not silently consume it. Newest first.
 */
export function openHandoffs(root) {
  return openWorkState(root, ['handoff']).map(({ id, description }) => ({ id, description }))
}

export async function indexLines(root, maxEntries, weights = DEFAULT_RANK_WEIGHTS, now = Date.now(), budget) {
  const nodes = await loadAll(root)
  return rankIndex(nodes, accessSignals(root, await listIds(root), (weights.degree ?? 0) > 0), maxEntries, weights, now, budget)
}

/**
 * The same index, read synchronously.
 *
 * The prompt-variable provider is synchronous and runs during assembly, so an
 * index that is only ever filled by an async warm-up loses the race on the
 * first request and shows the model a placeholder where its memory should be.
 * This is the one path that cannot wait.
 */
export function indexLinesSync(root, maxEntries, weights = DEFAULT_RANK_WEIGHTS, now = Date.now(), budget) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const nodes = []
  const traversals = new Map()
  const reads = new Map()
  const degrees = new Map()
  // One readdir per node is cheap next to the reads already here, but it is not
  // free at 5k nodes on the path that cannot wait — so a zeroed degree weight
  // buys the old cost back exactly.
  const withDegrees = (weights.degree ?? 0) > 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !ULID_RE.test(entry.name)) continue
    try {
      nodes.push({ id: entry.name, ...parseNode(fs.readFileSync(path.join(root, entry.name, 'node.md'), 'utf8')) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      continue
    }
    for (const line of readAccessLines(root, entry.name, path.join(root, entry.name))) {
      const dst = line.slice(0, 26)
      if (!ULID_RE.test(dst)) continue
      // Classify each line against the log's owner: a self-line is a direct
      // read (F10), anything else is a traversal that landed on `dst`.
      const bucket = dst === entry.name ? reads : traversals
      bucket.set(dst, (bucket.get(dst) ?? 0) + 1)
    }
    if (withDegrees) degrees.set(entry.name, edgeDegreeSync(root, entry.name))
  }
  return rankIndex(nodes, { traversals, reads, degrees }, maxEntries, weights, now, budget)
}
