import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadBackend } from './api.ts'
import { createAppStore, type AppStore } from './appStore.ts'
import { LiveSync, type LiveStatus } from './liveSync.ts'
import { useLiveStatus, useResource } from './useStore.ts'
import { GraphView } from './graph/GraphView.tsx'
import { Dashboard } from './dashboard/Dashboard.tsx'
import { WarningsPill } from './Warnings.tsx'
import { useI18n, type Locale } from './i18n.ts'

type View = 'graph' | 'dashboard'
interface Route {
  view: View
  nodeId: string | null
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h.startsWith('dashboard')) return { view: 'dashboard', nodeId: null }
  const m = /^graph\/([0-9A-Za-z]+)/.exec(h)
  return { view: 'graph', nodeId: m?.[1] ?? null }
}

function setHash(r: Route, replace = false) {
  const h = r.view === 'dashboard' ? '#dashboard' : r.nodeId ? `#graph/${r.nodeId}` : '#graph'
  if (window.location.hash === h) return
  if (replace) history.replaceState(null, '', h)
  else window.location.hash = h
}

export function App() {
  const { t } = useI18n()
  const [store, setStore] = useState<AppStore | null>(null)
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    let cancelled = false
    let created: AppStore | null = null
    void loadBackend().then((backend) => {
      if (cancelled) return
      const sync = new LiveSync((h) => backend.events(h))
      created = createAppStore(backend, sync)
      sync.start()
      setStore(created)
    })
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => {
      cancelled = true
      created?.dispose()
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  const backend = store?.backend ?? null
  const metaState = useResource(store?.meta ?? null)
  const graphState = useResource(store?.graph ?? null)
  const live = useLiveStatus(store?.sync ?? null)
  const meta = metaState.data
  const graph = graphState.data
  const graphError = graphState.error?.message ?? null
  const lastUpdate = graphState.fetchedAt

  const select = useCallback((id: string | null) => setHash({ view: 'graph', nodeId: id }), [])
  const tz = meta?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  const warnings = useMemo(() => graph?.warnings ?? [], [graph])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">
            m<em>explore</em>
          </span>
        </div>
        <nav className="tabs" role="tablist" aria-label={t('tabs.aria')}>
          <button
            role="tab"
            aria-selected={route.view === 'graph'}
            className={route.view === 'graph' ? 'tab active' : 'tab'}
            onClick={() => setHash({ view: 'graph', nodeId: route.nodeId })}
          >
            {t('tab.graph')}
            <span className="tab-count">{graph ? graph.nodes.length : '·'}</span>
          </button>
          <button
            role="tab"
            aria-selected={route.view === 'dashboard'}
            className={route.view === 'dashboard' ? 'tab active' : 'tab'}
            onClick={() => setHash({ view: 'dashboard', nodeId: null })}
          >
            {t('tab.dashboard')}
            <span className="tab-count">{meta ? meta.runCount : '·'}</span>
          </button>
        </nav>
        <div className="topbar-right">
          {route.view === 'graph' && <WarningsPill warnings={warnings} kind="graph" />}
          {meta && (
            <span
              className="root-path"
              title={t('root.title', {
                config: meta.configPath ?? meta.label ?? '—',
                graph: meta.graphRoot,
                state: meta.stateDir ?? '—',
              })}
            >
              {meta.graphRoot.split('/').slice(-2).join('/')}
            </span>
          )}
          {backend?.mock && <span className="mock-badge">{t('mock.badge')}</span>}
          {meta?.label !== undefined && <span className="mock-badge">{meta.label}</span>}
          <LiveBadge status={live} lastUpdate={lastUpdate} />
          <LanguageToggle />
        </div>
      </header>

      <main className="views">
        <section className="view" hidden={route.view !== 'graph'}>
          {store && (
            <GraphView
              store={store}
              graph={graph}
              graphVersion={graphState.version}
              error={graphError}
              selectedId={route.nodeId}
              onSelect={select}
              tz={tz}
              graphRootName={meta?.graphRoot.split('/').pop() ?? 'graph'}
              active={route.view === 'graph'}
            />
          )}
        </section>
        <section className="view" hidden={route.view !== 'dashboard'}>
          {store && <Dashboard store={store} tz={tz} active={route.view === 'dashboard'} source={meta?.source ?? 'service'} label={meta?.label} />}
        </section>
      </main>
    </div>
  )
}

function LiveBadge({ status, lastUpdate }: { status: LiveStatus; lastUpdate: number | null }) {
  const { t } = useI18n()
  const [, force] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => force((x) => x + 1), 15_000)
    return () => window.clearInterval(iv)
  }, [])
  const label = status === 'live' ? t('live.live') : status === 'connecting' ? t('live.connecting') : t('live.reconnecting')
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null
  return (
    <span
      className={`live live-${status}`}
      title={label + ' — ' + t('live.title') + (ago !== null ? t('live.lastRefresh', { s: ago }) : '')}
      aria-label={label}
    >
      <span className="live-dot" />
      <span className="live-label">{label}</span>
    </span>
  )
}

/** EN / 中文 switch: a quiet pill that matches the live badge; shows the current language, flips on click. */
function LanguageToggle() {
  const { t, locale, setLocale } = useI18n()
  const other: Locale = locale === 'zh' ? 'en' : 'zh'
  const name = (l: Locale) => (l === 'zh' ? t('lang.zh') : t('lang.en'))
  return (
    <button
      className="lang-btn"
      onClick={() => setLocale(other)}
      aria-label={t('lang.switch', { current: name(locale), other: name(other) })}
      title={t('lang.switch', { current: name(locale), other: name(other) })}
    >
      <svg viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8h12.4M8 1.8c1.9 2 2.8 4 2.8 6.2S9.9 12.2 8 14.2M8 1.8C6.1 3.8 5.2 5.8 5.2 8s.9 4.2 2.8 6.2" />
      </svg>
      <span lang={locale === 'zh' ? 'zh-CN' : 'en'}>{locale === 'zh' ? '中文' : 'EN'}</span>
    </button>
  )
}
