import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphResponse } from '../../shared/types.ts'
import type { AppStore } from '../appStore.ts'
import {
  computeVisibility,
  EDGE_STYLES,
  egoNetwork,
  LARGE_GRAPH,
  matchesFilters,
  sortForList,
  TYPE_COLORS,
  TYPE_KEYS,
  typeKey,
  panelLayout,
  type Filters,
  type NodeTypeKey,
  type StatusFilter,
} from '../graphModel.ts'
import { SEMANTIC_MIN_NODES } from './communities.ts'
import { ForceGraph, type ForceGraphHandle } from './ForceGraph.tsx'
import { NodeList } from './NodeList.tsx'
import { NodePanel } from './NodePanel.tsx'
import { useI18n, type MsgKey } from '../i18n.ts'

/** The rendered width of an element (ResizeObserver); `fallback` until it has been laid out, and while hidden. */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const cw = el.clientWidth
      if (cw > 0) setW(cw) // a hidden view (dashboard tab) reports 0: keep the last real width
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

interface Props {
  store: AppStore
  graph: GraphResponse | null
  /** Increments on every successful graph refetch (search re-runs on it; bodies may change without the graph). */
  graphVersion: number
  error: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  tz: string
  graphRootName: string
  active: boolean
}

export function GraphView({ store, graph, graphVersion, error, selectedId, onSelect, tz, graphRootName, active }: Props) {
  const { t, tn, num } = useI18n()
  const typeName = (k: NodeTypeKey) => t(`type.${k}` as MsgKey)
  const backend = store.backend
  const [query, setQuery] = useState('')
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null)
  const [searching, setSearching] = useState(false)
  const [types, setTypes] = useState<Set<NodeTypeKey>>(new Set())
  const [status, setStatus] = useState<StatusFilter>('all')
  const [hops, setHops] = useState(0)
  const [labelsAlways, setLabelsAlways] = useState(false)
  const [fitSignal, setFitSignal] = useState(0)
  const [legendOpen, setLegendOpen] = useState(false)
  const [fullGraph, setFullGraph] = useState(false)
  // Sidebar / graph / panel layout is chosen from the graph width it would leave (panelLayout): all three columns,
  // then without the sidebar, then the panel as a collapsible bottom sheet over a full-width graph
  const layoutRef = useRef<HTMLDivElement>(null)
  const layoutWidth = useWidth(layoutRef, typeof window !== 'undefined' ? window.innerWidth : 1440)
  const layout = panelLayout(layoutWidth)
  const narrow = layout === 'sheet'
  const [sheetCollapsed, setSheetCollapsed] = useState(false)
  const graphHandle = useRef<ForceGraphHandle | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // debounced server search over description + body; rerun on graph changes
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchIds(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let cancelled = false
    const t = window.setTimeout(() => {
      backend
        .search(q)
        .then((r) => {
          if (!cancelled) setSearchIds(new Set(r.ids))
        })
        .catch(() => {
          // fall back to description-only matching when search is unavailable
          if (!cancelled && graph) {
            const s = q.toLowerCase()
            setSearchIds(new Set(graph.nodes.filter((n) => n.description.toLowerCase().includes(s)).map((n) => n.id)))
          }
        })
        .finally(() => !cancelled && setSearching(false))
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query, backend, graphVersion])

  const deferredQuery = useDeferredValue(query.trim())
  const filters: Filters = useMemo(() => ({ types, status, searchIds }), [types, status, searchIds])
  const selectedExists = !!(selectedId && graph?.nodes.some((n) => n.id === selectedId))
  const ego = hops > 0 && selectedId && selectedExists ? { center: selectedId, hops } : null

  const visibility = useMemo(
    () => (graph ? computeVisibility(graph.nodes, graph.edges, filters, ego) : new Map()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, filters, ego?.center, ego?.hops],
  )

  const egoSet = useMemo(
    () => (graph && ego ? egoNetwork(graph.edges, ego.center, ego.hops) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, ego?.center, ego?.hops],
  )

  const listNodes = useMemo(() => {
    if (!graph) return []
    return sortForList(graph.nodes).filter((n) => matchesFilters(n, filters) && (!egoSet || egoSet.has(n.id)))
  }, [graph, filters, egoSet])

  // Keep the full catalogue searchable, but reveal relationships progressively.
  const canvasGraph = useMemo(() => {
    if (!graph || fullGraph) return graph
    if (!selectedId) return { ...graph, nodes: [], edges: [] }
    const links = graph.edges
      .filter((e) => e.source === selectedId || e.target === selectedId)
      .sort((a, b) => b.accessCount - a.accessCount)
    const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
    const ids = new Set([selectedId])
    for (const e of links) {
      const other = e.source === selectedId ? e.target : e.source
      const node = nodesById.get(other)
      if (node && matchesFilters(node, filters) && ids.size < 13) ids.add(other)
    }
    return { ...graph, nodes: graph.nodes.filter((n) => ids.has(n.id)),
      edges: links.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [graph, fullGraph, selectedId, filters])
  const canvasVisibility = useMemo(() => fullGraph ? visibility :
    new Map((canvasGraph?.nodes ?? []).map((n) => [n.id, 'normal' as const])),
    [fullGraph, visibility, canvasGraph])

  const typeCounts = useMemo(() => {
    const c = new Map<NodeTypeKey, number>()
    for (const n of graph?.nodes ?? []) c.set(typeKey(n.type), (c.get(typeKey(n.type)) ?? 0) + 1)
    return c
  }, [graph])

  const knownIds = useMemo(() => new Set(graph?.nodes.map((n) => n.id) ?? []), [graph])

  // refit whenever the ego focus changes
  useEffect(() => {
    setFitSignal((s) => s + 1)
  }, [ego?.center, ego?.hops, selectedId, fullGraph])

  // keyboard: "/" focuses search, Esc clears selection
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && tag !== 'INPUT') {
        onSelect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onSelect])

  const toggleType = (t: NodeTypeKey) =>
    setTypes((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })

  const filtersActive = types.size > 0 || status !== 'all' || !!searchIds
  const clearFilters = () => {
    setTypes(new Set())
    setStatus('all')
    setQuery('')
  }
  // simple view: how many of the selected memory's connections the canvas shows (filters + the 12-neighbour cap)
  const connectionCounts = useMemo(() => {
    if (fullGraph || !graph || !selectedId || !canvasGraph) return null
    const all = new Set<string>()
    for (const e of graph.edges) {
      if (e.source === selectedId) all.add(e.target)
      else if (e.target === selectedId) all.add(e.source)
    }
    all.delete(selectedId)
    return { shown: Math.max(0, canvasGraph.nodes.length - 1), total: all.size }
  }, [fullGraph, graph, selectedId, canvasGraph])
  const filterSummary = [
    ...[...types].map((k) => typeName(k)),
    ...(status !== 'all' ? [t(`status.${status}`)] : []),
    ...(query.trim() ? [t('filter.search', { q: query.trim() })] : []),
  ].join(' · ')
  const edgeCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of graph?.edges ?? []) c[e.type] = (c[e.type] ?? 0) + 1
    return c
  }, [graph])

  return (
    <div
      ref={layoutRef}
      className={`graph-layout${selectedId ? ` with-panel layout-${layout}` : ''}${selectedId && narrow ? ' sheet-mode' : ''}${
        selectedId && narrow && sheetCollapsed ? ' sheet-collapsed' : ''
      }`}
    >
      <aside className="sidebar">
        <div className="search">
          <svg className="search-icon" viewBox="0 0 20 20" aria-hidden>
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            placeholder={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter' && listNodes[0]) onSelect(listNodes[0].id)
            }}
            spellCheck={false}
          />
          {query ? (
            <button className="search-clear" onClick={() => setQuery('')} aria-label={t('search.clear')}>
              ×
            </button>
          ) : (
            <kbd className="search-kbd" title={t('search.kbd')}>/</kbd>
          )}
        </div>

        <div className="filter-row">
          <div className="seg" role="radiogroup" aria-label={t('status.aria')}>
            {(['all', 'active', 'superseded'] as const).map((s) => (
              <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                {t(`status.${s}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="type-chips">
          {TYPE_KEYS.filter((k) => typeCounts.get(k)).map((k) => (
            <button
              key={k}
              className={`chip ${types.has(k) ? 'on' : ''} ${types.size && !types.has(k) ? 'off' : ''}`}
              onClick={() => toggleType(k)}
              style={{ ['--c' as string]: TYPE_COLORS[k] }}
              title={t('chip.title', { type: typeName(k) })}
            >
              <i />
              {typeName(k)}
              <span>{num(typeCounts.get(k) ?? 0)}</span>
            </button>
          ))}
        </div>

        <div className="list-head">
          <span>
            {searching ? t('list.searching') : t('list.count', { n: num(listNodes.length), total: num(graph?.nodes.length ?? 0) })}
            {searchIds && !searching ? tn('list.matches', searchIds.size) : ''}
            {egoSet ? t('list.hopFocus', { n: hops }) : ''}
          </span>
          <span className="list-order" title={t('list.orderTitle')}>
            {t('list.order')}
          </span>
          {filtersActive && (
            <button className="link-btn" onClick={clearFilters}>
              {t('list.clear')}
            </button>
          )}
        </div>
        <NodeList nodes={listNodes} selectedId={selectedId} onSelect={onSelect} query={deferredQuery} />
      </aside>

      <div className="canvas">
        {error && !graph && <div className="canvas-state error">{t('canvas.loadError', { error })}</div>}
        {!graph && !error && <div className="canvas-state">{t('canvas.reading')}</div>}
        {graph && graph.nodes.length === 0 && <div className="canvas-state">{t('canvas.empty')}</div>}
        {(fullGraph || selectedId) && <ForceGraph
          // a fresh engine per mode: back in the simple view the star lays out from scratch (as on the landing page)
          // instead of settling from the full graph's positions, which crowded labels a little more on every round trip
          // …and per panel layout: a resize that swaps sheet / side panel / three columns re-lays the star for the new
          // canvas exactly as a fresh open there would (the full graph keeps its engine and only pans)
          key={fullGraph ? 'full' : `simple-${layout}`}
          graph={canvasGraph}
          visibility={canvasVisibility}
          selectedId={selectedId}
          emphasize={!!searchIds}
          labelsAlways={!fullGraph || labelsAlways}
          local={!fullGraph}
          lens={!ego}
          fitSignal={fitSignal}
          onSelect={onSelect}
          onCardBlocked={() => setLegendOpen(false)}
          handleRef={graphHandle}
        />}

        {!fullGraph && !selectedId && graph && graph.nodes.length > 0 && (
          <div className="browse-home">
            <span className="browse-eyebrow">{t('home.eyebrow')}</span>
            <h1>{t('home.title')}</h1>
            <p>{t('home.lead')}</p>
            <div className="browse-categories" role="group" aria-label={t('home.categories')}>
              {TYPE_KEYS.filter((k) => typeCounts.get(k)).map((k) => (
                <button key={k} className={types.has(k) ? 'chosen' : ''} aria-pressed={types.has(k)} onClick={() => toggleType(k)}>
                  <span>{typeName(k)}</span><strong>{num(typeCounts.get(k) ?? 0)}</strong>
                </button>
              ))}
            </div>
            <div className="browse-section-title">{filtersActive ? t('home.matching', { n: num(listNodes.length) }) : t('home.featured')}<span>{t('home.hint')}</span></div>
            <div className="browse-cards">
              {listNodes.slice(0, 6).map((n) => (
                <button key={n.id} onClick={() => onSelect(n.id)}>
                  <small>{typeName(typeKey(n.type))}</small><strong>{n.description || n.id}</strong>
                  <span>{tn('home.links', n.degree)} <b aria-hidden>↗</b></span>
                </button>
              ))}
            </div>
            {listNodes.length === 0 && <p>{t('home.none')}</p>}
          </div>
        )}
        <div className="canvas-tools top-left">
          <div className="focus-ctl">
            <div className="seg small" role="radiogroup" aria-label={t('mode.aria')}>
              <button role="radio" aria-checked={!fullGraph} title={t('mode.simpleTitle')} className={!fullGraph ? 'on' : ''} onClick={() => { setFullGraph(false); setHops(0) }}>{t('mode.simple')}</button>
              <button role="radio" aria-checked={fullGraph} title={t('mode.fullTitle')} className={fullGraph ? 'on' : ''} onClick={() => { setFullGraph(true); setHops(0); setFitSignal((s) => s + 1) }}>{t('mode.full')}</button>
            </div>
          </div>
          {!fullGraph && selectedId && <span className="focus-note">{t('focus.note')}</span>}
          {/* the sidebar (and its filters) is hidden while the panel is open on narrow windows: keep them visible */}
          {filtersActive && selectedId && (
            <div className="filter-chip" role="group" aria-label={t('filter.aria')}>
              <span className="filter-chip-label">{t('filter.label')}</span>
              <span className="filter-chip-what" title={filterSummary}>{filterSummary}</span>
              {connectionCounts && (
                <span className="filter-chip-count">
                  {tn('filter.shown', connectionCounts.total, { n: num(connectionCounts.shown), total: num(connectionCounts.total) })}
                </span>
              )}
              <button className="filter-chip-clear" onClick={clearFilters} title={t('filter.clearTitle')}>
                {t('filter.clear')}
              </button>
            </div>
          )}
          {fullGraph && (
          <div className="focus-ctl" title={selectedId ? t('focus.titleSelected') : t('focus.titleNone')}>
            <span className="focus-label">{t('focus.label')}</span>
            <div className="seg small">
              {[0, 1, 2, 3].map((h) => (
                <button
                  key={h}
                  disabled={h > 0 && !selectedExists}
                  className={hops === h ? 'on' : ''}
                  onClick={() => setHops(h)}
                >
                  {h === 0 ? t('focus.off') : tn('focus.hops', h)}
                </button>
              ))}
            </div>
          </div>
          )}
          {error && graph && <span className="stale-note">{t('canvas.stale')}</span>}
        </div>

        {(fullGraph || selectedId) && <div className="canvas-tools top-right" role="toolbar" aria-label={t('tool.aria')}>
          <button className="icon-btn" onClick={() => graphHandle.current?.zoomBy(1.35)} title={t('tool.zoomIn')} aria-label={t('tool.zoomIn')}>
            +
          </button>
          <button className="icon-btn" onClick={() => graphHandle.current?.zoomBy(1 / 1.35)} title={t('tool.zoomOut')} aria-label={t('tool.zoomOut')}>
            −
          </button>
          <button className="icon-btn" onClick={() => graphHandle.current?.fit()} title={t('tool.fit')} aria-label={t('tool.fit')}>
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
          <button className="icon-btn" onClick={() => graphHandle.current?.reheat()} title={t('tool.reheat')} aria-label={t('tool.reheat')}>
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="M15.5 6.5A6 6 0 1 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M16 3v4h-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
          <button
            className={`icon-btn text ${labelsAlways ? 'on' : ''}`}
            onClick={() => setLabelsAlways((v) => !v)}
            title={t('tool.labels')}
            aria-label={t('tool.labels')}
            aria-pressed={labelsAlways}
          >
            Aa
          </button>
        </div>}

        {(fullGraph || selectedId) && (!legendOpen ? (
          <div className="legend collapsed">
            <button className="legend-toggle" onClick={() => setLegendOpen(true)} aria-expanded={false}>
              {t('legend.show')}
            </button>
          </div>
        ) : (
        <div className="legend">
          <button className="legend-toggle" onClick={() => setLegendOpen(false)} title={t('legend.hideTitle')} aria-expanded>
            {t('legend.hide')}
          </button>
          <div className="legend-title">{t('legend.nodes')}</div>
          <div className="legend-grid">
            {TYPE_KEYS.filter((k) => typeCounts.get(k)).map((k) => (
              <button
                key={k}
                className={`legend-item ${types.size && !types.has(k) ? 'off' : ''}`}
                onClick={() => toggleType(k)}
              >
                <i style={{ background: TYPE_COLORS[k] }} />
                {typeName(k)}
              </button>
            ))}
          </div>
          <div className="legend-marks">
            <span>
              <i className="mk superseded" /> {t('legend.superseded')}
            </span>
            <span>
              <i className="mk handoff" /> {t('legend.handoff')}
            </span>
          </div>
          <div className="legend-title">{t('legend.edges')}</div>
          <div className="legend-edges">
            {Object.entries(EDGE_STYLES).map(([type, st]) => (
              <span key={type} title={type === 'supersedes' || type === 'follows-from' ? t('legend.directed') : t('legend.symmetric')}>
                <svg width="30" height="8" aria-hidden>
                  <line x1="1" y1="4" x2={type === 'supersedes' || type === 'follows-from' ? 23 : 29} y2="4" stroke={st.color} strokeWidth="1.8" strokeDasharray={st.dash ?? undefined} />
                  {(type === 'supersedes' || type === 'follows-from') && <path d="M22,0.5L29,4L22,7.5Z" fill={st.color} />}
                </svg>
                {t(`edge.${type}` as MsgKey)}
                <em>{num(edgeCounts[type] ?? 0)}</em>
              </span>
            ))}
          </div>
          <div className="legend-foot">{t('legend.weight')}</div>
          {(graph?.nodes.length ?? 0) > LARGE_GRAPH && (
            <div className="legend-foot">{t('legend.plainHidden')}</div>
          )}
          {fullGraph && (graph?.nodes.length ?? 0) >= SEMANTIC_MIN_NODES && (
            <>
              <div className="legend-foot">{t('legend.clusters')}</div>
              <div className="legend-foot">{t('legend.bubbleColors')}</div>
            </>
          )}
        </div>
        ))}
      </div>

      {selectedId && (
        <NodePanel
          key="panel"
          store={store}
          id={selectedId}
          graph={graph}
          knownIds={knownIds}
          tz={tz}
          graphRootName={graphRootName}
          onNavigate={onSelect}
          onClose={() => onSelect(null)}
          sheet={narrow ? { collapsed: sheetCollapsed, onToggle: () => setSheetCollapsed((c) => !c) } : undefined}
        />
      )}
    </div>
  )
}
