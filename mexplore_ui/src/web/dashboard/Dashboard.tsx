import { useEffect, useMemo, useState } from 'react'
import type { RunsPage, RunSourceKind, Stats, Usage, UsageSummary } from '../../shared/types.ts'
import type { RunSort, SortDir } from '../api.ts'
import { isRejected, type AppStore } from '../appStore.ts'
import { useResource } from '../useStore.ts'
import { addDays, dayInTz, fmtCompact, fmtInt, fmtMs, midnightInTz, totalCell } from '../format.ts'
import { WarningsPill } from '../Warnings.tsx'
import { DailyChart } from './DailyChart.tsx'
import { RunTable } from './RunTable.tsx'
import { SERIES, type SeriesKey } from './series.ts'
import { useI18n, type MsgKey } from '../i18n.ts'


type Preset = 'today' | '7d' | '30d' | '90d'
type Range = { preset: Preset } | { preset: 'custom'; from: string; to: string }

const PRESETS: { key: Preset; label: MsgKey; days: number }[] = [
  { key: 'today', label: 'range.today', days: 1 },
  { key: '7d', label: 'range.7d', days: 7 },
  { key: '30d', label: 'range.30d', days: 30 },
  { key: '90d', label: 'range.90d', days: 90 },
]

/** Whole local days in the server zone: [midnight of first day, midnight after last day). */
function resolveRange(r: Range, tz: string): { from: string; to: string; fromDay: string; toDay: string } {
  const today = dayInTz(Date.now(), tz)
  let fromDay: string
  let toDay: string
  if (r.preset === 'custom') {
    fromDay = r.from <= r.to ? r.from : r.to
    toDay = r.from <= r.to ? r.to : r.from
  } else {
    const days = PRESETS.find((p) => p.key === r.preset)!.days
    fromDay = addDays(today, -(days - 1))
    toDay = today
  }
  return {
    from: new Date(midnightInTz(fromDay, tz)).toISOString(),
    to: new Date(midnightInTz(addDays(toDay, 1), tz)).toISOString(),
    fromDay,
    toDay,
  }
}

const PAGE = 50

export function Dashboard({
  store,
  tz,
  active,
  source = 'service',
  label,
}: {
  store: AppStore
  tz: string
  active: boolean
  /** Which deployment produced the rows; picks the "unavailable" wording. */
  source?: RunSourceKind
  /** Source label from `/api/meta`, e.g. `opencode plugin`. */
  label?: string
}) {
  const { t } = useI18n()
  const [range, setRange] = useState<Range>({ preset: '7d' })
  const [sort, setSort] = useState<RunSort>('createdAt')
  const [dir, setDir] = useState<SortDir>('desc')
  const [offset, setOffset] = useState(0)
  // minute clock so preset ranges ("today", "7 days") roll over at local midnight
  const [clock, setClock] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setClock((c) => c + 1), 60_000)
    return () => window.clearInterval(iv)
  }, [])

  const resolved = useMemo(
    () => resolveRange(range, tz),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, tz, clock],
  )
  const usageQueryKey = `${resolved.from}|${resolved.to}`
  const runsQueryKey = `${usageQueryKey}|${sort}|${dir}|${offset}`

  useEffect(() => setOffset(0), [range, sort, dir])

  // Usage + runs are live resources: the store refetches them on (re)connect and on `run` hints. While the tab
  // is hidden the queries are paused (null) and resume — with a fresh load — when it is shown again.
  useEffect(() => {
    store.usage.setQuery(active ? { from: resolved.from, to: resolved.to } : null, active ? usageQueryKey : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, active, usageQueryKey])
  useEffect(() => {
    store.runs.setQuery(
      active ? { from: resolved.from, to: resolved.to, sort, dir, offset, limit: PAGE } : null,
      active ? runsQueryKey : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, active, runsQueryKey])

  const u = useResource(store.usage)
  const r = useResource(store.runs)
  // errors only count for the query the controls show right now
  const usageErr = u.errorKey === usageQueryKey ? u.error : null
  const runsErr = r.errorKey === runsQueryKey ? r.error : null
  // a rejected range must not leave the previous range's numbers under the new controls
  const usage: UsageSummary | null = isRejected(usageErr) ? null : u.data
  const runs: RunsPage | null = isRejected(runsErr) ? null : r.data
  const usageKey = u.dataKey
  const runsKey = r.dataKey
  const loading = u.loading
  const runsLoading = r.loading

  // Transient failures and an unopenable task database retry every 10 s (the server also retries on its
  // reconcile poll). Rejected queries (4xx) wait for the user to change the controls instead.
  const dbUnavailable = !!usage?.unavailable || !!runs?.unavailable
  const transientErr = (usageErr && !isRejected(usageErr) ? usageErr : null) ?? (runsErr && !isRejected(runsErr) ? runsErr : null)
  const needsRetry = dbUnavailable || !!transientErr
  useEffect(() => {
    if (!needsRetry || !active || u.loading || r.loading) return
    const t = window.setTimeout(() => {
      store.usage.refetch()
      store.runs.refetch()
    }, 10_000)
    return () => window.clearTimeout(t)
  }, [needsRetry, active, u, r, store])

  const usageTransient = usageErr && !isRejected(usageErr) ? usageErr : null
  const rangeError = isRejected(usageErr) ? usageErr : isRejected(runsErr) ? runsErr : null
  const usageStale = !!usage && (usageKey !== usageQueryKey || !!usageErr)
  const runsStale = !!runs && (runsKey !== runsQueryKey || !!runsErr)

  const shownTz = usage?.tz ?? tz

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <p className="dash-sub">{t('dash.sub')}</p>
          <p className="dash-sub">{label ?? t(source === 'plugin' ? 'source.plugin' : 'source.service')}</p>
        </div>
        <div className="range">
          <div className="seg" role="radiogroup" aria-label={t('range.aria')}>
            {PRESETS.map((p) => (
              <button key={p.key} role="radio" aria-checked={range.preset === p.key} className={range.preset === p.key ? 'on' : ''} onClick={() => setRange({ preset: p.key })}>
                {t(p.label)}
              </button>
            ))}
            <button
              role="radio"
              aria-checked={range.preset === 'custom'}
              className={range.preset === 'custom' ? 'on' : ''}
              onClick={() => setRange({ preset: 'custom', from: resolved.fromDay, to: resolved.toDay })}
            >
              {t('range.custom')}
            </button>
          </div>
          <div className="range-dates">
            <input
              type="date"
              value={resolved.fromDay}
              max={resolved.toDay}
              onChange={(e) => e.target.value && setRange({ preset: 'custom', from: e.target.value, to: resolved.toDay })}
              aria-label={t('range.from')}
            />
            <span>→</span>
            <input
              type="date"
              value={resolved.toDay}
              min={resolved.fromDay}
              onChange={(e) => e.target.value && setRange({ preset: 'custom', from: resolved.fromDay, to: e.target.value })}
              aria-label={t('range.to')}
            />
            <span className="tz" title={t('range.tzTitle')}>
              {shownTz}
            </span>
            {(loading || runsLoading) && <span className="spinner small" aria-label={t('range.loading')} />}
            <WarningsPill warnings={usage?.warnings ?? []} kind="usage" />
          </div>
          {rangeError && (
            <div className="range-error" role="alert">
              <strong>{t('range.rejected')}</strong> {rangeError.message}
            </div>
          )}
        </div>
      </div>

      {(dbUnavailable || usageTransient) && (
        <div className="unavail" role="status">
          <span className="spinner small" />
          <div>
            <strong>{t('unavail.title')}</strong>
            <span>
              {dbUnavailable
                ? t(source === 'plugin' ? 'unavail.plugin' : 'unavail.db')
                : t('unavail.api', { error: usageTransient!.message }) + (usage ? t('unavail.lastGood') : '') + t('unavail.end')}
            </span>
          </div>
        </div>
      )}

      {usage && !usage.unavailable && (
        <div className={usageStale ? 'stale-block' : undefined} title={usageStale && usageErr ? t('dash.staleTitle') : undefined}>
          <div className="ledger-cards">
            {(['read', 'manage', 'combined'] as const).map((k) => (
              <HeroCard key={k} k={k} s={usage[k]} />
            ))}
          </div>

          <div className="dash-grid">
            <section className="card chart-card">
              <DailyChart series={usage.series} />
            </section>
            <section className="card matrix-card">
              <StatsMatrix usage={usage} />
            </section>
          </div>
        </div>
      )}

      <section className="card runs-card">
        <RunTable
          page={runs}
          loading={runsLoading}
          stale={runsStale}
          pageMismatch={!!runs && runsKey !== runsQueryKey}
          error={runsErr && !isRejected(runsErr) ? runsErr.message : null}
          rejected={isRejected(runsErr)}
          tz={shownTz}
          sort={sort}
          dir={dir}
          onSort={(s) => {
            if (s === sort) setDir(dir === 'desc' ? 'asc' : 'desc')
            else {
              setSort(s)
              setDir('desc')
            }
          }}
          onPage={(o) => setOffset(Math.max(0, o))}
        />
      </section>
    </div>
  )
}

function HeroCard({ k, s }: { k: SeriesKey; s: Stats }) {
  const { t } = useI18n()
  const lb = s.usageRuns.partial > 0
  const total = totalCell(s.totals.totalTokens, lb)
  return (
    <div className={`hero hero-${k}`} style={{ ['--s' as string]: SERIES[k].color }}>
      <div className="hero-label">
        <i />
        {t(`series.${k}`)}
      </div>
      <div className="hero-big" title={total.title}>
        {total.ge && <span className="ge">≥</span>}
        {total.compact}
        <span className="unit">{t('hero.tokens')}</span>
      </div>
      <div className="hero-row">
        <span>
          <b>{fmtInt(s.runs)}</b> {t('hero.runs')}
        </span>
        <span>
          <b>{fmtMs(s.latencyMs.p50)}</b> {t('hero.p50')}
        </span>
        <span>
          <b>{fmtCompact(s.tokensPerRun.mean)}</b> {t('hero.perRun')}
        </span>
      </div>
      <Completeness s={s} />
    </div>
  )
}

function Completeness({ s }: { s: Stats }) {
  const { t, tn, num } = useI18n()
  const { complete, partial, unknown } = s.usageRuns
  const total = complete + partial + unknown
  if (!total) return <div className="complete-bar empty">{t('complete.none')}</div>
  return (
    <div className="complete">
      <div className="complete-bar" aria-hidden>
        <span className="c" style={{ flex: complete }} />
        <span className="p" style={{ flex: partial }} />
        <span className="u" style={{ flex: unknown }} />
      </div>
      <div className="complete-text">
        {t('complete.n', { n: num(complete) })}
        {partial > 0 && <span className="p">{t('complete.partial', { n: num(partial) })}</span>}
        {unknown > 0 && <span className="u">{tn('complete.unknown', unknown)}</span>}
      </div>
    </div>
  )
}

const TOKEN_ROWS: { key: keyof Usage; label: MsgKey }[] = [
  { key: 'inputTokens', label: 'tok.input' },
  { key: 'outputTokens', label: 'tok.output' },
  { key: 'cacheReadTokens', label: 'tok.cacheRead' },
  { key: 'cacheWriteTokens', label: 'tok.cacheWrite' },
  { key: 'reasoningTokens', label: 'tok.reasoning' },
  { key: 'totalTokens', label: 'tok.total' },
]

function StatsMatrix({ usage }: { usage: UsageSummary }) {
  const { t, num: count } = useI18n()
  const cols = ['read', 'manage', 'combined'] as const
  const num = (v: number | null | undefined, lb = false) => {
    const c = totalCell(v, lb)
    return (
      <span className={c.missing ? 'muted' : undefined} title={c.missing ? c.title : c.text}>
        {c.ge ? <span className="ge">≥</span> : null}
        {c.text}
      </span>
    )
  }
  const anyPartial = cols.some((c) => usage[c].usageRuns.partial > 0)
  const anyMissing = cols.some((c) => TOKEN_ROWS.some((row) => usage[c].totals[row.key] === undefined || usage[c].totals[row.key] === null))
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th />
          {cols.map((c) => (
            <th key={c} style={{ ['--s' as string]: SERIES[c].color }}>
              <i />
              {t(`series.${c}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="grp">
          <th colSpan={4}>{t('matrix.runsGroup')}</th>
        </tr>
        <tr>
          <th>{t('matrix.runs')}</th>
          {cols.map((c) => (
            <td key={c}>{num(usage[c].runs)}</td>
          ))}
        </tr>
        <tr>
          <th>{t('matrix.usageSplit')}</th>
          {cols.map((c) => (
            <td key={c} className="split">
              {count(usage[c].usageRuns.complete)} / <span className="p">{count(usage[c].usageRuns.partial)}</span> / <span className="u">{count(usage[c].usageRuns.unknown)}</span>
            </td>
          ))}
        </tr>

        <tr className="grp">
          <th colSpan={4}>
            {t('matrix.totals')}{' '}
            <span className="grp-note">
              {t('matrix.totalsNote')}
              {anyPartial ? t('matrix.lowerBound') : ''}
              {anyMissing ? t('matrix.notReported') : ''}
            </span>
          </th>
        </tr>
        {TOKEN_ROWS.map((r) => (
          <tr key={r.key} className={r.key === 'totalTokens' ? 'em' : ''}>
            <th>{t(r.label)}</th>
            {cols.map((c) => (
              <td key={c}>{num(usage[c].totals[r.key], usage[c].usageRuns.partial > 0)}</td>
            ))}
          </tr>
        ))}

        <tr className="grp">
          <th colSpan={4}>
            {t('matrix.perRun')} <span className="grp-note">{t('matrix.perRunNote')}</span>
          </th>
        </tr>
        {(['mean', 'p50', 'p95'] as const).map((p) => (
          <tr key={p}>
            <th>{t(`stat.${p}`)}</th>
            {cols.map((c) => (
              <td key={c}>{num(usage[c].tokensPerRun[p])}</td>
            ))}
          </tr>
        ))}

        <tr className="grp">
          <th colSpan={4}>
            {t('matrix.latency')} <span className="grp-note">{t('matrix.latencyNote')}</span>
          </th>
        </tr>
        {(['p50', 'p95', 'max'] as const).map((p) => (
          <tr key={p}>
            <th>{t(`stat.${p}`)}</th>
            {cols.map((c) => (
              <td key={c} title={usage[c].latencyMs[p] !== null ? `${fmtInt(usage[c].latencyMs[p])} ms` : t('matrix.noLatency')}>
                {fmtMs(usage[c].latencyMs[p])}
              </td>
            ))}
          </tr>
        ))}
        <tr className="foot">
          <th>{t('matrix.withLatency')}</th>
          {cols.map((c) => (
            <td key={c}>{fmtInt(usage[c].runsWithLatency)}</td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}
