import { describe, expect, test } from 'bun:test'
import type { Box } from './graphModel.ts'
import {
  boxesOverlap,
  candidateBox,
  disambiguateLabels,
  divergenceTag,
  labelBudget,
  LANDMARK_BASE,
  placeLabels,
  type Dot,
  type LabelItem,
  type PlacedLabel,
} from './labelPlacement.ts'

const view: Box = { left: 4, top: 4, right: 996, bottom: 796 }

function item(id: string, x: number, y: number, over: Partial<LabelItem> = {}): LabelItem {
  return { id, x, y, r: 4, w: 80, h: 15, tier: 3, order: 0, ...over }
}

function noOverlaps(placed: PlacedLabel[]) {
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) expect(boxesOverlap(placed[i]!.box, placed[j]!.box)).toBe(false)
}

describe('placeLabels', () => {
  test('dense cluster: never overlaps, every label inside the view', () => {
    const items: LabelItem[] = []
    for (let i = 0; i < 400; i++) items.push(item(`n${i}`, 20 + ((i * 37) % 960), 20 + ((i * 53) % 760), { order: i }))
    const r = placeLabels({ items, dots: [], obstacles: [], view, budget: 1000 })
    expect(r.placed.length).toBeGreaterThan(30)
    noOverlaps(r.placed)
    for (const p of r.placed) {
      expect(p.box.left).toBeGreaterThanOrEqual(view.left)
      expect(p.box.right).toBeLessThanOrEqual(view.right)
      expect(p.box.top).toBeGreaterThanOrEqual(view.top)
      expect(p.box.bottom).toBeLessThanOrEqual(view.bottom)
    }
  })

  test('priority: when two labels compete for the same space, the higher-priority one wins', () => {
    // a and b sit on top of each other: only one label fits around them in a narrow view
    const narrow: Box = { left: 0, top: 0, right: 200, bottom: 40 }
    const a = item('a', 100, 20, { order: 5, w: 90 })
    const b = item('b', 101, 20, { order: 1, w: 90 })
    const r = placeLabels({ items: [a, b], dots: [], obstacles: [], view: narrow, budget: 10 })
    expect(r.placed[0]!.id).toBe('b')
    const tiered = placeLabels({ items: [{ ...a, tier: 0 }, b], dots: [], obstacles: [], view: narrow, budget: 10 })
    expect(tiered.placed[0]!.id).toBe('a') // tier beats order
  })

  test('budget counts only non-pinned labels', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`n${i}`, 60 + (i % 6) * 160, 60 + Math.floor(i / 6) * 120, { order: i }))
    items.push(item('pin1', 900, 760, { pinned: true, tier: 2 }), item('pin2', 100, 760, { pinned: true, tier: 2 }))
    const r = placeLabels({ items, dots: [], obstacles: [], view, budget: 5 })
    const ids = r.placed.map((p) => p.id)
    expect(ids.filter((id) => id.startsWith('n'))).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    expect(ids).toContain('pin1')
    expect(ids).toContain('pin2')
  })

  test('obstacles and canvas edges reject positions; falls back to another side or drops', () => {
    const legend: Box = { left: 0, top: 595, right: 300, bottom: 800 }
    // right side would graze the legend, left is off-canvas → above
    const it = item('x', 70, 590, { w: 120 })
    const r = placeLabels({ items: [it], dots: [], obstacles: [legend], view, budget: 5 })
    expect(r.placed[0]!.side).toBe('above')
    expect(boxesOverlap(r.placed[0]!.box, legend)).toBe(false)
    // fully boxed in → dropped
    const boxedIn = placeLabels({ items: [item('y', 150, 700)], dots: [], obstacles: [{ left: 0, top: 600, right: 300, bottom: 800 }], view, budget: 5 })
    expect(boxedIn.placed.length).toBe(0)
    expect(boxedIn.dropped).toBe(1)
  })

  test('large dots and labelled dots are never covered; small dots may be grazed', () => {
    const it = item('a', 300, 100, { w: 100 })
    const bigOnRight: Dot = { id: 'big', x: 350, y: 100, r: 8 }
    const r1 = placeLabels({ items: [it], dots: [{ id: 'a', x: 300, y: 100, r: 4 }, bigOnRight], obstacles: [], view, budget: 5 })
    expect(r1.placed[0]!.side).toBe('left')
    const smallOnRight: Dot = { id: 's', x: 350, y: 100, r: 2 }
    const r2 = placeLabels({ items: [it], dots: [smallOnRight], obstacles: [], view, budget: 5 })
    expect(r2.placed[0]!.side).toBe('right')
    // a labelled dot (b, placed first) can't be covered by a's label, even though it is small
    const b = item('b', 350, 100, { r: 2, order: -1, w: 40 })
    const r3 = placeLabels({ items: [it, b], dots: [{ id: 'b', x: 350, y: 100, r: 2 }], obstacles: [], view, budget: 5 })
    expect(r3.placed.find((p) => p.id === 'a')!.side).toBe('left')
  })

  test('pinned labels may graze many small dots; landmarks may not', () => {
    const crowd: Dot[] = [0, 1, 2, 3, 4].map((i) => ({ id: `s${i}`, x: 320 + i * 15, y: 100, r: 2 }))
    const boxedView: Box = { left: 290, top: 80, right: 420, bottom: 120 } // only the right side fits
    const landmark = placeLabels({ items: [item('a', 300, 100, { w: 100 })], dots: crowd, obstacles: [], view: boxedView, budget: 5 })
    expect(landmark.placed.length).toBe(0)
    const pinned = placeLabels({ items: [item('a', 300, 100, { w: 100, pinned: true })], dots: crowd, obstacles: [], view: boxedView, budget: 5 })
    expect(pinned.placed.map((p) => p.side)).toEqual(['right'])
  })

  test('a label whose own dot is already covered by an earlier label is skipped', () => {
    const first = item('first', 100, 100, { w: 200, order: 0 })
    const under = item('under', 160, 100, { order: 1 }) // sits inside first's right-side box
    const r = placeLabels({ items: [first, under], dots: [], obstacles: [], view, budget: 5 })
    expect(r.placed.map((p) => p.id)).toEqual(['first'])
  })

  test('hysteresis: a previously shown label keeps its side and beats a slightly better newcomer', () => {
    const narrow: Box = { left: 0, top: 0, right: 400, bottom: 40 }
    const old = item('old', 200, 20, { order: 3, w: 150 })
    const fresh = item('fresh', 201, 20, { order: 1, w: 150 })
    const prev = new Map([['old', 'left' as const]])
    const r = placeLabels({ items: [old, fresh], dots: [], obstacles: [], view: narrow, budget: 1, previous: prev })
    expect(r.placed.map((p) => [p.id, p.side])).toEqual([['old', 'left']])
    // a much better newcomer (outside the stickiness window) still wins
    const strong = item('strong', 201, 20, { order: -10, w: 150 })
    const r2 = placeLabels({ items: [old, strong], dots: [], obstacles: [], view: narrow, budget: 1, previous: prev })
    expect(r2.placed[0]!.id).toBe('strong')
  })

  test('candidate boxes sit outside the dot, on the requested side', () => {
    const it = { x: 100, y: 100, r: 5, w: 40, h: 10 }
    expect(candidateBox(it, 'right', 3)).toEqual({ left: 108, right: 148, top: 95, bottom: 105 })
    expect(candidateBox(it, 'left', 3).right).toBe(92)
    expect(candidateBox(it, 'above', 3).bottom).toBe(92)
    expect(candidateBox(it, 'below', 3).top).toBe(108)
  })

  test('1500 items with dots places fast (spatial grid)', () => {
    const items: LabelItem[] = []
    const dots: Dot[] = []
    let s = 1
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 1500; i++) {
      const x = 10 + rnd() * 980
      const y = 10 + rnd() * 780
      const r = 2 + rnd() * 5
      items.push(item(`n${i}`, x, y, { r, order: i, w: 60 + rnd() * 120 }))
      dots.push({ id: `n${i}`, x, y, r })
    }
    const t0 = performance.now()
    const res = placeLabels({ items, dots, obstacles: [{ left: 0, top: 600, right: 300, bottom: 800 }], view, budget: 400 })
    const ms = performance.now() - t0
    noOverlaps(res.placed)
    expect(ms).toBeLessThan(16)
  })
})

describe('labelBudget', () => {
  const area = 1100 * 840
  test('about 20 at fit zoom on a full canvas', () => {
    expect(labelBudget({ k: 0.57, fitK: 0.57, viewArea: area })).toBe(LANDMARK_BASE)
  })
  test('grows with zoom, shrinks (gently) with a smaller canvas, capped', () => {
    const fit = labelBudget({ k: 1, fitK: 1, viewArea: area })
    expect(labelBudget({ k: 2, fitK: 1, viewArea: area })).toBeGreaterThan(fit)
    expect(labelBudget({ k: 1, fitK: 1, viewArea: area / 3 })).toBeLessThan(fit)
    expect(labelBudget({ k: 1, fitK: 1, viewArea: area / 3 })).toBeGreaterThanOrEqual(10)
    expect(labelBudget({ k: 100, fitK: 1, viewArea: area })).toBeLessThanOrEqual(90)
  })
  test('maximise (Aa) is much larger', () => {
    expect(labelBudget({ k: 1, fitK: 1, viewArea: area, maximise: true })).toBeGreaterThanOrEqual(150)
  })
})

describe('disambiguateLabels', () => {
  test('identical truncated labels get the part where they differ', () => {
    const out = disambiguateLabels([
      { id: 'a', label: '01J00000000000000000000004 的…', text: '01J00000000000000000000004 的 supersede 链修复 (5)', date: '2026-10-20' },
      { id: 'b', label: '01J00000000000000000000004 的…', text: '01J00000000000000000000004 的 supersede 链修复 (39)', date: '2026-10-20' },
      { id: 'c', label: 'something else', text: 'something else', date: null },
    ])
    expect(out.size).toBe(2)
    expect(out.get('a')!.endsWith('· (5)')).toBe(true)
    expect(out.get('b')!.endsWith('· (39)')).toBe(true)
    expect(out.get('a')).not.toBe(out.get('b'))
    expect(out.has('c')).toBe(false)
  })
  test('same text → date; same text and date → id tail', () => {
    const byDate = disambiguateLabels([
      { id: 'x1', label: 'weekly report', text: 'weekly report', date: '2026-10-20' },
      { id: 'x2', label: 'weekly report', text: 'weekly report', date: '2026-11-02' },
    ])
    expect(byDate.get('x1')).toBe('weekly report · 10-20')
    expect(byDate.get('x2')).toBe('weekly report · 11-02')
    const years = disambiguateLabels([
      { id: 'y1', label: 'r', text: 'r', date: '2025-10-20' },
      { id: 'y2', label: 'r', text: 'r', date: '2026-10-20' },
    ])
    expect(years.get('y1')).toBe('r · 2025-10-20')
    const byId = disambiguateLabels([
      { id: '01ABCDEF1111', label: 'dup', text: 'dup', date: null },
      { id: '01ABCDEF2222', label: 'dup', text: 'dup', date: null },
    ])
    expect(byId.get('01ABCDEF1111')).toBe('dup · #1111')
    expect(byId.get('01ABCDEF2222')).toBe('dup · #2222')
  })
  // Phase-2 review #1: a look-alike pair that rendered as "· (id…" and "· , team…"
  const OWNER_A = "Alex's Linear ticket conventions (2026-10-20): user alex@example.com (id 9f2e41aa-7c3d-4b1e), team Platform Core (PLC2)"
  const OWNER_B = "Alex's Linear ticket conventions (2026-10-20): user alex@example.com, team Platform Core (PLC2), project 数据平台 | Data"
  const meaningful = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length

  test('real look-alike pair: whole tokens, no stray punctuation, enough content', () => {
    const out = disambiguateLabels([
      { id: '01J00000000000000000000004', label: "Alex's Linear ticket convent…", text: OWNER_A, date: '2026-11-02' },
      { id: '01J00000000000000000000003', label: "Alex's Linear ticket convent…", text: OWNER_B, date: '2026-10-22' },
    ])
    const a = out.get('01J00000000000000000000004')!
    const b = out.get('01J00000000000000000000003')!
    const tagA = a.split(' · ')[1]!
    const tagB = b.split(' · ')[1]!
    expect(tagB).toBe('team Platform')
    expect(tagA.startsWith('id 9f2e41aa')).toBe(true)
    for (const t of [tagA, tagB]) {
      expect(t).not.toMatch(/^[\p{P}\s]/u) // never ", team…" / "(id…"
      expect(meaningful(t)).toBeGreaterThanOrEqual(3)
    }
    expect(a.startsWith("Alex's")).toBe(true)
  })

  test('divergenceTag: whole token, punctuation stripped, Han runs, bracketed tails', () => {
    const g = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment)
    const b = g(OWNER_B)
    expect(divergenceTag(b, OWNER_B.indexOf(', team'))).toBe('team Platform')
    // divergence inside a token backs up to the token start
    const ids = g('ref 01J00000000000000000000004 end')
    expect(divergenceTag(ids, 10)!.startsWith('01J0000000000')).toBe(true)
    const zh = g('项目：记忆系统重构，第二阶段')
    expect(divergenceTag(zh, 3)).toBe('记忆系统重构')
    expect(divergenceTag(g('链修复 (39)'), 5)).toBe('(39)')
    // too little to say → null (caller falls back)
    expect(divergenceTag(g('conventions: x'), 13)).toBeNull()
    expect(divergenceTag(g('a, b'), 1)).toBeNull()
  })

  test('thin excerpts fall back to the date, then the id tail', () => {
    const byDate = disambiguateLabels([
      { id: 'n1', label: 'conventions…', text: 'conventions: x', date: '2026-10-20' },
      { id: 'n2', label: 'conventions…', text: 'conventions: y', date: '2026-11-02' },
    ])
    expect(byDate.get('n1')!.endsWith('· 10-20')).toBe(true)
    expect(byDate.get('n2')!.endsWith('· 11-02')).toBe(true)
    const byId = disambiguateLabels([
      { id: '01J00000000000000000000004', label: 'conventions…', text: 'conventions: x', date: '2026-10-20' },
      { id: '01J00000000000000000000003', label: 'conventions…', text: 'conventions: y', date: '2026-10-20' },
    ])
    expect(byId.get('01J00000000000000000000004')!.endsWith('· #0004')).toBe(true)
    expect(byId.get('01J00000000000000000000003')!.endsWith('· #0003')).toBe(true)
  })
})
