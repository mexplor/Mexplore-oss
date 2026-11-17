// GENERATED from mexplore_import/src/tools.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * The eight history_* tools as data: names, descriptions, parameter schemas, and the compact JSON
 * each one returns to the agent (counts and ids, never conversation text). Hosts register them in
 * their own way; `createImportCore` (index.js) binds them to a job.
 *
 * @module mexplore-import/tools
 */

import { MODE_NAMES } from './estimate.js'

export const TOOLS = Object.freeze([
  'history_scan',
  'history_estimate',
  'history_confirm',
  'history_plan',
  'history_import_batch',
  'history_status',
  'history_rollback',
  'history_report',
])

export const DESCRIPTIONS = Object.freeze({
  history_scan: 'History import step 1: scan Claude Code history on this machine and list the scope (projects, months, flags, exclusions, redaction preview). Optional selection narrows it. Returns counts and a digest, never conversation text.',
  history_estimate: 'History import: estimate delegations, hours and cost for both modes, and whether to ask the user to choose a mode (「按天合并导入」 / batched by day is recommended when 「逐段导入」 / one segment at a time would take >= 2 h). Name the modes to the user only by modePrompt.names, never by their ids.',
  history_confirm: 'History import: record a confirmation the USER gave (gate scope | privacy | mode | start | resume), with the digest of what they were shown and their own words. Only call this after the user explicitly agreed.',
  history_plan: 'History import: build the plan from the confirmed scope (and mode). Returns the plan digest the user must confirm with gate "start".',
  history_import_batch: 'History import: import the next batch (a few delegations, a few minutes) into the live memory graph through the memory agent, after a whole-graph snapshot. Call again until done.',
  history_status: 'History import: where the import stands (confirmations, progress, stop, lock, backups).',
  history_rollback: 'History import: restore the WHOLE memory graph to the snapshot before the last batch (to: "last_batch") or to the backup before the import (to: "before_import"). Refuses and lists other sessions’ writes that would be lost unless confirmForeign is true (only after the user agreed). The current state is kept as a backup.',
  history_report: 'History import: final report (per month, nodes, rollbacks, maintenance note, recommendation).',
})

/** Hosts without approval cards: the rollback also names the foreign nodes the user agreed to lose. */
const ROLLBACK_NO_CARDS = 'History import: restore the WHOLE memory graph to the snapshot before the last batch (to: "last_batch") or to the backup before the import (to: "before_import"). Refuses and lists other sessions’ writes that would be lost, with a foreignDigest; to discard them, show the list in the chat and, only after the user agreed to lose exactly those, call again with confirmForeign: true and that foreignDigest. The current state is kept as a backup.'

const SELECTION = {
  projects: { type: 'array', items: { type: 'string' }, description: 'project labels from the scan; omit for all' },
  excludeProjects: { type: 'array', items: { type: 'string' } },
  fromDay: { type: 'string', description: 'YYYY-MM-DD' },
  throughDay: { type: 'string', description: 'YYYY-MM-DD' },
  excludeKeywordSessions: { type: 'boolean' },
  excludeNameFlagged: { type: 'boolean', description: 'default true' },
}

const empty = () => ({ type: 'object', additionalProperties: false, properties: {} })

export const PARAMETERS = Object.freeze({
  history_scan: { type: 'object', additionalProperties: false, properties: SELECTION },
  history_estimate: empty(),
  history_confirm: {
    type: 'object',
    additionalProperties: false,
    required: ['gate', 'digest', 'userSaid'],
    properties: {
      gate: { type: 'string', enum: ['scope', 'privacy', 'mode', 'start', 'resume'] },
      digest: { type: 'string', description: 'the digest (or stop id) of what the user was shown' },
      choice: { type: 'string', description: 'mode: full_replay (逐段导入) | m1 (按天合并导入), ids not to be said to the user; start: approve_all_writes (only when the plan has writeApproval and the user approved all writes); resume: one of the stop options' },
      userSaid: { type: 'string', description: 'the user’s own words, summarized' },
    },
  },
  history_plan: empty(),
  history_import_batch: empty(),
  history_status: empty(),
  history_rollback: {
    type: 'object',
    additionalProperties: false,
    properties: {
      to: { type: 'string', enum: ['last_batch', 'before_import'] },
      confirmForeign: { type: 'boolean', description: 'true only after the user agreed to lose the listed foreign writes' },
    },
  },
  history_report: empty(),
})

/** Description and parameters of one tool for a host that can ('supported') or cannot show cards. */
export function toolSchema(name, cards = 'supported') {
  if (name === 'history_rollback' && cards === 'unsupported') {
    const p = PARAMETERS.history_rollback
    return {
      description: ROLLBACK_NO_CARDS,
      parameters: { ...p, properties: { ...p.properties, foreignDigest: { type: 'string', description: 'the foreignDigest of the foreign nodes the user agreed, in the chat, to lose' } } },
    }
  }
  return { description: DESCRIPTIONS[name], parameters: PARAMETERS[name] }
}

// ---------------------------------------------------------------- what each tool returns

/** Compact JSON the agent reads; large listings are trimmed to what the user needs to see. */
export function summarizeScan(s) {
  return {
    digest: s.digest,
    selection: s.selection,
    units: s.unitIds.length,
    alreadyImported: s.alreadyImported,
    alreadyPartial: s.alreadyPartial ?? 0,
    existingNodes: s.existingNodes,
    projects: s.listing.map((r) => ({ project: r.project, flags: r.flags, sessions: r.sessions, units: r.units, kb: r.kb, firstDay: r.firstDay, lastDay: r.lastDay, keywordSessions: r.keywordSessions })),
    selectedMonths: s.months,
    autoExcluded: s.autoExcluded,
    redactionPreview: s.redactionPreview,
  }
}

export function summarizeEstimate(e) {
  return { digest: e.digest, units: e.units, turns: e.turns, unitTextKb: e.unitTextKb, modes: e.modes, modePrompt: e.modePrompt, coefficients: e.coefficients }
}

/** The plan as the agent shows it: the mode by its user-facing name (modeName), never only its id. */
export function summarizePlan(p) {
  return { digest: p.digest, mode: p.mode, modeName: p.modeName ?? MODE_NAMES[p.mode], units: p.units, delegations: p.delegations, estimate: p.estimate, graphRoot: p.graphRoot, notice: p.notice, writeApproval: p.writeApproval }
}
