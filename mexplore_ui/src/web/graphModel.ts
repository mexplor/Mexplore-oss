// Pure graph-data → d3 model mapping (no DOM, no d3 runtime). Unit-tested in graphModel.test.ts.
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3'
import type { EdgeType, GraphEdge, GraphNode, GraphResponse } from '../shared/types.ts'

export const NODE_TYPES = [
  'identity',
  'preference',
  'decision',
  'gotcha',
  'journal',
  'thread',
  'trivia',
  'handoff',
] as const
export type NodeTypeKey = (typeof NODE_TYPES)[number] | 'untyped'
export const TYPE_KEYS: NodeTypeKey[] = [...NODE_TYPES, 'untyped']

export const TYPE_COLORS: Record<NodeTypeKey, string> = {
  identity: '#7b3fa0',
  preference: '#1f8a83',
  decision: '#2358b5',
  gotcha: '#b3263e',
  journal: '#b07a1a',
  thread: '#5d8a26',
  trivia: '#8a7766',
  handoff: '#e2711d',
  untyped: '#a49c92',
}

/** Unknown/missing types fold into "untyped" so every Node still gets a colour. */
export function typeKey(type: string | null | undefined): NodeTypeKey {
  if (!type) return 'untyped'
  const t = type.trim().toLowerCase()
  return (NODE_TYPES as readonly string[]).includes(t) ? (t as NodeTypeKey) : 'untyped'
}

export function typeColor(type: string | null | undefined): string {
  return TYPE_COLORS[typeKey(type)]
}

export function nodeRadius(degree: number): number {
  return Math.min(15, 4.5 + Math.sqrt(Math.max(0, degree)) * 1.9)
}

/** Link stroke width: log-scaled by access strength; an edge with no history keeps a visible floor. */
export function linkWidth(accessCount: number): number {
  const a = Math.max(0, accessCount)
  return Math.min(6, 0.9 + Math.log2(1 + a) * 0.85)
}

/** Never-traversed edges sit well below any traversed one, so the edges you actually use carry the picture. */
export function linkOpacity(accessCount: number): number {
  const a = Math.max(0, accessCount)
  if (a === 0) return 0.17
  return Math.min(0.92, 0.36 + Math.log2(1 + a) * 0.12)
}

/** Above this many Nodes the graph switches to its "large" rendering mode (batched ticks, no transitions,
 * plain edges hidden when zoomed far out). */
export const LARGE_GRAPH = 600

/** How many neighbours get a label when a Node is selected or hovered. */
export const NEIGHBOUR_LABEL_BUDGET = 10

export function edgeKey(e: Pick<GraphEdge, 'source' | 'target' | 'type'>): string {
  return `${e.source}|${e.target}|${e.type}`
}

export interface SimNode extends SimulationNodeDatum {
  id: string
  data: GraphNode
  r: number
  color: string
  typeKey: NodeTypeKey
  /** One-line graph label: type prefix stripped, truncated to LABEL_COLUMNS display columns. */
  label: string
  /** Up to two lines for the selected / hovered Node. */
  labelLines: string[]
  /** Description without the importer's "label(…date…)" prefix and a restated type word (the label is cut from
   * this; used to disambiguate). The tooltip and panel show `data.description` unchanged. */
  text: string
  /** updated ?? created (ISO), for telling identical labels apart. */
  date: string | null
  /** BCP-47 tag for labels in a CJK script (so the browser picks the right glyph forms), else null. */
  lang: string | null
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  key: string
  data: GraphEdge
  type: EdgeType
  directed: boolean
  width: number
  opacity: number
  source: string | SimNode
  target: string | SimNode
}

export interface PrevPos {
  x?: number
  y?: number
  vx?: number
  vy?: number
}

export interface SimModel {
  nodes: SimNode[]
  links: SimLink[]
  /** Edges dropped because an endpoint is not in nodes. */
  dangling: number
  /** Ids that did not exist in the previous position map. */
  added: string[]
}

/** Deterministic small hash → [0,1) for stable jitter. */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

// ───────────── labels: width-aware, grapheme-safe ─────────────

/** Display budget of a one-line graph label, in columns (East Asian wide = 2, everything else = 1). */
export const LABEL_COLUMNS = 32
/** Width of one line of a wrapped (selected / hovered) label. */
export const WRAP_COLUMNS = 22
export const WRAP_LINES = 2

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** User-perceived characters; emoji ZWJ sequences, flags and combining marks stay whole. */
export function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment)
  return Array.from(s) // code points: at least never splits a surrogate pair
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  )
}

/** Display columns of one grapheme: decided by its first code point. */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0)
  return cp !== undefined && isWideCodePoint(cp) ? 2 : 1
}

export function displayWidth(s: string): number {
  let w = 0
  for (const g of graphemes(s)) w += graphemeWidth(g)
  return w
}

/** A break is preferred right after these (the punctuation itself is dropped before an ellipsis). */
const BREAK_AFTER = new Set(['，', '。', '、', '：', '；', '！', '？', '）', '」', '』', '/', ',', ';', ':', ')', '|', '｜'])
const TRAILING_JUNK = /[\s，。、：；,;:/|｜·\-–—(（「『]+$/u
/** Characters that glue a Latin token (word, ID, path, version) together — never cut between two of them. */
const WORD_CHAR = /^[\p{Script=Latin}\p{N}_\-.@#~'’]$/u

/**
 * How many graphemes of `gs` to keep so the kept width stays ≤ limit, preferring (in order) a break after
 * punctuation / before a space, then a dictionary word boundary (CJK has no spaces), then any boundary that is
 * not inside a Latin token — but only if that keeps at least ~55% of the room. Falls back to a hard cut.
 */
function findCut(gs: readonly string[], limit: number): number {
  let end = 0
  let w = 0
  const cum: number[] = [0]
  while (end < gs.length && w + graphemeWidth(gs[end]!) <= limit) {
    w += graphemeWidth(gs[end]!)
    end++
    cum.push(w)
  }
  if (end >= gs.length) return end
  const floor = limit * 0.55
  const inToken = (i: number) => WORD_CHAR.test(gs[i - 1]!) && WORD_CHAR.test(gs[i]!)
  for (let i = end; i > 0 && cum[i]! >= floor; i--) {
    if (BREAK_AFTER.has(gs[i - 1]!) || gs[i] === ' ') return i
  }
  const words = wordBoundaries(gs)
  if (words) {
    for (let i = end; i > 0 && cum[i]! >= floor; i--) if (words.has(i) && !inToken(i)) return i
  }
  for (let i = end; i > 0 && cum[i]! >= floor; i--) if (!inToken(i)) return i
  // rather lose a little more room than split an ID / date / version in half
  for (let i = end; i > 0 && cum[i]! >= limit * 0.25; i--) if (!inToken(i)) return i
  return end
}

const wordSegmenter: { segment(s: string): Iterable<{ index: number }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null

/** Grapheme indices where a dictionary word starts (only computed for text with Han / kana). */
function wordBoundaries(gs: readonly string[]): Set<number> | null {
  if (!wordSegmenter) return null
  const s = gs.join('')
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return null
  const at = new Map<number, number>()
  let off = 0
  gs.forEach((g, i) => {
    at.set(off, i)
    off += g.length
  })
  const out = new Set<number>()
  for (const seg of wordSegmenter.segment(s)) {
    const i = at.get(seg.index)
    if (i !== undefined) out.add(i)
  }
  return out
}

/**
 * Truncate to at most `columns` display columns (the ellipsis counts as one), never splitting a grapheme and
 * preferring natural breaks. Whitespace is collapsed first.
 */
export function truncateLabel(s: string, columns = LABEL_COLUMNS): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  const gs = graphemes(clean)
  let total = 0
  for (const g of gs) total += graphemeWidth(g)
  if (total <= columns) return clean
  const cut = findCut(gs, Math.max(1, columns - 1))
  let head = gs.slice(0, cut).join('').replace(TRAILING_JUNK, '')
  if (!head) head = gs.slice(0, Math.max(1, cut)).join('')
  return head + '…'
}

/** Closing punctuation never starts a line; it hangs at the end of the previous one (CJK line-breaking rule). */
const NO_LINE_START = /^[，。、：；！？）」』,.;:!?)]+/u

/**
 * Wrap into at most `lines` lines of `columns` display columns; the last line is truncated with an ellipsis.
 * Closing punctuation may hang one or two columns past the budget instead of starting a line.
 */
export function wrapLabel(s: string, columns = WRAP_COLUMNS, lines = WRAP_LINES): string[] {
  let rest = s.replace(/\s+/g, ' ').trim()
  const out: string[] = []
  while (rest && out.length < lines - 1) {
    const gs = graphemes(rest)
    if (displayWidth(rest) <= columns) break
    let cut = Math.max(1, findCut(gs, columns))
    // a Latin token a little longer than the line (e.g. "workflow-dispatcher") overflows rather than splits
    if (cut < gs.length && WORD_CHAR.test(gs[cut - 1]!) && WORD_CHAR.test(gs[cut]!)) {
      let j = cut
      while (j < gs.length && WORD_CHAR.test(gs[j]!)) j++
      if (displayWidth(gs.slice(0, j).join('')) <= columns + 6) cut = j
    }
    let line = gs.slice(0, cut).join('').trimEnd()
    rest = gs.slice(cut).join('').trimStart()
    const hang = NO_LINE_START.exec(rest)
    if (hang) {
      line += hang[0]
      rest = rest.slice(hang[0].length).trimStart()
    }
    out.push(line)
  }
  if (rest) out.push(truncateLabel(rest, columns))
  return out
}

/** Leading "type:" words people write into descriptions, mapped to the Node type they restate. */
const TYPE_PREFIXES: Record<string, NodeTypeKey> = {
  用户偏好: 'preference',
  偏好: 'preference',
  preference: 'preference',
  pref: 'preference',
  决策: 'decision',
  决定: 'decision',
  decision: 'decision',
  踩坑: 'gotcha',
  坑: 'gotcha',
  gotcha: 'gotcha',
  日志: 'journal',
  journal: 'journal',
  线索: 'thread',
  thread: 'thread',
  冷知识: 'trivia',
  trivia: 'trivia',
  交接: 'handoff',
  handoff: 'handoff',
  身份: 'identity',
  identity: 'identity',
}
const PREFIX_RE = /^\s*([\p{L}]{1,12})\s*[：:]\s*/u

/**
 * Drop a leading type word ("用户偏好：", "Decision:") from a graph label when it merely restates the Node's own
 * type — the dot colour already says it. Conservative: only known words, only when they match the type, and
 * never when nothing meaningful would be left. Tooltip and panel keep the full description.
 */
export function stripTypePrefix(description: string, type: string | null | undefined): string {
  const m = PREFIX_RE.exec(description)
  if (!m) return description
  const mapped = TYPE_PREFIXES[m[1]!.toLowerCase()]
  if (!mapped || mapped !== typeKey(type)) return description
  const rest = description.slice(m[0].length)
  return /[\p{L}\p{N}]/u.test(rest) ? rest : description
}

/**
 * A leading "label(…date…)" group some importers write in front of every description, e.g.
 * `线程(2026-07-09 Claude Code session a1000001 part 3,orion-agent):` or `2026-05-14(Claude Code session …):` — the
 * bookkeeping, not the memory. Only matched when the label or the parenthetical holds a date, so `acme-orion-eval(context
 * compact eval)` keeps its words.
 */
export const LEADING_META =
  /^\s*(?:\d{4}-\d{1,2}-\d{1,2}\s*[(（][^)）]{0,200}?[)）]|[^\s()（）]{0,14}\s*[(（][^)）]{0,200}?\d{4}-\d{1,2}[^)）]{0,200}?[)）])\s*[:：,，]?\s*/u

/**
 * Bookkeeping-only leaders without a dated parenthetical: an optional single label word, a `YYYY-MM-DD` date, then
 * only bookkeeping tokens — `Claude Code`, `session <hex id>`, `part N` / `part N→M` / `part N/M`, a `(…)` group —
 * and a colon. `2026-06-03 session a1000004 part 1(orion-agent):…` and `租赁合同案 2026-07-22 session a1000009
 * part 1:…` lose their leader; `租赁合同案 2026-07-22 更新(…):…` keeps it (更新 is content), and so does any text
 * where something else sits between the date and the colon (a hex id that is the subject, a title word).
 */
export const BOOKKEEPING_LEADER =
  /^\s*(?:[^\s()（）:：]{1,14}\s+)?\d{4}-\d{1,2}-\d{1,2}(?:\s*(?:Claude Code|session\s+[0-9a-f]{6,}(?:-[0-9a-f]+)*|part\s*\d+(?:\s*(?:→|\/|-)\s*(?:part\s*)?\d+)?|[(（][^)）]{0,200}[)）]))*\s*[:：]\s*/iu

/** Fewer letters/digits than this after stripping → keep the original text (nothing meaningful would be left). */
const MIN_STRIPPED_CHARS = 4

/**
 * Drop the importer's leading "label(…date…)" group (LEADING_META) or a bookkeeping-only leader
 * (BOOKKEEPING_LEADER) from a canvas label. Falls back to the original text when the
 * rest is empty or very short. Canvas only: list, panel, tooltip and search keep the full description.
 */
export function stripImporterPrefix(description: string): string {
  const m = LEADING_META.exec(description) ?? BOOKKEEPING_LEADER.exec(description)
  if (!m || !m[0]) return description
  const rest = description.slice(m[0].length).trim()
  const meaningful = rest.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  return meaningful >= MIN_STRIPPED_CHARS ? rest : description
}

/** Language tag for a label so CJK text gets the right font and glyph forms. */
export function labelLang(s: string): string | null {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return 'ja'
  if (/\p{Script=Hangul}/u.test(s)) return 'ko'
  if (/\p{Script=Han}/u.test(s)) return 'zh-Hans'
  return null
}

/** Which Node earns a label first: the most links (degree), then id — MAP.md rank no longer plays a part. */
export function compareLabelPriority(a: GraphNode, b: GraphNode): number {
  return b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** The `budget` highest-priority ids among `ids`, using a precomputed priority index (lower = first).
 * Ids for which `demote` is true (e.g. filter misses) only fill slots the others leave free. */
export function topByPriority(
  ids: Iterable<string>,
  priority: ReadonlyMap<string, number>,
  budget: number,
  demote?: (id: string) => boolean,
): Set<string> {
  const key = (id: string) => (demote?.(id) ? 1e9 : 0) + (priority.get(id) ?? 1e8)
  const arr = [...ids].sort((a, b) => key(a) - key(b) || (a < b ? -1 : 1))
  return new Set(arr.slice(0, Math.max(0, budget)))
}

/**
 * How strongly a Node is drawn. One resolved value instead of competing CSS rules, so a filter dim can never
 * bury the selection the user is looking at:
 *  - full:  normal
 *  - soft:  still clearly part of the story, but a filter miss (selected Node's / hovered Node's neighbour)
 *  - faint: background — filter miss with nothing pointing at it, or outside the lens; no label
 *  - hidden: outside hop focus
 */
export type NodeTone = 'full' | 'soft' | 'faint' | 'hidden'

export function nodeTone(o: {
  vis: Visibility
  selected: boolean
  hovered: boolean
  /** Neighbour of the selected Node. */
  neighbour: boolean
  /** Neighbour of the hovered Node that earned a label in the hover budget. */
  hoverLabelled: boolean
  /** Selection without hop focus. */
  lens: boolean
}): NodeTone {
  if (o.vis === 'hidden') return 'hidden'
  if (o.selected || o.hovered) return 'full'
  if (o.neighbour) return o.vis === 'dim' ? 'soft' : 'full'
  if (o.hoverLabelled) return o.vis === 'dim' || o.lens ? 'soft' : 'full'
  if (o.lens || o.vis === 'dim') return 'faint'
  return 'full'
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/**
 * Smallest pan (dx, dy) that puts `box` inside `view` and clear of every obstacle (legend, toolbars), keeping
 * `gap` px of air around obstacles. Tries escaping each obstacle in each direction, up to two obstacles deep;
 * when nothing fits (canvas too small), falls back to centring the box in the view.
 */
export function planPan(box: Box, view: Box, obstacles: readonly Box[], gap = 8): { dx: number; dy: number } {
  const shift = (b: Box, dx: number, dy: number): Box => ({ left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy })
  const inView = (b: Box) => b.left >= view.left && b.right <= view.right && b.top >= view.top && b.bottom <= view.bottom
  const ok = (dx: number, dy: number) => {
    const b = shift(box, dx, dy)
    return inView(b) && obstacles.every((o) => !overlaps(b, o))
  }
  const intoView = (dx: number, dy: number): [number, number] => {
    const b = shift(box, dx, dy)
    let ddx = 0
    let ddy = 0
    if (b.left < view.left) ddx = view.left - b.left
    else if (b.right > view.right) ddx = view.right - b.right
    if (b.top < view.top) ddy = view.top - b.top
    else if (b.bottom > view.bottom) ddy = view.bottom - b.bottom
    return [dx + ddx, dy + ddy]
  }
  const escapes = (dx: number, dy: number): [number, number][] => {
    const b = shift(box, dx, dy)
    const out: [number, number][] = []
    for (const o of obstacles) {
      if (!overlaps(b, o)) continue
      out.push(
        [dx + o.left - gap - b.right, dy],
        [dx + o.right + gap - b.left, dy],
        [dx, dy + o.top - gap - b.bottom],
        [dx, dy + o.bottom + gap - b.top],
      )
    }
    return out
  }
  const start = intoView(0, 0)
  const level1 = [start, ...escapes(...start)].map(([x, y]) => intoView(x, y))
  const level2 = level1.flatMap(([x, y]) => escapes(x, y).map(([a, b]) => intoView(a, b)))
  let best: [number, number] | null = null
  for (const c of [[0, 0] as [number, number], ...level1, ...level2]) {
    if (!ok(c[0], c[1])) continue
    if (!best || Math.hypot(c[0], c[1]) < Math.hypot(best[0], best[1])) best = c
  }
  if (best) return { dx: best[0], dy: best[1] }
  return {
    dx: (view.left + view.right) / 2 - (box.left + box.right) / 2,
    dy: (view.top + view.bottom) / 2 - (box.top + box.bottom) / 2,
  }
}

/**
 * Where to put a label card of size w×h (px, screen space) next to a dot spanning [dotLeft, dotRight] at height
 * cy: on the right when it fits, else on the left, else whichever side has more room; clamped into `view`
 * (the inset safe area). Whether the dot is on screen at all is judged against `canvas` (the real bounds), so a
 * dot inside the inset strip still gets a clamped, fully visible card. Returns the card's top-left corner.
 */
export function placeCard(
  dot: { left: number; right: number; cy: number },
  card: { w: number; h: number },
  view: Box,
  canvas: Box = view,
  gap = 4,
  /** Other dots (screen boxes) the card should rather not cover — e.g. the simple view's neighbours. */
  avoid: readonly Box[] = [],
): { x: number; y: number; side: 'right' | 'left' } {
  const rightX = dot.right + gap
  const leftX = dot.left - gap - card.w
  const cx = (dot.left + dot.right) / 2
  // a dot panned off-canvas takes its card with it — clamping would leave a card detached from any dot
  if (cx < canvas.left || cx > canvas.right || dot.cy < canvas.top || dot.cy > canvas.bottom) {
    return { x: rightX, y: dot.cy - card.h / 2, side: 'right' }
  }
  const y = Math.max(view.top, Math.min(dot.cy - card.h / 2, view.bottom - card.h))
  const at = (side: 'right' | 'left') => {
    const x = Math.max(view.left, Math.min(side === 'right' ? rightX : leftX, view.right - card.w))
    return { x, y, side }
  }
  const fits = (side: 'right' | 'left') => (side === 'right' ? rightX + card.w <= view.right : leftX >= view.left)
  let side: 'right' | 'left' = 'right'
  if (!fits('right')) {
    if (fits('left')) side = 'left'
    else side = view.right - dot.right >= dot.left - view.left ? 'right' : 'left'
  }
  if (avoid.length) {
    const covered = (p: { x: number; y: number }) =>
      avoid.filter((b) => b.left < p.x + card.w && b.right > p.x && b.top < p.y + card.h && b.bottom > p.y).length
    const other = side === 'right' ? 'left' : 'right'
    const here = covered(at(side))
    if (here > 0 && fits(other) && covered(at(other)) < here) side = other
  }
  return at(side)
}

/**
 * placeCard, but `hard` boxes (canvas overlays: toolbars, legend, filter chip, bottom sheet) are never covered when
 * any legal spot exists: both sides are tried, each also nudged vertically past the overlays while the card still
 * sits beside its dot. `blocked` reports that no clear spot exists here — the caller pans, then frees space.
 */
export function placeCardClear(
  dot: { left: number; right: number; cy: number },
  card: { w: number; h: number },
  view: Box,
  canvas: Box,
  gap: number,
  avoid: readonly Box[],
  hard: readonly Box[],
): { x: number; y: number; side: 'right' | 'left'; blocked: boolean } {
  const base = placeCard(dot, card, view, canvas, gap, avoid)
  const area = (x: number, y: number, boxes: readonly Box[]) => {
    let a = 0
    for (const b of boxes) {
      const ix = Math.min(b.right, x + card.w) - Math.max(b.left, x)
      const iy = Math.min(b.bottom, y + card.h) - Math.max(b.top, y)
      if (ix > 0 && iy > 0) a += ix * iy
    }
    return a
  }
  const cx = (dot.left + dot.right) / 2
  const offCanvas = cx < canvas.left || cx > canvas.right || dot.cy < canvas.top || dot.cy > canvas.bottom
  if (offCanvas || !hard.length || area(base.x, base.y, hard) === 0) return { ...base, blocked: false }

  const r = Math.max(4, (dot.right - dot.left) / 2)
  const clampY = (y: number) => Math.max(view.top, Math.min(y, view.bottom - card.h))
  const besideDot = (y: number) => y < dot.cy + r && y + card.h > dot.cy - r
  let best: { x: number; y: number; side: 'right' | 'left'; hardA: number; softA: number; cost: number } | null = null
  for (const side of [base.side, base.side === 'right' ? 'left' : 'right'] as const) {
    const raw = side === 'right' ? dot.right + gap : dot.left - gap - card.w
    const x = Math.max(view.left, Math.min(raw, view.right - card.w))
    const ys = [base.y]
    for (const b of hard) {
      if (b.left >= x + card.w || b.right <= x) continue
      ys.push(clampY(b.bottom + 2), clampY(b.top - 2 - card.h))
    }
    for (const y of ys) {
      if (!besideDot(y)) continue
      const hardA = area(x, y, hard)
      const softA = area(x, y, avoid)
      // clear of overlays first, then of neighbour dots; the preferred side and the smallest nudge break ties
      const cost = (side === base.side ? 0 : 1) + Math.abs(y - base.y) / 100
      if (!best || hardA < best.hardA || (hardA === best.hardA && (softA < best.softA || (softA === best.softA && cost < best.cost))))
        best = { x, y, side, hardA, softA, cost }
    }
  }
  if (!best) return { ...base, blocked: true }
  return { x: best.x, y: best.y, side: best.side, blocked: best.hardA > 0 }
}

/** Graph layout widths (keep in sync with styles.css `.graph-layout.with-panel`). */
export const SIDEBAR_W = 318
export const PANEL_W = 420 // three columns: minmax(420px, 34%)
export const PANEL_W_NARROW = 360 // sidebar hidden
/**
 * The narrowest graph a side panel may leave. Measured on the real graph's 13-node hub (simple view, 746px tall):
 * 441px → 5/13 labels, 540 → 10, 560 → 10, 580 → 12, 600 → 12, 620+ → 13. 580 keeps 1366px laptops in three
 * columns (graph 584px) while nothing narrower than 12/13 is ever offered; below it the panel becomes a sheet.
 */
export const MIN_GRAPH_W = 580

export type PanelLayout = 'columns' | 'no-sidebar' | 'sheet'

/**
 * How to lay out sidebar / graph / detail panel for a window `width` px wide, chosen by the graph width each layout
 * would leave (not by a fixed breakpoint): keep all three columns while the graph keeps ≥ minGraph px, else drop the
 * sidebar, else lay the panel over the graph as a bottom sheet.
 */
export function panelLayout(width: number, minGraph = MIN_GRAPH_W): PanelLayout {
  if (width - SIDEBAR_W - Math.max(PANEL_W, width * 0.34) >= minGraph) return 'columns'
  if (width - PANEL_W_NARROW >= minGraph) return 'no-sidebar'
  return 'sheet'
}

/**
 * Build the d3 simulation model. Existing ids keep their previous position/velocity (so live refreshes do not
 * scramble the layout); a new node is seeded next to an already-placed neighbour when there is one.
 */
export function buildSimModel(graph: Pick<GraphResponse, 'nodes' | 'edges'>, prev: ReadonlyMap<string, PrevPos> = new Map()): SimModel {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const links: SimLink[] = []
  let dangling = 0
  const seen = new Set<string>()
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      dangling++
      continue
    }
    const key = edgeKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    links.push({
      key,
      data: e,
      type: e.type,
      directed: e.directed,
      width: linkWidth(e.accessCount),
      opacity: linkOpacity(e.accessCount),
      source: e.source,
      target: e.target,
    })
  }

  const adj = adjacency(graph.edges)
  const added: string[] = []
  const nodes: SimNode[] = graph.nodes.map((n) => {
    const tk = typeKey(n.type)
    // canvas text: importer bookkeeping and a restated type word dropped (the dot colour already says the type)
    const text = stripTypePrefix(stripImporterPrefix(n.description || n.id), n.type)
    const node: SimNode = {
      id: n.id,
      data: n,
      r: nodeRadius(n.degree),
      color: TYPE_COLORS[tk],
      typeKey: tk,
      label: truncateLabel(text),
      labelLines: wrapLabel(text),
      text,
      date: n.updated ?? n.created,
      lang: labelLang(text),
    }
    const p = prev.get(n.id)
    if (p && p.x !== undefined && p.y !== undefined) {
      node.x = p.x
      node.y = p.y
      node.vx = p.vx ?? 0
      node.vy = p.vy ?? 0
    } else {
      added.push(n.id)
      for (const nb of adj.get(n.id) ?? []) {
        const q = prev.get(nb)
        if (q && q.x !== undefined && q.y !== undefined) {
          const a = hash01(n.id) * Math.PI * 2
          node.x = q.x + Math.cos(a) * 30
          node.y = q.y + Math.sin(a) * 30
          break
        }
      }
    }
    return node
  })
  return { nodes, links, dangling, added }
}

/** Undirected adjacency over every edge (directed edges are walkable both ways for ego focus). */
export function adjacency(edges: readonly Pick<GraphEdge, 'source' | 'target'>[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    let s = adj.get(a)
    if (!s) adj.set(a, (s = new Set()))
    s.add(b)
  }
  for (const e of edges) {
    if (e.source === e.target) continue
    add(e.source, e.target)
    add(e.target, e.source)
  }
  return adj
}

/** Nodes within `hops` (1–3) of `center`, including the center. */
export function egoNetwork(edges: readonly Pick<GraphEdge, 'source' | 'target'>[], center: string, hops: number): Set<string> {
  const adj = adjacency(edges)
  const out = new Set([center])
  let frontier = [center]
  for (let h = 0; h < hops && frontier.length; h++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!out.has(nb)) {
          out.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return out
}

/** Side-list order: mapRank ascending; unranked after, by created descending; id as final tie-break. */
export function compareForList(a: GraphNode, b: GraphNode): number {
  if (a.mapRank !== null && b.mapRank !== null) return a.mapRank - b.mapRank || a.id.localeCompare(b.id)
  if (a.mapRank !== null) return -1
  if (b.mapRank !== null) return 1
  const ca = a.created ?? ''
  const cb = b.created ?? ''
  if (ca !== cb) {
    if (!ca) return 1
    if (!cb) return -1
    return ca < cb ? 1 : -1
  }
  return a.id.localeCompare(b.id)
}

export function sortForList(nodes: readonly GraphNode[]): GraphNode[] {
  return [...nodes].sort(compareForList)
}

export type StatusFilter = 'all' | 'active' | 'superseded'

export interface Filters {
  /** Empty set = all types. */
  types: ReadonlySet<NodeTypeKey>
  status: StatusFilter
  /** null = no search active. */
  searchIds: ReadonlySet<string> | null
}

export function matchesFilters(n: GraphNode, f: Filters): boolean {
  if (f.types.size > 0 && !f.types.has(typeKey(n.type))) return false
  if (f.status === 'active' && n.superseded) return false
  if (f.status === 'superseded' && !n.superseded) return false
  if (f.searchIds && !f.searchIds.has(n.id)) return false
  return true
}

export type Visibility = 'normal' | 'dim' | 'hidden'

/**
 * Per-node visibility. Without ego focus, nodes that miss the filters are dimmed (context stays visible).
 * With ego focus, nodes outside the ego network are hidden; inside it, filter misses are dimmed.
 */
export function computeVisibility(
  nodes: readonly GraphNode[],
  edges: readonly Pick<GraphEdge, 'source' | 'target'>[],
  filters: Filters,
  ego: { center: string; hops: number } | null,
): Map<string, Visibility> {
  const egoSet = ego && nodes.some((n) => n.id === ego.center) ? egoNetwork(edges, ego.center, ego.hops) : null
  const vis = new Map<string, Visibility>()
  for (const n of nodes) {
    if (egoSet && !egoSet.has(n.id)) vis.set(n.id, 'hidden')
    else vis.set(n.id, matchesFilters(n, filters) ? 'normal' : 'dim')
  }
  return vis
}

/** Edge visibility follows its endpoints: hidden if either is hidden, dim if either is dim. */
export function linkVisibility(vis: ReadonlyMap<string, Visibility>, source: string, target: string): Visibility {
  const a = vis.get(source) ?? 'normal'
  const b = vis.get(target) ?? 'normal'
  if (a === 'hidden' || b === 'hidden') return 'hidden'
  if (a === 'dim' || b === 'dim') return 'dim'
  return 'normal'
}

/** Trim a segment so it stops at the target circle's rim (for arrowheads). */
export function trimSegment(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  sourceR: number,
  targetR: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = tx - sx
  const dy = ty - sy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6 || len <= sourceR + targetR) return { x1: sx, y1: sy, x2: tx, y2: ty }
  const ux = dx / len
  const uy = dy / len
  return { x1: sx + ux * sourceR, y1: sy + uy * sourceR, x2: tx - ux * targetR, y2: ty - uy * targetR }
}

export const EDGE_STYLES: Record<EdgeType, { label: string; dash: string | null; color: string }> = {
  plain: { label: 'plain', dash: null, color: '#6f6658' },
  'relates-to': { label: 'relates-to', dash: '5 4', color: '#2a7f8f' },
  supersedes: { label: 'supersedes', dash: null, color: '#c2410c' },
  'follows-from': { label: 'follows-from', dash: '1.5 3.5', color: '#5b4bb7' },
}
