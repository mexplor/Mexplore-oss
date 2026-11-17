import { useEffect, useMemo, useRef, useState } from 'react'
import { line, max, scaleLinear, scalePoint, area, curveMonotoneX } from 'd3'
import type { UsageSummary } from '../../shared/types.ts'
import { fmtCompact, fmtInt, fmtMs } from '../format.ts'
import { SERIES, type SeriesKey } from './series.ts'
import { useI18n } from '../i18n.ts'

type Row = UsageSummary['series'][number]
const KEYS: SeriesKey[] = ['combined', 'read', 'manage']

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && e.contentRect.width > 0 && setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function DailyChart({ series }: { series: Row[] }) {
  const { t, num } = useI18n()
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set())
  const [hover, setHover] = useState<number | null>(null)

  const toggle = (k: SeriesKey) =>
    setHidden((h) => {
      const n = new Set(h)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const m = { l: 56, r: 16, t: 14, b: 8 }
  const W = Math.max(320, width)
  const H1 = 210
  const H2 = 150
  const gap = 34
  const axisH = 26
  const totalH = H1 + gap + H2 + axisH + m.t

  const x = useMemo(
    () =>
      scalePoint<string>()
        .domain(series.map((s) => s.bucket))
        .range([m.l, W - m.r])
        .padding(0.35),
    [series, W],
  )

  const visible = KEYS.filter((k) => !hidden.has(k))
  const yTok = useMemo(() => {
    const mx = max(series, (s) => max(visible, (k) => s[k].totalTokens)) ?? 0
    return scaleLinear().domain([0, mx || 1]).nice(4).range([m.t + H1, m.t])
  }, [series, visible.join()])
  const yLat = useMemo(() => {
    const mx = max(series, (s) => max(visible, (k) => s[k].p50LatencyMs ?? 0)) ?? 0
    const top = m.t + H1 + gap
    return scaleLinear().domain([0, mx || 1000]).nice(4).range([top + H2, top])
  }, [series, visible.join()])

  if (!series.length) return <div className="chart-empty">{t('chart.empty')}</div>

  const tokLine = (k: SeriesKey) =>
    line<Row>()
      .x((d) => x(d.bucket)!)
      .y((d) => yTok(d[k].totalTokens))
      .curve(curveMonotoneX)(series) ?? ''
  const tokArea =
    area<Row>()
      .x((d) => x(d.bucket)!)
      .y0(yTok(0))
      .y1((d) => yTok(d.combined.totalTokens))
      .curve(curveMonotoneX)(series) ?? ''
  const latLine = (k: SeriesKey) =>
    line<Row>()
      .defined((d) => d[k].p50LatencyMs !== null)
      .x((d) => x(d.bucket)!)
      .y((d) => yLat(d[k].p50LatencyMs ?? 0))
      .curve(curveMonotoneX)(series) ?? ''

  const step = series.length > 1 ? (x(series[1]!.bucket)! - x(series[0]!.bucket)!) : W
  const labelEvery = Math.max(1, Math.ceil(46 / Math.max(1, step)))
  const hv = hover !== null ? series[hover] : undefined

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const px = e.clientX - box.left
    let best = 0
    let bd = Infinity
    series.forEach((s, i) => {
      const d = Math.abs(x(s.bucket)! - px)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    setHover(best)
  }

  const dayLabel = (b: string) => {
    const [, mo, d] = b.split('-')
    return `${Number(mo)}/${Number(d)}`
  }

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <h3>{t('chart.perDay')}</h3>
        <div className="chart-legend">
          {KEYS.map((k) => (
            <button key={k} className={hidden.has(k) ? 'off' : ''} onClick={() => toggle(k)} style={{ ['--s' as string]: SERIES[k].color }}>
              <i className={k === 'combined' ? 'thick' : ''} />
              {t(`series.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <svg width={W} height={totalH} className="chart-svg" onMouseLeave={() => setHover(null)}>
        {/* tokens panel */}
        <text className="panel-label" x={m.l} y={m.t - 2}>
          {t('chart.totalTokens')}
        </text>
        {yTok.ticks(4).map((t) => (
          <g key={`t${t}`}>
            <line className="grid" x1={m.l} x2={W - m.r} y1={yTok(t)} y2={yTok(t)} />
            <text className="tick" x={m.l - 8} y={yTok(t) + 3.5} textAnchor="end">
              {fmtCompact(t)}
            </text>
          </g>
        ))}
        {!hidden.has('combined') && <path d={tokArea} className="area" />}
        {visible.map((k) => (
          <path key={`tl${k}`} d={tokLine(k)} className={`series s-${k}`} stroke={SERIES[k].color} />
        ))}
        {visible.map((k) =>
          series.map((s) => (
            <circle key={`tp${k}${s.bucket}`} className="pt" cx={x(s.bucket)} cy={yTok(s[k].totalTokens)} r={series.length > 45 ? 0 : 2.4} fill={SERIES[k].color} />
          )),
        )}

        {/* latency panel */}
        <text className="panel-label" x={m.l} y={m.t + H1 + gap - 4}>
          {t('chart.p50')}
        </text>
        {yLat.ticks(3).map((t) => (
          <g key={`l${t}`}>
            <line className="grid" x1={m.l} x2={W - m.r} y1={yLat(t)} y2={yLat(t)} />
            <text className="tick" x={m.l - 8} y={yLat(t) + 3.5} textAnchor="end">
              {fmtMs(t)}
            </text>
          </g>
        ))}
        {visible.map((k) => (
          <path key={`ll${k}`} d={latLine(k)} className={`series s-${k}`} stroke={SERIES[k].color} />
        ))}
        {visible.map((k) =>
          series.map((s) =>
            s[k].p50LatencyMs === null ? null : (
              <circle key={`lp${k}${s.bucket}`} className="pt" cx={x(s.bucket)} cy={yLat(s[k].p50LatencyMs!)} r={series.length > 45 ? 0 : 2.4} fill={SERIES[k].color} />
            ),
          ),
        )}

        {/* x axis */}
        {series.map((s, i) =>
          i % labelEvery === 0 ? (
            <text key={`x${s.bucket}`} className="tick" x={x(s.bucket)} y={totalH - 8} textAnchor="middle">
              {dayLabel(s.bucket)}
            </text>
          ) : null,
        )}

        {hv && (
          <line className="guide" x1={x(hv.bucket)} x2={x(hv.bucket)} y1={m.t} y2={m.t + H1 + gap + H2} />
        )}
        <rect x={m.l} y={0} width={W - m.l - m.r} height={totalH - axisH + 6} fill="transparent" onMouseMove={onMove} />
      </svg>
      {hv && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(0, x(hv.bucket)! + 12), W - 230), top: 24 }}
        >
          <div className="chart-tip-day">{hv.bucket}</div>
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('chart.runs')}</th>
                <th>{t('chart.tokens')}</th>
                <th>{t('stat.p50')}</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => (
                <tr key={k}>
                  <th style={{ color: k === 'combined' ? '#f4f0e6' : SERIES[k].color }}>{t(`series.${k}`)}</th>
                  <td>{num(hv[k].runs)}</td>
                  <td title={fmtInt(hv[k].totalTokens)}>{fmtCompact(hv[k].totalTokens)}</td>
                  <td>{fmtMs(hv[k].p50LatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
