// Client half of the memory-graph panel: mexplore_ui's graph explorer inside a
// DSH main panel. Bundled (CommonJS, React external) into client.js, where the
// hand-written shell in client-shell.js evaluates it on first render.
//
// This replaces mexplore_ui's App.tsx/main.tsx, which own the whole page: they
// route through window.location.hash, append a favicon to <head> and create
// their own React root. Here the selection lives in React state, the backend is
// mexplore_ui's createHttpBackend with every URL under /mexplor, and the
// stylesheet is mexplore_ui's styles.css scoped under `.mxg-root` at build time
// and rendered as a <style> element, so it leaves with the panel.
// The token dashboard is left out: DSH has no A2A task database to read.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { createHttpBackend, type HttpDeps } from '../../mexplore_ui/src/web/api.ts'
import { createAppStore, type AppStore } from '../../mexplore_ui/src/web/appStore.ts'
import { GraphView } from '../../mexplore_ui/src/web/graph/GraphView.tsx'
import { setLocale, useI18n, type Locale } from '../../mexplore_ui/src/web/i18n.ts'
import { LiveSync, type LiveStatus } from '../../mexplore_ui/src/web/liveSync.ts'
import { useLiveStatus, useResource } from '../../mexplore_ui/src/web/useStore.ts'
import { WarningsPill } from '../../mexplore_ui/src/web/Warnings.tsx'
// Virtual module produced by scripts/build-ui.mjs: the scoped stylesheet text.
// @ts-expect-error resolved by the build
import SCOPED_CSS from 'mxg:scoped-css'

/** Host route prefix; mexplore_ui's backend asks for /api/..., DSH serves /mexplor/api/... */
export const API_PREFIX = '/mexplor'
export const ROOT_CLASS = 'mxg-root'
export const CSS_TEXT: string = SCOPED_CSS

export function prefixedDeps(prefix: string = API_PREFIX): HttpDeps {
  const fetchPrefixed: HttpDeps['fetch'] = (input, init) =>
    globalThis.fetch(prefix + input, { credentials: 'same-origin', ...init })
  // Called with `new` by api.ts; returning an object from a constructor function yields that object.
  const EventSourcePrefixed = function (this: unknown, url: string) {
    return new globalThis.EventSource(prefix + url)
  } as unknown as HttpDeps['EventSource']
  return { fetch: fetchPrefixed, EventSource: EventSourcePrefixed }
}

export interface MemoryGraphPanelProps {
  /** DSH UI language; anything starting with "zh" picks Chinese. */
  lang?: string
  title?: string
}

export function MemoryGraphPanel({ lang, title }: MemoryGraphPanelProps) {
  const locale: Locale = typeof lang === 'string' && lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  useEffect(() => {
    setLocale(locale)
  }, [locale])

  const { t } = useI18n()
  const [store, setStore] = useState<AppStore | null>(null)
  const [nodeId, setNodeId] = useState<string | null>(null)

  useEffect(() => {
    const backend = createHttpBackend(prefixedDeps())
    const sync = new LiveSync((h) => backend.events(h))
    const created = createAppStore(backend, sync)
    sync.start()
    setStore(created)
    return () => {
      created.dispose()
    }
  }, [])

  const metaState = useResource(store?.meta ?? null)
  const graphState = useResource(store?.graph ?? null)
  const live = useLiveStatus(store?.sync ?? null)
  const meta = metaState.data
  const graph = graphState.data
  const graphError = graphState.error?.message ?? metaState.error?.message ?? null
  const select = useCallback((id: string | null) => setNodeId(id), [])
  const tz = meta?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const warnings = useMemo(() => graph?.warnings ?? [], [graph])

  return (
    <div className={ROOT_CLASS}>
      <style data-mxg-styles="">{CSS_TEXT}</style>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="wordmark">{title ?? 'Mexplore'}</span>
            <span className="tab-count">{graph ? graph.nodes.length : '·'}</span>
          </div>
          <div className="topbar-right">
            <WarningsPill warnings={warnings} kind="graph" />
            {meta && (
              <span className="root-path" title={meta.graphRoot}>
                {meta.graphRoot.split(/[\\/]/).slice(-2).join('/')}
              </span>
            )}
            <LiveBadge status={live} lastUpdate={graphState.fetchedAt} t={t} />
          </div>
        </header>
        <main className="views">
          <section className="view">
            {store && (
              <GraphView
                store={store}
                graph={graph}
                graphVersion={graphState.version}
                error={graphError}
                selectedId={nodeId}
                onSelect={select}
                tz={tz}
                graphRootName={meta?.graphRoot.split(/[\\/]/).pop() ?? 'graph'}
                active
              />
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

type T = ReturnType<typeof useI18n>['t']

function LiveBadge({ status, lastUpdate, t }: { status: LiveStatus; lastUpdate: number | null; t: T }) {
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
