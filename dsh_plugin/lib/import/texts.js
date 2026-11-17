// GENERATED from mexplore_import/src/texts.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * Everything the history import says to the user or to the main agent, as data: the notice, the
 * graph-size refusal, the mode names, and the prompt section that walks the main agent through the
 * steps and the four confirmations. Hosts only inject it.
 *
 * The section has two variants. A host that can show an approval card (DSH) confirms everything in
 * the chat except two cases, which also get a card: a rollback that discards other sessions' writes,
 * and gate "start" when the host's approveWrites is on. A host that cannot show cards confirms those
 * two in the chat as well (design 26110900 §2.3).
 *
 * @module mexplore-import/texts
 */

import { MODE_NAMES, MODE_PROMPT_DEFAULTS } from './estimate.js'

export const NOTICE_ZH =
  '导入会直接写进你正在用的记忆图；出问题时会把整张图恢复到上一批之前（或导入之前）的状态。如果那之后别的会话也写过记忆，会先列出会丢掉哪些、经你同意才恢复，恢复前的状态也会另存一份备份。'
export const NOTICE_EN =
  'The import writes into your live memory graph; on a problem the WHOLE graph is restored to its state before the last batch (or before the import). If another session wrote memory since then, you are shown what would be lost and asked first, and the state before the rollback is kept as a backup.'
export const NOTICE = `${NOTICE_ZH} / ${NOTICE_EN}`

export const GRAPH_TOO_LARGE_ZH =
  '这一版只支持导入到空的或很小的记忆图（已有节点不超过 {max} 个），当前图有 {n} 个节点。请先把记忆代理的 graphRoot 指到一个新的空目录再导入，之后再切换。'
export const GRAPH_TOO_LARGE_EN =
  'This version only imports into an empty or small memory graph (at most {max} existing nodes); this graph has {n}. Point the memory agent\'s graphRoot at a new empty directory for the import, and switch later. Importing into a large existing graph is future work.'
export const GRAPH_TOO_LARGE = `${GRAPH_TOO_LARGE_ZH} / ${GRAPH_TOO_LARGE_EN}`

/** "中文 / English" -> [中文, English]; every bilingual string here has exactly one separator. */
function bilingual(s) {
  const parts = s.split(' / ')
  if (parts.length !== 2) throw new Error(`not a "zh / en" string: ${s.slice(0, 40)}`)
  return parts
}

const [tradeoffZh, tradeoffEn] = bilingual(MODE_PROMPT_DEFAULTS.tradeoff)
const [fullAboutZh, fullAboutEn] = bilingual(MODE_NAMES.full_replay.about)
const [m1AboutZh, m1AboutEn] = bilingual(MODE_NAMES.m1.about)

/** Static user-facing texts by language. The mode ids (full_replay, m1) never appear in them. */
export const TEXTS = Object.freeze({
  zh: Object.freeze({
    notice: NOTICE_ZH,
    graphTooLarge: GRAPH_TOO_LARGE_ZH,
    modeFullReplay: MODE_NAMES.full_replay.zh,
    modeFullReplayAbout: fullAboutZh,
    modeByDay: MODE_NAMES.m1.zh,
    modeByDayAbout: m1AboutZh,
    tradeoff: tradeoffZh,
  }),
  en: Object.freeze({
    notice: NOTICE_EN,
    graphTooLarge: GRAPH_TOO_LARGE_EN,
    modeFullReplay: MODE_NAMES.full_replay.en,
    modeFullReplayAbout: fullAboutEn,
    modeByDay: MODE_NAMES.m1.en,
    modeByDayAbout: m1AboutEn,
    tradeoff: tradeoffEn,
  }),
})

export const SECTION_NAME = 'memory:history-import'
export const SECTION_ORDER = 160

/** How the section names the host and what it recommends at the end; the defaults are DSH's. */
export const HOST_PROMPT_DEFAULTS = Object.freeze({
  host: 'DSH',
  recommend: 'recommend keeping the Mexplore · Memory agent switch (memory-graph-agent on, direct off; approveWrites optional)',
})

/**
 * The prompt section for the main agent.
 * @param {{cards?: 'supported' | 'unsupported', host?: string, recommend?: string}} [opts]
 */
export function sectionText(opts = {}) {
  const cards = opts.cards === 'unsupported' ? 'unsupported' : 'supported'
  const { host, recommend } = { ...HOST_PROMPT_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) }
  const withCards = cards === 'supported'
  const step6Approval = withCards
    ? `say that the import cannot ask before each save, that this confirmation approves ALL of its writes, and that ${host} will show one approval card for it.`
    : 'say that the import cannot ask before each save and that this confirmation approves ALL of its writes; there is no approval card, so ask exactly that in the chat.'
  const step8Rollback = withCards
    ? '"rollback" means history_rollback {confirmForeign: true} only after the user agreed to lose them'
    : '"rollback": call history_rollback {} first; it refuses and returns the current foreign nodes with a foreignDigest. Show those nodes, and only after the user agreed to lose exactly them call history_rollback {confirmForeign: true, foreignDigest: <that digest>}'
  const step8Cards = withCards
    ? `A whole-graph rollback always asks the user in the chat first; one that discards foreign writes also shows a ${host} approval card.`
    : 'A whole-graph rollback always asks the user in the chat first, and so does one that discards foreign writes; there is no approval card on this host.'
  const confirmations = withCards
    ? 'Confirmations: ask each question in the chat and record the user\'s answer with history_confirm; there is no separate approval card for the gates (only the two cards named above, unless the row sets askOnConfirm). Never treat silence or your own reading as a yes.'
    : 'Confirmations: ask each question in the chat and record the user\'s answer with history_confirm; this host shows no approval cards, so the chat answer is the only confirmation, also for discarding other sessions\' writes and for approving all writes. Never treat silence or your own reading as a yes.'
  return [
    '## Importing past conversations (history import)',
    'When the user asks to import their history (「导入历史」, "import my past conversations"), walk them through it with the history_* tools, in this order. Never skip a step, never answer a confirmation for the user, and never paste conversation text into the chat — the tools return counts and ids only.',
    'Only the history_* tools import. Never write your own import script, and never create, change or delete anything inside the memory graph directory with shell, file or script tools: that skips the write checks, the cursor and the rollback.',
    `1. Tell the user up front: ${NOTICE}`,
    '2. history_scan (optionally with projects / excludeProjects / fromDay / throughDay). Show per project: sessions, units, dates, size, flags (name:… looks private and is left out by default; mixed:… mixes work and personal), and what was excluded automatically. For a first try suggest one project or one week.',
    '3. Gate 1 — scope: if the graph already has nodes (existingNodes, at most 20 in this version), list them (id and description) and say the import may update them. When the user agrees, history_confirm {gate: "scope", digest: <scan digest>, userSaid: <their words>}. If they change the selection, scan again first. If a tool returns graph_too_large, tell the user its message: importing into a large existing graph is not supported yet; point graphRoot at a new empty directory for the import and switch later.',
    '4. Gate 2 — privacy: show the redaction preview (hits per kind; the two biggest kinds are mostly paths and hashes). Say plainly: secrets in known formats (API keys and tokens, passwords in common forms, ID, phone and card numbers) are replaced automatically, so a secret in an unusual format may slip through; health, family names, finances, politics and religion are NOT removed automatically. Then history_confirm {gate: "privacy", digest: <scan digest>, …}.',
    `5. history_estimate. Call the two modes only by their user-facing names (modePrompt.names; modeName in the plan, status and report): 「${MODE_NAMES.full_replay.zh}」 ("${MODE_NAMES.full_replay.en}": each segment goes to the memory agent separately, in time order; the most complete memory, the slowest) and 「${MODE_NAMES.m1.zh}」 ("${MODE_NAMES.m1.en}": up to 6 segments from the same day go to the memory agent together, verbatim, no summarizing; faster and cheaper). Never say the internal ids "full_replay" or "m1" (or "M1", "full replay") to the user. If modePrompt.ask is true, show both side by side with hours and $ (ranges), recommend 「${MODE_NAMES.m1.zh}」, add the tradeoff line, ask which one, and record Gate 3 with history_confirm {gate: "mode", digest: <estimate digest>, choice: "m1" for ${MODE_NAMES.m1.zh} | "full_replay" for ${MODE_NAMES.full_replay.zh}, …}. Otherwise say it will import 「${MODE_NAMES.full_replay.zh}」 and give hours and $.`,
    `6. history_plan. Show the mode by its name (modeName), delegations, hours and $ (ranges), the graph it writes into, and the notice from step 1 again. If writeApproval is set (the memory agent has approveWrites on), ${step6Approval} Gate 4: history_confirm {gate: "start", digest: <plan digest>, …} — with choice "approve_all_writes" only when writeApproval is set and the user agreed to exactly that.`,
    '7. Loop: call history_import_batch; after each call tell the user in one line: done/total, nodes written, rollbacks, eta; then call it again until it reports done. The user can keep working in other sessions meanwhile.',
    `8. If a batch returns a stop: explain \`reason\` in one sentence and offer exactly its options. foreign_writes: list the foreign nodes (id and description) — ${step8Rollback}; "continue" keeps the graph as it is and skips the failed item (its partial writes stay). rerun_unclean: "skip" skips only the failing item and resumes at the start of its batch. For any other choice: history_confirm {gate: "resume", digest: <stop id>, choice, userSaid}. Never decide for the user. ${step8Cards}`,
    `9. When done: history_report. Tell the user the totals, rollbacks, and the maintenance note, and ${recommend}.`,
    confirmations,
    `Resuming later (also after ${host} restarted): history_status, then continue at the step it shows. After an import is done, another import into the same graph is blocked by the size precondition (the graph is no longer empty or small) until large-graph import exists; the imported unit ids are recorded for that future incremental import.`,
  ].join('\n')
}
