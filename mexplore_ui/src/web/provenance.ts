// Write-session provenance, shaped for the node panel: who created the Node, what changed last, and the full
// history grouped by the chat that made each write. Pure functions; the components live in graph/ProvenanceView.
import type {
  NodeProvenance,
  ProvenanceActor,
  ProvenanceEntry,
  ProvenanceHost,
  ProvenanceReason,
} from '../shared/types.ts'
import { DICTIONARIES, type MsgKey } from './i18n.ts'

export interface ProvenanceGroup {
  /** `s:<session>` for a known chat; null-session lines share a group per actor/host/reason. */
  key: string
  session: string | null
  host: ProvenanceHost
  actor: ProvenanceActor
  reason: ProvenanceReason | null
  /** Newest first. */
  entries: ProvenanceEntry[]
  firstTs: string
  lastTs: string
}

export interface ProvenanceSummary {
  /** The oldest recorded line; `created` says whether it is the creation itself. */
  origin: ProvenanceEntry | null
  created: boolean
  /** The newest line; null when it is the origin (a single-line history). */
  latest: ProvenanceEntry | null
  /** Most recent activity first. */
  groups: ProvenanceGroup[]
  total: number
  /** Distinct known chat sessions. */
  chats: number
}

function time(entry: ProvenanceEntry): number {
  const ms = Date.parse(entry.ts)
  return Number.isNaN(ms) ? 0 : ms
}

export function groupKey(entry: ProvenanceEntry): string {
  return entry.session !== null ? `s:${entry.session}` : `n:${entry.actor}:${entry.host}:${entry.reason ?? ''}`
}

/** Every line the server returned, oldest first (stable by timestamp: appends are lock-free, so file order can jitter). */
export function provenanceEntries(p: NodeProvenance): ProvenanceEntry[] {
  const all = p.first ? [p.first, ...p.entries] : [...p.entries]
  return all.map((entry, index) => ({ entry, index })).sort((a, b) => time(a.entry) - time(b.entry) || a.index - b.index).map((x) => x.entry)
}

export function summarizeProvenance(p: NodeProvenance): ProvenanceSummary {
  const sorted = provenanceEntries(p)
  // A truncated file's first line comes back separately; it is the oldest record whatever its timestamp says.
  const origin = p.first ?? sorted[0] ?? null
  const newest = sorted[sorted.length - 1] ?? null
  const byKey = new Map<string, ProvenanceGroup>()
  for (const entry of sorted) {
    const key = groupKey(entry)
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        session: entry.session,
        host: entry.host,
        actor: entry.actor,
        reason: entry.reason ?? null,
        entries: [],
        firstTs: entry.ts,
        lastTs: entry.ts,
      }
      byKey.set(key, group)
    }
    group.entries.unshift(entry)
    group.lastTs = entry.ts
  }
  const groups = [...byKey.values()].sort((a, b) => time(b.entries[0]!) - time(a.entries[0]!))
  return {
    origin,
    created: origin?.op === 'create',
    latest: newest !== null && newest !== origin ? newest : null,
    groups,
    total: sorted.length,
    chats: groups.filter((g) => g.session !== null).length,
  }
}

/** The message for a line or group without a session id: the stored reason, shown honestly. */
export function nullReasonKey(x: { actor: ProvenanceActor; reason?: ProvenanceReason | null }): MsgKey {
  if (x.actor === 'import' || x.reason === 'import') return 'prov.reason.import'
  return x.reason ? (`prov.reason.${x.reason}` as MsgKey) : 'prov.reason.unknown'
}

export function hostKey(host: ProvenanceHost): MsgKey {
  return `prov.host.${host}` as MsgKey
}

/** A translatable op key, or null for an op this UI does not know (shown verbatim). */
export function opKey(op: string): MsgKey | null {
  const key = `prov.op.${op}`
  return key in DICTIONARIES.en ? (key as MsgKey) : null
}
