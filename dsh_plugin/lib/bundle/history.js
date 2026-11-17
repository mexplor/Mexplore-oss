/**
 * Bundle row `memory-graph-history`: import past Claude Code conversations into the long-term memory
 * graph, written by the bundle's own memory agent (`delegate()` in agent.js, one delegation per unit or
 * day batch, with the conversation's date as contextDate). The row injects the memory agent's settings,
 * so it only loads while the "Mexplore · Memory agent" switch is on — the import has no other writer.
 *
 * The import itself — steps, the four confirmations, tools, texts, snapshots and rollback — is the
 * host-neutral core in `lib/import/` (generated from the repository's `mexplore_import/src`). This row is
 * DSH's adapter to it: the memory agent as the writer, the agent's graphRoot and approveWrites, DSH
 * approval cards, tool registration and the prompt section (design 26110900 §3.1).
 *
 * Tools (main agent): history_scan, history_estimate, history_confirm, history_plan,
 * history_import_batch, history_status, history_rollback, history_report. The user answers each gate in
 * the chat and the agent records that answer with history_confirm; there is no DSH approval card for it
 * (maintainer decision 2026-11-09: the in-chat question already is the confirmation). Two cards stay, because they
 * guard data or were asked for: history_rollback with confirmForeign (discards other sessions' writes,
 * which the agent's own reading of the chat must not be enough for), and gate "start" when the memory
 * agent has approveWrites on (the user asked to approve writes; this one card approves them all).
 * Config `askOnConfirm: true` brings back a card for every gate and every rollback.
 *
 * approveWrites (the memory agent's own setting): delegate() is called directly, so the memory_agent
 * tool's per-call prompt never fires for the import. Asking before each of hundreds of delegations
 * would make a long import unattended-hostile, so instead the plan states it and gate "start" must
 * carry an explicit "approve all writes for this import" (choice approve_all_writes), recorded in
 * the gate; without it no batch runs.
 *
 * Config (all optional): projectsDir, envFiles, privateNamePatterns, mixedLabelPatterns,
 * personalKeywords, batchSize (5), maxBatchMinutes (8), maxExistingNodes (20: this version imports only into
 * an empty or small graph), askOnConfirm (false), costModel, m1, stateDir,
 * now (tests). Test hook, honoured only when the DSH process has MEXPLORE_HISTORY_TEST_HOOKS=1:
 * debug.abortItems / debug.abortAfterMs (cancel the delegation of each listed item index once per process).
 *
 * @module dsh-mexplore/history
 */

import { defineTool } from '../tool.js'
import { createImportCore, sectionText, TOOLS } from '../import/index.js'
import { delegate } from './agent.js'
import { SETTINGS_SERVICE } from './state.js'

export const name = 'memory-graph-history'
export const inject = ['tools', SETTINGS_SERVICE]

export { TOOLS }

export const SECTION_TEXT = sectionText({ cards: 'supported' })

/**
 * What an import delegation's writes record as their provenance (design
 * 26111000 §"Host adapters"): the writes are real graph writes, but they came
 * from a stored Claude Code conversation, not from the chat that ran the
 * import, so they are labelled `actor:'import'` and never attributed to a chat.
 * No session id exists for an imported conversation, hence the `import` reason.
 */
export const IMPORT_PROVENANCE = Object.freeze({ actor: 'import', host: 'dsh', session: null, reason: 'import' })

const OUTPUT = {
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export function apply(ctx, config = {}) {
  const settings = ctx[SETTINGS_SERVICE]
  if (settings === undefined || settings === null) throw new Error('the history import needs the memory agent switch (memory-graph-agent) to be on')
  const debug = process.env.MEXPLORE_HISTORY_TEST_HOOKS === '1' ? (config.debug ?? {}) : {}
  const firedDebug = new Set()

  /** The memory agent, in process: one manage delegation; its write hooks are the core's observer. */
  const writer = {
    async delegate(req, { contextDate, index, signal: jobSignal, observe, call: exec }) {
      let signal = jobSignal ?? exec.signal
      let timer
      if (Array.isArray(debug.abortItems) && debug.abortItems.includes(index) && !firedDebug.has(index)) {
        firedDebug.add(index)
        const ctrl = new AbortController()
        exec.signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
        timer = setTimeout(() => ctrl.abort(new Error('debug abort')), debug.abortAfterMs ?? 15000)
        signal = ctrl.signal
      }
      try {
        const out = await delegate(ctx, settings, req, { ...exec, signal }, { contextDate, withRecord: true, provenance: IMPORT_PROVENANCE, onRecord: (_childId, rec) => { rec.hooks = observe } })
        return out.record
      } finally {
        clearTimeout(timer)
      }
    },
  }

  const core = createImportCore(
    {
      graphRoot: () => settings.plugin.graphRoot,
      approveWrites: () => settings.approveWrites === true,
      secrets: () => ({ envFiles: config.envFiles ?? [], values: [] }),
      cards: 'supported',
      writer,
    },
    config,
  )

  ctx.on('tools/pre-execute', (exec, next) => {
    const card = core.cardFor(exec?.name, exec?.arguments ?? {})
    if (card === null) return next()
    return { kind: 'ask', reason: card.reason, displayReason: { en: card.en, zh: card.zh } }
  })

  for (const tool of core.tools) {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output: OUTPUT,
          execute: async (args, exec) => ({ text: core.toText(await tool.execute(args ?? {}, exec ?? {})) }),
        }),
      ),
    )
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section(core.section)
  })
}
