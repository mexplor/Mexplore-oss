/**
 * The history import job: scan -> estimate -> four confirmation gates -> plan -> batches -> report,
 * with whole-graph snapshots and rollback (reference design:
 * snapshot-and-rollback pipeline).
 *
 * State lives beside the graph in `<graphRoot>.history-import/` (0700): scan.json, estimate.json,
 * plan.json, confirmations.json, cursor.json, imported.json, units/ (0600; conversation text, never
 * leaves this machine except to the model), snapshots/batch-<n>/, backups/, history/ (finished
 * imports), lock/.
 *
 * Rules:
 *   - every confirmation carries the digest of what the user saw; a changed scan, estimate or plan
 *     invalidates it; with the memory agent's approveWrites on, gate "start" must also say "approve all
 *     writes for this import";
 *   - the import writes into the LIVE graph (the memory agent's graphRoot);
 *   - a full backup before the first batch, a whole-graph snapshot before every batch; manifests are
 *     taken from the copies themselves, never from the live graph;
 *   - attribution (what the import wrote vs. another session): a node is the import's own only if the
 *     import CREATED it; a pre-existing node the import updated, superseded or attached to is its own
 *     only while its content still has the hash the import last recorded; an edge is own only if the
 *     import made that link; an `.edge-types` sidecar only while it has the hash the import recorded;
 *     everything else that changed is foreign;
 *   - a problem (a delegation that threw, timed out, was cancelled, stopped early, latched the write
 *     fence, or ended without a parsable reply and without writes; or a batch interrupted by a restart)
 *     rolls the graph back to the batch's snapshot and reruns the batch once — only when nothing foreign
 *     changed; otherwise it stops and lists the foreign changes for the user to decide;
 *   - a rollback never touches `.locks/` and keeps the live bookkeeping (`.access/`, `.provenance/`,
 *     `.advisories*`, `.zero-write-turns`, `MAP.md`, `.maintain*`): these only grow or are regenerated, so
 *     the live copy already holds everything the snapshot had; files only in the snapshot are kept too.
 *     LOSS WINDOW (documented, not closed): `restore` copies the live `.provenance/` into the staging tree
 *     and only then swaps (see the copy loop below), so a line appended AFTER that copy and BEFORE the
 *     final rename stays only in the replaced tree, which is moved whole into `backups/` — the restored
 *     live log does not have it. Recovery for such a line is from that backup alone; the rollback does not
 *     replay it. Import backups and snapshots are full graph copies, so they CONTAIN session ids;
 *   - a rollback is a staged swap (clone the snapshot beside the graph, then two renames); the tree it
 *     replaces is moved, whole, into backups/ — nothing that landed is deleted; a crash at any phase is
 *     finished or undone on the next call;
 *   - unknown replies with landed writes count as passing; >= 3 of them AND > 10% of a month's items stop.
 *
 * @module mexplore-import/job
 */

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { expandHome } from './redact.js'
import { COEFFICIENTS, estimate, M1_DEFAULTS, MODE_NAMES, MODE_PROMPT_DEFAULTS, predict, unitKb } from './estimate.js'
import { itemRequest } from './request.js'
import { SCOPE_DEFAULTS } from './scope.js'
import { claudeCodeSource } from './source.js'
import { GRAPH_TOO_LARGE, NOTICE } from './texts.js'
import { DEFAULTS as CONVERT_DEFAULTS } from './convert.js'

export const JOB_DEFAULTS = Object.freeze({
  batchSize: 5,
  maxBatchMinutes: 8,
  envFiles: [],
  unknownRule: { minCount: 3, rate: 0.1 },
  maxExistingNodes: 20,
})

export { GRAPH_TOO_LARGE, NOTICE }

export const APPROVE_ALL = 'approve_all_writes'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
/** Bookkeeping kept from the live graph on a rollback; never evidence of a foreign write by itself. */
const BOOKKEEPING = /^(?:\.access(?:\/|$)|\.provenance(?:\/|$)|\.advisories|\.locks(?:\/|$)|\.zero-write-turns|\.maintain|MAP\.md$)/
const KEEP_LIVE_TOP = /^(?:\.access|\.provenance|\.advisories.*|\.zero-write-turns|\.maintain.*|MAP\.md)$/
const EDGE_TYPES = '.edge-types'

export const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
/** Short digest of a set of foreign nodes ({id} rows): what the user agreed to lose, in the chat. */
export const foreignDigest = (foreign) => digest(foreign.map((f) => f.id).sort()).slice(0, 12)
const now = () => new Date().toISOString()
const stamp = () => now().replace(/[:.]/g, '-')

export class HistoryError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

// ---------------------------------------------------------------- files

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback
    throw error
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function cloneTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 })
  try {
    execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'ignore' })
  } catch {
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  }
}

/** {relative path: sha256 | "link:<target>"} for every file and symlink (symlinks not followed). */
export function manifest(root) {
  const out = {}
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`
      else if (e.isDirectory()) walk(full)
      else if (e.isFile()) out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

/** Hash of a node's own content (everything under <id>/ except its __edges__/), from a manifest. */
export function nodeHash(m, id) {
  const prefix = `${id}/`
  const rows = Object.keys(m)
    .filter((p) => p.startsWith(prefix) && !p.startsWith(`${prefix}__edges__/`))
    .sort()
    .map((p) => [p, m[p]])
  return rows.length ? digest(rows) : null
}

/** The same hash read from the live graph for one node. */
function liveNodeHash(root, id) {
  const sub = manifest(path.join(root, id))
  const m = Object.fromEntries(Object.entries(sub).map(([k, v]) => [`${id}/${k}`, v]))
  return nodeHash(m, id)
}

function fileHash(file) {
  try {
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * What the import wrote, recorded AT EACH WRITE (agent-tools write hooks, see `writeHooks`):
 *   hashes        node id -> content hash right after the import's latest write to it (created or not)
 *   foreignTouched node ids whose content had changed since the snapshot (or since the import's own
 *                 previous write) when the import was about to write them: someone else wrote first
 *   links         "X|Y" edges the import made (both directions)
 *   sidecars      `<id>/__edges__/.edge-types` -> hash right after the import's write
 *   created       ids the import created (for reports)
 */
export const emptyTouch = () => ({ created: [], hashes: {}, foreignTouched: [], links: [], sidecars: {} })

/** Targets a write is about to change: memory_write {id, supersedes}, memory_attach {id}. */
function writeTargets(tool, args) {
  const out = []
  if (typeof args?.id === 'string' && ULID_RE.test(args.id)) out.push(args.id)
  if (tool === 'memory_write' && typeof args?.supersedes === 'string' && ULID_RE.test(args.supersedes)) out.push(args.supersedes)
  return out
}

/**
 * Hooks the delegation's tools call before and after every write (agent-tools.js executeRecorded):
 * before — any target whose content is not what the snapshot (or the import's own last write) left is
 * marked foreign-touched; after — the post-write content hash of every node the write changed, the
 * edges it made, and the sidecars it touched. `snapManifest` is the batch snapshot's manifest.
 */
export function writeHooks(touch, root, snapManifest, onChange = () => {}) {
  const foreignTouched = new Set(touch.foreignTouched)
  return {
    beforeWrite({ tool, args }) {
      for (const id of writeTargets(tool, args)) {
        const expected = touch.hashes[id] !== undefined ? touch.hashes[id] : nodeHash(snapManifest, id)
        if (liveNodeHash(root, id) !== expected) foreignTouched.add(id)
      }
      touch.foreignTouched = [...foreignTouched]
    },
    afterWrite({ tool, args, result }) {
      if (!result || typeof result !== 'object') return
      const ids = new Set(writeTargets(tool, args))
      if (typeof result.id === 'string' && ULID_RE.test(result.id)) ids.add(result.id)
      if (typeof result.superseded?.id === 'string') ids.add(result.superseded.id)
      if (result.created === true && typeof result.id === 'string') touch.created = [...new Set([...touch.created, result.id])]
      const linked = Array.isArray(result.links) ? result.links.filter((l) => l && ['created', 'exists'].includes(l.status ?? 'created')).map((l) => l.to).filter((x) => typeof x === 'string') : []
      const links = new Set(touch.links)
      for (const to of [...linked, ...(result.superseded?.id ? [result.superseded.id] : [])]) {
        links.add(`${result.id}|${to}`)
        links.add(`${to}|${result.id}`)
      }
      touch.links = [...links]
      for (const id of ids) touch.hashes[id] = liveNodeHash(root, id)
      for (const id of new Set([...ids, ...linked])) {
        const sidecar = `${id}/__edges__/${EDGE_TYPES}`
        const h = fileHash(path.join(root, sidecar))
        if (h !== null) touch.sidecars[sidecar] = h
      }
      onChange()
    },
  }
}

export function mergeTouches(list) {
  const out = emptyTouch()
  for (const t of list) {
    if (!t) continue
    out.created = [...new Set([...out.created, ...(t.created ?? [])])]
    out.links = [...new Set([...out.links, ...(t.links ?? [])])]
    out.foreignTouched = [...new Set([...out.foreignTouched, ...(t.foreignTouched ?? [])])]
    Object.assign(out.hashes, t.hashes ?? {})
    Object.assign(out.sidecars, t.sidecars ?? {})
  }
  return out
}

/**
 * Changes from `before` (the snapshot's manifest) to `after` (the live manifest), split into the
 * import's own and foreign ones. A node's content is the import's own only if the import recorded a
 * post-write hash for it, nobody wrote it before the import did, and it still has that hash. Edges:
 * only links the import made. Sidecars: only while they have the hash recorded after the import's write.
 * Bookkeeping is skipped (kept live on restore).
 */
export function attributeChanges(before, after, touch) {
  const links = new Set(touch.links)
  const foreignTouched = new Set(touch.foreignTouched ?? [])
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort()
  const foreign = []
  let own = 0
  const hashCache = new Map()
  const currentHash = (id) => {
    if (!hashCache.has(id)) hashCache.set(id, nodeHash(after, id))
    return hashCache.get(id)
  }
  for (const p of changed) {
    if (BOOKKEEPING.test(p)) continue
    const parts = p.split('/')
    const node = parts[0]
    let mine = false
    if (parts.length === 1) mine = false
    else if (parts[1] === '__edges__') {
      if (parts[2] === EDGE_TYPES) mine = touch.sidecars[p] !== undefined && touch.sidecars[p] === (after[p] ?? null)
      else mine = links.has(`${node}|${parts[2]}`)
    } else mine = !foreignTouched.has(node) && touch.hashes[node] !== undefined && touch.hashes[node] === currentHash(node)
    if (mine) own += 1
    else foreign.push(p)
  }
  return { changed: changed.length, own, foreign, foreignNodes: [...new Set(foreign.map((p) => p.split('/')[0]))] }
}

function describe(roots, id) {
  for (const root of roots) {
    try {
      const m = /^description:\s*(.*)$/m.exec(fs.readFileSync(path.join(root, id, 'node.md'), 'utf8'))
      if (m) return m[1].slice(0, 160)
    } catch {
      // try the next root
    }
  }
  return null
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// ---------------------------------------------------------------- the job

/** Batches and rollbacks running in this process, by graph root: one at a time per graph. */
const running = new Set()

const freshCursor = () => ({ started: false, next: 0, items: [], batches: [], rollbacks: [], stop: null, ackedMonths: [], skipped: [], decisions: [] })

export class HistoryJob {
  /**
   * @param {object} opts
   * @param {string} opts.graphRoot  the memory agent's graph (the LIVE graph)
   * @param {object} [opts.config]   row config: projectsDir, envFiles, batchSize, costModel, ...
   * @param {boolean} [opts.approveWrites]  the memory agent's approveWrites setting
   * @param {object} [opts.hooks]    tests only: {crashAt(phase)} to simulate a crash inside a rollback
   * @param {import('./source.js').HistorySource} [opts.source]  where the conversations come from (Claude Code history)
   */
  constructor({ graphRoot, config = {}, approveWrites = false, hooks = {}, source = claudeCodeSource }) {
    this.graphRoot = path.resolve(expandHome(graphRoot))
    this.config = { ...SCOPE_DEFAULTS, ...CONVERT_DEFAULTS, ...JOB_DEFAULTS, ...config }
    this.costModel = { ...COEFFICIENTS, ...(config.costModel ?? {}) }
    this.m1 = { ...M1_DEFAULTS, maxEvidence: this.config.maxEvidence, ...(config.m1 ?? {}) }
    this.modePrompt = { ...MODE_PROMPT_DEFAULTS, ...(config.modePrompt ?? {}) }
    this.dir = path.resolve(expandHome(config.stateDir ?? `${this.graphRoot}.history-import`))
    this.approveWrites = approveWrites
    this.hooks = hooks
    this.source = source
  }

  p(...parts) {
    return path.join(this.dir, ...parts)
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  confirmations() {
    return readJson(this.p('confirmations.json'), {})
  }

  cursor() {
    return readJson(this.p('cursor.json'), null)
  }

  saveCursor(cur) {
    writeJson(this.p('cursor.json'), cur)
  }

  // ---------------------------------------------------------- 1-2: scan and scope

  scan(selection = {}) {
    if (running.has(this.graphRoot)) throw new HistoryError('busy', 'a batch or rollback is running for this graph')
    this.lock()
    try {
      this.recoverRollback()
      return this.scanLocked(selection)
    } finally {
      this.unlock()
    }
  }

  /** Live nodes of the graph (id + description). */
  existingNodes() {
    if (!fs.existsSync(this.graphRoot)) return []
    return fs.readdirSync(this.graphRoot)
      .filter((d) => ULID_RE.test(d) && fs.existsSync(path.join(this.graphRoot, d, 'node.md')))
      .sort()
      .map((id) => ({ id, description: describe([this.graphRoot], id) }))
  }

  /** Precondition (this version): the live graph is empty or small. Checked at scan, plan and the first batch. */
  checkGraphSize() {
    const nodes = this.existingNodes()
    const max = this.config.maxExistingNodes
    if (nodes.length > max) {
      throw new HistoryError('graph_too_large', GRAPH_TOO_LARGE.replaceAll('{max}', String(max)).replaceAll('{n}', String(nodes.length)), { existingNodes: nodes.length, maxExistingNodes: max })
    }
    return nodes
  }

  /** The nodes the user saw at gate 1 must still be the graph's nodes (same ids, not only the same count). */
  checkExistingIds(existing, shown) {
    const now_ = existing.map((n) => n.id).sort().join()
    if (now_ !== [...(shown ?? [])].sort().join()) {
      throw new HistoryError('existing_nodes_changed', 'the graph’s existing nodes changed since the user saw them at gate 1; scan again and show the new list')
    }
  }

  scanLocked(selection) {
    const existing = this.checkGraphSize()
    const cur = this.cursor()
    if (cur?.started && !cur.finished) throw new HistoryError('import_started', 'an import into this graph is in progress; finish it, stop it, or roll it back before scanning a new scope')
    if (cur?.finished) this.archive(cur)
    this.ensureDir()
    const sel = { excludeNameFlagged: true, ...selection }
    const nowEpoch = this.config.now ? Date.parse(this.config.now) / 1000 : Date.now() / 1000
    const res = this.source.scan(this.config, sel, nowEpoch)
    // Partially imported units (their partial writes were kept) are skipped like imported ones.
    const rec = readJson(this.p('imported.json'), { unitIds: [] })
    const imported = new Set([...rec.unitIds, ...(rec.partial ?? [])])
    const units = res.units.filter((u) => !imported.has(u.unit_id))
    const unitsDir = this.p('units')
    fs.rmSync(unitsDir, { recursive: true, force: true })
    fs.mkdirSync(unitsDir, { recursive: true, mode: 0o700 })
    for (const u of units) {
      const { _closed_at: _c, _start_ts: _s, _entries: _e, _run_config_bytes: _r, ...rest } = u
      fs.writeFileSync(path.join(unitsDir, `${u.unit_id}.json`), JSON.stringify(rest), { mode: 0o600 })
    }
    const unitIds = units.map((u) => u.unit_id)
    const body = {
      selection: sel,
      nowEpoch,
      selectedDirs: res.selectedDirs,
      unitIds,
      unitsDigest: digest(units.map((u) => [u.unit_id, createHash('sha256').update(u.text).digest('hex')])),
      existingNodeIds: existing.map((n) => n.id),
    }
    const scanRecord = {
      ...body,
      digest: digest(body),
      createdAt: now(),
      alreadyImported: res.units.length - units.length,
      // Of those, units an earlier import left partially imported (its partial writes were kept).
      alreadyPartial: res.units.filter((u) => (rec.partial ?? []).includes(u.unit_id)).length,
      // Shown at gate 1: the import may update these.
      existingNodes: existing,
      listing: res.listing,
      months: res.months,
      autoExcluded: res.autoExcluded,
      redactionPreview: res.redactionPreview,
      keywordFlaggedSessions: res.keywordFlaggedSessions,
    }
    writeJson(this.p('scan.json'), scanRecord)
    // A new scan invalidates every earlier confirmation, estimate and plan.
    for (const f of ['estimate.json', 'plan.json', 'confirmations.json']) fs.rmSync(this.p(f), { force: true })
    return scanRecord
  }

  /** A finished import moves to history/<time>/ so a new one can start; imported.json keeps its unit ids. */
  archive(cur) {
    const dest = this.p('history', stamp())
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
    for (const f of ['cursor.json', 'plan.json', 'confirmations.json', 'estimate.json', 'scan.json']) {
      if (fs.existsSync(this.p(f))) fs.renameSync(this.p(f), path.join(dest, f))
    }
    for (const d of ['snapshots']) if (fs.existsSync(this.p(d))) fs.renameSync(this.p(d), path.join(dest, d))
    return { archived: dest, items: cur.next }
  }

  loadScan() {
    const s = readJson(this.p('scan.json'), null)
    if (!s) throw new HistoryError('no_scan', 'run history_scan first')
    return s
  }

  loadUnits(ids) {
    return ids.map((id) => JSON.parse(fs.readFileSync(this.p('units', `${id}.json`), 'utf8')))
  }

  // ---------------------------------------------------------- 5: estimate

  estimate() {
    const s = this.loadScan()
    const units = this.loadUnits(s.unitIds)
    const e = estimate(units, { costModel: this.costModel, m1: this.m1, modePrompt: this.modePrompt })
    const body = { scanDigest: s.digest, modes: e.modes, modePrompt: e.modePrompt, batches: e.batches.map((b) => b.map((u) => u.unit_id)) }
    const record = { ...body, digest: digest(body), createdAt: now(), units: e.units, turns: e.turns, unitTextKb: e.unitTextKb, coefficients: e.coefficients }
    writeJson(this.p('estimate.json'), record)
    return record
  }

  // ---------------------------------------------------------- gates

  /** Record a confirmation the user gave. `digest` must be the one the user was shown. */
  confirm({ gate, digest: shown, choice, userSaid }) {
    if (!userSaid || !String(userSaid).trim()) throw new HistoryError('confirm_needs_words', 'record the user’s own words (userSaid)')
    const c = this.confirmations()
    const at = now()
    if (gate === 'scope' || gate === 'privacy') {
      const s = this.loadScan()
      if (shown !== s.digest) throw new HistoryError('stale_digest', `the ${gate} the user saw is out of date; show the current scan (digest ${s.digest.slice(0, 12)}) and ask again`)
      c[gate] = { digest: shown, at, userSaid }
    } else if (gate === 'mode') {
      const e = readJson(this.p('estimate.json'), null)
      if (!e) throw new HistoryError('no_estimate', 'run history_estimate first')
      if (shown !== e.digest) throw new HistoryError('stale_digest', 'the estimate the user saw is out of date; show it again')
      if (!['full_replay', 'm1'].includes(choice)) throw new HistoryError('bad_choice', 'mode choice must be full_replay or m1')
      c.mode = { digest: shown, choice, at, userSaid }
    } else if (gate === 'start') {
      const plan = this.loadPlan()
      if (shown !== plan.digest) throw new HistoryError('stale_digest', 'the plan the user saw is out of date; show it again')
      if (plan.approveWrites && choice !== APPROVE_ALL) {
        throw new HistoryError('needs_write_approval', `approveWrites is on: the user must approve all memory writes of this import (${plan.delegations} delegations) at once; record choice "${APPROVE_ALL}" only after they said so`)
      }
      c.start = { digest: shown, at, userSaid, ...(plan.approveWrites ? { choice: APPROVE_ALL } : {}) }
    } else if (gate === 'resume') {
      const cur = this.cursor()
      if (!cur?.stop) throw new HistoryError('no_stop', 'the import is not stopped')
      if (shown !== cur.stop.id) throw new HistoryError('stale_digest', 'that is not the current stop; show the current one')
      if (!cur.stop.options.includes(choice)) throw new HistoryError('bad_choice', `choose one of: ${cur.stop.options.join(', ')}`)
      if (choice === 'rollback') throw new HistoryError('use_rollback', 'to roll back, call history_rollback (with confirmForeign after the user agreed to lose the listed writes)')
      return { gate, choice, ...this.resolveStop(cur, choice, userSaid) }
    } else {
      throw new HistoryError('bad_gate', 'gate must be scope, privacy, mode, start or resume')
    }
    writeJson(this.p('confirmations.json'), c)
    return { gate, recorded: c[gate] }
  }

  require(gate, expectedDigest) {
    const c = this.confirmations()[gate]
    if (!c) throw new HistoryError('confirmation_missing', `the user has not confirmed ${gate} yet`)
    if (c.digest !== expectedDigest) throw new HistoryError('confirmation_stale', `the ${gate} confirmation no longer matches; show it again`)
    return c
  }

  // ---------------------------------------------------------- plan

  plan() {
    const existing = this.checkGraphSize()
    const s = this.loadScan()
    this.checkExistingIds(existing, s.existingNodeIds)
    this.require('scope', s.digest)
    this.require('privacy', s.digest)
    const e = readJson(this.p('estimate.json'), null) ?? this.estimate()
    if (e.scanDigest !== s.digest) throw new HistoryError('confirmation_stale', 'the estimate is older than the scan; run history_estimate again')
    let mode = 'full_replay'
    if (e.modePrompt.ask) mode = this.require('mode', e.digest).choice
    const items = mode === 'm1' ? e.batches : s.unitIds.map((id) => [id])
    const units = new Map(this.loadUnits(s.unitIds).map((u) => [u.unit_id, u]))
    const itemDays = items.map((ids) => units.get(ids[0]).day)
    const kb = s.unitIds.reduce((acc, id) => acc + unitKb(units.get(id)), 0)
    const body = { scanDigest: s.digest, estimateDigest: e.digest, mode, items, itemDays, graphRoot: this.graphRoot, approveWrites: this.approveWrites, existingNodeIds: s.existingNodeIds }
    const plan = {
      ...body,
      digest: digest(body),
      createdAt: now(),
      units: s.unitIds.length,
      delegations: items.length,
      modeName: MODE_NAMES[mode],
      estimate: { ...e.modes[mode] },
      predicted: predict(items.length, kb, this.costModel),
      notice: NOTICE,
      writeApproval: this.approveWrites
        ? `approveWrites is on for the memory agent. The import cannot ask before each of its ${items.length} delegations, so the user approves all of this import's writes once, at gate "start" (choice "${APPROVE_ALL}").`
        : null,
    }
    writeJson(this.p('plan.json'), plan)
    return plan
  }

  loadPlan() {
    const plan = readJson(this.p('plan.json'), null)
    if (!plan) throw new HistoryError('no_plan', 'run history_plan first')
    const { scanDigest, estimateDigest, mode, items, itemDays, graphRoot, approveWrites, existingNodeIds } = plan
    if (digest({ scanDigest, estimateDigest, mode, items, itemDays, graphRoot, approveWrites, existingNodeIds }) !== plan.digest) throw new HistoryError('plan_changed', 'plan.json was changed after it was written; run history_plan again')
    return plan
  }

  // ---------------------------------------------------------- lock (H3)

  /** Per-graph lock: owner.json written in a temp dir, then renamed into place (atomic create-with-owner). */
  lock() {
    this.ensureDir()
    const dir = this.p('lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = randomBytes(8).toString('hex')
      const tmp = this.p(`lock.tmp-${process.pid}-${nonce}`)
      fs.mkdirSync(tmp, { mode: 0o700 })
      writeJson(path.join(tmp, 'owner.json'), { pid: process.pid, nonce, at: now() })
      try {
        fs.renameSync(tmp, dir)
        this.hooks.afterLock?.()
        // A competing takeover may have moved our fresh lock away and put its own in place: re-read.
        const owner = readJson(path.join(dir, 'owner.json'), {})
        if (owner.nonce !== nonce) throw new HistoryError('busy', `another importer (pid ${owner.pid}) took the lock at the same moment; try again`)
        this.lockNonce = nonce
        return
      } catch (error) {
        if (error instanceof HistoryError) throw error
        fs.rmSync(tmp, { recursive: true, force: true })
        if (!['EEXIST', 'ENOTEMPTY', 'EISDIR'].includes(error.code)) throw error
      }
      const owner = readJson(path.join(dir, 'owner.json'), {})
      const ownStale = owner.pid === process.pid && !running.has(this.graphRoot)
      if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) throw new HistoryError('busy', `another process (pid ${owner.pid}) is importing into this graph`)
      if (owner.pid === process.pid && !ownStale) {
        this.lockNonce = owner.nonce
        return
      }
      // The owner is gone (or left a stale lock in this process): take the lock over.
      this.hooks.beforeTakeover?.()
      const stale = this.p(`lock.stale-${process.pid}-${nonce}-${stamp()}`)
      try {
        fs.renameSync(dir, stale)
      } catch (error) {
        // someone else took it over first; the next attempt sees their lock
        if (error.code === 'ENOENT') continue
        throw error
      }
      // Another process may have judged the same owner dead and finished its takeover first: then what
      // was just moved aside is ITS live lock, not the dead one. Put it back and back off.
      const moved = readJson(path.join(stale, 'owner.json'), {})
      if ((moved.pid !== owner.pid || moved.nonce !== owner.nonce) && moved.pid && pidAlive(moved.pid)) {
        try {
          fs.renameSync(stale, dir)
        } catch {
          // a third importer got in meanwhile; leave the moved lock where it is, never delete a live lock
        }
        throw new HistoryError('busy', `another importer (pid ${moved.pid}) took the lock over at the same moment; try again`)
      }
      fs.rmSync(stale, { recursive: true, force: true })
    }
    throw new HistoryError('busy', 'could not take the import lock')
  }

  unlock() {
    const owner = readJson(this.p('lock', 'owner.json'), null)
    if (owner?.pid === process.pid && owner.nonce === this.lockNonce) fs.rmSync(this.p('lock'), { recursive: true, force: true })
  }

  async exclusive(fn) {
    if (running.has(this.graphRoot)) throw new HistoryError('busy', 'a batch or rollback is already running for this graph')
    running.add(this.graphRoot)
    try {
      this.lock()
    } catch (error) {
      running.delete(this.graphRoot)
      throw error
    }
    try {
      this.recoverRollback()
      return await fn()
    } finally {
      running.delete(this.graphRoot)
      this.unlock()
    }
  }

  // ---------------------------------------------------------- 7: one batch

  /**
   * Import the next batch. `delegateItem(request, {contextDate, index, signal, onRecord})` runs one
   * memory-agent delegation and returns {text, record} (agent.js delegate with withRecord); it may
   * throw with error.record. Returns a progress report; stops are reported in `stop` and persisted.
   */
  async runBatch(delegateItem, { signal } = {}) {
    const plan = this.loadPlan()
    const start = this.require('start', plan.digest)
    this.require('scope', plan.scanDigest)
    this.require('privacy', plan.scanDigest)
    if (plan.approveWrites && start.choice !== APPROVE_ALL) throw new HistoryError('needs_write_approval', 'approveWrites is on and the user has not approved all writes of this import')
    if (Boolean(plan.approveWrites) !== Boolean(this.approveWrites)) throw new HistoryError('confirmation_stale', 'the memory agent’s approveWrites setting changed after the plan was confirmed; run history_plan again')
    if (path.resolve(plan.graphRoot) !== this.graphRoot) throw new HistoryError('confirmation_stale', 'the memory agent now points at a different graph than the confirmed plan')
    return this.exclusive(async () => {
      let cur = this.cursor() ?? freshCursor()
      if (cur.stop) return { stopped: true, stop: cur.stop, progress: this.progress(cur, plan) }
      if (cur.next >= plan.items.length) return { done: true, progress: this.progress(cur, plan) }
      if (!cur.started) {
        this.checkExistingIds(this.checkGraphSize(), plan.existingNodeIds)
        cur.started = true
        cur.startedAt = now()
        const backup = this.p('backups', 'before-import')
        fs.rmSync(backup, { recursive: true, force: true })
        if (fs.existsSync(this.graphRoot)) cloneTree(this.graphRoot, backup)
        else fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
        writeJson(this.p('backups', 'before-import.manifest.json'), manifest(backup))
        cur.backupBeforeImport = backup
        this.saveCursor(cur)
      }
      // A batch left 'running' means DSH stopped mid-batch: treat it as a problem first.
      const interrupted = cur.batches.find((b) => b.status === 'running')
      if (interrupted) {
        const r = this.rollbackOrStop(cur, interrupted, 'the previous batch was interrupted (DSH stopped or restarted)', cur.inflight?.index ?? cur.next)
        if (r.stop) return { stopped: true, stop: r.stop, progress: this.progress(this.cursor(), plan) }
        cur = this.cursor()
        cur.batches.at(-1).rerun = true
        this.saveCursor(cur)
      }
      return await this.batchLoop(cur, plan, delegateItem, signal)
    })
  }

  async batchLoop(cur, plan, delegateItem, signal) {
    for (;;) {
      const rerun = cur.batches.at(-1)?.status === 'rolled_back' && cur.batches.at(-1).rerun === true
      const n = cur.batches.filter((b) => b.status !== 'rolled_back').length + 1
      const snap = this.p('snapshots', `batch-${n}`)
      fs.rmSync(snap, { recursive: true, force: true })
      if (fs.existsSync(this.graphRoot)) cloneTree(this.graphRoot, path.join(snap, 'graph'))
      else fs.mkdirSync(path.join(snap, 'graph'), { recursive: true, mode: 0o700 })
      // The manifest describes the copy itself: a write landing between clone and manifest is not hidden.
      const snapManifest = manifest(path.join(snap, 'graph'))
      writeJson(path.join(snap, 'manifest.json'), snapManifest)
      const batch = { n, status: 'running', startItem: cur.next, snapshot: snap, touch: emptyTouch(), rerun, startedAt: now() }
      writeJson(path.join(snap, 'cursor.json'), { ...cur, batches: [...cur.batches] })
      cur.batches.push(batch)
      this.saveCursor(cur)

      const t0 = Date.now()
      let problem = null
      const lines = []
      const skipped = new Set((cur.skipped ?? []).map((s) => s.index))
      while (cur.next < plan.items.length && lines.length < this.config.batchSize && Date.now() - t0 < this.config.maxBatchMinutes * 60000) {
        const index = cur.next
        if (skipped.has(index)) {
          cur.next = index + 1
          continue
        }
        if (signal?.aborted) {
          problem = { index, reason: 'was cancelled by the user', cancelled: true }
          break
        }
        const units = this.loadUnits(plan.items[index])
        const req = itemRequest(units)
        const started = Date.now()
        let out = null
        let record = null
        let error = null
        // Every write of the delegation is hashed as it happens (and persisted at once, so a crash stays
        // attributable); a target someone else changed first is marked foreign-touched.
        const hooks = writeHooks(batch.touch, this.graphRoot, snapManifest, () => this.saveCursor(cur))
        cur.inflight = { index, at: now() }
        this.saveCursor(cur)
        try {
          out = await delegateItem(req, { contextDate: plan.itemDays[index], index, signal, onRecord: (_childId, rec) => { rec.hooks = hooks } })
          record = out.record
        } catch (e) {
          error = e
          record = e?.record ?? null
        }
        delete cur.inflight
        const landed = (record?.writes ?? []).filter((w) => w.landed && w.id && ULID_RE.test(w.id))
        const verdict = signal?.aborted ? { kind: 'problem', reason: 'was cancelled by the user' } : classify(error, record)
        const entry = { index, unitIds: plan.items[index], day: plan.itemDays[index], verdict: verdict.kind, reason: verdict.reason, wallMs: Date.now() - started,
          nodesWritten: [...new Set(landed.map((w) => w.id))], childId: record?.childId ?? null, maintenanceDue: record?.maintenanceDue ?? null, at: now() }
        if (verdict.kind === 'problem') {
          problem = { ...entry, cancelled: Boolean(signal?.aborted) }
          break
        }
        cur.items[index] = entry
        if (record?.maintenanceDue != null) cur.maintenanceDue = record.maintenanceDue
        cur.next = index + 1
        this.saveCursor(cur)
        lines.push(entry)
      }
      if (problem) {
        this.saveCursor(cur)
        const r = this.rollbackOrStop(cur, batch, `delegation ${problem.index + 1} ${problem.reason}`, problem.index)
        if (r.stop) return { stopped: true, stop: r.stop, progress: this.progress(this.cursor(), plan) }
        cur = this.cursor()
        if (problem.cancelled) {
          const stop = this.setStop(cur, 'cancelled', 'the import was cancelled; the graph is back at its state before the batch', ['continue', 'stop'], { index: problem.index, startItem: batch.startItem })
          return { stopped: true, stop, progress: this.progress(this.cursor(), plan) }
        }
        if (rerun) {
          const stop = this.setStop(cur, 'rerun_unclean', `the batch had a problem again after one rerun (${problem.reason}); the graph is back at its state before the batch`, ['continue', 'skip', 'stop'],
            { index: problem.index, startItem: batch.startItem })
          return { stopped: true, stop, progress: this.progress(this.cursor(), plan) }
        }
        cur.batches.at(-1).rerun = true
        this.saveCursor(cur)
        continue
      }
      batch.status = 'done'
      batch.endedAt = now()
      // Keep only the snapshot before the latest batch.
      for (const b of cur.batches) {
        if (b !== batch && b.snapshot && fs.existsSync(b.snapshot)) {
          fs.rmSync(b.snapshot, { recursive: true, force: true })
          b.snapshotRemoved = true
        }
      }
      if (cur.next >= plan.items.length) this.finish(cur, plan)
      this.saveCursor(cur)
      const unknownStop = this.unknownRule(cur, plan, lines)
      if (unknownStop) return { stopped: true, stop: unknownStop, batch: lines, progress: this.progress(this.cursor(), plan) }
      return { done: cur.next >= plan.items.length, batch: lines, progress: this.progress(cur, plan) }
    }
  }

  /** Done: remember the imported unit ids so a later import skips them, and allow a new scan. */
  finish(cur, plan) {
    cur.finished = true
    cur.finishedAt = now()
    this.recordImported(cur, plan)
  }

  /**
   * Unit ids of the items that were imported and kept (ok or unknown), and in `partial` those of the
   * skipped items whose partial writes were kept, for a later incremental import: both are skipped then.
   */
  recordImported(cur, plan) {
    const ids = (cur.items ?? []).filter((x) => x && ['ok', 'unknown'].includes(x.verdict) && x.index < cur.next).flatMap((x) => plan.items[x.index])
    const partial = (cur.skipped ?? []).filter((x) => x.partial).flatMap((x) => x.unitIds)
    const prior = readJson(this.p('imported.json'), { unitIds: [] })
    writeJson(this.p('imported.json'), { unitIds: [...new Set([...prior.unitIds, ...ids])], partial: [...new Set([...(prior.partial ?? []), ...partial])], updatedAt: now() })
  }

  unknownRule(cur, plan, lines) {
    const rule = this.config.unknownRule
    for (const month of new Set(lines.map((l) => l.day.slice(0, 7)))) {
      if (cur.ackedMonths.includes(month)) continue
      const unknowns = cur.items.filter((x) => x?.day?.startsWith(month) && x.verdict === 'unknown').length
      const planned = plan.itemDays.filter((d) => d.startsWith(month)).length
      if (unknowns >= rule.minCount && unknowns > rule.rate * planned) {
        return this.setStop(cur, 'unknown_rate', `${unknowns} replies in ${month} did not parse (their writes landed): at least ${rule.minCount} and more than ${rule.rate * 100}% of ${planned}`, ['continue', 'stop'], { month })
      }
    }
    return null
  }

  setStop(cur, reason, detail, options, extra = {}) {
    cur.stop = { id: digest([reason, detail, Date.now()]).slice(0, 12), reason, detail, options, at: now(), ...extra }
    this.saveCursor(cur)
    return cur.stop
  }

  resolveStop(cur, choice, userSaid) {
    const stop = cur.stop
    const plan = this.loadPlan()
    cur.decisions = [...(cur.decisions ?? []), { stop, choice, userSaid, at: now() }]
    let note = ''
    if (choice === 'stop') {
      cur.finished = true
      cur.finishedAt = now()
      this.recordImported(cur, plan)
      this.saveCursor(cur)
      return { note: 'the import stays stopped; the items already imported, and the skipped items whose partial writes were kept (partialItems in the report), are recorded, so a later import skips them (a later import is only possible while the graph is still empty or small)' }
    }
    if (stop.reason === 'rollback_interrupted') return this.resolveInterruptedRollback(cur, stop, choice)
    if (stop.reason === 'unknown_rate' && choice === 'continue') cur.ackedMonths.push(stop.month)
    const skip = (index, why, extra = {}) => {
      cur.skipped = [...(cur.skipped ?? []).filter((s) => s.index !== index), { index, unitIds: plan.items[index], day: plan.itemDays[index], why, userSaid, at: now(), ...extra }]
    }
    if (stop.reason === 'rerun_unclean' && choice === 'skip') {
      // Only the failing item is skipped; the graph is back at the batch start, so resume there (H2).
      skip(stop.index, 'failed twice; skipped by the user')
      cur.next = stop.startItem
      note = `item ${stop.index + 1} is skipped; the import resumes at item ${stop.startItem + 1}, so no other item is dropped`
    }
    if (stop.reason === 'foreign_writes' && choice === 'continue') {
      // Keep the graph as it is; never rerun on top of the failed item's partial writes: skip it (M2).
      // Partial: a later "stop" or the end of the import records it in imported.json, so no later import repeats it.
      skip(stop.index, 'failed with writes by another session in the graph; the user kept the graph, its partial writes stay', { partial: true })
      const b = cur.batches.at(-1)
      if (b?.status === 'running') b.status = 'kept_after_problem'
      delete cur.inflight
      cur.next = stop.index + 1
      note = `item ${stop.index + 1} is skipped and its partial writes stay in the graph; the import continues at item ${stop.index + 2}`
    }
    if (stop.reason === 'cancelled' && choice === 'continue') note = `the import continues at item ${cur.next + 1}`
    cur.stop = null
    this.saveCursor(cur)
    return { note }
  }

  // ---------------------------------------------------------- rollback (C1, H1)

  /**
   * Roll the graph back to `batch`'s snapshot when nothing foreign changed since; otherwise stop and
   * list the foreign changes. Returns {rolledBack} or {stop}.
   */
  rollbackOrStop(cur, batch, why, index) {
    const before = readJson(path.join(batch.snapshot, 'manifest.json'))
    const diff = attributeChanges(before, manifest(this.graphRoot), batch.touch)
    if (diff.foreignNodes.length > 0) return { stop: this.foreignStop(cur, batch, why, diff, index) }
    const r = this.restore(cur, batch.snapshot, batch.touch, `rollback: ${why}`, [])
    if (r.stop) return r
    return { rolledBack: true }
  }

  foreignStop(cur, batch, why, diff, index) {
    const foreign = diff.foreignNodes.map((id) => ({ id, description: describe([this.graphRoot, path.join(batch.snapshot, 'graph')], id) }))
    return this.setStop(cur, 'foreign_writes', `${why}; a rollback would also discard ${diff.foreign.length} changed paths on ${foreign.length} nodes that another session wrote`, ['rollback', 'continue', 'stop'],
      { foreign, ownPaths: diff.own, index, startItem: batch.startItem })
  }

  /**
   * Staged swap to `snapshot` (H1). Re-checks for foreign changes right before the swap (allowed:
   * `confirmedForeign`, the nodes the user agreed to lose). The replaced tree becomes the backup.
   */
  restore(cur, snapshot, touch, why, confirmedForeign, extra = {}) {
    const ts = stamp()
    const staging = `${this.graphRoot}.rollback-staging-${ts}`
    const trash = `${this.graphRoot}.rollback-replaced-${ts}`
    const backup = this.p('backups', `rolled-back-${ts}`)
    cloneTree(path.join(snapshot, 'graph'), staging)
    fs.rmSync(path.join(staging, '.locks'), { recursive: true, force: true })
    // Keep the live bookkeeping (see module rules); files only in the snapshot stay.
    if (fs.existsSync(this.graphRoot)) {
      for (const name of fs.readdirSync(this.graphRoot)) {
        if (!KEEP_LIVE_TOP.test(name)) continue
        fs.rmSync(path.join(staging, name), { recursive: true, force: true })
        cloneTree(path.join(this.graphRoot, name), path.join(staging, name))
      }
    }
    // Last check, right before the swap.
    const diff = attributeChanges(readJson(path.join(snapshot, 'manifest.json')), manifest(this.graphRoot), touch)
    const allowed = new Set(confirmedForeign)
    const newForeign = diff.foreignNodes.filter((id) => !allowed.has(id))
    if (newForeign.length > 0) {
      fs.rmSync(staging, { recursive: true, force: true })
      const batch = cur.batches.at(-1) ?? { startItem: cur.next, snapshot }
      return { stop: this.foreignStop(cur, { ...batch, snapshot }, `${why}; another session wrote while the rollback was being prepared`, diff, cur.next) }
    }
    const restoredCursor = readJson(path.join(snapshot, 'cursor.json'))
    const rolledBatch = cur.batches.at(-1)
    if (rolledBatch) restoredCursor.batches.push({ ...rolledBatch, status: 'rolled_back', rolledBackAt: now() })
    restoredCursor.rollbacks = [...(cur.rollbacks ?? []), { why, backup, ownPaths: diff.own, foreignNodes: diff.foreignNodes, at: now(), ...extra }]
    restoredCursor.stop = null
    for (const k of ['decisions', 'ackedMonths', 'skipped', 'backupBeforeImport']) if (cur[k] !== undefined) restoredCursor[k] = cur[k]
    // An item skipped only because its partial writes were kept, at or after the restored position, lost
    // those writes with this rollback: it is no longer skipped, the import reaches it again.
    if (restoredCursor.skipped) restoredCursor.skipped = restoredCursor.skipped.filter((x) => !(x.partial && x.index >= restoredCursor.next))
    delete restoredCursor.inflight
    cur.rollbackInProgress = { staging, trash, backup, restoredCursor, phase: 'staged', at: now() }
    this.saveCursor(cur)
    this.crash('staged')
    // Locks of other sessions move with the live tree's lock directory, never restored from the snapshot.
    if (fs.existsSync(path.join(this.graphRoot, '.locks'))) fs.renameSync(path.join(this.graphRoot, '.locks'), path.join(staging, '.locks'))
    if (fs.existsSync(this.graphRoot)) fs.renameSync(this.graphRoot, trash)
    this.crash('moved')
    if (fs.existsSync(this.graphRoot)) {
      // A concurrent writer recreated the graph root after it moved away: undo the swap, keep their writes.
      const recreated = this.p('backups', `recreated-during-rollback-${ts}`)
      fs.renameSync(this.graphRoot, recreated)
      fs.renameSync(trash, this.graphRoot)
      if (fs.existsSync(path.join(staging, '.locks')) && !fs.existsSync(path.join(this.graphRoot, '.locks'))) fs.renameSync(path.join(staging, '.locks'), path.join(this.graphRoot, '.locks'))
      fs.rmSync(staging, { recursive: true, force: true })
      delete cur.rollbackInProgress
      const stop = this.setStop(cur, 'rollback_aborted', `the graph folder was recreated by another writer during the rollback; nothing was rolled back. What that writer wrote meanwhile is kept at ${recreated}`, ['rollback', 'continue', 'stop'],
        { index: cur.next, startItem: cur.batches.at(-1)?.startItem ?? cur.next, recreated })
      return { stop }
    }
    fs.renameSync(staging, this.graphRoot)
    this.crash('swapped')
    return { restored: this.finishRollback(cur.rollbackInProgress) }
  }

  crash(phase) {
    this.hooks.onPhase?.(phase)
    if (this.hooks.crashAt === phase) throw new Error(`simulated crash at ${phase}`)
  }

  finishRollback(rip) {
    fs.mkdirSync(path.dirname(rip.backup), { recursive: true, mode: 0o700 })
    // Cursor first (with the move still pending), then the move: a crash in between is finished by recovery.
    const restored = { ...rip.restoredCursor, pendingBackup: { from: rip.trash, to: rip.backup } }
    this.saveCursor(restored)
    this.crash('cursor_saved')
    if (fs.existsSync(rip.trash)) fs.renameSync(rip.trash, rip.backup)
    delete restored.pendingBackup
    this.saveCursor(restored)
    return restored
  }

  /** The user's choice after a rollback was interrupted while another writer recreated the graph folder. */
  resolveInterruptedRollback(cur, stop, choice) {
    const rip = stop.rip
    const ts = stamp()
    if (choice === 'use_restored') {
      fs.renameSync(this.graphRoot, this.p('backups', `recreated-during-rollback-${ts}`))
      fs.renameSync(rip.staging, this.graphRoot)
      const restored = this.finishRollback({ ...rip, restoredCursor: { ...rip.restoredCursor, decisions: cur.decisions } })
      return { note: `the restored graph is in place; what the other writer wrote meanwhile is kept at ${this.p('backups', `recreated-during-rollback-${ts}`)}`, next: restored.next }
    }
    // keep_current: the recreated folder stays the graph; both other trees are kept as backups.
    fs.renameSync(rip.staging, this.p('backups', `unused-restore-${ts}`))
    if (fs.existsSync(rip.trash)) fs.renameSync(rip.trash, this.p('backups', `replaced-${ts}`))
    // The batch that was being rolled back belongs to the replaced tree: it is abandoned, not interrupted.
    // Left "running", the next batch would roll it back against a snapshot of a tree that is no longer
    // the graph and report every snapshot node as foreign. The next batch snapshots the current graph.
    for (const b of cur.batches ?? []) {
      if (b.status !== 'running') continue
      b.status = 'abandoned'
      b.abandonedAt = now()
    }
    delete cur.inflight
    cur.stop = null
    this.saveCursor(cur)
    return { note: 'the current graph is kept; the prepared restore and the replaced graph are both in backups; the next batch starts from the current graph' }
  }

  /** Finish or undo a rollback a crash interrupted, from what is on disk (H1). */
  recoverRollback() {
    const cur = this.cursor()
    if (cur?.pendingBackup) {
      if (fs.existsSync(cur.pendingBackup.from)) fs.renameSync(cur.pendingBackup.from, cur.pendingBackup.to)
      delete cur.pendingBackup
      this.saveCursor(cur)
    }
    const rip = cur?.rollbackInProgress
    if (!rip) return null
    const live = fs.existsSync(this.graphRoot)
    const staged = fs.existsSync(rip.staging)
    const moved = fs.existsSync(rip.trash)
    if (live && staged && !moved) {
      // Crashed before the swap: undo.
      if (fs.existsSync(path.join(rip.staging, '.locks')) && !fs.existsSync(path.join(this.graphRoot, '.locks'))) fs.renameSync(path.join(rip.staging, '.locks'), path.join(this.graphRoot, '.locks'))
      fs.rmSync(rip.staging, { recursive: true, force: true })
      delete cur.rollbackInProgress
      this.saveCursor(cur)
      return { undone: true }
    }
    if (!live && staged && moved) {
      fs.renameSync(rip.staging, this.graphRoot)
      return { finished: true, cursor: this.finishRollback(rip) }
    }
    if (live && !staged && moved) return { finished: true, cursor: this.finishRollback(rip) }
    if (!live && !staged && moved) {
      fs.renameSync(rip.trash, this.graphRoot)
      delete cur.rollbackInProgress
      this.saveCursor(cur)
      return { undone: true }
    }
    // live && staged && moved: another writer recreated the graph folder while the rollback was cut off.
    // Keep all three trees and let the user choose.
    delete cur.rollbackInProgress
    this.saveCursor(cur)
    this.setStop(cur, 'rollback_interrupted', `a rollback was interrupted and another writer recreated the graph folder meanwhile; nothing was deleted. "use_restored" puts the restored graph in place (the recreated folder goes to backups); "keep_current" keeps the recreated folder as the graph (the restore and the replaced graph go to backups)`,
      ['use_restored', 'keep_current', 'stop'], { index: cur.next, rip })
    return { aborted: true }
  }

  /**
   * User-requested rollback: to the snapshot before the last batch, or to the backup before the import.
   * `expectForeign` (hosts without approval cards): the foreignDigest of the foreign nodes the user
   * agreed to lose in the chat; with confirmForeign, the rollback runs only if the foreign nodes are
   * still exactly those.
   */
  async rollback({ to = 'last_batch', confirmForeign = false, expectForeign } = {}) {
    return this.exclusive(async () => {
      const cur = this.cursor()
      if (!cur?.started) throw new HistoryError('nothing_to_roll_back', 'no import batch has run')
      let snapshot
      let touch
      if (to === 'before_import') {
        snapshot = this.p('backups', 'before-import-snapshot')
        fs.rmSync(snapshot, { recursive: true, force: true })
        fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 })
        cloneTree(cur.backupBeforeImport, path.join(snapshot, 'graph'))
        writeJson(path.join(snapshot, 'manifest.json'), manifest(path.join(snapshot, 'graph')))
        writeJson(path.join(snapshot, 'cursor.json'), { ...freshCursor(), backupBeforeImport: cur.backupBeforeImport })
        touch = mergeTouches(cur.batches.filter((b) => !['rolled_back', 'abandoned'].includes(b.status)).map((b) => b.touch))
      } else {
        // An abandoned batch's snapshot is of a tree that is no longer the graph (keep_current).
        const last = [...cur.batches].reverse().find((b) => !['rolled_back', 'abandoned'].includes(b.status) && b.snapshot && fs.existsSync(b.snapshot))
        if (!last) throw new HistoryError('nothing_to_roll_back', 'no batch snapshot is left')
        snapshot = last.snapshot
        touch = mergeTouches(cur.batches.slice(cur.batches.indexOf(last)).map((b) => b.touch))
      }
      const diff = attributeChanges(readJson(path.join(snapshot, 'manifest.json')), manifest(this.graphRoot), touch)
      const foreign = diff.foreignNodes.map((id) => ({ id, description: describe([this.graphRoot], id) }))
      if (foreign.length && !confirmForeign) {
        return { refused: true, foreign, foreignPaths: diff.foreign.length, ownPaths: diff.own,
          detail: 'another session wrote these since the snapshot; a rollback discards them. Ask the user; call again with confirmForeign only if they agree. The current state is kept as a backup either way.' }
      }
      if (foreign.length && expectForeign !== undefined && expectForeign !== foreignDigest(foreign)) {
        return { refused: true, foreign, foreignDigest: foreignDigest(foreign), foreignPaths: diff.foreign.length, ownPaths: diff.own,
          detail: 'the user has not agreed to lose exactly these foreign nodes (foreignDigest is missing or the list changed since they saw it). Show this list in the chat, and call again with confirmForeign and this foreignDigest only if they agree.' }
      }
      const r = this.restore(cur, snapshot, touch, `user asked: rollback to ${to}`, foreign.map((f) => f.id), { confirmedForeign: foreign.map((f) => f.id) })
      if (r.stop) return { rolledBack: false, stop: r.stop }
      if (to === 'before_import') {
        // The confirmed plan was for the graph as it was; after a full rollback it must be confirmed again (M6).
        const c = this.confirmations()
        delete c.start
        writeJson(this.p('confirmations.json'), c)
      }
      return { rolledBack: true, to, next: r.restored.next, discardedOwnPaths: diff.own, discardedForeign: foreign, backup: r.restored.rollbacks.at(-1).backup,
        ...(to === 'before_import' ? { note: 'the start confirmation was cleared; confirm the plan again before importing' } : {}) }
    })
  }

  // ---------------------------------------------------------- status and report

  progress(cur, plan) {
    const done = (cur?.items ?? []).filter((x) => x && x.verdict !== 'skipped')
    const walls = done.map((x) => x.wallMs).filter(Boolean)
    const left = plan.items.length - (cur?.next ?? 0)
    const etaH = walls.length >= 3 ? (left * (walls.reduce((a, b) => a + b, 0) / walls.length)) / 3.6e6 : (plan.estimate.wallH * left) / Math.max(plan.items.length, 1)
    return {
      done: cur?.next ?? 0,
      total: plan.items.length,
      unknowns: done.filter((x) => x.verdict === 'unknown').length,
      skipped: (cur?.skipped ?? []).length,
      nodesWritten: new Set(done.flatMap((x) => x.nodesWritten ?? [])).size,
      rollbacks: cur?.rollbacks?.length ?? 0,
      etaH: Math.round(etaH * 100) / 100,
      maintenanceDue: cur?.maintenanceDue ?? null,
    }
  }

  status() {
    const scanRec = readJson(this.p('scan.json'), null)
    const plan = readJson(this.p('plan.json'), null)
    const cur = this.cursor()
    const c = this.confirmations()
    const owner = readJson(this.p('lock', 'owner.json'), null)
    let state = 'not_scanned'
    if (scanRec) state = 'scanned'
    if (plan) state = 'planned'
    if (cur?.started) state = cur.stop ? 'stopped' : cur.finished ? 'done' : 'in_progress'
    if (running.has(this.graphRoot)) state = 'running'
    return {
      state,
      graphRoot: this.graphRoot,
      confirmed: Object.fromEntries(['scope', 'privacy', 'mode', 'start'].map((g) => [g, Boolean(c[g])])),
      plan: plan ? { mode: plan.mode, modeName: MODE_NAMES[plan.mode], delegations: plan.delegations, units: plan.units, estimate: plan.estimate, digest: plan.digest, writeApproval: plan.writeApproval } : null,
      progress: plan && cur ? this.progress(cur, plan) : null,
      stop: cur?.stop ?? null,
      lock: owner ? { ...owner, live: owner.pid === process.pid ? running.has(this.graphRoot) : pidAlive(owner.pid) } : null,
      ...(cur?.rollbackInProgress ? { rollbackInProgress: { phase: cur.rollbackInProgress.phase, at: cur.rollbackInProgress.at, note: 'an interrupted rollback is finished or undone by the next history_import_batch or history_rollback' } } : {}),
      backups: fs.existsSync(this.p('backups')) ? fs.readdirSync(this.p('backups')).filter((f) => !f.endsWith('.json')) : [],
    }
  }

  report() {
    const plan = this.loadPlan()
    const cur = this.cursor() ?? freshCursor()
    const months = new Map()
    for (const x of cur.items.filter(Boolean)) {
      const m = months.get(x.day.slice(0, 7)) ?? { month: x.day.slice(0, 7), delegations: 0, ok: 0, unknown: 0, nodesWritten: new Set() }
      m.delegations += 1
      if (x.verdict === 'ok') m.ok += 1
      if (x.verdict === 'unknown') m.unknown += 1
      ;(x.nodesWritten ?? []).forEach((id) => m.nodesWritten.add(id))
      months.set(m.month, m)
    }
    const nodes = fs.existsSync(this.graphRoot) ? fs.readdirSync(this.graphRoot).filter((d) => ULID_RE.test(d) && fs.existsSync(path.join(this.graphRoot, d, 'node.md'))).length : 0
    const wallMs = cur.items.filter(Boolean).reduce((a, x) => a + (x.wallMs ?? 0), 0)
    return {
      graphRoot: this.graphRoot,
      mode: plan.mode,
      modeName: MODE_NAMES[plan.mode],
      delegations: { done: cur.next ?? 0, planned: plan.items.length, imported: cur.items.filter(Boolean).length, skipped: (cur.skipped ?? []).length },
      skippedItems: (cur.skipped ?? []).map((s) => ({ item: s.index + 1, day: s.day, units: s.unitIds, why: s.why })),
      // Skipped items whose partial writes stay in the graph; recorded in imported.json, a later import skips them.
      partialItems: (cur.skipped ?? []).filter((s) => s.partial).map((s) => ({ item: s.index + 1, day: s.day, units: s.unitIds, why: s.why })),
      months: [...months.values()].map((m) => ({ ...m, nodesWritten: m.nodesWritten.size })),
      wallH: Math.round((wallMs / 3.6e6) * 100) / 100,
      nodesInGraph: nodes,
      rollbacks: (cur.rollbacks ?? []).map((r) => ({ why: r.why, at: r.at, foreignNodes: r.foreignNodes, backup: r.backup })),
      decisions: (cur.decisions ?? []).map((d) => ({ reason: d.stop.reason, choice: d.choice, at: d.at })),
      maintenance: cur.maintenanceDue != null
        ? `The graph reports ${cur.maintenanceDue} queued maintenance findings. Maintenance is not run during the import in this version; run a maintenance pass (docs/maintain-agent.md) when convenient.`
        : 'No maintenance backlog reported.',
      backups: { beforeImport: cur.backupBeforeImport ?? null },
      recommendation:
        'Keep using the Mexplore · Memory agent switch (memory-graph-agent on, direct off): a separate memory agent reads and writes, and checks its citations against what it actually read. Set approveWrites: true in its config to approve memory writes.',
    }
  }
}

/** Verdict for one delegation from what it actually did. */
export function classify(error, record) {
  if (error) {
    const msg = String(error?.message ?? error)
    const reason = /did not finish within/.test(msg) ? 'timed out' : /abort/i.test(msg) ? 'was cancelled' : /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(msg) ? 'hit a network error' : 'failed'
    return { kind: 'problem', reason }
  }
  if (!record) return { kind: 'problem', reason: 'returned no record' }
  if (record.stopReason !== 'completed') return { kind: 'problem', reason: `stopped early (${record.stopReason})` }
  if (record.fenceLatched) return { kind: 'problem', reason: 'latched the write fence (a write had an uncertain or partial effect)' }
  const landed = record.writes.filter((w) => w.landed).length
  if (!record.structured && landed === 0) return { kind: 'problem', reason: 'ended without a parsable reply and without writes' }
  if (!record.structured) return { kind: 'unknown', reason: 'reply did not parse; writes landed' }
  return { kind: 'ok', reason: '' }
}
