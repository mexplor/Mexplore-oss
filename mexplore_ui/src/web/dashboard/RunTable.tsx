import type { RunsPage, RunSummary } from '../../shared/types.ts'
import type { RunSort, SortDir } from '../api.ts'
import { fmtCompact, fmtDateTime, fmtInt, fmtMs } from '../format.ts'
import { SERIES } from './series.ts'
import { useI18n } from '../i18n.ts'

interface Props {
  page: RunsPage | null
  /** A request for the current controls is in flight. */
  loading: boolean
  /** The rows on screen do not reflect the current controls / last refresh failed. */
  stale: boolean
  /** The rows on screen belong to a different range/sort/page than the controls show. */
  pageMismatch: boolean
  /** Transient fetch failure (retried every 10 s by the dashboard). */
  error: string | null
  /** The server rejected the query (4xx); the message is shown by the range selector. */
  rejected: boolean
  tz: string
  sort: RunSort
  dir: SortDir
  onSort: (s: RunSort) => void
  onPage: (offset: number) => void
}

export function RunTable({ page, loading, stale, pageMismatch, error, rejected, tz, sort, dir, onSort, onPage }: Props) {
  const { t } = useI18n()
  // Never leave another page's rows under new controls after a failure: drop them and say so.
  const failedNewQuery = !!error && pageMismatch
  const runs = failedNewQuery ? [] : (page?.runs ?? [])
  const maxTok = Math.max(1, ...runs.map((r) => r.usage?.totalTokens ?? 0))
  const total = page?.total ?? 0
  const offset = page?.offset ?? 0
  const limit = page?.limit ?? 50
  const pages = Math.max(1, Math.ceil(total / limit))
  const current = Math.floor(offset / limit)

  const H = (k: RunSort | undefined, children: React.ReactNode, className?: string) =>
    k ? (
      <th className={`sortable ${className ?? ''} ${sort === k ? 'sorted' : ''}`} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button onClick={() => onSort(k)}>
          {children}
          <span className="sort-ind">{sort === k ? (dir === 'desc' ? '↓' : '↑') : '↕'}</span>
        </button>
      </th>
    ) : (
      <th className={className}>{children}</th>
    )

  return (
    <div className="runs">
      <div className="runs-head">
        <h3>{t('runs.title')}</h3>
        <span className="muted">
          {page?.unavailable ? t('runs.unavailable') : failedNewQuery || !page ? '' : t('runs.inRange', { n: fmtInt(total) })}
        </span>
        {loading && pageMismatch && (
          <span className="runs-status">
            <span className="spinner small" /> {t('runs.loading')}
          </span>
        )}
        {error && !pageMismatch && (
          <span className="runs-status warn-text" role="status">
            {t('runs.refreshFailed')}
          </span>
        )}
      </div>
      <div className={`runs-scroll ${stale && !failedNewQuery ? 'stale-block' : ''}`} aria-busy={loading}>
        <table className="run-table">
          <thead>
            <tr>
              {H('createdAt', t('runs.colTime', { tz }))}
              {H(undefined, t('runs.colAuthority'))}
              {H(undefined, t('runs.colTask'))}
              {H('totalTokens', t('runs.colTokens'), 'num')}
              {H(undefined, t('runs.colUsage'))}
              {H('latencyMs', t('runs.colLatency'), 'num')}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <RunRow key={r.taskId} r={r} tz={tz} maxTok={maxTok} />
            ))}
            {failedNewQuery ? (
              <tr>
                <td colSpan={6} className="empty error">
                  <span className="spinner small" /> {t('runs.loadFailed')}
                  <span className="empty-detail">{error}</span>
                </td>
              </tr>
            ) : page && !runs.length ? (
              <tr>
                <td colSpan={6} className="empty">
                  {page.unavailable ? t('runs.listUnavailable') : t('runs.none')}
                </td>
              </tr>
            ) : !page ? (
              <tr>
                <td colSpan={6} className="empty">
                  {rejected ? t('runs.rejected') : error ? (
                    <>
                      <span className="spinner small" /> {t('runs.loadFailed')}
                      <span className="empty-detail">{error}</span>
                    </>
                  ) : (
                    t('runs.loadingRows')
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {total > limit && !failedNewQuery && (
        <div className={`pager ${loading && pageMismatch ? 'busy' : ''}`}>
          <span>
            {t('runs.pager', { from: fmtInt(offset + 1), to: fmtInt(Math.min(total, offset + limit)), total: fmtInt(total) })}
          </span>
          <div className="pager-btns">
            <button disabled={current === 0} onClick={() => onPage(0)} title={t('runs.first')} aria-label={t('runs.first')}>
              «
            </button>
            <button disabled={current === 0} onClick={() => onPage(offset - limit)}>
              {t('runs.prev')}
            </button>
            {pageList(current, pages).map((p, i) =>
              p === null ? (
                <span key={`g${i}`} className="gap">
                  …
                </span>
              ) : (
                <button key={p} className={p === current ? 'on' : ''} onClick={() => onPage(p * limit)}>
                  {p + 1}
                </button>
              ),
            )}
            <button disabled={current >= pages - 1} onClick={() => onPage(offset + limit)}>
              {t('runs.next')}
            </button>
            <button disabled={current >= pages - 1} onClick={() => onPage((pages - 1) * limit)} title={t('runs.last')} aria-label={t('runs.last')}>
              »
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function pageList(cur: number, n: number): (number | null)[] {
  if (n <= 7) return Array.from({ length: n }, (_, i) => i)
  const s = new Set([0, n - 1, cur - 1, cur, cur + 1].filter((p) => p >= 0 && p < n))
  const arr = [...s].sort((a, b) => a - b)
  const out: (number | null)[] = []
  arr.forEach((p, i) => {
    if (i && p - arr[i - 1]! > 1) out.push(null)
    out.push(p)
  })
  return out
}

function RunRow({ r, tz, maxTok }: { r: RunSummary; tz: string; maxTok: number }) {
  const { t } = useI18n()
  const u = r.usage
  const tot = u?.totalTokens
  const known = tot !== undefined && tot !== null && r.usageStatus !== 'unknown'
  return (
    <tr className={`st-${r.usageStatus}`}>
      <td className="time">{fmtDateTime(r.createdAt, tz, true)}</td>
      <td>
        <span className="auth" style={{ ['--s' as string]: SERIES[r.authority].color }}>
          {t(`series.${r.authority}`)}
        </span>
      </td>
      <td className="uuid">{r.taskId}</td>
      <td className="num tok">
        {known ? (
          <span className="tok-cell">
            <span className="tok-bar" style={{ width: `${Math.max(2, (tot / maxTok) * 100)}%` }} />
            <span className="tok-val">
              {r.usageStatus === 'partial' && <span className="ge">≥</span>}
              {fmtInt(tot)}
            </span>
            <span className="tok-tip" role="tooltip">
              <TokSplit r={r} />
            </span>
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <span className={`status ${r.usageStatus}`} title={t(`usage.${r.usageStatus}Hint`)}>
          {t(`usage.${r.usageStatus}`)}
        </span>
      </td>
      <td className="num">{r.latencyMs === null ? <span className="muted">—</span> : fmtMs(r.latencyMs)}</td>
    </tr>
  )
}

function TokSplit({ r }: { r: RunSummary }) {
  const { t } = useI18n()
  const u = r.usage ?? {}
  const rows: [string, number | undefined][] = [
    [t('tok.input'), u.inputTokens],
    [t('tok.output'), u.outputTokens],
    [t('tok.cacheRead'), u.cacheReadTokens],
    [t('tok.cacheWrite'), u.cacheWriteTokens],
    [t('tok.reasoning'), u.reasoningTokens],
  ]
  return (
    <>
      <span className="tt-head">{r.usageStatus === 'partial' ? t('split.lowerBound') : ''}{t('split.head')}</span>
      {rows.map(([k, v]) => (
        <span key={k} className="tt-row">
          <span>{k}</span>
          <b>{v === undefined ? '—' : fmtInt(v)}</b>
        </span>
      ))}
      <span className="tt-row total">
        <span>{t('split.total')}</span>
        <b>{fmtInt(u.totalTokens)}</b>
      </span>
      <span className="tt-foot">{t('split.foot', { n: fmtCompact(u.totalTokens) })}</span>
    </>
  )
}
