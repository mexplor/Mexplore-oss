// GENERATED from mexplore_import/src/source.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * Where the conversations to import come from. This version has one source, the Claude Code history
 * on this machine (`~/.claude/projects`); later sources (OpenCode's own sessions, a ChatGPT export)
 * implement the same interface and are passed to the job as `source` (design 26110900 §3.5, Q6).
 *
 * @typedef {object} HistorySource
 * @property {string} id      stable id, e.g. "claude-code"
 * @property {string} label   what the user is told the history comes from
 * @property {(config: object, selection: object, nowEpoch: number) => SourceScan} scan
 *   list the sessions, read the selected ones into units (`mexplor-unit-v1`, redacted) and describe
 *   the scope; must never return conversation text outside `units`
 *
 * @typedef {object} SourceScan
 * @property {object[]} units          the selected units, in import order
 * @property {object[]} listing        per project: sessions, units, kb, days, flags
 * @property {string[]} selectedDirs
 * @property {object[]} months
 * @property {object} autoExcluded
 * @property {object[]} redactionPreview hits per kind, never values
 * @property {number} keywordFlaggedSessions
 *
 * @module mexplore-import/source
 */

import { scan } from './scope.js'

/** Claude Code history (`projectsDir`, default ~/.claude/projects). */
export const claudeCodeSource = Object.freeze({ id: 'claude-code', label: 'Claude Code', scan })
