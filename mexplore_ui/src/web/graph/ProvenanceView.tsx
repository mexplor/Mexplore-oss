// "Written by": which chat created and changed a Node, from its write-session provenance (read-only).
//   ProvenanceCard     glanceable: who created it and the latest change, always visible under the title.
//   ProvenanceHistory  the full history in the viewer, grouped by chat, collapsible and capped.
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { GraphResponse, NodeProvenance, ProvenanceEntry, ProvenanceHost } from '../../shared/types.ts'
import { fmtDateTime, fmtRelative, shortId, shortSession } from '../format.ts'
import { useI18n } from '../i18n.ts'
import { hostKey, nullReasonKey, opKey, provenanceEntries, summarizeProvenance, type ProvenanceGroup } from '../provenance.ts'

type NodeIndex = Map<string, GraphResponse['nodes'][number]>

const GROUP_CAP = 6
const LINE_CAP = 12
const HOST_COLOR: Record<ProvenanceHost, string> = { dsh: '#1f6f6a', opencode: '#3f55a6', unknown: '#8a8173' }

export function ProvenanceCard({ p, tz, active, onOpen }: { p: NodeProvenance; tz: string; active: boolean; onOpen: () => void }) {
  const { t, tn } = useI18n()
  const s = useMemo(() => summarizeProvenance(p), [p])
  if (!s.origin) {
    return (
      <button className="prov-card empty" onClick={onOpen} title={t(p.unreadable ? 'prov.unreadableTitle' : 'prov.noneTitle')}>
        <span className="prov-label">{t('prov.title')}</span>
        <span className="prov-none">{t(p.unreadable ? 'prov.unreadable' : 'prov.none')}</span>
        <svg className="prov-info" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7.2v4M8 4.8v.4" />
        </svg>
      </button>
    )
  }
  return (
    <section className="prov-card" aria-label={t('prov.title')}>
      <header>
        <span className="prov-label">{t('prov.title')}</span>
        <button className={`prov-open${active ? ' on' : ''}`} onClick={onOpen} aria-pressed={active}>
          {t('prov.openHistory')}
          <span className="count">{tn('file.writes', s.total)}</span>
          <span aria-hidden>›</span>
        </button>
      </header>
      <div className="prov-row">
        <span className="k" title={s.created ? undefined : t('prov.firstRecordTitle')}>
          {t(s.created ? 'prov.created' : 'prov.firstRecord')}
        </span>
        <span className="prov-who">
          {!s.created && <Op entry={s.origin} />}
          <Who entry={s.origin} />
        </span>
        <time title={s.origin.ts}>{fmtDateTime(s.origin.ts, tz)}</time>
      </div>
      {s.latest && (
        <div className="prov-row">
          <span className="k">{t('prov.latest')}</span>
          <span className="prov-who">
            <Op entry={s.latest} />
            <Who entry={s.latest} />
          </span>
          <time title={fmtDateTime(s.latest.ts, tz, true)}>{fmtRelative(s.latest.ts)}</time>
        </div>
      )}
    </section>
  )
}

export function ProvenanceHistory({ p, tz, nodeIndex, onNavigate }: { p: NodeProvenance; tz: string; nodeIndex: NodeIndex; onNavigate: (id: string) => void }) {
  const { t, tn, num } = useI18n()
  const s = useMemo(() => summarizeProvenance(p), [p])
  const [groupLimit, setGroupLimit] = useState(GROUP_CAP)
  if (!s.origin) {
    return (
      <div className="prov">
        <div className="att-state">
          <strong>{p.unreadable ? `${t('file.provenance')}: ${t('prov.unreadable')}` : t('prov.emptyTitle')}</strong>
          <span>{t(p.unreadable ? 'prov.unreadableTitle' : 'prov.noneTitle')}</span>
        </div>
      </div>
    )
  }
  const first = provenanceEntries(p)[0]
  return (
    <div className="prov">
      <div className="access-stats">
        <div>
          <b>{num(s.total)}</b>
          <span>{t('prov.writes')}</span>
        </div>
        <div>
          <b>{num(s.chats)}</b>
          <span>{t('prov.chats')}</span>
        </div>
        <div title={first?.ts}>
          <b className="date">{fmtDateTime(first?.ts, tz).slice(0, 10)}</b>
          <span>{t('prov.since')}</span>
        </div>
      </div>
      {p.truncated && <div className="trunc-note">{t('prov.truncated')}</div>}
      {p.skipped > 0 && <div className="prov-skipped">{tn('prov.skipped', p.skipped)}</div>}
      <div className="prov-groups">
        {s.groups.slice(0, groupLimit).map((g, i) => (
          <Group key={g.key} g={g} defaultOpen={i === 0} tz={tz} nodeIndex={nodeIndex} onNavigate={onNavigate} />
        ))}
      </div>
      {s.groups.length > groupLimit && (
        <button className="prov-more" onClick={() => setGroupLimit(Infinity)}>
          {tn('prov.moreChats', s.groups.length - groupLimit)}
        </button>
      )}
    </div>
  )
}

function Group({ g, defaultOpen, tz, nodeIndex, onNavigate }: { g: ProvenanceGroup; defaultOpen: boolean; tz: string; nodeIndex: NodeIndex; onNavigate: (id: string) => void }) {
  const { t, tn } = useI18n()
  const [limit, setLimit] = useState(LINE_CAP)
  return (
    <details className="prov-group" open={defaultOpen}>
      <summary>
        <svg className="prov-caret" viewBox="0 0 16 16" aria-hidden>
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="prov-who">
          <Who entry={g} />
        </span>
        <span className="prov-count">{tn('file.writes', g.entries.length)}</span>
        <time title={`${fmtDateTime(g.firstTs, tz)} → ${fmtDateTime(g.lastTs, tz)}`}>{fmtRelative(g.lastTs)}</time>
      </summary>
      <ol className="prov-lines">
        {g.entries.slice(0, limit).map((e, i) => {
          const peer = e.peer ? (nodeIndex.get(e.peer)?.description ?? shortId(e.peer)) : null
          return (
            <li key={`${e.ts}-${e.op}-${i}`}>
              <time title={e.ts}>{fmtDateTime(e.ts, tz, true)}</time>
              <Op entry={e} />
              <span className="prov-detail">
                {e.peer && peer !== null && (
                  <button className="inline-link" onClick={() => onNavigate(e.peer!)} title={e.peer}>
                    {peer.length > 52 ? `${peer.slice(0, 51)}…` : peer}
                  </button>
                )}
                {e.type && <span className="prov-tag">{e.type}</span>}
                {e.file && <code>{e.file}</code>}
              </span>
            </li>
          )
        })}
      </ol>
      {g.entries.length > limit && (
        <button className="prov-more inline" onClick={() => setLimit(Infinity)}>
          {tn('prov.moreLines', g.entries.length - limit)}
        </button>
      )}
      {g.session === null && <p className="prov-why">{t(nullReasonKey(g) === 'prov.reason.import' ? 'prov.importTitle' : 'prov.nullTitle')}</p>}
    </details>
  )
}

function Op({ entry }: { entry: ProvenanceEntry }) {
  const { t } = useI18n()
  const key = opKey(entry.op)
  return (
    <span className="prov-op" data-op={entry.op} title={entry.call ? t('prov.call', { id: entry.call }) : undefined}>
      {key ? t(key) : entry.op}
    </span>
  )
}

/** Host + root chat session, or the stored reason when no session was recorded. */
function Who({ entry }: { entry: Pick<ProvenanceEntry, 'host' | 'actor' | 'session'> & { reason?: ProvenanceEntry['reason'] | null } }) {
  const { t } = useI18n()
  const reasonKey = entry.session === null ? nullReasonKey(entry) : null
  // "unknown host · unknown — …" says the same thing twice; the reason alone is the honest summary.
  const showHost = entry.host !== 'unknown' || entry.session !== null
  return (
    <>
      {showHost && (
        <span className="prov-host" style={{ ['--h' as string]: HOST_COLOR[entry.host] }}>
          {t(hostKey(entry.host))}
        </span>
      )}
      {entry.session !== null ? (
        <SessionId id={entry.session} />
      ) : (
        <span className={`prov-null${reasonKey === 'prov.reason.import' ? ' import' : ''}`} title={t(reasonKey === 'prov.reason.import' ? 'prov.importTitle' : 'prov.nullTitle')}>
          {t(reasonKey!)}
        </span>
      )}
    </>
  )
}

function SessionId({ id }: { id: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = (e: MouseEvent) => {
    // Inside a <summary>, a click would also toggle the group.
    e.preventDefault()
    e.stopPropagation()
    void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined)
  }
  return (
    <button className={`prov-sid${copied ? ' copied' : ''}`} onClick={copy} title={t('prov.sessionTitle', { id })} aria-label={`${t('prov.copy')}: ${id}`}>
      <span>{copied ? t('prov.copied') : shortSession(id)}</span>
      <svg viewBox="0 0 16 16" aria-hidden>
        {copied ? (
          <path d="M3.5 8.5l3 3 6-7" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
          </>
        )}
      </svg>
    </button>
  )
}
