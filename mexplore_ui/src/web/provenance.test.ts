import { afterEach, describe, expect, test } from 'bun:test'
import type { NodeProvenance, ProvenanceEntry } from '../shared/types.ts'
import { shortSession } from './format.ts'
import { setLocale, translate } from './i18n.ts'
import { groupKey, hostKey, nullReasonKey, opKey, summarizeProvenance } from './provenance.ts'

afterEach(() => setLocale('en'))

const DSH = 'session-1b2c3d4e-5f60-4a1b-9c2d-3e4f5a6b7c8d'
const OC = 'ses_6d1a2b3c4ffeXyZabcDEFghij'

function e(ts: string, op: string, who: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return { ts: `2026-11-10T${ts}:00.000Z`, op, actor: 'chat', host: 'dsh', session: DSH, ...who }
}

function prov(entries: ProvenanceEntry[], extra: Partial<NodeProvenance> = {}): NodeProvenance {
  return { entries, first: null, truncated: false, skipped: 0, unreadable: false, ...extra }
}

describe('summarizeProvenance', () => {
  test('empty: no origin, no latest, no groups', () => {
    const s = summarizeProvenance(prov([]))
    expect(s).toEqual({ origin: null, created: false, latest: null, groups: [], total: 0, chats: 0 })
  })

  test('creator, latest change, and groups by chat with the most recent first', () => {
    const create = e('08:00', 'create')
    const link = e('09:00', 'edge', { host: 'opencode', session: OC, peer: '01JC0000000000000000000000' })
    const upd = e('10:00', 'update')
    const s = summarizeProvenance(prov([create, link, upd]))
    expect(s.origin).toBe(create)
    expect(s.created).toBe(true)
    expect(s.latest).toBe(upd)
    expect(s.total).toBe(3)
    expect(s.chats).toBe(2)
    expect(s.groups.map((g) => g.key)).toEqual([`s:${DSH}`, `s:${OC}`])
    expect(s.groups[0]!.entries).toEqual([upd, create]) // newest first inside a group
    expect(s.groups[0]).toMatchObject({ firstTs: create.ts, lastTs: upd.ts, host: 'dsh' })
  })

  test('a single line is the origin and there is no separate latest', () => {
    const s = summarizeProvenance(prov([e('08:00', 'create')]))
    expect(s.latest).toBeNull()
    expect(s.groups).toHaveLength(1)
  })

  test('lines are ordered by time even when the lock-free appends landed out of order', () => {
    const late = e('10:00', 'update')
    const early = e('08:00', 'create')
    const s = summarizeProvenance(prov([late, early]))
    expect(s.origin).toBe(early)
    expect(s.latest).toBe(late)
  })

  test('null sessions group by actor, host and reason, and never count as a chat', () => {
    const imp = { actor: 'import' as const, session: null, reason: 'import' as const }
    const unverified = { session: null, reason: 'root-unverified' as const }
    const s = summarizeProvenance(prov([e('08:00', 'create', imp), e('08:05', 'edge', imp), e('09:00', 'update', unverified)]))
    expect(s.chats).toBe(0)
    expect(s.groups.map((g) => [g.key, g.entries.length])).toEqual([
      ['n:chat:dsh:root-unverified', 1],
      ['n:import:dsh:import', 2],
    ])
    expect(groupKey(e('08:00', 'create', imp))).toBe('n:import:dsh:import')
  })

  test('a truncated file: the separate first line is the origin, even before an unrelated op', () => {
    const first = e('07:00', 'create', { session: 'session-origin' })
    const s = summarizeProvenance(prov([e('12:00', 'edge'), e('13:00', 'update')], { first, truncated: true }))
    expect(s.origin).toBe(first)
    expect(s.created).toBe(true)
    expect(s.total).toBe(3)
  })

  test('history that starts after creation reports a first record, not a creation', () => {
    const s = summarizeProvenance(prov([e('08:00', 'edge'), e('09:00', 'update')]))
    expect(s.origin?.op).toBe('edge')
    expect(s.created).toBe(false)
  })
})

describe('labels', () => {
  test('a null session shows its stored reason honestly', () => {
    expect(translate('en', nullReasonKey({ actor: 'chat', reason: 'root-unverified' }))).toBe('unknown — root not verified')
    expect(translate('en', nullReasonKey({ actor: 'import', reason: 'import' }))).toBe('history import')
    expect(translate('en', nullReasonKey({ actor: 'import' }))).toBe('history import')
    expect(translate('zh', nullReasonKey({ actor: 'chat', reason: 'walk-failed' }))).toBe('未知 — 会话追溯失败')
    expect(translate('en', nullReasonKey({ actor: 'chat' }))).toBe('unknown chat')
    for (const reason of ['no-resolver', 'root-unverified', 'walk-failed', 'import', 'resolver-error'] as const) {
      expect(translate('en', nullReasonKey({ actor: 'chat', reason }))).not.toContain('prov.')
    }
  })

  test('hosts and ops translate; an op this UI does not know stays verbatim', () => {
    expect(translate('en', hostKey('opencode'))).toBe('OpenCode')
    expect(translate('zh', hostKey('unknown'))).toBe('未知宿主')
    for (const op of ['create', 'update', 'attach', 'annotate', 'supersede', 'superseded-by', 'merge', 'merged-into', 'restore', 'edge']) {
      expect(opKey(op)).not.toBeNull()
    }
    expect(opKey('teleport')).toBeNull()
  })

  test('session ids keep their host prefix and are shortened in the middle', () => {
    expect(shortSession(DSH)).toBe('session-1b2c3d4e…7c8d')
    expect(shortSession(OC)).toBe('ses_6d1a2b3c…ghij')
    expect(shortSession('ses_demoRootChat')).toBe('ses_demoRootChat')
    expect(shortSession('x'.repeat(30))).toBe('xxxxxxxx…xxxx')
  })
})
