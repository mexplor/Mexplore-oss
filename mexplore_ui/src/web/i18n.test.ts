import { afterEach, describe, expect, test } from 'bun:test'
import { DICTIONARIES, getLocale, LOCALES, setLocale, translate, translatePlural, type MsgKey } from './i18n.ts'
import { fmtCompact, fmtInt, fmtMs, fmtRelative, totalCell } from './format.ts'

afterEach(() => setLocale('en'))

describe('dictionaries', () => {
  test('every locale has exactly the same keys', () => {
    const base = Object.keys(DICTIONARIES.en).sort()
    for (const l of LOCALES) expect(Object.keys(DICTIONARIES[l]).sort()).toEqual(base)
  })

  test('no empty or whitespace-only values', () => {
    for (const l of LOCALES)
      for (const [k, v] of Object.entries(DICTIONARIES[l])) {
        if (!v.trim()) throw new Error(`${l}.${k} is empty`)
      }
  })

  test('placeholders match across locales (no {param} lost in translation)', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const k of Object.keys(DICTIONARIES.en) as MsgKey[]) expect(params(DICTIONARIES.zh[k])).toEqual(params(DICTIONARIES.en[k]))
  })

  test('plural keys come in .one/.other pairs', () => {
    const keys = Object.keys(DICTIONARIES.en)
    for (const k of keys.filter((x) => x.endsWith('.one'))) expect(keys).toContain(k.replace(/\.one$/, '.other'))
    for (const k of keys.filter((x) => x.endsWith('.other'))) expect(keys).toContain(k.replace(/\.other$/, '.one'))
  })
})

describe('translate', () => {
  test('landing copy: user-approved English, the maintainer\'s Chinese kept verbatim', () => {
    const en = DICTIONARIES.en
    const zh = DICTIONARIES.zh
    expect([en['home.eyebrow'], en['home.title'], en['home.featured'], en['mode.simple'], en['mode.full']]).toEqual(['MEMORY EXPLORER', 'Explore your memory', 'Featured', 'Simple view', 'Full graph'])
    expect([zh['home.eyebrow'], zh['home.title'], zh['home.featured'], zh['home.hint'], zh['mode.simple'], zh['mode.full']]).toEqual(['记忆浏览', '从一条记忆开始', '精选入口', '点击查看内容与关联', '简洁浏览', '完整图谱'])
    expect(translate('en', 'home.matching', { n: '1,234' })).toBe('Memories found · 1,234')
    expect(translate('zh', 'home.matching', { n: 64 })).toBe('匹配的记忆 · 64')
    expect(zh['home.lead']).toBe('搜索一个主题，或选择下面的记忆，再逐步探索它的关联。')
    expect(zh['home.none']).toBe('没有匹配的记忆，试试其他关键词或清除筛选。')
    expect(zh['focus.note']).toBe('仅显示当前记忆与最多 12 个直接关联 · 点击节点继续探索')
    expect(translatePlural('zh', 'home.links', 12)).toBe('12 个关联')
  })

  test('fills params and picks plural forms', () => {
    expect(translate('en', 'list.count', { n: 3, total: 90 })).toBe('3 of 90')
    expect(translate('zh', 'list.count', { n: 3, total: 90 })).toBe('3 / 90')
    expect(translatePlural('en', 'home.links', 1)).toBe('1 connection')
    expect(translatePlural('en', 'home.links', 12)).toBe('12 connections')
    expect(translatePlural('zh', 'home.links', 12)).toBe('12 个关联')
    expect(translatePlural('en', 'tip.visits', 1234)).toBe('1,234 visits')
  })

  test('setLocale switches the module locale used by non-React callers', () => {
    setLocale('zh')
    expect(getLocale()).toBe('zh')
    setLocale('en')
    expect(getLocale()).toBe('en')
  })
})

describe('locale-aware formatting', () => {
  test('English keeps the existing formats', () => {
    setLocale('en')
    expect(fmtInt(925307)).toBe('925,307')
    expect(fmtCompact(925307)).toBe('925k')
    expect(fmtMs(125_000)).toBe('2m 05s')
    expect(fmtRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(totalCell(undefined, false).title).toContain('Not reported')
  })

  test('Chinese uses 万-style compact numbers and Chinese relative times', () => {
    setLocale('zh')
    expect(fmtInt(925307)).toBe('925,307')
    expect(fmtCompact(925307)).toBe('92.5万')
    expect(fmtCompact(123_456_789)).toBe('1.23亿')
    expect(fmtMs(125_000)).toBe('2分05秒')
    expect(fmtRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 分钟前')
    expect(fmtRelative(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3 天前')
    expect(totalCell(1000, true).title).toBe('1,000 token（下限：含部分采集）')
  })
})
