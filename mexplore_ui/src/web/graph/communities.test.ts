import { describe, expect, test } from 'bun:test'
import {
  focusTarget,
  FOCUS_MAX_K,
  BUBBLE_HUES,
  BUBBLE_NEUTRAL,
  bubbleColor,
  bubbleRadius,
  cleanDescription,
  detectCommunities,
  louvain,
  MAX_COMMUNITIES,
  modularity,
  semanticEnabled,
  semanticState,
  separateBubbles,
  SZ_FADE_END,
  SZ_FAR_END,
  SZ_MID_END,
  terms,
  topTerms,
  type CommunityNodeInput,
} from './communities.ts'

/** Deterministic PRNG for synthetic graphs (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

const id = (i: number) => `N${String(i).padStart(5, '0')}`

/** `groups` dense clusters of `size` nodes, `bridges` random links between clusters. */
function plantedGraph(groups: number, size: number, pIn: number, bridges: number, seed = 7) {
  const r = rng(seed)
  const nodes: CommunityNodeInput[] = []
  const links: { source: string; target: string }[] = []
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < size; i++) nodes.push({ id: id(g * size + i), description: `cluster ${g} item`, type: 'thread', degree: 0 })
    for (let i = 0; i < size; i++)
      for (let j = i + 1; j < size; j++) if (r() < pIn) links.push({ source: id(g * size + i), target: id(g * size + j) })
  }
  for (let b = 0; b < bridges; b++) {
    const g1 = Math.floor(r() * groups)
    const g2 = (g1 + 1 + Math.floor(r() * (groups - 1))) % groups
    links.push({ source: id(g1 * size + Math.floor(r() * size)), target: id(g2 * size + Math.floor(r() * size)) })
  }
  return { nodes, links }
}

/** Partition as a canonical list of sorted member lists (independent of community numbering). */
function partition(of: ReadonlyMap<string, number>): string[][] {
  const groups = new Map<number, string[]>()
  for (const [n, c] of of) {
    let g = groups.get(c)
    if (!g) groups.set(c, (g = []))
    g.push(n)
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
}

describe('louvain', () => {
  test('two cliques joined by one edge split into two communities', () => {
    const edges: [number, number, number][] = []
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) edges.push([i, j, 1], [i + 5, j + 5, 1])
    edges.push([4, 5, 1])
    const c = louvain(10, edges)
    expect(new Set(c.slice(0, 5)).size).toBe(1)
    expect(new Set(c.slice(5)).size).toBe(1)
    expect(c[0]).not.toBe(c[5])
    expect(modularity(10, edges, c)).toBeGreaterThan(0.4)
  })

  test('isolated nodes stay alone; an empty graph is all singletons', () => {
    expect(louvain(3, [])).toEqual([0, 1, 2])
    const c = louvain(4, [[0, 1, 1]])
    expect(c[0]).toBe(c[1])
    expect(new Set(c).size).toBe(3)
  })

  test('recovers planted clusters', () => {
    const g = plantedGraph(6, 30, 0.3, 25)
    const r = detectCommunities(g.nodes, g.links)
    expect(r.communities.filter((c) => !c.other).length).toBe(6)
    for (const c of r.communities) {
      const groupsInside = new Set(c.members.map((m) => Math.floor(Number(m.slice(1)) / 30)))
      expect(groupsInside.size).toBe(1)
    }
  })
})

describe('detectCommunities', () => {
  test('a synthetic two-cluster graph splits along the planted line', () => {
    const g = plantedGraph(2, 20, 0.5, 2, 11)
    const r = detectCommunities(g.nodes, g.links)
    const p = partition(r.of)
    expect(p.length).toBe(2)
    expect(p[0]).toEqual(g.nodes.slice(0, 20).map((n) => n.id))
    expect(p[1]).toEqual(g.nodes.slice(20).map((n) => n.id))
    expect(r.links).toEqual([{ a: 0, b: 1, count: r.links[0]!.count }])
    expect(r.links[0]!.count).toBeGreaterThanOrEqual(1)
  })

  test('deterministic: the same partition and terms for shuffled node and edge order', () => {
    const g = plantedGraph(8, 25, 0.2, 60, 3)
    const base = detectCommunities(g.nodes, g.links)
    for (let s = 1; s <= 5; s++) {
      const r = rng(100 + s)
      const again = detectCommunities(shuffle(g.nodes, r), shuffle(g.links, r))
      expect(partition(again.of)).toEqual(partition(base.of))
      expect(again.communities.map((c) => [c.key, c.members.length, c.terms])).toEqual(
        base.communities.map((c) => [c.key, c.members.length, c.terms]),
      )
    }
  })

  test('duplicate and reversed links count once (weight 1 per node pair)', () => {
    const g = plantedGraph(2, 12, 0.6, 1, 5)
    const doubled = [...g.links, ...g.links.map((l) => ({ source: l.target, target: l.source }))]
    expect(partition(detectCommunities(g.nodes, doubled).of)).toEqual(partition(detectCommunities(g.nodes, g.links).of))
  })

  test('isolated nodes and isolated pairs fold into one "other" community; small attached groups join a neighbour', () => {
    const g = plantedGraph(2, 10, 0.7, 1, 9)
    const nodes = [
      ...g.nodes,
      { id: 'Z1', description: 'lonely' },
      { id: 'Z2', description: 'lonely' },
      { id: 'P1', description: 'pair' },
      { id: 'P2', description: 'pair' },
      { id: 'T1', description: 'tail' },
    ]
    // T1 hangs off the first cluster only
    const links = [...g.links, { source: 'P1', target: 'P2' }, { source: 'T1', target: id(0) }]
    const r = detectCommunities(nodes, links)
    const other = r.communities.find((c) => c.other)!
    expect(other).toBeDefined()
    expect(other.members).toEqual(['P1', 'P2', 'Z1', 'Z2'])
    expect(r.communities.at(-1)).toBe(other) // "other" sorts last
    expect(r.of.get('T1')).toBe(r.of.get(id(0)))
    expect(other.top).toEqual([]) // "other" members never get mid-zoom labels
  })

  test('communities beyond the cap join "other"', () => {
    const g = plantedGraph(5, 8, 0.8, 0, 13)
    const r = detectCommunities(g.nodes, g.links, { maxCommunities: 3 })
    expect(r.communities.length).toBe(4)
    expect(r.communities[3]!.other).toBe(true)
    expect(r.communities[3]!.members.length).toBe(16)
    expect(MAX_COMMUNITIES).toBeGreaterThanOrEqual(20)
  })

  test('top nodes are the highest-degree members, dominant type is the most common type', () => {
    const nodes: CommunityNodeInput[] = [
      { id: 'a', description: '', type: 'gotcha', degree: 1 },
      { id: 'b', description: '', type: 'gotcha', degree: 9 },
      { id: 'c', description: '', type: 'decision', degree: 4 },
      { id: 'd', description: '', type: 'gotcha', degree: 4 },
    ]
    const links = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'a' },
      { source: 'a', target: 'c' },
    ]
    const r = detectCommunities(nodes, links)
    expect(r.communities.length).toBe(1)
    expect(r.communities[0]!.top).toEqual(['b', 'c', 'd'])
    expect(r.communities[0]!.dominantType).toBe('gotcha')
  })

  test('performance: 1,200 nodes / ~4k links cluster and describe within budget', () => {
    const r0 = rng(42)
    const words = ['orion', 'staging', 'deploy', 'compact', 'orion', 'notion', 'locomo', 'dossier', 'cron', 'tidb']
    const cjk = ['压缩评测', '周报', '租赁合同', '部署', '记忆', '召回', '微信', '收盘', '派发', '落库']
    const g = plantedGraph(20, 60, 0.11, 400, 21)
    for (const n of g.nodes) {
      const k = Math.floor(Number(n.id.slice(1)) / 60) % 10
      n.description = `事实(2026-07-${10 + (k % 9)}, Claude Code session ${Math.floor(r0() * 1e8).toString(16)} part 2):${cjk[k]}相关 ${words[k]} 记录 ${Math.floor(r0() * 1000)}`
    }
    expect(g.links.length).toBeGreaterThan(3500)
    const t0 = performance.now()
    const r = detectCommunities(g.nodes, g.links)
    const ms = performance.now() - t0
    // measured 21–24 ms (3 runs, bun 1.3.10, Apple silicon, 1,200 nodes / 4,334 links); the budget leaves room for
    // slow CI machines. Real graph (1,141 nodes, distinct descriptions): Louvain ~4 ms, topic words 64–110 ms cold
    expect(ms).toBeLessThan(800)
    expect(r.communities.length).toBeGreaterThanOrEqual(10)
  })
})

describe('topic words', () => {
  test('strips the importer prefix, dates, ids, times, uuids and part N', () => {
    const s =
      '线程(2026-07-28 Claude Code session a100000d part 1→part 2,orion 投资助手):01J00000000000000000000005 在 18:32 合入 b30000001,session d5000001-2222-4333-8444-555555555555'
    const c = cleanDescription(s)
    for (const junk of ['线程', '2026', 'a100000d', 'part 1', '01J00000', '18:32', 'b30000001', 'd5000001']) expect(c).not.toContain(junk)
    expect(c).toContain('合入')
    // a parenthetical without a date is content, not bookkeeping
    expect(cleanDescription('acme-orion-eval(context compact eval)三套')).toContain('acme-orion-eval')
  })

  test('the stoplist drops boilerplate words in both scripts', () => {
    const t = terms('偏好/方向(2026-07-28 用户原话):Claude Code session part 结果 决策 the user and gotcha orion 召回质量')
    for (const junk of ['偏好', '方向', '用户', '原话', '结果', '决策', 'claude', 'code', 'session', 'part', 'the', 'user', 'gotcha'])
      expect(t.has(junk)).toBe(false)
    expect(t.has('orion')).toBe(true)
    expect([...t].some((x) => x.includes('召回'))).toBe(true)
  })

  test('English: lowercase, ≥ 3 chars, no id fragments', () => {
    const t = terms('Deploy to TiDB via k8s on 3b2f p1a gpt5-mini OK')
    expect(t.has('deploy')).toBe(true)
    expect(t.has('tidb')).toBe(true)
    expect(t.has('gpt5-mini')).toBe(true)
    for (const junk of ['to', 'k8s', 'b2f', 'p1a', 'ok', 'via']) expect(t.has(junk)).toBe(false)
  })

  test('CJK: character n-grams on word boundaries, no function-character n-grams', () => {
    const t = terms('租赁合同的民事诉讼')
    expect([...t].sort()).toEqual(['合同', '民事', '民事诉讼', '租赁', '租赁合同', '诉讼'])
    for (const x of t) expect(x.includes('的')).toBe(false)
    // n-grams never start or end inside a word: 用户拍板 gives no "户拍", 见附件 no "见附"
    const u = terms('用户拍板见附件')
    expect(u.has('户拍')).toBe(false)
    expect(u.has('见附')).toBe(false)
    const r = terms('记忆召回质量下降')
    for (const x of ['记忆', '召回', '记忆召回', '召回质量']) expect(r.has(x)).toBe(true)
  })

  test('distinctive terms beat terms common to the whole graph, and the whole phrase beats its fragment', () => {
    const docs = [
      '租赁合同 诉讼 orion',
      '租赁合同 判决 orion',
      '租赁合同 诉讼 证据',
      '部署 staging orion',
      '部署 staging 生产',
      '部署 tidb staging',
    ].map((d) => terms(d))
    const df = new Map<string, number>()
    for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1)
    const first = topTerms(docs.slice(0, 3), df, docs.length)
    expect(first[0]).toBe('租赁合同')
    expect(first).toContain('诉讼')
    expect(first).not.toContain('租赁') // fragment of a picked phrase
    const second = topTerms(docs.slice(3), df, docs.length)
    expect(second.slice(0, 2).sort()).toEqual(['staging', '部署'])
  })
})

describe('semantic zoom levels', () => {
  test('far → fade → mid → near by zoom relative to the fit zoom', () => {
    const fit = 0.2
    expect(semanticState(fit, fit, true)).toEqual({ level: 'far', bubbles: 1, nodes: 0 })
    const mid = semanticState(fit * (SZ_FAR_END + SZ_FADE_END) / 2, fit, true)
    expect(mid.level).toBe('fade')
    expect(mid.bubbles).toBeCloseTo(0.5, 5)
    expect(mid.nodes).toBeCloseTo(0.5, 5)
    expect(semanticState(fit * SZ_FADE_END, fit, true).level).toBe('mid')
    expect(semanticState(fit * SZ_MID_END, fit, true).level).toBe('near')
    // disabled: always the plain view
    expect(semanticState(fit, fit, false)).toEqual({ level: 'near', bubbles: 0, nodes: 1 })
  })

  test('only on big full graphs without hop focus', () => {
    const base = { nodeCount: 1141, communityCount: 17, local: false, anyHidden: false }
    expect(semanticEnabled(base)).toBe(true)
    expect(semanticEnabled({ ...base, local: true })).toBe(false)
    expect(semanticEnabled({ ...base, anyHidden: true })).toBe(false)
    expect(semanticEnabled({ ...base, nodeCount: 120 })).toBe(false)
    expect(semanticEnabled({ ...base, communityCount: 2 })).toBe(false)
  })

  test('overlapping bubbles are pushed apart deterministically; the big one moves least', () => {
    const make = () => [
      { x: 0, y: 0, r: 100 },
      { x: 30, y: 0, r: 20 },
      { x: 30, y: 0, r: 20 },
      { x: -50, y: 10, r: 40 },
    ]
    const a = make()
    separateBubbles(a, 8)
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++)
        expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.y - a[j]!.y)).toBeGreaterThanOrEqual(a[i]!.r + a[j]!.r + 8 - 0.5)
    expect(Math.hypot(a[0]!.x, a[0]!.y)).toBeLessThan(Math.hypot(a[1]!.x - 30, a[1]!.y))
    const b = make()
    separateBubbles(b, 8)
    expect(b).toEqual(a)
  })

  test('bubble area grows with the member count', () => {
    expect(bubbleRadius(4) ** 2 / bubbleRadius(1) ** 2).toBeCloseTo(4, 5)
  })
})

describe('bubble colours', () => {
  test('slots 1–8 solid hues, 9–16 the same hues tinted, beyond and "other" neutral', () => {
    expect(bubbleColor({ index: 0, other: false })).toEqual({ color: '#2a78d6', tier: 'solid' })
    expect(bubbleColor({ index: 7, other: false })).toEqual({ color: '#e34948', tier: 'solid' })
    expect(bubbleColor({ index: 8, other: false })).toEqual({ color: '#2a78d6', tier: 'tint' })
    expect(bubbleColor({ index: 15, other: false })).toEqual({ color: '#e34948', tier: 'tint' })
    expect(bubbleColor({ index: 16, other: false })).toEqual({ color: BUBBLE_NEUTRAL, tier: 'neutral' })
    expect(bubbleColor({ index: 3, other: true })).toEqual({ color: BUBBLE_NEUTRAL, tier: 'neutral' })
    expect(BUBBLE_HUES.length).toBe(8)
  })

  test('slots are stable for the same graph regardless of input order', () => {
    const g = plantedGraph(10, 12, 0.5, 20, 17)
    const a = detectCommunities(g.nodes, g.links).communities.map((c) => [c.key, bubbleColor(c)])
    const r = rng(5)
    const b = detectCommunities(shuffle(g.nodes, r), shuffle(g.links, r)).communities.map((c) => [c.key, bubbleColor(c)])
    expect(b).toEqual(a)
  })
})

describe('focusTarget (select a node while semantic zoom is active)', () => {
  const base = { node: { x: 100, y: 50 }, w: 1000, h: 800, pad: 80, minK: 0.9 }
  test('fits the node + neighbours box and centres it', () => {
    const t = focusTarget({ ...base, bbox: { x0: 0, y0: 0, x1: 600, y1: 400 }, currentK: 0.4 })
    // (1000-160)/600 = 1.4, (800-160)/400 = 1.6 → 1.4
    expect(t.k).toBeCloseTo(1.4, 5)
    expect([t.cx, t.cy]).toEqual([300, 200])
    expect(t.panOnly).toBe(false)
  })

  test('clamped up to the mid level when the box is large; then centred on the node', () => {
    const t = focusTarget({ ...base, bbox: { x0: -2000, y0: -2000, x1: 2000, y1: 2000 }, currentK: 0.3 })
    expect(t.k).toBe(0.9)
    expect([t.cx, t.cy]).toEqual([100, 50])
  })

  test('a tiny box zooms no further than the cap', () => {
    const t = focusTarget({ ...base, bbox: { x0: 90, y0: 40, x1: 110, y1: 60 }, currentK: 0.3 })
    expect(t.k).toBe(FOCUS_MAX_K)
  })

  test('never zooms out: at or beyond the target it only pans to the node', () => {
    const t = focusTarget({ ...base, bbox: { x0: 0, y0: 0, x1: 600, y1: 400 }, currentK: 2.5 })
    expect(t).toEqual({ k: 2.5, cx: 100, cy: 50, panOnly: true })
    const same = focusTarget({ ...base, bbox: { x0: 0, y0: 0, x1: 600, y1: 400 }, currentK: 1.4 })
    expect(same.panOnly).toBe(true)
    expect(same.k).toBe(1.4)
  })
})
