// Markdown → sanitised HTML. Never loads remote resources: every <img> that is not an inline data: image is
// swapped for a placeholder, style attributes and embedding tags are dropped, links open in a new tab.
import DOMPurify from 'dompurify'
import { marked } from 'marked'

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g

let hooked = false
function ensureHooks() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? ''
      if (!/^data:image\/(png|gif|jpe?g|webp);/i.test(src)) {
        let host = ''
        try {
          host = new URL(src, 'http://local.invalid').host
        } catch {
          /* ignore */
        }
        el.removeAttribute('src')
        el.setAttribute('data-blocked', host === 'local.invalid' ? 'relative path' : host || 'image')
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  })
}

const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'track', 'picture', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset', 'background', 'poster', 'action', 'formaction', 'ping', 'xlink:href'],
}

/** Render markdown to safe HTML; ULIDs of known Nodes become in-app links (`data-node`). */
export function renderMarkdown(md: string, knownIds?: ReadonlySet<string>): string {
  ensureHooks()
  const raw = marked.parse(md, { async: false, gfm: true, breaks: false }) as string
  const clean = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string
  const tpl = document.createElement('template')
  tpl.innerHTML = clean

  // Blocked images → visible placeholder chip.
  tpl.content.querySelectorAll('img[data-blocked]').forEach((img) => {
    const span = document.createElement('span')
    span.className = 'img-blocked'
    const alt = img.getAttribute('alt')
    span.textContent = `image not loaded${alt ? ` · ${alt}` : ''} · ${img.getAttribute('data-blocked')}`
    span.title = 'Remote images are never fetched by this read-only viewer'
    img.replaceWith(span)
  })

  if (knownIds && knownIds.size) {
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text
      if (t.parentElement?.closest('pre, a')) continue
      ULID_RE.lastIndex = 0
      if (ULID_RE.test(t.data)) targets.push(t)
    }
    for (const t of targets) {
      const frag = document.createDocumentFragment()
      let last = 0
      ULID_RE.lastIndex = 0
      for (let m = ULID_RE.exec(t.data); m; m = ULID_RE.exec(t.data)) {
        const id = m[0]
        frag.append(t.data.slice(last, m.index))
        if (knownIds.has(id)) {
          const a = document.createElement('a')
          a.className = 'ulid-link'
          a.setAttribute('data-node', id)
          a.href = `#graph/${id}`
          a.textContent = id
          frag.append(a)
        } else {
          frag.append(id)
        }
        last = m.index + id.length
      }
      frag.append(t.data.slice(last))
      t.replaceWith(frag)
    }
  }
  return tpl.innerHTML
}
