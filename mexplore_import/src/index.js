/**
 * The history import core, shared by every harness (design 26110900). It owns the steps and their
 * order, the four confirmations, scan / redaction / estimate, the plan, batches, snapshots, rollback,
 * the attribution of writes, the report, every user-facing text, and the eight history_* tools. A
 * host adapts only what is host-specific:
 *
 *   createImportCore(host, config) -> { tools, section, cardFor, texts, toText }
 *
 * ImportHost:
 *   graphRoot()              the graph the import writes into; read again on every tool call
 *   stateDir?(graphRoot)     default `${graphRoot}.history-import` (or config.stateDir)
 *   approveWrites()          the host's own "approve writes" setting; false when it has none
 *   writer                   ImportWriter, below
 *   secrets?()               {envFiles, values}: env files to read secret names and values from, and
 *                            secret values the host holds (used in memory only, never written)
 *   cards                    'supported' | 'unsupported' (can the host show an approval card?)
 *   source?                  HistorySource (source.js); default Claude Code history
 *   prompt?                  {host, recommend}: how the prompt names the host, and what it recommends
 *
 * ImportWriter.delegate(request, {contextDate, index, signal, observe, call}) runs ONE manage
 * delegation with the host's own agent (one unit, or one day batch) and returns a WriterOutcome
 * {stopReason, fenceLatched, structured, writes: [{tool, id, landed}], maintenanceDue?, childId?}.
 * It must call observe.beforeWrite({tool, args}) right before and observe.afterWrite({tool, args,
 * result}) right after every memory_write / memory_attach, in the process that writes. `call` is the
 * host's own context of the tool call that runs the batch (DSH: the tool `exec`, which carries the
 * calling agent), passed through untouched. When the delegation fails, the writer throws an Error
 * whose `record` (or `outcome`) is the WriterOutcome so far; the error message is classified
 * (timed out / cancelled / network error / failed).
 *
 * ImportToolSpec.execute(args, call) returns a JSON value; a refusal by the import comes back as
 * {error, message} and is marked so that `toText` renders it compactly. `call.signal` cancels.
 *
 * @module mexplore-import
 */

import { cardFor } from './cards.js'
import { foreignDigest, HistoryError, HistoryJob } from './job.js'
import { claudeCodeSource } from './source.js'
import { SECTION_NAME, SECTION_ORDER, sectionText, TEXTS } from './texts.js'
import { summarizeEstimate, summarizePlan, summarizeScan, TOOLS, toolSchema } from './tools.js'

export { cardFor } from './cards.js'
export { APPROVE_ALL, foreignDigest, GRAPH_TOO_LARGE, HistoryError, HistoryJob, JOB_DEFAULTS, NOTICE } from './job.js'
export { MODE_NAMES } from './estimate.js'
export { claudeCodeSource } from './source.js'
export { HOST_PROMPT_DEFAULTS, SECTION_NAME, SECTION_ORDER, sectionText, TEXTS } from './texts.js'
export { DESCRIPTIONS, PARAMETERS, summarizeEstimate, summarizePlan, summarizeScan, TOOLS, toolSchema } from './tools.js'

const REFUSAL = Symbol.for('mexplore-import.refusal')

/** The text a host shows the agent for a tool result: refusals compact, results indented. */
export function toText(value) {
  return value !== null && typeof value === 'object' && value[REFUSAL] === true ? JSON.stringify(value) : JSON.stringify(value, null, 1)
}

function refusal(error) {
  const out = { error: error.code, message: error.message }
  Object.defineProperty(out, REFUSAL, { value: true })
  return out
}

/**
 * @param {object} host    ImportHost (see the module comment)
 * @param {object} [config] the host's import config: projectsDir, envFiles, batchSize, maxBatchMinutes,
 *                          maxExistingNodes, askOnConfirm, costModel, m1, stateDir, now (tests), ...
 */
export function createImportCore(host, config = {}) {
  if (!host || typeof host.graphRoot !== 'function') throw new TypeError('createImportCore: host.graphRoot() is required')
  if (!host.writer || typeof host.writer.delegate !== 'function') throw new TypeError('createImportCore: host.writer.delegate() is required')
  const cards = host.cards === 'unsupported' ? 'unsupported' : 'supported'
  const askOnConfirm = config.askOnConfirm === true
  const approveWrites = () => (typeof host.approveWrites === 'function' ? host.approveWrites() === true : false)

  const job = () => {
    const graphRoot = host.graphRoot()
    const secrets = typeof host.secrets === 'function' ? host.secrets() : null
    const cfg = { ...config }
    if (secrets) {
      cfg.envFiles = secrets.envFiles ?? []
      if (secrets.values?.length) cfg.secretValues = secrets.values
    }
    if (typeof host.stateDir === 'function') cfg.stateDir = host.stateDir(graphRoot)
    return new HistoryJob({ graphRoot, config: cfg, approveWrites: approveWrites(), source: host.source ?? claudeCodeSource })
  }

  /** The job's delegation callback, on top of the host's writer. Throws keep their message and record. */
  const delegateItem = (call) => async (request, { contextDate, index, signal, onRecord }) => {
    const box = {}
    onRecord?.(null, box)
    try {
      const outcome = await host.writer.delegate(request, { contextDate, index, signal, observe: box.hooks, call })
      return { record: outcome }
    } catch (error) {
      if (error && typeof error === 'object' && error.record === undefined && error.outcome !== undefined) error.record = error.outcome
      throw error
    }
  }

  const rollback = async (args) => {
    if (cards === 'supported') return job().rollback(args)
    // No card: the chat answer must name exactly the foreign nodes the user agreed to lose.
    const { foreignDigest: shown, ...rest } = args
    if (rest.confirmForeign === true) return job().rollback({ ...rest, expectForeign: shown ?? null })
    const r = await job().rollback(rest)
    return r.refused && Array.isArray(r.foreign) && r.foreignDigest === undefined ? { ...r, foreignDigest: foreignDigest(r.foreign) } : r
  }

  const handlers = {
    history_scan: (args) => summarizeScan(job().scan(args)),
    history_estimate: () => summarizeEstimate(job().estimate()),
    history_confirm: (args) => job().confirm(args),
    history_plan: () => summarizePlan(job().plan()),
    history_import_batch: (_args, call) => job().runBatch(delegateItem(call), { signal: call.signal }),
    history_status: () => job().status(),
    history_rollback: rollback,
    history_report: () => job().report(),
  }

  const tools = TOOLS.map((name) => ({
    name,
    ...toolSchema(name, cards),
    async execute(args, call) {
      try {
        return await handlers[name](args ?? {}, call ?? {})
      } catch (error) {
        if (error instanceof HistoryError) return refusal(error)
        throw error
      }
    },
  }))

  return {
    cards,
    tools,
    section: { name: SECTION_NAME, order: SECTION_ORDER, text: sectionText({ cards, ...(host.prompt ?? {}) }) },
    cardFor: (tool, args) => cardFor(tool, args, { cards, askOnConfirm, plan: () => job().loadPlan(), approveWrites: approveWrites(), graphRoot: host.graphRoot() }),
    texts: TEXTS,
    toText,
  }
}
