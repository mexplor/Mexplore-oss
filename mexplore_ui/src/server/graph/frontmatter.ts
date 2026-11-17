// `node.md` parsing.
//
// The frontmatter is line-oriented `key: value` text between a leading `---`
// and the next `---` — NOT YAML (Definitions §2, dsh_plugin/lib/graph.js
// `fmValue`). Parsing must be defensive (GUD-001): a malformed file yields a
// warning, never an exception.

export interface ParsedNodeFile {
  /** Raw frontmatter fields, in file order. */
  frontmatter: Record<string, string>
  /** Markdown body: everything after the closing `---` (one leading blank line dropped). */
  body: string
  description: string
  /** `type` frontmatter value, or null when absent/empty. */
  type: string | null
  created: string | null
  updated: string | null
  supersededBy: string | null
  /** Non-null when the file could not be read/parsed cleanly. */
  warning: string | null
}

/** Banners are prepended to the body; graph-maintain scans the first 10 body lines. */
const BANNER_SCAN_LINES = 10
const BANNER_RE = /^Superseded by ([0-9A-HJKMNP-TV-Z]{26}) on /

export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string; ok: boolean } {
  const lines = text.split('\n')
  if (lines[0] !== '---') return { frontmatter: {}, body: text, ok: false }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { frontmatter: {}, body: text, ok: false }

  const frontmatter: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    if (key === '') continue
    // graph-maintain's fmOf reads `key: value` (one space) — tolerate any spacing.
    frontmatter[key] = line.slice(colon + 1).trim()
  }
  // The body starts after the closing delimiter; graph-maintain skips one blank
  // separator line written by renderNode (`---\n\n<body>`).
  let bodyStart = end + 1
  if (lines[bodyStart] === '') bodyStart++
  return { frontmatter, body: lines.slice(bodyStart).join('\n'), ok: true }
}

/** The supersede banner within the first 10 body lines, as graph-maintain:231-232 reads it. */
export function findSupersededBy(body: string): string | null {
  const lines = body.split('\n')
  for (const line of lines.slice(0, BANNER_SCAN_LINES)) {
    const found = BANNER_RE.exec(line.trim())
    if (found?.[1] !== undefined) return found[1]
  }
  return null
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function parseNodeFile(text: string): ParsedNodeFile {
  const { frontmatter, body, ok } = splitFrontmatter(text)
  const type = nonEmpty(frontmatter['type'])
  const supersededBy = findSupersededBy(body)
  return {
    frontmatter,
    body,
    description: frontmatter['description']?.trim() ?? '',
    type,
    created: nonEmpty(frontmatter['created']),
    updated: nonEmpty(frontmatter['updated']),
    supersededBy,
    warning: ok ? null : 'malformed frontmatter',
  }
}

export function isOpenHandoff(type: string | null, supersededBy: string | null): boolean {
  return type === 'handoff' && supersededBy === null
}
