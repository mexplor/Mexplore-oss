// Display formatting helpers. Numbers and relative times follow the UI language (i18n.getLocale()); dates stay
// ISO-like (YYYY-MM-DD HH:MM), which reads the same in both languages.
import { formatNumber, getLocale, intlTag, t } from './i18n.ts'

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : formatNumber(getLocale(), Math.round(n))
}

const zhCompact = new Map<number, Intl.NumberFormat>()

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (getLocale() === 'zh') {
    // 万 / 亿 grouping reads naturally in Chinese ("92.5万" rather than "925k")
    const digits = 3
    let f = zhCompact.get(digits)
    if (!f) zhCompact.set(digits, (f = new Intl.NumberFormat(intlTag('zh'), { notation: 'compact', maximumSignificantDigits: digits })))
    return f.format(n)
  }
  if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0)}k`
  if (a < 1e9) return `${(n / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`
  return `${(n / 1e9).toFixed(2)}B`
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return getLocale() === 'zh' ? `${m}分${String(r).padStart(2, '0')}秒` : `${m}m ${String(r).padStart(2, '0')}s`
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

const dtCache = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`
  let f = dtCache.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz })
    } catch {
      f = new Intl.DateTimeFormat('en-CA', opts)
    }
    dtCache.set(key, f)
  }
  return f
}

/** "2026-11-04 14:32" in the given IANA zone. */
export function fmtDateTime(iso: string | null | undefined, tz?: string, seconds = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = dtf(tz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).formatToParts(d)
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? ''
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}${seconds ? `:${p('second')}` : ''}`
}

/** YYYY-MM-DD for an instant in the given zone. */
export function dayInTz(t: number, tz?: string): string {
  return dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
}

/** Offset (ms) of `tz` at instant t: local wall-clock − UTC. */
function tzOffset(t: number, tz?: string): number {
  const parts = dtf(tz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(t))
  const g = (k: string) => Number(parts.find((x) => x.type === k)?.value ?? 0)
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
  return asUtc - Math.floor(t / 1000) * 1000
}

/** UTC instant of local midnight for day "YYYY-MM-DD" in tz. */
export function midnightInTz(day: string, tz?: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d)
  let t = guess - tzOffset(guess, tz)
  t = guess - tzOffset(t, tz)
  return t
}

/** Add n calendar days to "YYYY-MM-DD". */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const x = new Date(Date.UTC(y, m - 1, d + n))
  return x.toISOString().slice(0, 10)
}

const tr = t

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.round((now - t) / 1000)
  if (s < 0) return tr('rel.now')
  if (s < 60) return tr('rel.s', { n: s })
  if (s < 3600) return tr('rel.m', { n: Math.floor(s / 60) })
  if (s < 86400) return tr('rel.h', { n: Math.floor(s / 3600) })
  const d = Math.floor(s / 86400)
  return d < 60 ? tr('rel.d', { n: d }) : tr('rel.mo', { n: Math.floor(d / 30) })
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

/**
 * A chat session id for display: the host prefix (`session-` on DSH, `ses_` on OpenCode) stays whole so the
 * host still reads at a glance, and the rest keeps its first 8 and last 4 characters. Short ids are unchanged.
 */
export function shortSession(id: string): string {
  if (id.length <= 22) return id
  const prefix = /^(session-|ses_)/.exec(id)?.[0] ?? ''
  const rest = id.slice(prefix.length)
  return `${prefix}${rest.slice(0, 8)}…${rest.slice(-4)}`
}

/**
 * A population token total from `Stats.totals`. The server omits a component unless every contributing run
 * reported it, so a missing key renders "—" (never 0) and is never summed; partial captures mark a lower bound.
 */
export function totalCell(
  v: number | null | undefined,
  lowerBound: boolean,
): { missing: boolean; text: string; compact: string; ge: boolean; title: string } {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return { missing: true, text: '—', compact: '—', ge: false, title: tr('total.missingTitle') }
  }
  return {
    missing: false,
    text: fmtInt(v),
    compact: fmtCompact(v),
    ge: lowerBound,
    title: tr('total.title', { n: fmtInt(v) }) + (lowerBound ? tr('total.lowerBound') : ''),
  }
}
