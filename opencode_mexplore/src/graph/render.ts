/**
 * Turning a dsh tool result into model-visible text, under the host's own
 * limits (SEC-004, AC-023).
 *
 * OpenCode spills any tool output over 2,000 lines or 50 KB to a file under
 * `tool-output/` and keeps it 7 days. Both are host CONFIGURATION, so this
 * adapter sits comfortably below them rather than on the boundary: a graph tool
 * result is truncated here, in the tool call, and the model is told how to
 * continue, so no `tool-output/` file is ever created for a memory read.
 *
 * TWO invariants matter more than the exact cut:
 *
 *   - a page must always make PROGRESS. A single 60 KB line (minified JSON, a
 *     one-line transcript) cannot be dropped whole, or the resume note points
 *     at the offset the caller already used and the next page repeats it. So an
 *     oversized line is cut to a UTF-8-safe PREFIX;
 *   - the note must describe the body that is actually delivered. It names a
 *     byte offset, so it is recomputed from the final body, never from a
 *     candidate the shrink loop went on to reduce.
 *
 * @module mexplore/graph/render
 */
import type { DshRenderBlock } from './load'

/** Lines kept at most — below the host's 2,000-line spill threshold. */
export const MAX_CONTENT_LINES = 1_900
/** UTF-8 bytes kept at most — below the host's 50 KB spill threshold. */
export const MAX_CONTENT_BYTES = 45_000

/** Bytes held back for the truncation note, which is built after the cut. */
const NOTE_RESERVE_BYTES = 400
/** Below this, a prefix is too short to be worth a page of its own. */
const MIN_PREFIX_BYTES = 64
/** Shrink passes: the note is bounded, so this converges in two or three. */
const MAX_SHRINK_PASSES = 8

/** What a caller-supplied note builder needs to explain the cut. */
export interface CutInfo {
  /** Lines in the untruncated result, including the ones kept. */
  totalLines: number
  /** Characters of the original text kept, before the note. */
  keptChars: number
  /** The kept prefix itself — the bytes the caller actually received. */
  keptText: string
}

export interface RenderedContent {
  content: string
  truncated: boolean
  /** The delivered prefix of the original text, without the note. */
  body: string
}

/** What `capContent` returns: the rendered text, nothing more. */
export interface CappedContent {
  content: string
  truncated: boolean
}

/** The one line that replaces everything past the cut. */
export function defaultTruncationNote(info: CutInfo): string {
  return `…[output truncated by mexplore at the host limit (${info.totalLines} lines total): don't re-read this page from the start — continue an attachment where this left off via memory_read_file's \`offset\`, or narrow the query]`
}

/**
 * Join a dsh render's text blocks and cap the result.
 *
 * `noteFor` lets a caller name the exact place to resume from when it can
 * compute one (memory_read_file knows its page's byte offset); anything else
 * gets the generic note. It may be called more than once while the body is
 * being fitted, and only the value built from the FINAL body is used.
 */
export function renderContent(blocks: unknown, noteFor?: (info: CutInfo) => string): RenderedContent {
  return capDetailed(joinBlocks(blocks), noteFor)
}

/** A dsh render is an array of blocks; only `text` blocks are model-visible. */
export function joinBlocks(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is DshRenderBlock => block !== null && typeof block === 'object')
    .filter((block) => (block.type === undefined || block.type === 'text') && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** Cap `text`, dropping the delivered-prefix detail callers do not need. */
export function capContent(text: string, noteFor?: (info: CutInfo) => string): CappedContent {
  const { content, truncated } = capDetailed(text, noteFor)
  return { content, truncated }
}

function capDetailed(text: string, noteFor?: (info: CutInfo) => string): RenderedContent {
  if (fits(text)) return { content: text, body: text, truncated: false }
  const lines = text.split('\n')
  // One line is reserved for the note, counted against the line budget.
  const maxBodyLines = MAX_CONTENT_LINES - 1
  const budget = MAX_CONTENT_BYTES - NOTE_RESERVE_BYTES
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (kept.length >= maxBodyLines) break
    const separator = kept.length === 0 ? 0 : 1
    const cost = byteLength(line) + separator
    if (used + cost <= budget) {
      kept.push(line)
      used += cost
      continue
    }
    // No whole line fits. Deliver a UTF-8-safe PREFIX of it anyway: a page that
    // delivers nothing cannot be paged past, because its resume offset would be
    // the offset the caller just used.
    const room = budget - used - separator
    if (room >= MIN_PREFIX_BYTES) {
      const prefix = utf8Prefix(line, room)
      if (prefix.length > 0) kept.push(prefix)
    }
    break
  }

  // Fit body + note TOGETHER, recomputing both after every reduction: the note
  // carries a byte offset derived from the body, so a stale one either skips
  // bytes the caller never received or repeats a page forever.
  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass += 1) {
    const body = kept.join('\n')
    const note = (noteFor ?? defaultTruncationNote)({ totalLines: lines.length, keptChars: body.length, keptText: body })
    const total = byteLength(body) + (body.length === 0 ? 0 : 1) + byteLength(note)
    if (total <= MAX_CONTENT_BYTES) return { content: withNote(body, note), body, truncated: true }
    // Cut the overflow plus a margin for the note growing as the offset shrinks.
    const target = Math.max(0, byteLength(body) - (total - MAX_CONTENT_BYTES) - 32)
    const next = utf8Prefix(body, target)
    if (next === body) break
    kept.length = 0
    if (next.length > 0) kept.push(...next.split('\n'))
  }
  // Unreachable in practice (the note is bounded well below the cap); still
  // returns a note-only page rather than an over-limit one.
  const body = kept.join('\n')
  const note = (noteFor ?? defaultTruncationNote)({ totalLines: lines.length, keptChars: body.length, keptText: body })
  return { content: withNote(body, note), body, truncated: true }
}

function withNote(body: string, note: string): string {
  return body.length === 0 ? note : `${body}\n${note}`
}

function fits(text: string): boolean {
  return byteLength(text) <= MAX_CONTENT_BYTES && countLines(text) <= MAX_CONTENT_LINES
}

/** Count lines without materializing the split, for the fast path only. */
function countLines(text: string): number {
  let count = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1
  return count
}

/**
 * The longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`,
 * never splitting a code point (so a lone surrogate half is never emitted).
 *
 * dsh's own attachment reader already ends its window on a character boundary;
 * this is the same contract for the OUTPUT cap, where a byte budget and a
 * character-indexed string do not line up.
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return ''
  if (byteLength(text) <= maxBytes) return text
  // A code unit is at least one byte, so this slice is at least as long as the
  // answer; trimming then only ever moves backwards.
  let slice = text.slice(0, Math.min(text.length, maxBytes))
  while (slice.length > 0 && byteLength(slice) > maxBytes) {
    const over = byteLength(slice) - maxBytes
    // A code point costs at most 4 bytes, so removing ceil(over / 4) code units
    // removes at least `over` bytes. Never zero, so this always terminates.
    slice = slice.slice(0, Math.max(0, slice.length - Math.max(1, Math.ceil(over / 4))))
  }
  // A high surrogate at the cut would encode as U+FFFD beside the note.
  const last = slice.charCodeAt(slice.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1)
  return slice
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}
