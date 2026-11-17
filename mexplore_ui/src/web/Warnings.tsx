import { useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n.ts'

/** Unobtrusive warnings indicator: a small pill that expands into a list on click. */
export function WarningsPill({ warnings, kind }: { warnings: readonly string[]; kind: 'graph' | 'usage' }) {
  const { tn, t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!warnings.length) return null
  return (
    <div className="warn" ref={ref}>
      <button
        className="warn-pill"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={tn(`warn.${kind}`, warnings.length)}
        title={tn(`warn.${kind}`, warnings.length)}
      >
        <span className="warn-glyph" aria-hidden>
          !
        </span>
        <span className="warn-label">{tn(`warn.${kind}`, warnings.length)}</span>
        <span className="warn-count" aria-hidden>
          {warnings.length}
        </span>
      </button>
      {open && (
        <div className="warn-pop" role="dialog">
          <div className="warn-pop-head">{t('warn.head')}</div>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
