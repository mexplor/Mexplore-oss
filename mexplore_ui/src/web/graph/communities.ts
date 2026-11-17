// Community clustering + topic words for the graph's semantic zoom. Pure (no DOM, no d3 runtime), deterministic,
// unit-tested in communities.test.ts. ForceGraph computes this once per graph structure and draws each community as
// one bubble when zoomed far out.
//
// Clustering is a small self-contained Louvain (Blondel et al. 2008: local moving + aggregation, repeated until no
// node moves). Nodes are visited in sorted-id order, so the partition depends only on the graph — not on input order,
// and with no random number generator at all.
import { LEADING_META, TYPE_KEYS, typeKey, type NodeTypeKey } from '../graphModel.ts'

// ───────────── Louvain ─────────────

/** Weighted undirected graph over 0..n-1. `nbr[i]` / `w[i]` are parallel; a pair appears once in each endpoint's list. */
interface WGraph {
  n: number
  nbr: number[][]
  w: number[][]
  /** Self-loop weight per node (an aggregated community's internal weight). */
  self: number[]
}

function degrees(g: WGraph): number[] {
  const k = new Array<number>(g.n).fill(0)
  for (let i = 0; i < g.n; i++) {
    let s = 2 * g.self[i]!
    for (const x of g.w[i]!) s += x
    k[i] = s
  }
  return k
}

/** One level of local moving. Returns the community of each node (renumbered 0..c-1 by first appearance) and
 * whether any node moved. */
function localMoving(g: WGraph, resolution: number): { comm: number[]; count: number; moved: boolean } {
  const k = degrees(g)
  let m2 = 0
  for (const x of k) m2 += x
  const comm = Array.from({ length: g.n }, (_, i) => i)
  const tot = k.slice()
  let movedAny = false
  if (m2 === 0) return { comm, count: g.n, moved: false }
  const wc = new Map<number, number>()
  for (let pass = 0; pass < 100; pass++) {
    let moved = 0
    for (let i = 0; i < g.n; i++) {
      const ci = comm[i]!
      const ki = k[i]!
      wc.clear()
      const nb = g.nbr[i]!
      const ww = g.w[i]!
      for (let a = 0; a < nb.length; a++) {
        const c = comm[nb[a]!]!
        wc.set(c, (wc.get(c) ?? 0) + ww[a]!)
      }
      tot[ci] = tot[ci]! - ki
      // gain of joining c (up to a constant shared by every c): w(i→c) − γ·tot(c)·k_i / 2m
      let best = ci
      let bestGain = (wc.get(ci) ?? 0) - (resolution * tot[ci]! * ki) / m2
      for (const [c, wic] of wc) {
        if (c === ci) continue
        const gain = wic - (resolution * tot[c]! * ki) / m2
        // strictly better (epsilon) keeps the node where it is on ties; equal gains go to the lower community index
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && best !== ci && c < best)) {
          best = c
          bestGain = gain
        }
      }
      tot[best] = tot[best]! + ki
      if (best !== ci) {
        comm[i] = best
        moved++
      }
    }
    if (!moved) break
    movedAny = true
  }
  const remap = new Map<number, number>()
  for (let i = 0; i < g.n; i++) {
    const c = comm[i]!
    if (!remap.has(c)) remap.set(c, remap.size)
    comm[i] = remap.get(c)!
  }
  return { comm, count: remap.size, moved: movedAny }
}

function aggregate(g: WGraph, comm: readonly number[], count: number): WGraph {
  const maps = Array.from({ length: count }, () => new Map<number, number>())
  const self = new Array<number>(count).fill(0)
  for (let i = 0; i < g.n; i++) {
    const ci = comm[i]!
    self[ci] = self[ci]! + g.self[i]!
    const nb = g.nbr[i]!
    const ww = g.w[i]!
    for (let a = 0; a < nb.length; a++) {
      const j = nb[a]!
      if (j < i) continue // each pair once
      const cj = comm[j]!
      if (ci === cj) self[ci] = self[ci]! + ww[a]!
      else {
        maps[ci]!.set(cj, (maps[ci]!.get(cj) ?? 0) + ww[a]!)
        maps[cj]!.set(ci, (maps[cj]!.get(ci) ?? 0) + ww[a]!)
      }
    }
  }
  return {
    n: count,
    nbr: maps.map((m) => [...m.keys()]),
    w: maps.map((m) => [...m.values()]),
    self,
  }
}

/**
 * Louvain community detection on an undirected weighted graph over nodes 0..n-1 (duplicate pairs add up, self-loops
 * are ignored). Returns a community index per node (0..c-1). Deterministic: nodes are visited in index order.
 */
export function louvain(n: number, edges: readonly (readonly [number, number, number])[], resolution = 1): number[] {
  const maps = Array.from({ length: n }, () => new Map<number, number>())
  for (const [a, b, w] of edges) {
    if (a === b || a < 0 || b < 0 || a >= n || b >= n || !(w > 0)) continue
    maps[a]!.set(b, (maps[a]!.get(b) ?? 0) + w)
    maps[b]!.set(a, (maps[b]!.get(a) ?? 0) + w)
  }
  let g: WGraph = { n, nbr: maps.map((m) => [...m.keys()]), w: maps.map((m) => [...m.values()]), self: new Array<number>(n).fill(0) }
  let member = Array.from({ length: n }, (_, i) => i)
  for (let level = 0; level < 32; level++) {
    const { comm, count, moved } = localMoving(g, resolution)
    if (!moved) break
    member = member.map((c) => comm[c]!)
    g = aggregate(g, comm, count)
  }
  return member
}

/** Newman modularity of a partition (for tests and the report). */
export function modularity(n: number, edges: readonly (readonly [number, number, number])[], comm: readonly number[]): number {
  let m = 0
  const k = new Array<number>(n).fill(0)
  const inW = new Map<number, number>()
  for (const [a, b, w] of edges) {
    if (a === b) continue
    m += w
    k[a] = k[a]! + w
    k[b] = k[b]! + w
    if (comm[a] === comm[b]) inW.set(comm[a]!, (inW.get(comm[a]!) ?? 0) + w)
  }
  if (m === 0) return 0
  const tot = new Map<number, number>()
  for (let i = 0; i < n; i++) tot.set(comm[i]!, (tot.get(comm[i]!) ?? 0) + k[i]!)
  let q = 0
  for (const [c, t] of tot) q += (inW.get(c) ?? 0) / m - (t / (2 * m)) ** 2
  return q
}

// ───────────── topic words ─────────────

/** Removed anywhere in the text before tokenising: links, ids, dates, times, versions, `part N`. */
const NOISE_PATTERNS: readonly RegExp[] = [
  /https?:\/\/\S+/giu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, // uuid
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/gu, // ULID (node ids)
  /\d{4}-\d{1,2}(?:-\d{1,2})?/gu, // dates
  /\b\d{1,2}-\d{1,2}\b/gu, // short dates 07-19
  /\d{1,2}:\d{2}(?::\d{2})?/gu, // times
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/giu, // commit / session hex ids
  /\bv?\d+(?:\.\d+)+\b/giu, // versions
  /\bpart\s*\d+\b/giu,
]

/** English words that say nothing about a topic: grammar, plus this graph's bookkeeping vocabulary. */
export const EN_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'the and for with from into onto that this these those are was were been being has have had not but via per ' +
    'its it’s use used uses using see also only all any each etc than then when what which who why how out off ' +
    'over under about after before again more most some such can could would should will may might must one two ' +
    'new now yes just very still both own same other into upon there their them they you your our his her she ' +
    'claude code session sessions part worktree user users assistant attachment attachments details detail node ' +
    'nodes memory note notes fact facts gotcha gotchas handoff journal thread threads decision decisions preference ' +
    'preferences pref result results status cst utc pst jst todo done tbd none null true false ' +
    // git / work-log vocabulary every coding memory shares
    'feat fix develop main master branch commit merge step steps run runs turn turns seq'
  ).split(' '),
)

/**
 * CJK bigrams that carry no topic: the importer's labels (事实 / 偏好 / 线程 / 结果 …) and generic words. Anything
 * containing a function character (CJK_FUNCTION_CHARS) is dropped as well.
 */
export const CJK_STOP_TERMS: ReadonlySet<string> = new Set(
  (
    '用户 助手 附件 原话 线程 休眠 决策 结果 偏好 方向 事实 做法 状态 结论 教训 规则 诊断 落地 交接 日志 踩坑 ' +
    '本次 这次 已经 没有 一个 进行 需要 可以 以及 通过 因为 所以 但是 如果 不是 就是 什么 怎么 目前 当前 之后 之前 ' +
    '然后 同时 其中 包括 相关 问题 情况 内容 时候 要求 说明 结果 工作 明确 确认 现在 继续 下次 再次 只有 所有 两个 ' +
    '三个 第一 第二 用于 对于 关于 根据 直接 一次 一下 一起 本地 记录 会话 实测 当时 后续 之后 仍然 必须 拍板 原文 ' +
    '已经 完成 开始 处理 使用 改成 改为 作为 不要 不会 应该 可能 原因 方案 已合'
  ).split(' '),
)

/** Single characters that glue phrases together; a CJK n-gram containing one is never a topic word. */
const CJK_FUNCTION_CHARS = new Set([...'的了是在和与及把被为也都就而或但并其该此这那之个将不着过吗呢吧啊于所以从向'])

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
// a Latin word never starts in the middle of an alphanumeric run ("3b2f" is an id fragment, not the word "b2f")
const LATIN_WORD = /(?<![\p{L}\p{N}])[\p{Script=Latin}][\p{Script=Latin}\p{N}]*(?:[-_][\p{Script=Latin}\p{N}]+)*/gu

/** Strip the bookkeeping prefix and the noise patterns. */
export function cleanDescription(s: string): string {
  let t = s.replace(LEADING_META, ' ')
  for (const re of NOISE_PATTERNS) t = t.replace(re, ' ')
  return t
}

/**
 * Distinct terms of one description: lowercase Latin words (≥ 3 chars, no stopwords, not mostly digits) and CJK
 * character n-grams of length 2–4 (no stop terms, no function characters).
 */
export function terms(description: string): ReadonlySet<string> {
  const hit = termCache.get(description)
  if (hit) return hit
  const out = extractTerms(description)
  if (termCache.size > 20000) termCache.clear()
  termCache.set(description, out)
  return out
}

/** Descriptions rarely change between live refreshes: a rebuilt graph only tokenises its new descriptions. */
const termCache = new Map<string, ReadonlySet<string>>()

function extractTerms(description: string): Set<string> {
  const text = cleanDescription(description)
  const out = new Set<string>()
  for (const m of text.matchAll(LATIN_WORD)) {
    const w = m[0].toLowerCase()
    if (w.length < 3 || EN_STOPWORDS.has(w)) continue
    const digits = w.replace(/\D/g, '').length
    // ids and codes ("p1a", "x86") — a digit is fine in a longer name ("gpt5-mini", "locomo10")
    if (digits * 2 >= w.length || (digits > 0 && w.length < 5)) continue
    out.add(w)
  }
  for (const m of text.matchAll(CJK_RUN)) {
    const run = Array.from(m[0])
    const cuts = wordCuts(m[0], run)
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        // n-grams start and end on dictionary word boundaries (見附件 → no "见附"; 用户拍板 → no "户拍")
        if (cuts && (!cuts.has(i) || !cuts.has(i + n))) continue
        const g = run.slice(i, i + n)
        if (g.some((c) => CJK_FUNCTION_CHARS.has(c))) continue
        const term = g.join('')
        if (n === 2 && CJK_STOP_TERMS.has(term)) continue
        if (n > 2 && hasStopBigramEdge(term)) continue
        out.add(term)
      }
    }
  }
  return out
}

const wordSegmenter: { segment(s: string): Iterable<{ index: number }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null

/** Character positions (in `chars`) where a dictionary word starts or the run ends; null without Intl.Segmenter
 * (then every position counts and the n-grams are plain character n-grams). */
function wordCuts(run: string, chars: readonly string[]): Set<number> | null {
  if (!wordSegmenter) return null
  const at = new Map<number, number>()
  let off = 0
  chars.forEach((c, i) => {
    at.set(off, i)
    off += c.length
  })
  const out = new Set<number>([chars.length])
  for (const seg of wordSegmenter.segment(run)) {
    const i = at.get(seg.index)
    if (i !== undefined) out.add(i)
  }
  return out
}

/** A longer n-gram that starts or ends with a stop bigram ("用户偏好" → starts with 用户) is not a topic either. */
function hasStopBigramEdge(term: string): boolean {
  const cs = Array.from(term)
  return CJK_STOP_TERMS.has(cs.slice(0, 2).join('')) || CJK_STOP_TERMS.has(cs.slice(-2).join(''))
}

const isCjk = (s: string) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(s)

/** Two picked terms say the same thing: one contains the other (any script), or two CJK terms overlap as
 * suffix/prefix — they were cut from the same phrase (租赁 / 赁合同). */
function overlapsTerm(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true
  if (!isCjk(a) || !isCjk(b)) return false
  const ca = Array.from(a)
  const cb = Array.from(b)
  for (let n = 1; n < Math.min(ca.length, cb.length); n++) {
    if (ca.slice(-n).join('') === cb.slice(0, n).join('')) return true
    if (cb.slice(-n).join('') === ca.slice(0, n).join('')) return true
  }
  return false
}

/**
 * Pick up to `count` distinctive terms for a group of documents (TF-IDF-like): a term scores
 * (share of the group's documents containing it) × log(N / documents containing it in the whole graph), each document
 * counted once. A term must appear in at least two of the group's documents (one, for a group of one). Overlapping
 * picks are skipped.
 */
export function topTerms(
  group: readonly ReadonlySet<string>[],
  df: ReadonlyMap<string, number>,
  totalDocs: number,
  count = 3,
): string[] {
  const cf = new Map<string, number>()
  for (const doc of group) for (const t of doc) cf.set(t, (cf.get(t) ?? 0) + 1)
  const minCf = group.length >= 2 ? 2 : 1
  const scored: { t: string; s: number }[] = []
  for (const [t, c] of cf) {
    if (c < minCf) continue
    const d = df.get(t) ?? c
    const idf = Math.log((totalDocs + 1) / d)
    // CJK n-grams: a slight bonus per extra character, so the whole word beats its own fragments at equal coverage
    const len = isCjk(t) ? Array.from(t).length : 2
    const s = (c / group.length) * idf * (1 + 0.04 * (len - 2))
    if (s > 0) scored.push({ t, s })
  }
  scored.sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  // a fragment stands for its whole phrase: 租赁 → 租赁合同 when the longer CJK n-gram covers ≥ 80% of the fragment's
  // documents (the longest such, then the most covered)
  const whole = (t: string): string => {
    if (!isCjk(t)) return t
    const c = cf.get(t)!
    let best = t
    for (const [u, cu] of cf) {
      if (u.length <= best.length || !u.includes(t) || cu < Math.max(minCf, 0.8 * c)) continue
      best = u
    }
    return best
  }
  const out: string[] = []
  for (const s0 of scored) {
    const t = whole(s0.t)
    if (out.some((p) => overlapsTerm(p, t))) continue
    out.push(t)
    if (out.length >= count) break
  }
  return out
}

// ───────────── communities of a graph ─────────────

/** Communities smaller than this are folded away (into a neighbour community, or into "other"). */
export const MIN_COMMUNITY = 3
/** At most this many bubbles; the smallest communities beyond it join "other". */
export const MAX_COMMUNITIES = 40

export interface CommunityNodeInput {
  id: string
  description: string
  type?: string | null
  degree?: number
}

export interface Community {
  /** Index in `communities` (sorted by size, largest first; "other" last). */
  index: number
  /** Smallest member id: a stable handle across rebuilds of the same graph. */
  key: string
  members: string[]
  /** Isolated / tiny groups folded together. */
  other: boolean
  /** Most common node type among the members (ties: TYPE_KEYS order). */
  dominantType: NodeTypeKey
  /** 2–3 distinctive topic words (may be fewer, never junk-padded). */
  terms: string[]
  /** Up to TOP_PER_COMMUNITY members that get a label at mid zoom (degree, then id). */
  top: string[]
}

export const TOP_PER_COMMUNITY = 3

export interface CommunityLink {
  a: number
  b: number
  /** Number of distinct node pairs linking the two communities. */
  count: number
}

export interface CommunityResult {
  communities: Community[]
  /** Node id → community index. */
  of: Map<string, number>
  links: CommunityLink[]
  /** Modularity of the raw Louvain partition (before folding small communities). */
  modularity: number
  /** Raw Louvain community count (before folding). */
  rawCount: number
  ms: { cluster: number; terms: number }
}

/**
 * Cluster the graph (Louvain over unique undirected node pairs, weight 1 — the edge type and direction do not
 * matter, and a pair linked twice counts once) and describe each community.
 *
 * Small communities (< MIN_COMMUNITY nodes) that have links outside join the neighbouring community they share the
 * most links with; the rest (isolated nodes, isolated pairs) are folded into one "other" community, which also takes
 * every community beyond the MAX_COMMUNITIES largest.
 */
export function detectCommunities(
  nodes: readonly CommunityNodeInput[],
  links: readonly { source: string; target: string }[],
  opts: { resolution?: number; minSize?: number; maxCommunities?: number } = {},
): CommunityResult {
  const t0 = performance.now()
  const minSize = opts.minSize ?? MIN_COMMUNITY
  const maxCommunities = opts.maxCommunities ?? MAX_COMMUNITIES
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const index = new Map(sorted.map((n, i) => [n.id, i]))
  const pairs = new Set<string>()
  const edges: [number, number, number][] = []
  for (const l of links) {
    const a = index.get(l.source)
    const b = index.get(l.target)
    if (a === undefined || b === undefined || a === b) continue
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = lo * 1048576 + hi
    if (pairs.has(String(key))) continue
    pairs.add(String(key))
    edges.push([lo, hi, 1])
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const n = sorted.length
  const raw = louvain(n, edges, opts.resolution ?? 1)
  const q = modularity(n, edges, raw)
  const rawCount = new Set(raw).size

  // fold small communities
  const size = new Map<number, number>()
  for (const c of raw) size.set(c, (size.get(c) ?? 0) + 1)
  const comm = raw.slice()
  const OTHER = -1
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const [a, b] of edges) {
    adj[a]!.push(b)
    adj[b]!.push(a)
  }
  const rawMembers = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const c = raw[i]!
    let g = rawMembers.get(c)
    if (!g) rawMembers.set(c, (g = []))
    g.push(i)
  }
  for (const [c, ms] of rawMembers) {
    if (ms.length >= minSize) continue
    // links from the whole small community to big communities
    const votes = new Map<number, number>()
    for (const j of ms) {
      for (const x of adj[j]!) {
        const cx = raw[x]!
        if (cx !== c && (size.get(cx) ?? 0) >= minSize) votes.set(cx, (votes.get(cx) ?? 0) + 1)
      }
    }
    let best = OTHER
    let bestV = 0
    for (const [cx, v] of votes) {
      if (v > bestV || (v === bestV && best !== OTHER && ((size.get(cx) ?? 0) > (size.get(best) ?? 0) || ((size.get(cx) ?? 0) === (size.get(best) ?? 0) && cx < best)))) {
        best = cx
        bestV = v
      }
    }
    for (const j of ms) comm[j] = best
  }
  // group, order by size (largest first), cap, "other" last
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const c = comm[i]!
    let g = groups.get(c)
    if (!g) groups.set(c, (g = []))
    g.push(i)
  }
  const real = [...groups.entries()].filter(([c]) => c !== OTHER).map(([, m]) => m)
  real.sort((a, b) => b.length - a.length || a[0]! - b[0]!)
  const kept = real.slice(0, maxCommunities)
  const otherMembers = [...(groups.get(OTHER) ?? []), ...real.slice(maxCommunities).flat()].sort((a, b) => a - b)
  const memberLists: { m: number[]; other: boolean }[] = kept.map((m) => ({ m, other: false }))
  if (otherMembers.length) memberLists.push({ m: otherMembers, other: true })
  const tCluster = performance.now()

  // topic words: document frequency over the whole graph, each node counted once
  const docs = sorted.map((nd) => terms(nd.description || ''))
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1)

  const of = new Map<string, number>()
  const communities: Community[] = memberLists.map(({ m, other }, ci) => {
    const members = m.map((i) => sorted[i]!)
    for (const nd of members) of.set(nd.id, ci)
    const typeCount = new Map<NodeTypeKey, number>()
    for (const nd of members) {
      const tk = typeKey(nd.type)
      typeCount.set(tk, (typeCount.get(tk) ?? 0) + 1)
    }
    let dominantType: NodeTypeKey = 'untyped'
    let dc = -1
    for (const tk of TYPE_KEYS) {
      const c = typeCount.get(tk) ?? 0
      if (c > dc) {
        dc = c
        dominantType = tk
      }
    }
    // same order as the graph's label priority (compareLabelPriority): most links first, then id
    const top = members
      .map((nd) => ({ id: nd.id, degree: nd.degree ?? 0 }))
      .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, TOP_PER_COMMUNITY)
      .map((x) => x.id)
    return {
      index: ci,
      key: members[0]!.id,
      members: members.map((nd) => nd.id),
      other,
      dominantType,
      terms: topTerms(
        m.map((i) => docs[i]!),
        df,
        n,
      ),
      top: other ? [] : top,
    }
  })

  const linkCount = new Map<number, number>()
  for (const [a, b] of edges) {
    const ca = of.get(sorted[a]!.id)!
    const cb = of.get(sorted[b]!.id)!
    if (ca === cb) continue
    const lo = Math.min(ca, cb)
    const hi = Math.max(ca, cb)
    linkCount.set(lo * 65536 + hi, (linkCount.get(lo * 65536 + hi) ?? 0) + 1)
  }
  const clinks: CommunityLink[] = [...linkCount.entries()]
    .map(([k, count]) => ({ a: Math.floor(k / 65536), b: k % 65536, count }))
    .sort((x, y) => x.a - y.a || x.b - y.b)

  return {
    communities,
    of,
    links: clinks,
    modularity: q,
    rawCount,
    ms: { cluster: tCluster - t0, terms: performance.now() - tCluster },
  }
}

// ───────────── semantic zoom levels ─────────────

/** Semantic zoom only pays off on big graphs; below this the plain view is readable. */
export const SEMANTIC_MIN_NODES = 200
/** …and with at least this many bubbles to show. */
export const SEMANTIC_MIN_COMMUNITIES = 3

/**
 * Zoom thresholds as multiples of the zoom at which the whole graph fits the canvas (k / fitK), the same relative
 * measure the label budget uses: the absolute scale at fit depends on the graph's size.
 *  - below FAR_END: bubbles only
 *  - FAR_END…FADE_END: bubbles fade out, nodes fade in
 *  - FADE_END…MID_END: nodes; only each community's top nodes are labelled
 *  - above MID_END: today's view (labels by budget)
 */
export const SZ_FAR_END = 1.5
export const SZ_FADE_END = 2.2
export const SZ_MID_END = 3.5

export type SemanticLevel = 'far' | 'fade' | 'mid' | 'near'

export interface SemanticState {
  level: SemanticLevel
  /** Bubble layer opacity 0..1. */
  bubbles: number
  /** Node + edge layer opacity 0..1. */
  nodes: number
}

export function semanticState(k: number, fitK: number, enabled: boolean): SemanticState {
  if (!enabled || !(fitK > 0)) return { level: 'near', bubbles: 0, nodes: 1 }
  const z = k / fitK
  if (z < SZ_FAR_END) return { level: 'far', bubbles: 1, nodes: 0 }
  if (z < SZ_FADE_END) {
    const x = (z - SZ_FAR_END) / (SZ_FADE_END - SZ_FAR_END)
    const s = x * x * (3 - 2 * x) // smoothstep
    return { level: 'fade', bubbles: 1 - s, nodes: s }
  }
  if (z < SZ_MID_END) return { level: 'mid', bubbles: 0, nodes: 1 }
  return { level: 'near', bubbles: 0, nodes: 1 }
}

export function semanticEnabled(o: { nodeCount: number; communityCount: number; local: boolean; anyHidden: boolean }): boolean {
  return !o.local && !o.anyHidden && o.nodeCount >= SEMANTIC_MIN_NODES && o.communityCount >= SEMANTIC_MIN_COMMUNITIES
}

/**
 * Push overlapping circles apart (in place) until every pair keeps `gap` between rims, or `iterations` run out. A
 * pair splits the overlap in inverse proportion to area, so a big bubble barely moves and small ones slide off it.
 * Display only: communities share links, so their node patches overlap, but their bubbles must not. Deterministic.
 */
export function separateBubbles(circles: { x: number; y: number; r: number }[], gap = 8, iterations = 120): void {
  const n = circles.length
  for (let it = 0; it < iterations; it++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const a = circles[i]!
      if (!(a.r > 0)) continue
      for (let j = i + 1; j < n; j++) {
        const b = circles[j]!
        if (!(b.r > 0)) continue
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        const min = a.r + b.r + gap
        if (d >= min) continue
        if (d < 1e-6) {
          // coincident centres: a fixed direction per pair keeps the result deterministic
          const ang = ((i * 7 + j * 13) % 360) * (Math.PI / 180)
          dx = Math.cos(ang)
          dy = Math.sin(ang)
          d = 1
        } else {
          dx /= d
          dy /= d
        }
        const push = (min - d) / 2 + 0.01
        const wa = b.r * b.r / (a.r * a.r + b.r * b.r) // a moves by b's share of the area
        a.x -= dx * push * 2 * wa
        a.y -= dy * push * 2 * wa
        b.x += dx * push * 2 * (1 - wa)
        b.y += dy * push * 2 * (1 - wa)
        moved = true
      }
    }
    if (!moved) break
  }
}

/** Zoom cap for a selection focus (same ceiling as the whole-graph fit). */
export const FOCUS_MAX_K = 1.6

/**
 * Where to look when a node is selected while semantic zoom is active: the bounding box of the node and its 1-hop
 * neighbours (world units, already including dot radii), fitted into a w×h canvas with `pad` px of air.
 *  - The zoom is at least `minK` (the mid level, so labels and not bubbles show) and at most max(minK, FOCUS_MAX_K).
 *  - Never zooms out: when `currentK` is already at or beyond the target, the zoom stays and the view only pans to
 *    centre the node.
 *  - Centred on the box when it fits at the chosen zoom; otherwise on the node itself (a crowded hub keeps every
 *    neighbour, some just off screen, but the selection is always in the middle).
 * Returns the zoom and the world point to put at the canvas centre.
 */
export function focusTarget(o: {
  node: { x: number; y: number }
  bbox: { x0: number; y0: number; x1: number; y1: number }
  w: number
  h: number
  pad: number
  currentK: number
  minK: number
}): { k: number; cx: number; cy: number; panOnly: boolean } {
  const bw = Math.max(1, o.bbox.x1 - o.bbox.x0)
  const bh = Math.max(1, o.bbox.y1 - o.bbox.y0)
  const fitK = Math.min(Math.max(1, o.w - 2 * o.pad) / bw, Math.max(1, o.h - 2 * o.pad) / bh)
  const target = Math.min(Math.max(o.minK, FOCUS_MAX_K), Math.max(o.minK, fitK))
  if (o.currentK >= target) return { k: o.currentK, cx: o.node.x, cy: o.node.y, panOnly: true }
  const fits = target <= fitK + 1e-9
  return fits
    ? { k: target, cx: (o.bbox.x0 + o.bbox.x1) / 2, cy: (o.bbox.y0 + o.bbox.y1) / 2, panOnly: false }
    : { k: target, cx: o.node.x, cy: o.node.y, panOnly: false }
}

/** World-space bubble radius: area proportional to the member count (one node ≈ a disc of radius `unit`). */
export function bubbleRadius(count: number, unit = 16): number {
  return unit * Math.sqrt(Math.max(1, count))
}

// ───────────── bubble colours ─────────────

/**
 * Categorical bubble hues by community slot (validated light-theme order; validate_palette.js against the paper
 * surface #f4f0e6: all checks pass, contrast vs surface < 3:1 for orange / aqua / yellow / magenta). That is
 * acceptable because colour is never the only identity cue: every bubble is directly labelled with its topic words
 * and member count, and slots 9–16 add a dashed stroke as a second encoding.
 */
export const BUBBLE_HUES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const
export const BUBBLE_NEUTRAL = '#a49c92'

export type BubbleTier = 'solid' | 'tint' | 'neutral'

/**
 * Colour of a community bubble by its slot (communities are ordered by size, largest first, ties by the lowest node
 * id — so the same graph always gets the same colours): slots 1–8 take the eight hues; 9–16 reuse them as a lighter
 * tint with a dashed stroke; beyond 16, and "other", stay neutral grey (dashed). Never a generated hue.
 */
export function bubbleColor(c: Pick<Community, 'index' | 'other'>): { color: string; tier: BubbleTier } {
  if (c.other || c.index >= BUBBLE_HUES.length * 2) return { color: BUBBLE_NEUTRAL, tier: 'neutral' }
  return { color: BUBBLE_HUES[c.index % BUBBLE_HUES.length]!, tier: c.index < BUBBLE_HUES.length ? 'solid' : 'tint' }
}
