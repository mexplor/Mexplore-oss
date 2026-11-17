import { useEffect, useMemo, useState } from 'react'
import type { GraphResponse, Neighbour, NodeDetail } from '../../shared/types.ts'
import type { Backend, FileResult } from '../api.ts'
import type { AppStore } from '../appStore.ts'
import { useResource } from '../useStore.ts'
import { EDGE_STYLES, typeColor, typeKey } from '../graphModel.ts'
import { fmtBytes, fmtDateTime, fmtRelative, shortId } from '../format.ts'
import { renderMarkdown } from '../markdown.ts'
import { useI18n, type MsgKey } from '../i18n.ts'
import { ProvenanceCard, ProvenanceHistory } from './ProvenanceView.tsx'
import { provenanceEntries } from '../provenance.ts'

interface Props {
  store: AppStore
  id: string
  graph: GraphResponse | null
  knownIds: ReadonlySet<string>
  tz: string
  graphRootName: string
  onNavigate: (id: string) => void
  onClose: () => void
  /** Narrow windows: the panel is a bottom sheet over the canvas that can be collapsed to its header. */
  sheet?: { collapsed: boolean; onToggle: () => void }
}

type Entry = { kind: 'node' } | { kind: 'file'; name: string } | { kind: 'edges' } | { kind: 'access' } | { kind: 'provenance' }

export function NodePanel({ store, id, graph, knownIds, tz, graphRootName, onNavigate, onClose, sheet }: Props) {
  const { t, tn, num } = useI18n()
  const backend = store.backend
  const [entry, setEntry] = useState<Entry>({ kind: 'node' })
  const [titleOpen, setTitleOpen] = useState(false)
  useEffect(() => setTitleOpen(false), [id])

  // Keep the edges/access view while walking the graph; attachments are per-node so reset to node.md.
  useEffect(() => {
    setEntry((e) => (e.kind === 'file' ? { kind: 'node' } : e))
  }, [id])

  // The selected node is a live resource: the store refetches it on (re)connect and on graph/node hints.
  useEffect(() => {
    store.node.setQuery(id, id)
    return () => store.node.setQuery(null, null)
  }, [store, id])
  const nodeState = useResource(store.node)
  const detail: NodeDetail | null = nodeState.dataKey === id ? nodeState.data : null
  const fetchErr = nodeState.errorKey === id ? nodeState.error : null
  const state: 'loading' | 'ok' | 'missing' | 'error' =
    fetchErr && (fetchErr.status === 404 || fetchErr.status === 400) ? 'missing' : fetchErr ? 'error' : detail ? 'ok' : 'loading'
  const err = fetchErr?.message ?? ''
  const tick = nodeState.version

  const nodeIndex = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph])
  const d = detail?.id === id ? detail : null
  const g = nodeIndex.get(id)

  const groups = useMemo(() => {
    const out: Neighbour[] = []
    const inn: Neighbour[] = []
    const both: Neighbour[] = []
    for (const n of d?.neighbours ?? []) (n.direction === 'out' ? out : n.direction === 'in' ? inn : both).push(n)
    return { out, inn, both }
  }, [d])

  const writes = useMemo(() => (d ? provenanceEntries(d.provenance) : []), [d])

  const title = d?.description ?? g?.description ?? ''
  const color = typeColor(d?.type ?? g?.type ?? null)

  return (
    <aside
      className={`panel${sheet ? ' sheet' : ''}${sheet?.collapsed ? ' collapsed' : ''}`}
      style={{ ['--c' as string]: color }}
    >
      <div className="panel-head">
        {sheet?.collapsed ? (
          <button className="sheet-title" onClick={sheet.onToggle} title={t('panel.expand')}>
            {title || id}
          </button>
        ) : (
          <div className="crumbs" title={id}>
            <span>{graphRootName}</span>
            <span className="crumb-sep">/</span>
            <button className="crumb-id" onClick={() => void navigator.clipboard?.writeText(id)} title={t('panel.copyId')}>
              {id}
            </button>
            <span className="crumb-sep">/</span>
            <span className="crumb-file">{entryLabel(entry)}</span>
          </div>
        )}
        {sheet && (
          <button
            className="sheet-toggle"
            onClick={sheet.onToggle}
            aria-expanded={!sheet.collapsed}
            aria-label={sheet.collapsed ? t('panel.expand') : t('panel.collapse')}
            title={sheet.collapsed ? t('panel.expand') : t('panel.collapse')}
          >
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d={sheet.collapsed ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
            </svg>
          </button>
        )}
        <button className={`close${sheet ? ' in-sheet' : ''}`} onClick={onClose} aria-label={t('panel.close')} title={t('panel.closeTitle')}>
          ×
        </button>
      </div>

      {state === 'missing' && (
        <div className="panel-state">
          <strong>{t('panel.missingTitle')}</strong>
          <p>{t('panel.missingBody')}</p>
        </div>
      )}
      {state === 'error' && !d && <div className="panel-state">{t('panel.readError', { error: err })}</div>}
      {state === 'loading' && !d && (
        <div className="panel-state">
          <span className="spinner" /> {t('panel.reading')}
        </div>
      )}

      {d && state !== 'missing' && (
        <>
          <div className="panel-title">
            <h2
              className={title.length > 160 ? (titleOpen ? 'expandable' : 'clamped expandable') : ''}
              onClick={() => title.length > 160 && setTitleOpen((o) => !o)}
              title={title.length > 160 && !titleOpen ? t('panel.expandTitle') : undefined}
            >
              {title || <span className="muted">{t('panel.noDesc')}</span>}
            </h2>
            <div className="badges">
              <span className="badge type">
                <i />
                {t(`type.${typeKey(d.type)}` as MsgKey)}
              </span>
              {d.openHandoff && <span className="badge handoff">{t('badge.handoff')}</span>}
              {d.superseded && (
                <span className="badge sup">
                  {d.supersededBy
                    ? t('badge.supersededBy', { link: '\u0000' })
                        .split('\u0000')
                        .map((part, i) =>
                          i === 0 ? (
                            <span key={i}>{part}</span>
                          ) : (
                            <span key={i}>
                              <button className="inline-link" onClick={() => onNavigate(d.supersededBy!)}>
                                {nodeIndex.get(d.supersededBy!)?.description ? truncate(nodeIndex.get(d.supersededBy!)!.description, 34) : shortId(d.supersededBy!)}
                              </button>
                              {part}
                            </span>
                          ),
                        )
                    : t('badge.superseded')}
                </span>
              )}
              {d.mapRank !== null ? (
                <span className="badge plain" title={t('badge.mapRankTitle')}>
                  {t('badge.mapRank', { n: d.mapRank + 1 })}
                </span>
              ) : (
                <span className="badge plain" title={t('badge.notInMapTitle')}>
                  {t('badge.notInMap')}
                </span>
              )}
            </div>
          </div>

          <ProvenanceCard p={d.provenance} tz={tz} active={entry.kind === 'provenance'} onOpen={() => setEntry({ kind: 'provenance' })} />

          <div className="explorer">
            <div className="explorer-head">
              <span>{t('explorer.name')}</span>
              <span>{t('explorer.size')}</span>
              <span>{t('explorer.modified')}</span>
            </div>
            <FileRow active={entry.kind === 'node'} icon="doc" name="node.md" size={t('file.chars', { n: num(d.body.length) })} mtime={d.updated ?? d.created ?? ''} onClick={() => setEntry({ kind: 'node' })} />
            {d.attachments.map((a) => (
              <FileRow
                key={a.name}
                active={entry.kind === 'file' && entry.name === a.name}
                icon={/\.(png|jpe?g|gif|webp|pdf|zip|sqlite)$/i.test(a.name) ? 'bin' : 'file'}
                name={a.name}
                size={fmtBytes(a.size)}
                mtime={fmtDateTime(a.mtime, tz)}
                onClick={() => setEntry({ kind: 'file', name: a.name })}
              />
            ))}
            <FileRow active={entry.kind === 'edges'} icon="dir" name="__edges__/" size={tn('file.links', d.neighbours.length)} mtime={groups.inn.length ? tn('file.backlinks', groups.inn.length) : ''} onClick={() => setEntry({ kind: 'edges' })} />
            <FileRow active={entry.kind === 'access'} icon="log" name={t('file.accessLog')} size={tn('file.visits', d.visitCount)} mtime={d.recentAccess[0] ? fmtRelative(d.recentAccess[0].at) : t('file.never')} onClick={() => setEntry({ kind: 'access' })} />
            <FileRow
              active={entry.kind === 'provenance'}
              icon="pen"
              name={t('file.provenance')}
              size={tn('file.writes', writes.length)}
              mtime={writes.length ? fmtRelative(writes[writes.length - 1]!.ts) : t('file.never')}
              onClick={() => setEntry({ kind: 'provenance' })}
            />
          </div>

          <div className="viewer">
            {entry.kind === 'node' && <NodeMd d={d} knownIds={knownIds} />}
            {entry.kind === 'file' && (
              <AttachmentView
                backend={backend}
                id={id}
                name={entry.name}
                tick={tick}
                knownIds={knownIds}
                meta={d.attachments.find((a) => a.name === entry.name)}
                tz={tz}
              />
            )}
            {entry.kind === 'edges' && <EdgesView groups={groups} nodeIndex={nodeIndex} onNavigate={onNavigate} />}
            {entry.kind === 'access' && <AccessView d={d} nodeIndex={nodeIndex} tz={tz} onNavigate={onNavigate} />}
            {entry.kind === 'provenance' && <ProvenanceHistory key={id} p={d.provenance} tz={tz} nodeIndex={nodeIndex} onNavigate={onNavigate} />}
          </div>
        </>
      )}
    </aside>
  )
}

function entryLabel(e: Entry): string {
  return e.kind === 'node' ? 'node.md' : e.kind === 'file' ? e.name : e.kind === 'edges' ? '__edges__/' : e.kind === 'access' ? '.access' : '.provenance'
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function FileRow(p: { active: boolean; icon: 'doc' | 'file' | 'bin' | 'dir' | 'log' | 'pen'; name: string; size: string; mtime: string; onClick: () => void }) {
  return (
    <button className={`file-row ${p.active ? 'active' : ''}`} onClick={p.onClick} title={p.name}>
      <span className="file-name">
        <FileIcon kind={p.icon} />
        {p.name}
      </span>
      <span className="file-size">{p.size}</span>
      <span className="file-mtime">{p.mtime}</span>
    </button>
  )
}

function FileIcon({ kind }: { kind: 'doc' | 'file' | 'bin' | 'dir' | 'log' | 'pen' }) {
  if (kind === 'dir')
    return (
      <svg className="ficon dir" viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 4.5v8h13v-7H7.5l-1.5-1.5h-4.5z" />
      </svg>
    )
  if (kind === 'pen')
    return (
      <svg className="ficon log" viewBox="0 0 16 16" aria-hidden>
        <path d="M10.6 2.4l3 3-7.8 7.8-3.6.6.6-3.6z" />
        <path d="M9 4l3 3" />
      </svg>
    )
  if (kind === 'log')
    return (
      <svg className="ficon log" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5V8l2.5 1.5" />
      </svg>
    )
  return (
    <svg className={`ficon ${kind}`} viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
      {kind === 'doc' && <path d="M5.5 8h5M5.5 10.5h5M5.5 13h3" />}
      {kind === 'bin' && <path d="M5.5 9h1v3h-1zM8.5 9h2v3h-2z" />}
    </svg>
  )
}

function NodeMd({ d, knownIds }: { d: NodeDetail; knownIds: ReadonlySet<string> }) {
  const { t } = useI18n()
  const html = useMemo(() => renderMarkdown(d.body, knownIds), [d.body, knownIds])
  const fm = Object.entries(d.frontmatter)
  return (
    <div className="nodemd">
      <dl className="frontmatter">
        {fm.length === 0 && <div className="muted">{t('md.noFrontmatter')}</div>}
        {fm.map(([k, v]) => (
          <div key={k} className="fm-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {d.body.trim() ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="muted pad">{t('md.emptyBody')}</div>}
    </div>
  )
}

function AttachmentView(props: {
  backend: Backend
  id: string
  name: string
  tick: number
  knownIds: ReadonlySet<string>
  meta: { size: number; mtime: string } | undefined
  tz: string
}) {
  const { backend, id, name, tick, knownIds, meta, tz } = props
  const { t } = useI18n()
  const [res, setRes] = useState<FileResult | null>(null)
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const isMd = /\.(md|markdown)$/i.test(name)

  useEffect(() => {
    let cancelled = false
    setRes(null)
    backend
      .file(id, name)
      .then((r) => !cancelled && setRes(r))
      .catch((e: unknown) => !cancelled && setRes({ kind: 'error', message: String(e) }))
    return () => {
      cancelled = true
    }
  }, [backend, id, name, tick])

  const html = useMemo(() => (res?.kind === 'text' && isMd ? renderMarkdown(res.text, knownIds) : ''), [res, isMd, knownIds])

  return (
    <div className="attachment">
      <div className="att-head">
        <span className="att-meta">
          {meta ? t('att.meta', { size: fmtBytes(meta.size), date: fmtDateTime(meta.mtime, tz) }) : ''}
        </span>
        {isMd && res?.kind === 'text' && (
          <div className="seg small">
            <button className={mode === 'rendered' ? 'on' : ''} onClick={() => setMode('rendered')}>
              {t('att.rendered')}
            </button>
            <button className={mode === 'raw' ? 'on' : ''} onClick={() => setMode('raw')}>
              {t('att.raw')}
            </button>
          </div>
        )}
      </div>
      {!res && (
        <div className="panel-state">
          <span className="spinner" /> {t('att.reading', { name })}
        </div>
      )}
      {res?.kind === 'binary' && (
        <div className="att-state">
          <strong>{t('att.binaryTitle')}</strong>
          <span>{t('att.binaryBody')}</span>
        </div>
      )}
      {res?.kind === 'missing' && (
        <div className="att-state">
          <strong>{t('att.missingTitle')}</strong>
          <span>{t('att.missingBody')}</span>
        </div>
      )}
      {res?.kind === 'error' && (
        <div className="att-state">
          <strong>{t('att.errorTitle')}</strong>
          <span>{res.message}</span>
        </div>
      )}
      {res?.kind === 'text' && (
        <>
          {res.truncated && <div className="trunc-note">{t('att.truncated')}</div>}
          {isMd && mode === 'rendered' ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="raw">{res.text}</pre>
          )}
        </>
      )}
    </div>
  )
}

function EdgesView({
  groups,
  nodeIndex,
  onNavigate,
}: {
  groups: { out: Neighbour[]; inn: Neighbour[]; both: Neighbour[] }
  nodeIndex: Map<string, GraphResponse['nodes'][number]>
  onNavigate: (id: string) => void
}) {
  const { t, num } = useI18n()
  const sections: { key: string; title: string; hint: string; items: Neighbour[] }[] = [
    { key: 'out', title: t('edges.out'), hint: t('edges.outHint'), items: groups.out },
    { key: 'both', title: t('edges.both'), hint: t('edges.bothHint'), items: groups.both },
    { key: 'in', title: t('edges.in'), hint: t('edges.inHint'), items: groups.inn },
  ]
  if (!groups.out.length && !groups.inn.length && !groups.both.length) {
    return <div className="muted pad">{t('edges.none')}</div>
  }
  return (
    <div className="edges">
      {sections.map(
        (s) =>
          s.items.length > 0 && (
            <section key={s.key}>
              <h4>
                {s.title} <span className="count">{num(s.items.length)}</span>
                <span className="hint">{s.hint}</span>
              </h4>
              <ul>
                {s.items.map((nb, i) => {
                  const gn = nodeIndex.get(nb.id)
                  return (
                    <li key={`${nb.id}-${nb.edgeType}-${i}`}>
                      <button
                        className={`nb-row ${gn?.superseded ? 'superseded' : ''}`}
                        onClick={() => onNavigate(nb.id)}
                        style={{ ['--c' as string]: typeColor(gn?.type ?? null), ['--e' as string]: EDGE_STYLES[nb.edgeType].color }}
                      >
                        <span className="nb-dir" aria-label={t(nb.direction === 'out' ? 'dir.out' : nb.direction === 'in' ? 'dir.in' : 'dir.both')}>
                          {nb.direction === 'out' ? '→' : nb.direction === 'in' ? '←' : '↔'}
                        </span>
                        <span className="nb-edge">{t(`edge.${nb.edgeType}` as MsgKey)}</span>
                        <span className="nb-desc">
                          <i className="dot" />
                          {nb.description || <span className="muted">{t('panel.noDesc')}</span>}
                        </span>
                        <span className="nb-id">{shortId(nb.id)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ),
      )}
    </div>
  )
}

function AccessView({
  d,
  nodeIndex,
  tz,
  onNavigate,
}: {
  d: NodeDetail
  nodeIndex: Map<string, GraphResponse['nodes'][number]>
  tz: string
  onNavigate: (id: string) => void
}) {
  const { t, num } = useI18n()
  const desc = (id: string) => nodeIndex.get(id)?.description ?? shortId(id)
  return (
    <div className="access">
      <div className="access-stats">
        <div>
          <b>{num(d.visitCount)}</b>
          <span>{t('access.visits')}</span>
        </div>
        <div>
          <b>{num(d.degree)}</b>
          <span>{t('access.links')}</span>
        </div>
        <div>
          <b>{num(d.recentAccess.length)}</b>
          <span>{t('access.recent')}{d.recentAccess.length >= 50 ? t('access.latest50') : ''}</span>
        </div>
      </div>
      {d.recentAccess.length === 0 ? (
        <div className="muted pad">{t('access.none')}</div>
      ) : (
        <ol className="access-list">
          {d.recentAccess.map((a, i) => {
            const visit = a.src === d.id && a.dst === d.id
            const out = a.src === d.id && a.dst !== d.id
            const other = out ? a.dst : a.src
            return (
              <li key={`${a.at}-${i}`} className={visit ? 'visit' : out ? 'out' : 'in'}>
                <time title={a.at}>
                  {fmtDateTime(a.at, tz, true)}
                  <span>{fmtRelative(a.at)}</span>
                </time>
                <span className="ev">
                  {visit ? (
                    <>
                      <span className="ev-glyph">◉</span> {t('access.read')}
                    </>
                  ) : (
                    <>
                      <span className="ev-glyph">{out ? '→' : '←'}</span>
                      {out ? t('access.to') : t('access.from')}
                      <button className="inline-link" onClick={() => onNavigate(other)}>
                        {truncate(desc(other), 48)}
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
