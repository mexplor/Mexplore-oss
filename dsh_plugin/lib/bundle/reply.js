/**
 * Reply assembly for `memory_agent`.
 *
 * The child is asked for one JSON object `{text, unknown, citations}`. Valid
 * JSON gives the reply; otherwise the prose is kept and marked unstructured.
 * Citations are never taken on the model's word: they are filtered against
 * node ids the child's tools actually returned. Attachments are rebuilt from
 * verified memory_read_file pages, never retyped by the model.
 *
 * `calls` are the records agent-tools.js keeps: `{tool, callId, outcome,
 * verification?}`.
 *
 * @module dsh-mexplore/bundle/reply
 */

/** All node ids and attachment names actually observed in tool results. */
export function collectEvidence(calls) {
  const nodes = new Map()
  const ensure = (id) => {
    let entry = nodes.get(id)
    if (!entry) {
      entry = { attachments: new Set() }
      nodes.set(id, entry)
    }
    return entry
  }
  for (const call of calls) {
    if (call.outcome?.kind !== 'result') continue
    const record = call.outcome.result
    if (record === null || typeof record !== 'object') continue
    if (call.tool === 'memory_read') {
      if (typeof record.id !== 'string') continue
      const entry = ensure(record.id)
      if (typeof record.description === 'string') entry.description = record.description
      if (Array.isArray(record.files)) {
        for (const file of record.files) {
          if (file && typeof file === 'object' && typeof file.name === 'string') entry.attachments.add(file.name)
        }
      }
    } else if (call.tool === 'memory_search') {
      if (!Array.isArray(record.matches)) continue
      for (const row of record.matches) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
        const entry = ensure(row.id)
        if (entry.description === undefined && typeof row.description === 'string') entry.description = row.description
        if (Array.isArray(row.files)) {
          for (const file of row.files) if (typeof file === 'string') entry.attachments.add(file)
        }
      }
    } else if (call.tool === 'memory_read_file') {
      if (typeof record.id !== 'string' || typeof record.file !== 'string') continue
      ensure(record.id).attachments.add(record.file)
    }
  }
  return nodes
}

/** Keep only citations grounded in actual tool results. */
export function groundCitations(calls, modelCitations) {
  const nodes = collectEvidence(calls)
  const out = []
  const seen = new Set()
  for (const candidate of modelCitations) {
    const node = nodes.get(candidate.nodeId)
    if (!node) continue
    const attachment = candidate.attachment
    if (attachment !== undefined && !node.attachments.has(attachment)) continue
    const key = `${candidate.nodeId}\u0000${attachment ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      nodeId: candidate.nodeId,
      ...(node.description === undefined ? {} : { description: node.description }),
      ...(attachment === undefined ? {} : { attachment }),
    })
  }
  return out
}

/** If the model cited nothing, the nodes it actually read. Search rows are not citations. */
export function fallbackCitations(calls) {
  const nodes = collectEvidence(calls)
  const readIds = new Set()
  for (const call of calls) {
    if (call.outcome?.kind !== 'result') continue
    const id = call.outcome.result?.id
    if (typeof id === 'string' && (call.tool === 'memory_read' || call.tool === 'memory_read_file')) readIds.add(id)
  }
  const out = []
  for (const id of readIds) {
    const node = nodes.get(id)
    if (!node) continue
    out.push({ nodeId: id, ...(node.description === undefined ? {} : { description: node.description }) })
  }
  return out
}

/** UTF-8-safe cut at or below `maxBytes`. */
export function boundText(text, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  while (end > 0 && end < buffer.length) {
    const byte = buffer[end]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    end -= 1
  }
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
}

function asCitationList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.nodeId !== 'string') continue
    out.push({ nodeId: entry.nodeId, ...(typeof entry.attachment === 'string' ? { attachment: entry.attachment } : {}) })
  }
  return out
}

function tryParseObject(candidate) {
  try {
    const parsed = JSON.parse(candidate)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const REPAIR_WORK_BUDGET_FACTOR = 8
const REPAIR_WORK_BUDGET_FLOOR = 65_536
const STRICT_SCAN_BUDGET_FACTOR = 8
const STRICT_SCAN_BUDGET_FLOOR = 65_536

/** Escape raw control characters that appear inside JSON string literals. */
export function escapeRawControlCharsInStrings(candidate) {
  let out = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i]
    const code = ch.charCodeAt(0)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      } else if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`
        changed = true
        continue
      }
    } else if (ch === '"') {
      inString = true
    }
    out += ch
  }
  return changed ? out : candidate
}

function lastControlCharAtOrBefore(text, end) {
  for (let i = Math.min(end, text.length - 1); i >= 0; i -= 1) {
    if (text.charCodeAt(i) < 0x20) return i
  }
  return -1
}

/** The `{` whose braces balance to the `}` at `lastBrace`, scanning backward. */
function terminalOpener(text, lastBrace) {
  let depth = 0
  let inString = false
  for (let i = lastBrace; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '"') {
      let backslashes = 0
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) backslashes += 1
      if (backslashes % 2 === 0) inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '}') {
      depth += 1
    } else if (ch === '{') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The child's final text, parsed as the requested JSON object when possible.
 * Same two bounded passes as reply.ts `parseAgentStdout`.
 */
export function parseAgentReply(stdout, maxReplyBytes) {
  const trimmed = stdout.trim()
  let parsed = tryParseObject(trimmed)
  const lastBrace = parsed ? -1 : trimmed.lastIndexOf('}')
  const candidates = function* () {
    for (let at = trimmed.lastIndexOf('{', lastBrace); at !== -1; at = at === 0 ? -1 : trimmed.lastIndexOf('{', at - 1)) {
      yield at
    }
  }
  if (!parsed && lastBrace !== -1) {
    const exempt = new Set()
    const first = trimmed.indexOf('{')
    if (first !== -1 && first < lastBrace) exempt.add(first)
    const terminal = terminalOpener(trimmed, lastBrace)
    if (terminal !== -1 && terminal < lastBrace) exempt.add(terminal)
    for (const at of [...exempt].sort((a, b) => b - a)) {
      parsed = tryParseObject(trimmed.slice(at, lastBrace + 1))
      if (parsed) break
    }
    if (!parsed) {
      let budget = STRICT_SCAN_BUDGET_FACTOR * trimmed.length + STRICT_SCAN_BUDGET_FLOOR
      for (const at of candidates()) {
        if (exempt.has(at)) continue
        budget -= lastBrace + 1 - at
        if (budget < 0) break
        parsed = tryParseObject(trimmed.slice(at, lastBrace + 1))
        if (parsed) break
      }
    }
  }
  if (!parsed && lastBrace !== -1) {
    const lastControl = lastControlCharAtOrBefore(trimmed, lastBrace)
    if (lastControl !== -1) {
      const repairAt = (at) => tryParseObject(escapeRawControlCharsInStrings(trimmed.slice(at, lastBrace + 1)))
      const first = trimmed.indexOf('{')
      if (first !== -1 && first < lastBrace && first <= lastControl) parsed = repairAt(first)
      let budget = REPAIR_WORK_BUDGET_FACTOR * trimmed.length + REPAIR_WORK_BUDGET_FLOOR
      if (!parsed) {
        for (const at of candidates()) {
          if (at > lastControl || at === first) continue
          budget -= 2 * (lastBrace + 1 - at)
          if (budget < 0) break
          parsed = repairAt(at)
          if (parsed) break
        }
      }
    }
  }

  if (parsed && typeof parsed.text === 'string' && typeof parsed.unknown === 'boolean') {
    const bounded = boundText(parsed.text, maxReplyBytes)
    return {
      structured: true,
      text: bounded.text,
      truncated: bounded.truncated,
      unknown: parsed.unknown,
      citations: asCitationList(parsed.citations),
    }
  }
  const bounded = boundText(stdout, maxReplyBytes)
  return { structured: false, text: bounded.text, truncated: bounded.truncated, unknown: false, citations: [] }
}

/**
 * Rebuild exact text attachments only when consecutive pages from offset 0 or
 * a later start were read under one file version and every page round-tripped
 * to the raw bytes. A mixed or altered set yields nothing for that file.
 */
export function buildArtifacts(calls, maxArtifactBytes) {
  const groups = new Map()
  for (const call of calls) {
    if (call.tool !== 'memory_read_file' || call.outcome?.kind !== 'result') continue
    const verification = call.verification
    if (!verification?.verified) continue
    const record = call.outcome.result
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      typeof record.file !== 'string' ||
      typeof record.content !== 'string' ||
      typeof record.size !== 'number' ||
      typeof record.offset !== 'number' ||
      typeof record.bytes !== 'number'
    ) {
      continue
    }
    if (
      verification.nodeId !== record.id ||
      verification.attachment !== record.file ||
      verification.offset !== record.offset ||
      verification.bytes !== record.bytes ||
      verification.size !== record.size
    ) {
      continue
    }
    const key = `${record.id}\u0000${record.file}`
    let group = groups.get(key)
    if (!group) {
      group = { nodeId: record.id, attachment: record.file, pages: [] }
      groups.set(key, group)
    }
    group.pages.push({
      offset: record.offset,
      bytes: record.bytes,
      text: record.content,
      size: record.size,
      version: verification.version ?? '',
      fileHash: verification.fileHash ?? '',
      nextOffset: typeof record.next_offset === 'number' ? record.next_offset : undefined,
    })
  }
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) return []

  const artifacts = []
  for (const group of groups.values()) {
    const pages = [...group.pages].sort((a, b) => a.offset - b.offset)
    const first = pages[0]
    if (!first || first.version.length === 0) continue
    const prefix = []
    let bytes = 0
    let cursor = first.offset
    for (const page of pages) {
      if (page.version !== first.version || page.size !== first.size || page.fileHash !== first.fileHash) break
      if (page.offset !== cursor) break
      const pageBytes = Buffer.byteLength(page.text, 'utf8')
      if (pageBytes !== page.bytes) break
      if (bytes + pageBytes > maxArtifactBytes) break
      prefix.push(page)
      bytes += pageBytes
      cursor += pageBytes
      if (page.nextOffset === undefined) break
    }
    const last = prefix[prefix.length - 1]
    if (!last) continue
    const text = prefix.map((page) => page.text).join('')
    if (Buffer.byteLength(text, 'utf8') !== bytes) continue
    const complete = last.nextOffset === undefined && cursor === first.size
    artifacts.push({
      nodeId: group.nodeId,
      attachment: group.attachment,
      totalBytes: first.size,
      version: first.version,
      offset: first.offset,
      text,
      complete,
      ...(complete ? {} : { nextOffset: cursor }),
    })
  }
  return artifacts
}

/**
 * What the main agent reads. The reply, then grounded citations, then verbatim
 * attachments, then the writes the child actually made — all from tool
 * records, not from the child's prose.
 */
export function renderDelegation({ parsed, calls, citations, artifacts, stopReason, diagnostic, fenceLatched, maxOutputBytes }) {
  const lines = []
  if (stopReason !== 'completed') {
    lines.push(`Memory agent stopped early (${stopReason}). Treat the reply as partial.${diagnostic ? ` Detail: ${diagnostic}` : ''}`)
  }
  if (!parsed.structured) {
    lines.push('The memory agent did not return the requested JSON reply; its raw text follows and is not a confirmed answer.')
  }
  if (parsed.unknown) lines.push('Memory has no record that answers this (unknown). Do not fill the gap yourself.')
  if (lines.length > 0) lines.push('')
  lines.push(parsed.text + (parsed.truncated ? '\n[reply truncated]' : ''))

  const writes = summarizeWrites(calls)
  if (writes.length > 0) {
    lines.push('', 'Writes made in this delegation (from tool results):')
    for (const write of writes) lines.push(`- ${write}`)
  }
  if (fenceLatched) {
    lines.push('', 'Warning: a write in this delegation had an uncertain or partial effect; later writes were refused. Check the graph before relying on it.')
  }
  if (citations.length > 0) {
    lines.push('', 'Citations (verified against nodes the memory agent read):')
    for (const c of citations) {
      lines.push(`- ${c.nodeId}${c.attachment ? ` / ${c.attachment}` : ''}${c.description ? ` — ${c.description}` : ''}`)
    }
  }
  let content = lines.join('\n')
  for (const artifact of artifacts) {
    const state = artifact.complete ? 'complete' : `continues at offset ${artifact.nextOffset}`
    const section =
      `\n\n--- attachment ${artifact.attachment} (node ${artifact.nodeId}, ${artifact.totalBytes} bytes, version ${artifact.version}, from offset ${artifact.offset}, ${state}) ---\n` +
      `${artifact.text}\n--- end attachment ${artifact.attachment} ---`
    if (Buffer.byteLength(content + section, 'utf8') > maxOutputBytes) {
      content += `\n\n[attachment ${artifact.attachment} on ${artifact.nodeId} omitted: output limit; ask memory_agent to continue it from offset ${artifact.offset}]`
      continue
    }
    content += section
  }
  const bounded = boundText(content, maxOutputBytes)
  return bounded.truncated ? `${bounded.text}\n[output truncated]` : bounded.text
}

function summarizeWrites(calls) {
  const out = []
  for (const call of calls) {
    if (call.tool !== 'memory_write' && call.tool !== 'memory_attach') continue
    if (call.outcome?.kind === 'result') {
      const r = call.outcome.result ?? {}
      const id = typeof r.id === 'string' ? r.id : '?'
      const what = call.tool === 'memory_attach' ? `attached ${r.file ?? r.filename ?? 'a file'} to ${id}` : `${r.created === true ? 'created' : 'wrote'} node ${id}`
      out.push(what)
    } else if (call.outcome?.executionStarted === false) {
      out.push(`${call.tool} refused before running: ${String(call.outcome.error).slice(0, 200)}`)
    } else if (call.outcome?.auditedRefusal) {
      out.push(`${call.tool} refused with nothing written (${call.outcome.auditedRefusal})`)
    } else {
      out.push(`${call.tool} failed; its effect is uncertain: ${String(call.outcome?.error).slice(0, 200)}`)
    }
  }
  return out
}
