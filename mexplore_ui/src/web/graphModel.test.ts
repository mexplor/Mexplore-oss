import { describe, expect, test } from 'bun:test'
import type { GraphEdge, GraphNode } from '../shared/types.ts'
import {
  buildSimModel,
  compareForList,
  compareLabelPriority,
  computeVisibility,
  displayWidth,
  egoNetwork,
  graphemes,
  LABEL_COLUMNS,
  labelLang,
  linkOpacity,
  linkVisibility,
  linkWidth,
  matchesFilters,
  nodeTone,
  placeCard,
  placeCardClear,
  panelLayout,
  MIN_GRAPH_W,
  planPan,
  sortForList,
  stripImporterPrefix,
  stripTypePrefix,
  topByPriority,
  trimSegment,
  truncateLabel,
  typeColor,
  typeKey,
  TYPE_COLORS,
  WRAP_COLUMNS,
  wrapLabel,
} from './graphModel.ts'

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    description: `desc ${id}`,
    type: null,
    created: null,
    updated: null,
    superseded: false,
    supersededBy: null,
    openHandoff: false,
    degree: 0,
    attachmentCount: 0,
    mapRank: null,
    visitCount: 0,
    ...over,
  }
}

function edge(source: string, target: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return { source, target, type: 'plain', directed: false, halves: 2, accessCount: 0, lastAccess: null, ...over }
}

describe('typeKey / typeColor', () => {
  test('known types map to themselves, unknown and null fold into untyped', () => {
    expect(typeKey('decision')).toBe('decision')
    expect(typeKey(' Handoff ')).toBe('handoff')
    expect(typeKey(null)).toBe('untyped')
    expect(typeKey('weird')).toBe('untyped')
    expect(typeColor('gotcha')).toBe(TYPE_COLORS.gotcha)
    expect(typeColor(undefined)).toBe(TYPE_COLORS.untyped)
  })
})

describe('link strength scaling', () => {
  test('zero access still visible but clearly fainter; monotone; capped', () => {
    expect(linkWidth(0)).toBeGreaterThan(0.5)
    expect(linkOpacity(0)).toBeGreaterThan(0.1)
    expect(linkOpacity(0)).toBeLessThan(linkOpacity(1) - 0.15)
    expect(linkWidth(10)).toBeGreaterThan(linkWidth(1))
    expect(linkOpacity(10)).toBeGreaterThan(linkOpacity(1))
    expect(linkWidth(1e9)).toBeLessThanOrEqual(6)
    expect(linkOpacity(1e9)).toBeLessThanOrEqual(0.92)
  })
})

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('displayWidth', () => {
  test('East Asian wide counts 2, Latin 1, emoji sequences one wide grapheme', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('用户偏好')).toBe(8)
    expect(displayWidth('，：')).toBe(4)
    expect(displayWidth('a用b')).toBe(4)
    expect(displayWidth('👨‍👩‍👧')).toBe(2)
    expect(graphemes('👨‍👩‍👧🎉').length).toBe(2)
  })
})

describe('truncateLabel', () => {
  test('short text is returned as-is, whitespace collapsed; empty stays empty', () => {
    expect(truncateLabel('  magento   order\ngrid ')).toBe('magento order grid')
    expect(truncateLabel('')).toBe('')
    expect(truncateLabel('   ')).toBe('')
  })

  test('CJK is budgeted by width, not code units', () => {
    const s = '发来文章论文先默认存到收件箱然后再决定是否整理归档并且打上标签以便检索'
    const t = truncateLabel(s)
    expect(t.endsWith('…')).toBe(true)
    expect(displayWidth(t)).toBeLessThanOrEqual(LABEL_COLUMNS)
    expect(t.length).toBeLessThanOrEqual(16) // 15 Han + ellipsis
    // a 30-code-unit Latin label still fits whole
    expect(truncateLabel('launchd plist for memory agent')).toBe('launchd plist for memory agent')
  })

  test('prefers a break after CJK punctuation / spaces and drops the punctuation', () => {
    const t = truncateLabel('发来文章/论文先默认存 Obsidian 01-Inbox，再决定是否整理归档')
    expect(t).toBe('发来文章/论文先默认存 Obsidian…') // "01-Inbox" would overflow; not cut in half
    expect(truncateLabel('记忆图谱的边按访问次数，加权排序后再写回地图文件里面')).toBe('记忆图谱的边按访问次数…')
  })

  test('mixed text never cuts inside a Latin ID', () => {
    const t = truncateLabel('DEMO4100 精简版移植到 sample-go main 分支并修正回调 DEMO4200')
    expect(displayWidth(t)).toBeLessThanOrEqual(LABEL_COLUMNS)
    const head = t.slice(0, -1)
    // whatever survives ends on a whole token
    expect(['DEMO4100', 'sample-go', 'main'].some((tok) => head.endsWith(tok)) || /\p{Script=Han}$/u.test(head)).toBe(true)
    expect(head).not.toMatch(/sample-g$|sampl$|DEMO42$/)
    const ids = truncateLabel('see 01J00000000000000000000004 and 01J00000000000000000000003')
    expect(ids).toBe('see 01J00000000000000000000004…')
  })

  test('emoji and surrogate pairs are never split', () => {
    const s = '评审结论 🎉👨‍👩‍👧 '.repeat(6)
    for (const n of [5, 8, 11, 17, 32]) {
      const t = truncateLabel(s, n)
      expect(t).not.toMatch(LONE_SURROGATE)
      expect(displayWidth(t)).toBeLessThanOrEqual(n)
      expect(t.includes('\u200D') ? t.includes('👨‍👩‍👧') : true).toBe(true)
    }
  })

  test('a single unbreakable token still truncates hard', () => {
    const t = truncateLabel('x'.repeat(80))
    expect(t).toBe('x'.repeat(LABEL_COLUMNS - 1) + '…')
  })
})

describe('wrapLabel', () => {
  test('short text is one line', () => {
    expect(wrapLabel('bun sqlite WAL')).toEqual(['bun sqlite WAL'])
  })
  test('at most two lines, each within the column budget, ellipsis on overflow', () => {
    const lines = wrapLabel('发来文章/论文先默认存 Obsidian 01-Inbox，再决定是否整理归档并打标签')
    expect(lines.length).toBe(2)
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(WRAP_COLUMNS)
    expect(lines[1]!.endsWith('…')).toBe(true)
    const latin = wrapLabel('graph-maintain prune policy for stale edges and orphans')
    expect(latin[0]).toBe('graph-maintain prune')
    // CJK wraps on a dictionary word boundary, not mid-word (默认 stays whole)
    const zh = wrapLabel('发来文章/论文先默认存 Obsidian 01-Inbox')
    expect(zh.some((l) => l.endsWith('默') || l.startsWith('认'))).toBe(false)
    // closing punctuation hangs instead of starting a line
    expect(wrapLabel('部署前先跑门禁测试，失败不得上线')).toEqual(['部署前先跑门禁测试，', '失败不得上线'])
    // a date token is not split on the ellipsis line
    expect(wrapLabel('gpt-6.1-sol 评审结论 2026-11-03：通过 🎉', 18)[1]).toBe('评审结论…')
    expect(wrapLabel('gpt-6.1-sol 评审结论 2026-11-03：通过 🎉')).toEqual(['gpt-6.1-sol 评审结论', '2026-11-03：通过 🎉'])
    // a slightly-too-long leading token overflows the line instead of splitting
    expect(wrapLabel('workflow-dispatcher 配置放在 配置中心，不在部署包里')[0]).toBe('workflow-dispatcher')
    expect(latin.every((l) => !l.startsWith(' ') && !l.endsWith(' '))).toBe(true)
  })
})

describe('stripTypePrefix', () => {
  test('drops a prefix that restates the Node type', () => {
    expect(stripTypePrefix('用户偏好：发来文章先存 Obsidian', 'preference')).toBe('发来文章先存 Obsidian')
    expect(stripTypePrefix('决策： 端口 43190 只监听本机', 'decision')).toBe('端口 43190 只监听本机')
    expect(stripTypePrefix('Decision: port 43190 for ui', 'decision')).toBe('port 43190 for ui')
    expect(stripTypePrefix('gotcha:FSEvents coalescing', 'Gotcha')).toBe('FSEvents coalescing')
  })
  test('keeps it when the type differs, the word is unknown, or nothing would be left', () => {
    expect(stripTypePrefix('决策：端口 43190', 'thread')).toBe('决策：端口 43190')
    expect(stripTypePrefix('decision: port 43190', null)).toBe('decision: port 43190')
    expect(stripTypePrefix('DEMO4100 lean-C4 port: plan', 'decision')).toBe('DEMO4100 lean-C4 port: plan')
    expect(stripTypePrefix('http://example.com', 'decision')).toBe('http://example.com')
    expect(stripTypePrefix('决策：', 'decision')).toBe('决策：')
    expect(stripTypePrefix('决策：  …  ', 'decision')).toBe('决策：  …  ')
    expect(stripTypePrefix('', 'decision')).toBe('')
  })
})

describe('stripImporterPrefix (canvas labels only)', () => {
  test('drops a leading label(…date…) group', () => {
    expect(stripImporterPrefix('线程(2026-07-09 Claude Code session a1000001 part 3,orion-agent):正文在这里')).toBe('正文在这里')
    expect(stripImporterPrefix('2026-05-14(Claude Code session a1000002, part 1):用户贴了一张截图')).toBe('用户贴了一张截图')
    expect(stripImporterPrefix('偏好/做法（2026-06-03，用户多次纠正）：汇报要说人话')).toBe('汇报要说人话')
    expect(stripImporterPrefix('Gotcha(2026-06-15 session a1000003 part 1): compaction drops tool results')).toBe('compaction drops tool results')
  })

  test('keeps text whose parenthetical has no date, or no prefix at all', () => {
    expect(stripImporterPrefix('acme-orion-eval(context compact eval)三套 eval 全景')).toBe('acme-orion-eval(context compact eval)三套 eval 全景')
    expect(stripImporterPrefix('Plain description')).toBe('Plain description')
  })

  test('drops bookkeeping-only leaders: date, session <hex>, part N, (…), then a colon', () => {
    const cases: [string, string][] = [
      ['2026-06-03 session a1000004 part 1(orion-agent):为证明 dossier 有效跑 LoCoMo', '为证明 dossier 有效跑 LoCoMo'],
      ['2026-06-01 session a1000005 part 6:按用户要求记录改动', '按用户要求记录改动'],
      ['2026-06-02 session a1000006 part 2 (a1000006-2222-4333, /Users/someone/Code): review 收敛', 'review 收敛'],
      ['2026-06-25 session a1000007(Claude Code,/Users/someone)part 1:用户慰劳测试团队', '用户慰劳测试团队'],
      ['2026-06-23 Claude Code session a1000008（/Users/someone/Code/orion-agent）：用户连发四次', '用户连发四次'],
      ['2026-06-03 session a1000006 part 1→part 3:收口完成了', '收口完成了'],
      ['租赁合同案 2026-07-22 session a1000009 part 1:三方胜算评估收口', '三方胜算评估收口'],
    ]
    for (const [from, to] of cases) expect(stripImporterPrefix(from)).toBe(to)
  })

  test('keeps a leader when content sits between the date and the colon', () => {
    for (const d of [
      '租赁合同案 2026-07-22 更新(session a100000a part 1):确认开庭日期',
      '2026-06-09 session a100000b part 6 时间线(orion-agent):dossier 压缩触发排查',
      '2026-08-05 session a100000c part 3 大更正:该 session 实际在 JP staging',
      '2026-05-27 生成 Orion vs Vega context 压缩对比报告:见附件',
      'worker a200000000000001 2026-06-24 恢复:失败原因',
      '2026-05-31 orion-agent/session a1000005 part 4:本地拉最新代码',
    ])
      expect(stripImporterPrefix(d)).toBe(d)
  })

  test('falls back to the original when the rest is empty or very short', () => {
    expect(stripImporterPrefix('线程(2026-07-09 session 1):')).toBe('线程(2026-07-09 session 1):')
    expect(stripImporterPrefix('线程(2026-07-09 session 1):ok')).toBe('线程(2026-07-09 session 1):ok')
  })

  test('buildSimModel: the canvas label is stripped, the data keeps the full description', () => {
    const d = '线程(2026-07-28 Claude Code session a100000d part 1,orion 投资助手):宏观+实时突发市场分析'
    const m = buildSimModel({ nodes: [node('A', { description: d, type: 'thread' })], edges: [] })
    expect(m.nodes[0]!.label).toBe('宏观+实时突发市场分析')
    expect(m.nodes[0]!.labelLines.join('')).toBe('宏观+实时突发市场分析')
    expect(m.nodes[0]!.data.description).toBe(d) // tooltip, panel, list and search read this
  })
})

describe('label helpers', () => {
  test('labelLang tags CJK scripts only', () => {
    expect(labelLang('Common 工序拆分 meeting')).toBe('zh-Hans')
    expect(labelLang('ひらがな と 漢字')).toBe('ja')
    expect(labelLang('한국어')).toBe('ko')
    expect(labelLang('plain latin')).toBeNull()
  })
  test('label priority follows links: degree first (MAP.md rank ignored), then id', () => {
    const list = [node('b-lo', { degree: 1, mapRank: 0 }), node('r3', { degree: 5, mapRank: 3 }), node('a-hi', { degree: 9 }), node('c-tie', { degree: 5 })]
    expect(list.sort(compareLabelPriority).map((n) => n.id)).toEqual(['a-hi', 'c-tie', 'r3', 'b-lo'])
    const prio = new Map(list.map((n, i) => [n.id, i]))
    expect([...topByPriority(['b-lo', 'r3', 'a-hi'], prio, 2)]).toEqual(['a-hi', 'r3'])
    expect(topByPriority(['a'], prio, 0).size).toBe(0)
  })
  test('buildSimModel strips the redundant prefix and tags the language', () => {
    const m = buildSimModel({ nodes: [node('P', { type: 'preference', description: '用户偏好：发来文章/论文先默认存 Obsidian 01-Inbox，再决定是否整理' })], edges: [] })
    const p = m.nodes[0]!
    expect(p.label.startsWith('发来文章')).toBe(true)
    expect(p.lang).toBe('zh-Hans')
    expect(p.labelLines.length).toBeLessThanOrEqual(2)
  })
})

describe('buildSimModel', () => {
  const nodes = [node('A', { degree: 2, type: 'decision' }), node('B', { degree: 1 }), node('C', { degree: 1 })]
  const edges = [
    edge('A', 'B', { accessCount: 4 }),
    edge('A', 'C', { type: 'supersedes', directed: true, halves: 1 }),
    edge('A', 'Z'), // dangling endpoint
    edge('A', 'B', { accessCount: 4 }), // duplicate key
  ]

  test('one sim node per graph node, one link per unique edge, dangling dropped', () => {
    const m = buildSimModel({ nodes, edges })
    expect(m.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C'])
    expect(m.links.map((l) => l.key)).toEqual(['A|B|plain', 'A|C|supersedes'])
    expect(m.dangling).toBe(1)
    expect(m.added).toEqual(['A', 'B', 'C'])
  })

  test('maps style attributes from data', () => {
    const m = buildSimModel({ nodes, edges })
    const a = m.nodes[0]!
    expect(a.color).toBe(TYPE_COLORS.decision)
    expect(a.r).toBeGreaterThan(m.nodes[1]!.r)
    const sup = m.links[1]!
    expect(sup.directed).toBe(true)
    expect(sup.source).toBe('A')
    expect(sup.target).toBe('C')
    expect(m.links[0]!.width).toBeGreaterThan(sup.width)
  })

  test('keeps previous positions by id and seeds new nodes near a placed neighbour', () => {
    const prev = new Map([
      ['A', { x: 100, y: 50, vx: 1, vy: 2 }],
      ['B', { x: -10, y: 5 }],
    ])
    const m = buildSimModel({ nodes, edges }, prev)
    const [a, b, c] = m.nodes
    expect([a!.x, a!.y, a!.vx, a!.vy]).toEqual([100, 50, 1, 2])
    expect([b!.x, b!.y]).toEqual([-10, 5])
    expect(m.added).toEqual(['C'])
    // C's only neighbour is A → placed 30px from A
    expect(Math.hypot(c!.x! - 100, c!.y! - 50)).toBeCloseTo(30, 5)
  })

  test('new node with no placed neighbour leaves x/y undefined for d3 to initialise', () => {
    const m = buildSimModel({ nodes: [node('Q')], edges: [] }, new Map())
    expect(m.nodes[0]!.x).toBeUndefined()
  })
})

describe('list ordering', () => {
  test('mapRank ascending, then unranked by created desc, nulls last', () => {
    const list = sortForList([
      node('u-old', { created: '2026-10-01' }),
      node('r2', { mapRank: 2 }),
      node('u-none'),
      node('r0', { mapRank: 0 }),
      node('u-new', { created: '2026-11-03' }),
    ])
    expect(list.map((n) => n.id)).toEqual(['r0', 'r2', 'u-new', 'u-old', 'u-none'])
    expect(compareForList(node('a', { mapRank: 1 }), node('b', { mapRank: 1 }))).toBeLessThan(0)
  })
})

describe('ego network + visibility', () => {
  const edges = [edge('A', 'B'), edge('B', 'C', { directed: true, type: 'follows-from' }), edge('C', 'D'), edge('X', 'Y')]
  const nodes = ['A', 'B', 'C', 'D', 'X', 'Y'].map((id) => node(id, { superseded: id === 'C' }))

  test('hops walk edges regardless of direction', () => {
    expect([...egoNetwork(edges, 'A', 1)].sort()).toEqual(['A', 'B'])
    expect([...egoNetwork(edges, 'A', 2)].sort()).toEqual(['A', 'B', 'C'])
    expect([...egoNetwork(edges, 'D', 3)].sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  test('filters dim, ego hides', () => {
    const f = { types: new Set<never>(), status: 'active' as const, searchIds: null }
    const v1 = computeVisibility(nodes, edges, f, null)
    expect(v1.get('C')).toBe('dim')
    expect(v1.get('X')).toBe('normal')
    const v2 = computeVisibility(nodes, edges, f, { center: 'A', hops: 2 })
    expect(v2.get('X')).toBe('hidden')
    expect(v2.get('B')).toBe('normal')
    expect(v2.get('C')).toBe('dim')
    expect(linkVisibility(v2, 'B', 'C')).toBe('dim')
    expect(linkVisibility(v2, 'X', 'Y')).toBe('hidden')
    // unknown ego center → no focus applied
    expect(computeVisibility(nodes, edges, f, { center: 'NOPE', hops: 1 }).get('X')).toBe('normal')
  })

  test('search + type filters', () => {
    const n = node('A', { type: 'gotcha' })
    expect(matchesFilters(n, { types: new Set(['gotcha']), status: 'all', searchIds: null })).toBe(true)
    expect(matchesFilters(n, { types: new Set(['decision']), status: 'all', searchIds: null })).toBe(false)
    expect(matchesFilters(n, { types: new Set(), status: 'all', searchIds: new Set(['B']) })).toBe(false)
  })
})

describe('trimSegment', () => {
  test('stops at the circle rims', () => {
    const s = trimSegment(0, 0, 100, 0, 5, 10)
    expect(s).toEqual({ x1: 5, y1: 0, x2: 90, y2: 0 })
    // overlapping circles: untouched
    expect(trimSegment(0, 0, 3, 0, 5, 5)).toEqual({ x1: 0, y1: 0, x2: 3, y2: 0 })
  })
})

describe('nodeTone — filter dim never buries the selection (Kimi review #1)', () => {
  const base = { vis: 'normal' as const, selected: false, hovered: false, neighbour: false, hoverLabelled: false, lens: false }
  test('selection and hovered Node stay full even when they miss the filter', () => {
    expect(nodeTone({ ...base, vis: 'dim', selected: true, lens: true })).toBe('full')
    expect(nodeTone({ ...base, vis: 'dim', hovered: true })).toBe('full')
  })
  test('filter-missing neighbours are soft — above the lens background, below full', () => {
    expect(nodeTone({ ...base, vis: 'dim', neighbour: true, lens: true })).toBe('soft')
    expect(nodeTone({ ...base, neighbour: true, lens: true })).toBe('full')
    expect(nodeTone({ ...base, lens: true })).toBe('faint')
    expect(nodeTone({ ...base, vis: 'dim', lens: true })).toBe('faint')
  })
  test('hover-labelled neighbours are lifted too; plain filter misses stay faint', () => {
    expect(nodeTone({ ...base, vis: 'dim', hoverLabelled: true })).toBe('soft')
    expect(nodeTone({ ...base, hoverLabelled: true, lens: true })).toBe('soft')
    expect(nodeTone({ ...base, hoverLabelled: true })).toBe('full')
    expect(nodeTone({ ...base, vis: 'dim' })).toBe('faint')
    expect(nodeTone(base)).toBe('full')
  })
  test('hop focus still hides', () => {
    expect(nodeTone({ ...base, vis: 'hidden', neighbour: true })).toBe('hidden')
  })
  test('label budget prefers filter matches, then rank', () => {
    const prio = new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]])
    const dim = new Set(['a', 'b'])
    expect([...topByPriority(['a', 'b', 'c', 'd'], prio, 3, (id) => dim.has(id))]).toEqual(['c', 'd', 'a'])
  })
})

describe('planPan — clear of overlays (Kimi review #2)', () => {
  const view = { left: 8, top: 8, right: 792, bottom: 592 }
  const legend = { left: 14, top: 400, right: 314, bottom: 592 }
  const tools = { left: 740, top: 14, right: 784, bottom: 200 }
  const shift = (b: typeof view, d: { dx: number; dy: number }) => ({ left: b.left + d.dx, right: b.right + d.dx, top: b.top + d.dy, bottom: b.bottom + d.dy })
  const hits = (a: typeof view, b: typeof view) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

  test('no move when already clear', () => {
    expect(planPan({ left: 400, top: 200, right: 560, bottom: 240 }, view, [legend, tools])).toEqual({ dx: 0, dy: 0 })
  })
  test('a box behind the legend moves out by the smallest pan', () => {
    const box = { left: 100, top: 480, right: 260, bottom: 520 }
    const d = planPan(box, view, [legend, tools])
    const moved = shift(box, d)
    expect(hits(moved, legend)).toBe(false)
    expect(moved.left >= view.left && moved.right <= view.right && moved.top >= view.top && moved.bottom <= view.bottom).toBe(true)
    // escaping upward (88 + gap) beats escaping right (222 + gap)
    expect(d).toEqual({ dx: 0, dy: 400 - 8 - 520 })
  })
  test('off-canvas and behind a toolbar at once', () => {
    const box = { left: 700, top: 0, right: 860, bottom: 40 }
    const moved = shift(box, planPan(box, view, [legend, tools]))
    expect(hits(moved, tools) || hits(moved, legend)).toBe(false)
    expect(moved.right).toBeLessThanOrEqual(view.right)
    expect(moved.top).toBeGreaterThanOrEqual(view.top)
  })
  test('nothing fits → centre', () => {
    const d = planPan({ left: 0, top: 0, right: 2000, bottom: 40 }, view, [])
    expect(d.dx).toBe(400 - 1000)
  })
})

describe('placeCard — flips and clamps (Kimi review #4)', () => {
  const view = { left: 6, top: 6, right: 594, bottom: 394 }
  test('prefers the right side', () => {
    expect(placeCard({ left: 90, right: 110, cy: 200 }, { w: 150, h: 38 }, view)).toEqual({ x: 114, y: 181, side: 'right' })
  })
  test('flips left when the right side would overflow', () => {
    const p = placeCard({ left: 520, right: 540, cy: 200 }, { w: 150, h: 38 }, view)
    expect(p.side).toBe('left')
    expect(p.x + 150).toBeLessThanOrEqual(520)
  })
  test('clamps vertically and horizontally when neither side fits', () => {
    const p = placeCard({ left: 280, right: 300, cy: 8 }, { w: 400, h: 38 }, view)
    expect(p.y).toBe(6)
    expect(p.x).toBeGreaterThanOrEqual(6)
    expect(p.x + 400).toBeLessThanOrEqual(594)
  })
  test('prefers the side that does not cover other dots (simple view neighbours)', () => {
    const neighbourOnRight = { left: 130, top: 190, right: 150, bottom: 210 }
    expect(placeCard({ left: 290, right: 310, cy: 200 }, { w: 150, h: 38 }, view, view, 4, [{ left: 330, top: 190, right: 350, bottom: 210 }]).side).toBe('left')
    // both sides covered equally → keep the preferred right side
    expect(placeCard({ left: 290, right: 310, cy: 200 }, { w: 150, h: 38 }, view, view, 4, [neighbourOnRight, { left: 330, top: 190, right: 350, bottom: 210 }]).side).toBe('right')
  })
  test('a dot panned off-canvas keeps its card next to it (no clamping into view)', () => {
    expect(placeCard({ left: 700, right: 720, cy: 200 }, { w: 150, h: 38 }, view)).toEqual({ x: 724, y: 181, side: 'right' })
  })

  // Kimi review 2 #2: the off-canvas test uses the real canvas, the inset only clamps
  const canvas = { left: 0, top: 0, right: 600, bottom: 400 }
  test.each([1, 2.77, 5])('dot %ppx inside the top edge: card clamped fully into the inset', (cy) => {
    const p = placeCard({ left: 90, right: 110, cy }, { w: 150, h: 38 }, view, canvas)
    expect(p.y).toBe(6)
    expect(p.side).toBe('right')
  })
  test.each([1, 3, 5])('dot %ppx inside the bottom edge: card clamped fully into the inset', (d) => {
    const p = placeCard({ left: 90, right: 110, cy: 400 - d }, { w: 150, h: 38 }, view, canvas)
    expect(p.y + 38).toBe(394)
  })
  test('dot genuinely off-canvas (above the top) is not clamped', () => {
    const p = placeCard({ left: 90, right: 110, cy: -12 }, { w: 150, h: 38 }, view, canvas)
    expect(p.y).toBe(-12 - 19)
  })
})

describe('placeCardClear — overlays are hard (Kimi review 3 #3)', () => {
  const view = { left: 6, top: 6, right: 594, bottom: 394 }
  const dot = { left: 290, right: 310, cy: 200 }
  test('no overlay in the way: same spot as placeCard', () => {
    const p = placeCardClear(dot, { w: 150, h: 38 }, view, view, 4, [], [{ left: 0, top: 0, right: 100, bottom: 50 }])
    expect(p).toEqual({ ...placeCard(dot, { w: 150, h: 38 }, view), blocked: false })
  })
  test('legend on the right: flips left even when the right side "fits"', () => {
    const p = placeCardClear(dot, { w: 150, h: 38 }, view, view, 4, [], [{ left: 320, top: 150, right: 594, bottom: 394 }])
    expect(p.side).toBe('left')
    expect(p.blocked).toBe(false)
  })
  test('overlay on both sides at dot height: nudged vertically while staying beside the dot', () => {
    const hard = [{ left: 314, top: 185, right: 594, bottom: 215 }, { left: 0, top: 185, right: 286, bottom: 215 }]
    const p = placeCardClear(dot, { w: 150, h: 38 }, view, view, 4, [], hard)
    expect(p.blocked).toBe(true) // a 38px card cannot clear a 30px band and still touch a 20px dot
    const tall = [{ left: 314, top: 150, right: 594, bottom: 196 }]
    const q = placeCardClear(dot, { w: 150, h: 38 }, view, view, 4, [], [...tall, { left: 0, top: 0, right: 286, bottom: 394 }])
    expect(q.blocked).toBe(false)
    expect(q.y).toBeGreaterThanOrEqual(196)
    expect(q.y).toBeLessThan(210)
  })
  test('nowhere clear: reports blocked so the caller can pan / free space', () => {
    const p = placeCardClear(dot, { w: 150, h: 38 }, view, view, 4, [], [{ left: 0, top: 0, right: 600, bottom: 400 }])
    expect(p.blocked).toBe(true)
  })
})

describe('panelLayout — picked from the graph width it leaves (Kimi review 3 #1)', () => {
  test('desktop keeps three columns while the graph keeps MIN_GRAPH_W', () => {
    expect(panelLayout(1440)).toBe('columns')
    expect(panelLayout(1366)).toBe('columns')
  })
  test('mid widths drop the sidebar instead of squeezing the graph to ~360px', () => {
    for (const w of [1000, 1101, 1200, 1300]) expect(panelLayout(w)).toBe('no-sidebar')
  })
  test('narrow windows lay the panel over the graph as a sheet', () => {
    for (const w of [600, 700, 801, 900]) expect(panelLayout(w)).toBe('sheet')
  })
  test('the graph never gets narrower than MIN_GRAPH_W beside a panel', () => {
    for (let w = 500; w <= 2000; w += 7) {
      const l = panelLayout(w)
      const graph = l === 'columns' ? w - 318 - Math.max(420, w * 0.34) : l === 'no-sidebar' ? w - 360 : w
      expect(graph).toBeGreaterThanOrEqual(Math.min(MIN_GRAPH_W, w))
    }
  })
})
