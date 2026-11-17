// GENERATED from mexplore_import/src/scope.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * Scope listing for the history import, ported from a reference importer `history_import/onboard_scan.py`:
 * projects (worktrees rolled up, home prefix shown as ~), private / mixed flags, units, sessions, KB,
 * dates, months, auto-excluded counts and the redaction preview (counts only, never values).
 *
 * @module mexplore-import/scope
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { convert, sessionFiles } from './convert.js'
import { expandHome } from './redact.js'
import { unitKb } from './estimate.js'

export const SCOPE_DEFAULTS = Object.freeze({
  projectsDir: '~/.claude/projects',
  worktreeMarker: '--claude-worktrees-',
  privateNamePatterns: ['^-private-', '(?i)personal', '(?i)private'],
  mixedLabelPatterns: ['^~$', '^~-Documents', '^~-Desktop', '^~-Downloads'],
  personalKeywords: ['travel', 'hotel', 'visa', '旅行', '酒店', '机票', '火车票', '签证', '出行'],
})

const NOISE = {
  user_entries_noise_meta: 'skill/command expansions',
  user_entries_noise_compact_summary: 'compaction summaries',
  'user_entries_noise_origin_task-notification': 'background task notifications',
  user_entries_noise_origin_peer: 'messages from other sessions',
  user_entries_noise_wrapper: 'local command / hook wrappers',
  user_entries_noise_slash_command: 'slash commands without arguments',
  user_entries_tool_result: 'tool results (not new turns)',
  duplicate_entries_skipped: 'duplicates from resumed or forked sessions',
  turns_dropped_short: 'turns in segments too short at day end',
  segments_still_open: 'segments still open at scan time (not imported yet)',
}
const INFLATED = { opaque_secret: 'mostly file paths', long_hex: 'mostly hashes and ids' }

/** Python-style pattern ("(?i)" prefix) -> RegExp. */
const toRe = (p) => (p.startsWith('(?i)') ? new RegExp(p.slice(4), 'i') : new RegExp(p))

export const homePrefix = () => os.homedir().replace(/[^A-Za-z0-9]/g, '-')

export function projectLabel(dirName, worktreeMarker, nameFlags = []) {
  if (nameFlags.length) return `[flagged] ${nameFlags[0]}`
  const name = worktreeMarker ? dirName.split(worktreeMarker)[0] : dirName
  const prefix = homePrefix()
  if (name === prefix) return '~'
  if (name.startsWith(`${prefix}-`)) return `~${name.slice(prefix.length)}`
  return name
}

/** {dirName: {dir, label, sessionFiles, subagentFiles, stems, flags}} */
export function discover(cfg) {
  const root = expandHome(cfg.projectsDir)
  const priv = cfg.privateNamePatterns.map((p) => [p, toRe(p)])
  const mixed = cfg.mixedLabelPatterns.map((p) => [p, toRe(p)])
  const out = {}
  let names = []
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const dir = path.join(root, name)
    if (!fs.statSync(dir).isDirectory()) continue
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    let subagents = 0
    for (const sub of fs.readdirSync(dir)) {
      const sa = path.join(dir, sub, 'subagents')
      if (fs.existsSync(sa) && fs.statSync(sa).isDirectory()) subagents += fs.readdirSync(sa).filter((f) => f.endsWith('.jsonl')).length
    }
    const nameFlags = priv.filter(([, re]) => re.test(name)).map(([p]) => `name:${p}`)
    const label = projectLabel(name, cfg.worktreeMarker, nameFlags)
    const flags = [...nameFlags, ...mixed.filter(([, re]) => re.test(label)).map(([p]) => `mixed:${p}`)]
    out[name] = { dir, label, sessionFiles: files.length, subagentFiles: subagents, stems: files.map((f) => f.slice(0, -6)), flags }
  }
  return out
}

/** A user (or agent) may name a project by its label, its label without the leading ~, or its folder name. */
const names = (name, p) => new Set([p.label, p.label.replace(/^~/, ''), name])
const matches = (list, name, p) => list.some((x) => names(name, p).has(x))

export function selectedDirs(projects, sel) {
  return Object.entries(projects)
    .filter(([name, p]) => {
      if (sel.projects && sel.projects !== 'all' && !matches(sel.projects, name, p)) return false
      if (matches(sel.excludeProjects ?? [], name, p)) return false
      if (sel.excludeNameFlagged !== false && p.flags.some((f) => f.startsWith('name:'))) return false
      return true
    })
    .map(([name]) => name)
}

export const inWindow = (u, sel) => (!sel.fromDay || u.day >= sel.fromDay) && (!sel.throughDay || u.day <= sel.throughDay)

/**
 * Scan: listing over every project, then the selected units (convert run on exactly the selected files,
 * because uuid dedupe is global across files). Returns {listing, units, counts}.
 */
export function scan(cfg, sel, now) {
  const projects = discover(cfg)
  const byStem = new Map()
  for (const [name, p] of Object.entries(projects)) for (const s of p.stems) byStem.set(s, name)
  const labelOf = (u) => projects[byStem.get(u.session_id)]?.label ?? '(unmapped)'
  const allFiles = sessionFiles(cfg.projectsDir, [])
  const all = convert(cfg, now, allFiles)
  const kw = cfg.personalKeywords.length ? new RegExp(cfg.personalKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null
  const flagged = new Set(kw ? all.turns.filter((t) => kw.test(t.user)).map((t) => t.session_id) : [])
  const rows = new Map()
  const row = (label) => {
    if (!rows.has(label)) rows.set(label, { project: label, flags: new Set(), dirs: 0, sessionFiles: 0, subagentFiles: 0, sessions: new Set(), units: 0, kb: 0, firstDay: null, lastDay: null, keywordSessions: new Set() })
    return rows.get(label)
  }
  for (const p of Object.values(projects)) {
    const r = row(p.label)
    r.dirs += 1
    r.sessionFiles += p.sessionFiles
    r.subagentFiles += p.subagentFiles
    p.flags.forEach((f) => r.flags.add(f))
  }
  for (const u of all.units) {
    const r = row(labelOf(u))
    r.sessions.add(u.session_id)
    r.units += 1
    r.kb += unitKb(u)
    r.firstDay = !r.firstDay || u.day < r.firstDay ? u.day : r.firstDay
    r.lastDay = !r.lastDay || u.day > r.lastDay ? u.day : r.lastDay
    if (flagged.has(u.session_id)) r.keywordSessions.add(u.session_id)
  }
  const listing = [...rows.values()]
    .map((r) => ({ ...r, flags: [...r.flags].sort(), sessions: r.sessions.size, keywordSessions: r.keywordSessions.size, kb: Math.round(r.kb * 10) / 10 }))
    .filter((r) => r.sessionFiles > 0)
    .sort((a, b) => b.units - a.units || (a.project < b.project ? -1 : 1))

  const names = selectedDirs(projects, sel)
  const files = sessionFiles(cfg.projectsDir, [], new Set(names))
  const picked = convert(cfg, now, files)
  let units = picked.units.filter((u) => inWindow(u, sel))
  if (sel.excludeKeywordSessions) units = units.filter((u) => !flagged.has(u.session_id))
  const months = new Map()
  for (const u of units) {
    const m = months.get(u.day.slice(0, 7)) ?? { month: u.day.slice(0, 7), units: 0, sessions: new Set(), kb: 0 }
    m.units += 1
    m.sessions.add(u.session_id)
    m.kb += unitKb(u)
    months.set(m.month, m)
  }
  // What is masked in exactly the text that will be sent: markers in the selected units.
  const preview = {}
  for (const u of units) {
    for (const m of u.text.matchAll(/\[REDACTED:([a-z_]+)/g)) preview[m[1]] = (preview[m[1]] ?? 0) + 1
  }
  return {
    listing,
    selectedDirs: names.sort(),
    units,
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({ ...m, sessions: m.sessions.size, kb: Math.round(m.kb * 10) / 10 })),
    // Counted over the selected project folders (all dates), before the date window.
    autoExcluded: {
      'subagent transcript files': names.reduce((s, n) => s + projects[n].subagentFiles, 0),
      'project folders left out by the selection': Object.keys(projects).length - names.length,
      ...Object.fromEntries(Object.entries(NOISE).map(([k, d]) => [d, picked.counts[k] ?? 0])),
    },
    redactionPreview: Object.entries(preview).sort((a, b) => b[1] - a[1]).map(([kind, hits]) => ({ kind, hits, note: INFLATED[kind] ?? '' })),
    keywordFlaggedSessions: flagged.size,
  }
}
