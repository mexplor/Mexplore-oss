/**
 * Importer v2 delegation for one unit or one M1 batch, ported from a reference importer
 * `history_import/request-v2.mjs`: the evidence is exactly build-request.mjs's (one entry per message,
 * role kept, sourceId <turn_id>:<role>, date = unit day, complete flag); the message reads like a live
 * assistant handing its latest conversation over for memory upkeep — no session id, no part numbers,
 * none of our text says evidence, unit, part, import or replay — plus one sentence asking not to record
 * third parties' personal information.
 *
 * @module mexplore-import/request
 */

import { splitTurns, unitEvidence } from './estimate.js'

export const PII_RULE =
  "Do not record other people's personal information (a name together with private details, contact info, finances, health or HR matters); work facts are fine."
const ASK = 'Please save to memory what is worth keeping long-term: durable decisions, preferences and outcomes.'
const V1_HEADER =
  /^Conversation dated (\d{4}-\d{2}-\d{2}) \(Claude Code session \S+ in (.*), part \d+ of that session(?:, part \d+\/\d+ of that day)?\)\.?$/

/** Project label for a working directory: the repo for a worktree folder, 'home directory' for home. */
export function projectName(cwd) {
  let p = (cwd ?? '').trim().replace(/\/+$/, '')
  if (!p) return null
  const wt = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees|worktrees)\/[^/]+(?:\/.*)?$/.exec(p)
  if (wt) p = wt[1]
  if (/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|~)$/.test(p)) return 'home directory'
  return p.split('/').pop() || null
}

const clock = (iso) => iso.slice(11, 16)

/** "Conversation on <day> from HH:MM to HH:MM (UTC+8) in the <project> project". */
export function agentHeader(unit) {
  const { header } = splitTurns(unit.text)
  const m = V1_HEADER.exec(header)
  if (!m) throw new Error(`${unit.unit_id}: unexpected header shape`)
  const end = unit.ended_at.slice(0, 10) === unit.day ? clock(unit.ended_at) : `${clock(unit.ended_at)} the next day`
  const project = projectName(m[2])
  const where = project === null ? '' : project === 'home directory' ? ' in the home directory' : ` in the ${project} project`
  return `Conversation on ${unit.day} from ${clock(unit.started_at)} to ${end} (UTC+8)${where}`
}

/** {message, authority, evidence} for one item: one unit, or one same-day M1 batch. */
export function itemRequest(units) {
  if (units.length === 0) throw new Error('empty item')
  if (new Set(units.map((u) => u.day)).size !== 1) throw new Error('an item spans several days')
  if (units.length === 1) {
    return {
      message: `Here is my latest conversation with the user, for memory upkeep. ${agentHeader(units[0])}. It follows in order, one entry per message. ${ASK} ${PII_RULE}`,
      authority: 'manage',
      evidence: unitEvidence(units[0]).evidence,
    }
  }
  const headers = []
  const ranges = []
  const evidence = []
  for (const u of units) {
    const own = unitEvidence(u).evidence
    headers.push(agentHeader(u))
    ranges.push([evidence.length + 1, evidence.length + own.length])
    evidence.push(...own)
  }
  const list = headers.map((h, i) => `(${i + 1}) ${h}: entries ${ranges[i][0]}-${ranges[i][1]}`).join('; ')
  return {
    message: `Here are my conversations with the user from today, for memory upkeep: ${headers.length} in time order, one entry per message: ${list}. ${ASK} ${PII_RULE}`,
    authority: 'manage',
    evidence,
  }
}
