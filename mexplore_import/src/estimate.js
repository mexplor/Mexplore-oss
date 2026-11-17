/**
 * Estimate, M1 day batching and the mode prompt, ported from a reference importer
 * `history_import/onboard_scan.py` (reference) and `batch_plan.ts`.
 *
 * Cost model: per delegation, output tokens = fixed + perKb x unit KB; wall = fixed + perKOutput x
 * output/1000; cost = fixed + perKb x KB. KB = UTF-8 bytes of the unit text / 1000. The defaults are
 * the in-DSH calibration (COEFFICIENTS.source says on how many units); a deployment can override them
 * with the row's `costModel` config.
 *
 * M1: units in global start order are packed greedily into batches that stay on one local day, hold at
 * most `maxUnitsPerBatch` units, at most `maxEvidence` evidence entries, and whose run-config-sized JSON
 * stays within `budgetBytes` (the same measure as the A2A import, so batch counts are comparable).
 *
 * @module mexplore-import/estimate
 */

/**
 * In-DSH calibration, 2026-11-06: 22 real units (one delegation each) through this plugin's memory agent
 * in an isolated DSH 0.2.2-rc.1 profile, deepseek-v4.1-flash-1017 pinned to one provider. Per delegation:
 * output tokens = 3,910 + 352/KB (r 0.80); wall s = 3.35 + 8.68 per 1k output (r 0.98); cost from the
 * children's token usage at the AI Gateway's fitted prices ($0.08 / $0.008 / $0.55 per M uncached /
 * cached / output) = $0.00416 + $0.000306/KB. The main agent's own tokens are not included. For
 * comparison, the A2A full-replay regression (257 units) was 3,623 + 296/KB, 5.2 + 7.4 s, $0.00502 +
 * $0.000267/KB; on the same 22 units it predicted 21% less wall time. The ranges are wider than the A2A
 * ones because 22 units is a small sample.
 */
export const COEFFICIENTS = Object.freeze({
  source: 'in-DSH calibration on 22 units (2026-11-06)',
  outputFixedTokens: 3910,
  outputTokensPerKb: 352,
  wallFixedS: 3.35,
  wallSPerKOutput: 8.68,
  costFixedUsd: 0.00416,
  costUsdPerKb: 0.000306,
  range: { output: [-0.15, 0.15], wall: [-0.1, 0.25], cost: [-0.15, 0.15] },
})

export const M1_DEFAULTS = Object.freeze({ maxUnitsPerBatch: 6, maxEvidence: 50, budgetBytes: 60000 })

/**
 * What the user is told about each mode. The ids (full_replay, m1) are internal and never shown;
 * the agent uses these names and descriptions (maintainer decision 2026-11-09).
 */
export const MODE_NAMES = Object.freeze({
  full_replay: Object.freeze({
    zh: '逐段导入',
    en: 'one conversation segment at a time',
    about: '每段对话单独交给记忆代理，按时间顺序；记得最全，也最慢。 / Each segment of conversation is handed to the memory agent separately, in time order; the most complete memory, and the slowest.',
  }),
  m1: Object.freeze({
    zh: '按天合并导入',
    en: 'batched by day',
    about: '同一天最多 6 段对话原样（不做摘要）一起交给记忆代理；更快、更省钱。 / Up to 6 segments from the same day are handed to the memory agent together, verbatim, with no summarizing; faster and cheaper.',
  }),
})

export const MODE_PROMPT_DEFAULTS = Object.freeze({
  askModeThresholdHours: 2,
  tradeoff:
    '「按天合并导入」更快更省钱，但试点里新建的节点约少 25%，关联和附件约少 35%；回答会不会因此变差还没测。 / "Batched by day" is faster and cheaper, but in our pilot it produced about 25% fewer new nodes and about 35% fewer links and attachments; whether answers get worse is not yet measured.',
})

export const unitKb = (unit) => Buffer.byteLength(unit.text, 'utf8') / 1000

export function predict(delegations, kb, cm = COEFFICIENTS) {
  const out = cm.outputFixedTokens * delegations + cm.outputTokensPerKb * kb
  const wall = cm.wallFixedS * delegations + (cm.wallSPerKOutput * out) / 1000
  const cost = cm.costFixedUsd * delegations + cm.costUsdPerKb * kb
  return { outputTokens: Math.round(out), wallH: round(wall / 3600, 2), costUsd: round(cost, 2) }
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d

export function withRange(p, cm = COEFFICIENTS) {
  const r = cm.range
  return {
    ...p,
    wallHRange: [round(p.wallH * (1 + r.wall[0]), 1), round(p.wallH * (1 + r.wall[1]), 1)],
    costUsdRange: [round(p.costUsd * (1 + r.cost[0]), 2), round(p.costUsd * (1 + r.cost[1]), 2)],
  }
}

// ---------------------------------------------------------------- M1 batch sizing

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000'
const REQUEST_KEY = `opencode-ses_xxxxxxxxxxxxxxxxxxxxxxxxxx-msg_xxxxxxxxxxxxxxxxxxxxxxxxxx-${PLACEHOLDER_ID}`
const RUN_DIR = `/Users/xxxx/.local/state/memory-agent/xxxxxxxxxxxxxxxxxx/runs/${PLACEHOLDER_ID}/run-${PLACEHOLDER_ID}-${PLACEHOLDER_ID}`

export function splitTurns(text) {
  const lines = text.split('\n')
  const entries = []
  for (const line of lines.slice(1)) {
    const m = /^(USER|ASSISTANT): /.exec(line)
    if (m) entries.push({ role: m[1] === 'USER' ? 'user' : 'assistant', lines: [line.slice(m[0].length)] })
    else if (entries.length) entries[entries.length - 1].lines.push(line)
  }
  return { header: lines[0], entries: entries.map((e) => ({ role: e.role, content: e.lines.join('\n') })) }
}

/** build-request.mjs evidence: one entry per message, sourceId <turn_id>:<role>, date = unit day. */
export function unitEvidence(unit) {
  const { header, entries } = splitTurns(unit.text)
  let turn = -1
  const evidence = entries.map((e) => {
    if (e.role === 'user') turn += 1
    return { role: e.role, content: e.content, sourceId: `${unit.turn_ids[Math.max(turn, 0)]}:${e.role}`, date: unit.day, complete: !e.content.includes('…[truncated]') }
  })
  return { header, evidence }
}

function measure(units, m1) {
  const headers = []
  const ranges = []
  const evidence = []
  for (const u of units) {
    const { header, evidence: own } = unitEvidence(u)
    headers.push(header)
    ranges.push([evidence.length + 1, evidence.length + own.length])
    evidence.push(...own)
  }
  const listing = headers.map((h, i) => `(${i + 1}) ${h.replace(/\.$/, '')}: entries ${ranges[i][0]}-${ranges[i][1]}`).join('; ')
  const message = `Please save to memory what is worth keeping long-term from the past conversations attached as evidence: durable decisions, preferences and outcomes. The evidence holds ${headers.length} conversations in time order, one entry per message: ${listing}.`
  const runConfig = {
    taskId: PLACEHOLDER_ID, requestKey: REQUEST_KEY, authority: 'manage',
    originalIds: { taskId: PLACEHOLDER_ID, requestKey: REQUEST_KEY, callerAgentId: 'build', callerSessionId: 'ses_xxxxxxxxxxxxxxxxxxxxxxxxxx' },
    graphRoot: '/Users/xxxx/xxxxxxxxxxxxxx/xxxxxxxxxxxxxxxxxxxxxxxxx', privateWorkDir: RUN_DIR, receiptsFile: `${RUN_DIR}/receipts.jsonl`,
    contextDate: evidence.length ? evidence.map((e) => e.date).sort()[0] : '1970-01-01', message,
    evidence: evidence.map((e) => ({ sourceId: e.sourceId, role: e.role, sourceKind: 'conversation', content: e.content, complete: e.complete, date: e.date })),
    batchWrites: true, appendWrites: true, stableManagePrompt: true, promptProfile: true, retryGuard: true, indexBudget: true,
    diagnosticsFile: `${RUN_DIR}/observation.jsonl`,
  }
  const bytes = Buffer.byteLength(`${JSON.stringify(runConfig)}\n`, 'utf8')
  return { evidence: evidence.length, bytes, fits: evidence.length <= m1.maxEvidence && bytes <= m1.budgetBytes }
}

const startMs = (u) => Math.floor(Date.parse(u.started_at))

/** Greedy same-day packing (batch_plan.ts). Returns arrays of units. */
export function m1Plan(units, m1 = M1_DEFAULTS) {
  const ordered = [...units].sort((a, b) => startMs(a) - startMs(b) || (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0))
  const batches = []
  let cur = []
  for (const u of ordered) {
    if (cur.length && cur[0].day === u.day && cur.length < m1.maxUnitsPerBatch && measure([...cur, u], m1).fits) {
      cur.push(u)
      continue
    }
    if (cur.length) batches.push(cur)
    cur = [u]
  }
  if (cur.length) batches.push(cur)
  return batches
}

/** Estimate for both modes plus the mode prompt (maintainer decision 2026-11-06: >= threshold -> ask, recommend batched by day). */
export function estimate(units, { costModel = COEFFICIENTS, m1 = M1_DEFAULTS, modePrompt = MODE_PROMPT_DEFAULTS } = {}) {
  const kb = units.reduce((s, u) => s + unitKb(u), 0)
  const turns = units.reduce((s, u) => s + u.turn_ids.length, 0)
  const batches = units.length ? m1Plan(units, m1) : []
  const full = { delegations: units.length, ...withRange(predict(units.length, kb, costModel), costModel) }
  const m1Mode = { delegations: batches.length, ...withRange(predict(batches.length, kb, costModel), costModel) }
  const ask = full.wallH >= modePrompt.askModeThresholdHours
  return {
    units: units.length,
    turns,
    unitTextKb: round(kb, 1),
    modes: { full_replay: full, m1: m1Mode },
    modePrompt: ask
      ? { ask: true, recommended: 'm1', recommendedName: MODE_NAMES.m1, names: MODE_NAMES, tradeoff: modePrompt.tradeoff, thresholdH: modePrompt.askModeThresholdHours,
          maintainPass: 'not included: maintenance is not run during the import in this version' }
      : { ask: false, defaultMode: 'full_replay', defaultModeName: MODE_NAMES.full_replay, thresholdH: modePrompt.askModeThresholdHours },
    batches,
    coefficients: costModel.source,
  }
}
