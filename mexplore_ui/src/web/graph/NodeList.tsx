import { memo, useEffect, useRef } from 'react'
import type { GraphNode } from '../../shared/types.ts'
import { typeColor, typeKey } from '../graphModel.ts'
import { useI18n, type MsgKey } from '../i18n.ts'

interface Props {
  nodes: GraphNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  query: string
}

export function NodeList({ nodes, selectedId, onSelect, query }: Props) {
  const { t } = useI18n()
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (!selectedId || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (!nodes.length) {
    return <div className="list-empty">{t('list.empty')}</div>
  }
  return (
    <ol className="node-list" ref={listRef}>
      {nodes.map((n) => (
        <Row key={n.id} n={n} selected={n.id === selectedId} onSelect={onSelect} query={query} />
      ))}
    </ol>
  )
}

const Row = memo(function Row({
  n,
  selected,
  onSelect,
  query,
}: {
  n: GraphNode
  selected: boolean
  onSelect: (id: string) => void
  query: string
}) {
  // memo'd row: subscribe itself so a language switch re-renders it
  const { t, num } = useI18n()
  const cls = ['node-row', selected && 'selected', n.superseded && 'superseded', n.openHandoff && 'handoff'].filter(Boolean).join(' ')
  return (
    <li className={cls} data-id={n.id}>
      <button onClick={() => onSelect(n.id)} style={{ ['--c' as string]: typeColor(n.type) }}>
        <span className="rank">{n.mapRank !== null ? n.mapRank + 1 : '–'}</span>
        <span className="row-main">
          <span className="row-desc">{highlight(n.description || n.id, query)}</span>
          <span className="row-meta">
            <i className="dot" />
            {t(`type.${typeKey(n.type)}` as MsgKey)}
            {n.openHandoff && <b className="tag-handoff">{t('row.open')}</b>}
            {n.superseded && <b className="tag-sup">{t('row.superseded')}</b>}
            <span className="sep">·</span>
            {n.updated ?? n.created ?? t('row.noDate')}
            <span className="row-nums">
              <span title={t('row.links')}>{num(n.degree)}↔</span>
              {n.visitCount > 0 && <span title={t('row.visits')}>{num(n.visitCount)}◉</span>}
              {n.attachmentCount > 0 && <span title={t('row.attachments')}>{num(n.attachmentCount)}▤</span>}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
})

function highlight(text: string, q: string) {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}
