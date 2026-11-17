// Pure, DOM-free label placement for the graph view: greedy, priority-ordered, collision-culled in screen space.
// Unit-tested in labelPlacement.test.ts. ForceGraph.tsx feeds it screen positions + measured sizes and renders
// whatever comes back.
import { displayWidth, graphemes, LABEL_COLUMNS, truncateLabel, type Box } from './graphModel.ts'

export type LabelSide = 'right' | 'left' | 'above' | 'below'

export interface LabelItem {
  id: string
  /** Dot centre, screen px. */
  x: number
  y: number
  /** Dot radius, screen px. */
  r: number
  /** Label box size, screen px (text + halo padding). */
  w: number
  h: number
  /** Coarse priority class, lower first (search match, open handoff, neighbour, landmark, filter miss…). */
  tier: number
  /** Order inside the tier (MAP rank → degree → id), lower first. */
  order: number
  /** Budget-exempt (selection / hover neighbours): never counted against the budget, and may graze any number of
   * small dots (the user is looking at this neighbourhood); still never overlaps labels, cards, hub-sized or
   * labelled dots, overlays or edges. */
  pinned?: boolean
}

export interface Dot {
  id: string
  x: number
  y: number
  r: number
}

export interface PlacementInput {
  items: readonly LabelItem[]
  /** Every drawn dot on screen; labels must not cover them (see hardDotRadius / maxSoftDotHits). */
  dots: readonly Dot[]
  /** Overlays (legend, toolbars) and reserved boxes (selected / hovered cards). */
  obstacles: readonly Box[]
  /** Usable canvas area (already inset from the edges). */
  view: Box
  /** How many non-pinned labels may be shown. */
  budget: number
  /** Last placement: those labels try their old side first and get a rank bonus (hysteresis). */
  previous?: ReadonlyMap<string, LabelSide>
  /** Dots this big (screen px radius) may never be covered; smaller ones may be grazed up to maxSoftDotHits. */
  hardDotRadius?: number
  maxSoftDotHits?: number
  /** Gap between dot rim and label box, px. */
  gap?: number
  /** Rank positions a previously shown label is moved up by (default ≈ 30% of the budget, at least 4). */
  stickiness?: number
}

export interface PlacedLabel {
  id: string
  side: LabelSide
  box: Box
}

export interface PlacementResult {
  placed: PlacedLabel[]
  /** Items examined / dropped because every candidate position collided. */
  considered: number
  dropped: number
}

const SIDES: readonly LabelSide[] = ['right', 'left', 'above', 'below']

export function candidateBox(it: Pick<LabelItem, 'x' | 'y' | 'r' | 'w' | 'h'>, side: LabelSide, gap = 3): Box {
  switch (side) {
    case 'right':
      return { left: it.x + it.r + gap, right: it.x + it.r + gap + it.w, top: it.y - it.h / 2, bottom: it.y + it.h / 2 }
    case 'left':
      return { left: it.x - it.r - gap - it.w, right: it.x - it.r - gap, top: it.y - it.h / 2, bottom: it.y + it.h / 2 }
    case 'above':
      return { left: it.x - it.w / 2, right: it.x + it.w / 2, top: it.y - it.r - gap - it.h, bottom: it.y - it.r - gap }
    case 'below':
      return { left: it.x - it.w / 2, right: it.x + it.w / 2, top: it.y + it.r + gap, bottom: it.y + it.r + gap + it.h }
  }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function circleHitsBox(cx: number, cy: number, r: number, b: Box): boolean {
  const nx = Math.max(b.left, Math.min(cx, b.right))
  const ny = Math.max(b.top, Math.min(cy, b.bottom))
  const dx = cx - nx
  const dy = cy - ny
  return dx * dx + dy * dy < r * r
}

/** Uniform grid over screen space: O(1) neighbourhood queries for boxes and dots. */
class Grid<T> {
  private cells = new Map<number, T[]>()
  constructor(private size: number) {}
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + (cy + 32768)
  }
  insert(b: Box, v: T) {
    const s = this.size
    for (let cx = Math.floor(b.left / s); cx <= Math.floor(b.right / s); cx++)
      for (let cy = Math.floor(b.top / s); cy <= Math.floor(b.bottom / s); cy++) {
        const k = this.key(cx, cy)
        const c = this.cells.get(k)
        if (c) c.push(v)
        else this.cells.set(k, [v])
      }
  }
  /** Calls fn for every value in the cells overlapping b (a value may repeat); stops when fn returns true. */
  some(b: Box, fn: (v: T) => boolean): boolean {
    const s = this.size
    for (let cx = Math.floor(b.left / s); cx <= Math.floor(b.right / s); cx++)
      for (let cy = Math.floor(b.top / s); cy <= Math.floor(b.bottom / s); cy++) {
        const c = this.cells.get(this.key(cx, cy))
        if (c) for (const v of c) if (fn(v)) return true
      }
    return false
  }
}

/**
 * Greedy label placement. Items are taken in priority order (tier, then order — with a bonus for labels shown
 * last time); each tries its previous side, then right / left / above / below, and takes the first position that
 * stays inside the view and clear of obstacles, already placed labels, labelled dots and large dots. A label is
 * also skipped when its own dot is already covered by an earlier label. Pinned items are exempt from the budget.
 */
export function placeLabels(input: PlacementInput): PlacementResult {
  const gap = input.gap ?? 3
  const hardR = input.hardDotRadius ?? 4.5
  const maxSoft = input.maxSoftDotHits ?? 2
  const budget = Math.max(0, input.budget)
  const prev = input.previous ?? new Map<string, LabelSide>()
  const sticky = input.stickiness ?? Math.max(4, Math.round(budget * 0.3))

  const boxes = new Grid<Box>(48)
  const dots = new Grid<number>(48) // indices into input.dots
  input.dots.forEach((d, i) => dots.insert({ left: d.x - d.r, right: d.x + d.r, top: d.y - d.r, bottom: d.y + d.r }, i))
  // a dot spanning several cells is reported once per cell: stamp it per candidate instead of allocating a Set
  const stamp = new Int32Array(input.dots.length)
  let pass = 0
  const labelledDots = new Set<string>()

  const eff = (it: LabelItem) => it.order - (prev.has(it.id) ? sticky : 0)
  const queue = [...input.items].sort((a, b) => a.tier - b.tier || eff(a) - eff(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const placed: PlacedLabel[] = []
  let used = 0
  let considered = 0
  let dropped = 0
  const v = input.view

  for (const it of queue) {
    if (!it.pinned && used >= budget) continue
    considered++
    // own dot already under an earlier label → this label would point at hidden ink
    const ownDot = { left: it.x - it.r, right: it.x + it.r, top: it.y - it.r, bottom: it.y + it.r }
    if (boxes.some(ownDot, (b) => circleHitsBox(it.x, it.y, it.r, b))) {
      dropped++
      continue
    }
    const order = prev.has(it.id) ? [prev.get(it.id)!, ...SIDES.filter((s) => s !== prev.get(it.id))] : SIDES
    let chosen: PlacedLabel | null = null
    for (const side of order) {
      const b = candidateBox(it, side, gap)
      if (b.left < v.left || b.right > v.right || b.top < v.top || b.bottom > v.bottom) continue
      if (input.obstacles.some((o) => boxesOverlap(b, o))) continue
      if (boxes.some(b, (o) => boxesOverlap(b, o))) continue
      let soft = 0
      const visit = ++pass
      const blocked = dots.some(b, (i) => {
        if (stamp[i] === visit) return false
        stamp[i] = visit
        const d = input.dots[i]!
        if (d.id === it.id) return false
        if (!circleHitsBox(d.x, d.y, d.r, b)) return false
        if (d.r >= hardR || labelledDots.has(d.id)) return true
        return !it.pinned && ++soft > maxSoft
      })
      if (blocked) continue
      chosen = { id: it.id, side, box: b }
      break
    }
    if (!chosen) {
      dropped++
      continue
    }
    placed.push(chosen)
    boxes.insert(chosen.box, chosen.box)
    labelledDots.add(it.id)
    if (!it.pinned) used++
  }
  return { placed, considered, dropped }
}

/** Landmark target at fit zoom. */
export const LANDMARK_BASE = 20

/**
 * How many landmark labels to show: ~20 at fit zoom on a full-size canvas, growing with zoom (relative to the fit
 * zoom) so zooming in reveals local labels, and gently with canvas area. "Maximise" (Aa) multiplies it.
 */
export function labelBudget(o: { k: number; fitK: number; viewArea: number; maximise?: boolean; refArea?: number }): number {
  const zoom = Math.min(8, Math.max(0.4, o.k / Math.max(1e-6, o.fitK)))
  const area = Math.min(1.5, Math.max(0.45, Math.sqrt(o.viewArea / (o.refArea ?? 1100 * 840))))
  const n = LANDMARK_BASE * Math.pow(zoom, 0.9) * area
  return o.maximise ? Math.min(400, Math.round(n * 8)) : Math.max(4, Math.min(90, Math.round(n)))
}

// ───────────── disambiguating identical labels ─────────────

export interface DisambItem {
  id: string
  /** The label as currently shown (truncated). */
  label: string
  /** Full (prefix-stripped) description the label was cut from. */
  text: string
  /** ISO date (updated ?? created), if any. */
  date: string | null
}

const TAG_COLUMNS = 14
/** Characters that make up a Latin-ish token (word, id, version, path piece). */
const WORDC = /^[\p{Script=Latin}\p{N}_\-.@#'’]$/u
/** Han / kana: one "token" per run (no spaces in CJK text). */
const HANC = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u
const MEANINGFUL = /[\p{L}\p{N}]/gu
/** A complete short bracketed tail ("(5)", "(39)", "（二）") is a perfectly good tag on its own. */
const BRACKET_TAIL = /^[(（][\p{L}\p{N}]{1,6}[)）]$/u

const meaningfulCount = (s: string) => (s.match(MEANINGFUL) ?? []).length
const stripPunct = (s: string) => s.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')

/**
 * The tag that tells one description apart from its look-alikes, starting where it diverges (`lcp`): whole tokens,
 * no leading/trailing punctuation, at most TAG_COLUMNS wide. Null when it would say almost nothing (< 3 letters /
 * digits / Han), so the caller falls back to a date or the id tail.
 */
export function divergenceTag(g: readonly string[], lcp: number): string | null {
  const kind = (c: string | undefined) => (c === undefined ? 0 : WORDC.test(c) ? 1 : HANC.test(c) ? 2 : 0)
  // back up to the start of the token the divergence falls in ("9f2e41aa", not "2e41aa")
  let s = lcp
  while (s > 0 && kind(g[s - 1]) === 1 && kind(g[s]) === 1) s--
  const tail = g.slice(s > 0 && /[(（]/.test(g[s - 1]!) ? s - 1 : s).join('').trim()
  if (BRACKET_TAIL.test(tail)) return tail
  // skip separators, then collect whole tokens (with the separators between them) while they fit
  while (s < g.length && kind(g[s]) === 0) s++
  let out = ''
  let i = s
  let truncated = false
  while (i < g.length) {
    let sep = ''
    while (i < g.length && kind(g[i]) === 0) sep += g[i++]
    if (i >= g.length) break
    const k = kind(g[i])
    let tok = ''
    while (i < g.length && kind(g[i]) === k) tok += g[i++]
    const next = out ? out + sep + tok : tok
    if (displayWidth(next) <= TAG_COLUMNS) {
      out = next
      if (meaningfulCount(out) >= 3 && displayWidth(out) >= TAG_COLUMNS - 3) break
      continue
    }
    // doesn't fit: take part of it only when what we have is still too thin to identify anything
    if (meaningfulCount(out) < 3) {
      out = truncateLabel(next, TAG_COLUMNS)
      truncated = out.endsWith('…')
    }
    break
  }
  let tag = stripPunct(out)
  if (truncated && tag) tag += '…'
  return meaningfulCount(tag) >= 3 ? tag : null
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function shortDate(d: string, all: (string | null)[]): string {
  const years = new Set(all.filter((x): x is string => !!x).map((x) => x.slice(0, 4)))
  return years.size > 1 ? d.slice(0, 10) : d.slice(5, 10)
}

/**
 * Labels that came out identical (e.g. two "01J00000000000000000000004 的…") get a distinguishing tag: the part of
 * the description where they first differ, else their date, else the id's tail. Returns new labels for the ids
 * that needed one; everything else is untouched. Pure.
 */
export function disambiguateLabels(items: readonly DisambItem[], columns = LABEL_COLUMNS): Map<string, string> {
  const groups = new Map<string, DisambItem[]>()
  for (const it of items) {
    const g = groups.get(it.label)
    if (g) g.push(it)
    else groups.set(it.label, [it])
  }
  const out = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const gs = group.map((it) => graphemes(it.text.replace(/\s+/g, ' ').trim()))
    const dates = group.map((it) => it.date)
    const idTail = (id: string) => `#${id.slice(-4)}`
    const dateTag = (i: number) => {
      const d = group[i]!.date
      if (!d) return null
      const t = shortDate(d, dates)
      return group.some((g, j) => j !== i && g.date && shortDate(g.date, dates) === t) ? null : t
    }
    const tags = group.map((it, i) => {
      let lcp = 0
      for (let j = 0; j < group.length; j++) if (j !== i) lcp = Math.max(lcp, commonPrefix(gs[i]!, gs[j]!))
      const ex = lcp < gs[i]!.length ? divergenceTag(gs[i]!, lcp) : null
      return ex ?? dateTag(i) ?? idTail(it.id)
    })
    // tags that still collide fall back to date, then id tail
    const final = tags.map((t, i) => (tags.some((u, j) => j !== i && u === t) ? (dateTag(i) ?? idTail(group[i]!.id)) : t))
    group.forEach((it, i) => {
      const tag = final[i]!
      const room = Math.max(6, columns - displayWidth(tag) - 3)
      out.set(it.id, `${truncateLabel(it.text, room)} · ${tag}`)
    })
  }
  return out
}
