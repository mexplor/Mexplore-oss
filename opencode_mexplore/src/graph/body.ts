/**
 * Graph-confined paging of node BODIES (review-2 Major 10).
 *
 * dsh's `memory_read` view cuts a body over 50,000 chars and tells the reader to
 * "read node.md … under the graph root" (`dsh_plugin/lib/index.js:2950-2953`).
 * A mexplore child has no filesystem tools, and `memory_read_file` refuses
 * `node.md` as a reserved name — so a long body's tail was unreachable. This
 * adapter's own 45,000-byte cap cut even earlier for non-ASCII bodies: a
 * 30,000-char CJK body is ~90 KB, well past the cap while under dsh's threshold.
 *
 * The fix is a continuation the child CAN make: the advertised `memory_read`
 * gains an optional `body_offset`, and this module serves the slice itself out
 * of dsh's own graph module — a node id validated by dsh's `assertId` (so no
 * traversal), a `withNodeLocks` read of `node.md` under the same per-node lock
 * dsh's reads take, and nothing outside the graph root. `body_offset` is never
 * forwarded to dsh and is not part of any dsh definition.
 *
 * Offsets are UTF-16 code-unit indices into the body dsh would render —
 * `parseNode(node.md).body.trim()`, the exact string `renderNodeView` shows — and
 * a page boundary never splits a surrogate pair, so every non-empty page
 * advances by at least one code point.
 *
 * Body paging grants NO write authorization: it never runs dsh's `memory_read`,
 * so it never touches `seenBodies`/`versionSeen`. A continuation page is
 * content, not permission.
 *
 * @module mexplore/graph/body
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DshGraphModule } from './load'
import { MAX_CONTENT_BYTES, MAX_CONTENT_LINES, byteLength } from './render'

/**
 * dsh's own body cut (`BODY_VIEW_CHARS` in `dsh_plugin/lib/index.js`). Mirrored
 * rather than imported: it is module-private there, and its value is part of the
 * view contract this module has to reproduce.
 */
export const BODY_VIEW_CHARS = 50_000

/** The advertised parameter that asks for a body continuation. */
export const BODY_OFFSET_PARAM = 'body_offset'

/** The one sentence the advertised schema uses to describe it. */
export const BODY_OFFSET_DESCRIPTION =
  'continue a cut-off node body from this character offset; the cut-off view tells you the value'

/** `…[body continues at char N of M — call memory_read again with id=<id> and body_offset=N]` */
export function continuationLine(id: string, offset: number, total: number): string {
  return `…[body continues at char ${offset} of ${total} — call memory_read again with id=${id} and body_offset=${offset}]`
}

/** `…[body cut at char N of M — call memory_read again with id=<id> and body_offset=N]` */
export function cutLine(id: string, delivered: number, total: number): string {
  return `…[body cut at char ${delivered} of ${total} — call memory_read again with id=${id} and body_offset=${delivered}]`
}

/** The closing line of a page that reached the end. */
export function endOfBodyLine(end: number, total: number): string {
  return `…[end of body — char ${end} of ${total}]`
}

/** An invalid `body_offset`, named with its value and the range it must fall in. */
export class BodyOffsetError extends Error {
  readonly code = 'INVALID_BODY_OFFSET'

  constructor(message: string) {
    super(message)
    this.name = 'BodyOffsetError'
  }
}

/**
 * Validate a caller-supplied `body_offset` against the body it addresses.
 *
 * `0` is the start; `total` is allowed and serves an explicit "end of body"
 * page — what a model that already finished paging would ask for, and an answer
 * it can act on beats an error. Anything negative, fractional, non-numeric or
 * past the end is a mistake with a remedy, so it is named precisely.
 */
export function assertBodyOffset(value: unknown, total: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BodyOffsetError(
      `memory_read: body_offset must be an integer character offset (got ${JSON.stringify(value)})`,
    )
  }
  if (value < 0) {
    throw new BodyOffsetError(`memory_read: body_offset must not be negative (got ${value}); the body starts at char 0`)
  }
  if (value > total) {
    throw new BodyOffsetError(
      `memory_read: body_offset ${value} is past the end of this body (${total} chars); the page you just read names the exact next offset to use`,
    )
  }
  return value
}

/** Does this text fit both host-facing caps? */
function fits(text: string): boolean {
  if (byteLength(text) > MAX_CONTENT_BYTES) return false
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    lines += 1
    if (lines > MAX_CONTENT_LINES) return false
  }
  return true
}

/** Cut a trailing lone high surrogate, so a page never splits a code point. */
function trimSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

function pageText(id: string, description: string, slice: string, offset: number, end: number, total: number): string {
  const heading = `${id} — ${description}\nbody chars ${offset}–${Math.max(end - 1, offset)} of ${total}:\n\n`
  const note = end >= total ? endOfBodyLine(end, total) : continuationLine(id, end, total)
  return `${heading}${slice}\n\n${note}`
}

/** One served page of a node body. */
export interface BodyPage {
  /** The rendered page: heading, the slice, and its continuation line. */
  content: string
  /** Character offset this page starts at. */
  offset: number
  /** Character offset the NEXT page starts at (equals `total` when done). */
  end: number
  /** Total body length in characters. */
  total: number
  /** True when this page reaches the end of the body. */
  done: boolean
}

/**
 * Serve one page of `body` starting at `offset`.
 *
 * The slice is fitted to the adapter's own caps (the ones the host spill
 * thresholds are derived from), shrinking until heading + slice + note fit. At
 * least one code point is always served, so paging cannot stall.
 */
export function pageBody(options: { id: string; description: string; body: string; offset: number }): BodyPage {
  const { id, description, body, offset } = options
  const total = body.length
  if (offset >= total) {
    // An explicit end-of-body page rather than an empty range: a heading like
    // `chars 100–100 of 100` would read as one character of content.
    return {
      content: `${id} — ${description}\nbody: char ${total} of ${total} — end of body\n\n${endOfBodyLine(total, total)}`,
      offset,
      end: total,
      total,
      done: true,
    }
  }
  // A generous starting budget: one UTF-16 code unit is at most 4 UTF-8 bytes,
  // so this can only over-take, and the shrink loop below corrects it.
  let take = Math.min(total - offset, MAX_CONTENT_BYTES)
  for (let pass = 0; pass < 64; pass += 1) {
    const slice = trimSurrogate(body.slice(offset, offset + take))
    if (slice.length === 0) break
    const end = offset + slice.length
    const text = pageText(id, description, slice, offset, end, total)
    if (fits(text) || take <= 1) return { content: text, offset, end, total, done: end >= total }
    // Shrink by the overflow, with a margin for the heading and the note (which
    // only gets shorter as the slice shrinks, so this converges).
    const over = Math.max(1, byteLength(text) - MAX_CONTENT_BYTES)
    const sliceBytes = Math.max(1, byteLength(slice))
    const ratio = Math.max(0.05, (sliceBytes - over - 64) / sliceBytes)
    take = Math.max(1, Math.floor(slice.length * Math.min(ratio, 0.95)))
  }
  // Defensive: never return a page that made no progress.
  const slice = body.slice(offset, offset + Math.max(1, take))
  const end = offset + slice.length
  return { content: pageText(id, description, slice, offset, end, total), offset, end, total, done: end >= total }
}

/**
 * How many characters of `body` a rendered `memory_read` view actually
 * delivered — the smaller of dsh's own cut and this adapter's cap.
 *
 * `renderText` is dsh's whole render and `deliveredText` the prefix this adapter
 * hands back. dsh's body starts at a known character index of the render, so the
 * delivered body is the longest COMMON PREFIX of that slice and the body itself:
 * a common-prefix scan needs no assumption about where a note begins, and it is
 * exact whether the cut came from dsh's 50,000-char limit, from this cap, or from
 * both.
 */
export function deliveredBodyChars(body: string, renderText: string, deliveredText: string): number {
  if (body.length === 0) return 0
  const dshPrefix = trimSurrogate(body.slice(0, Math.min(body.length, BODY_VIEW_CHARS)))
  const at = renderText.indexOf(dshPrefix)
  if (at < 0) {
    // The render is not the shape expected: credit the delivered text itself,
    // never more than dsh would have shown.
    return Math.min(dshPrefix.length, Math.max(0, deliveredText.length))
  }
  const shown = deliveredText.slice(at)
  const limit = Math.min(shown.length, dshPrefix.length)
  let same = 0
  while (same < limit && shown.charCodeAt(same) === dshPrefix.charCodeAt(same)) same += 1
  return same
}

/** dsh's own "read node.md … under the graph root" sentence. */
const DSH_BODY_CUT_RE = /…\[body truncated: \d+ more chars — read node\.md inside node \S+ under the graph root for the rest\]/

/**
 * Replace any continuation hint in a rendered `memory_read` view with the one
 * this runtime can actually serve.
 *
 * Two hints exist and both are wrong here: dsh's "read node.md under the graph
 * root" sentence (the child has no filesystem tools) and this adapter's own cap
 * note (which says `offset`, a `memory_read_file` argument). Both become a
 * precise `body_offset` continuation, computed from what was DELIVERED — the
 * dsh cut or the cap, whichever came first.
 */
export function rewriteBodyHints(options: {
  /** dsh's whole render, for locating the body inside it. */
  text: string
  /** The delivered prefix WITHOUT this adapter's cap note. */
  deliveredBody: string
  id: string
  body: string
}): string {
  const { text, deliveredBody, id, body } = options
  if (body.length === 0) return deliveredBody
  const shown = deliveredBodyChars(body, text, deliveredBody)
  // The whole body arrived: nothing to continue, and no note to add.
  if (shown >= body.length) return deliveredBody
  const hint = cutLine(id, shown, body.length)
  // dsh's own sentence sends the reader to `node.md` on disk, which a mexplore
  // child cannot reach — replace it in place when it survived the cap.
  if (DSH_BODY_CUT_RE.test(deliveredBody)) return deliveredBody.replace(DSH_BODY_CUT_RE, hint)
  // Otherwise the answer ends at the cut (dsh's, this cap's, or both), so the
  // hint replaces whatever note followed it.
  const noteAt = deliveredBody.lastIndexOf('\n…[')
  const bodyPart = noteAt < 0 ? deliveredBody : deliveredBody.slice(0, noteAt)
  return `${bodyPart}\n${hint}`
}


/**
 * Read a node's body for a continuation page.
 *
 * Confinement, in order: dsh's `assertId` (a ULID pattern, which is also what
 * makes the joined path un-traversable), then the path join, then a read under
 * dsh's own per-node lock — the same lock `memory_read` and the writers use, so
 * a page is never read from a half-renamed `node.md`. `parseNode` is dsh's
 * authority for where the frontmatter ends and the body begins, and `trim()`
 * matches what `renderNodeView` renders, so offsets agree with the view.
 */
export async function readNodeBody(
  graph: DshGraphModule,
  graphRoot: string,
  id: string,
): Promise<{ id: string; description: string; body: string }> {
  const valid = graph.assertId(id)
  const raw = await graph.withNodeLocks(graphRoot, [valid], async () => {
    try {
      return await fsp.readFile(path.join(graphRoot, valid, 'node.md'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`memory_read: node does not exist: ${valid}`)
      }
      throw error
    }
  })
  const parsed = graph.parseNode(raw)
  return { id: valid, description: parsed.description, body: parsed.body.trim() }
}
