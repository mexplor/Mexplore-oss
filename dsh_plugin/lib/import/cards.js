// GENERATED from mexplore_import/src/cards.js — do not edit; run `node scripts/sync-vendored.mjs`
/**
 * Which history tool calls get an approval card, and what the card says (design 26110900 §2.3).
 *
 * On a host that can show cards, every gate is confirmed in the chat and only two calls get a card:
 *   - history_rollback with confirmForeign (discards other sessions' writes; the agent's own reading
 *     of the chat must not be enough for that);
 *   - gate "start" when the host's approveWrites is on (this one card approves all of the import's
 *     writes, since the import cannot ask before each one).
 * `askOnConfirm: true` brings back a card for every gate and every rollback. A host that cannot show
 * cards gets none: those two cases are confirmed in the chat (foreignDigest, choice approve_all_writes).
 *
 * @module mexplore-import/cards
 */

/**
 * @typedef {object} Card
 * @property {'foreign_rollback' | 'approve_all_writes' | 'gate' | 'rollback'} kind
 * @property {string} reason  short English reason, for the host's logs and audit
 * @property {string} zh      what the user is asked
 * @property {string} en
 */

/**
 * @param {string} tool
 * @param {object} args
 * @param {object} opts
 * @param {'supported' | 'unsupported'} opts.cards
 * @param {boolean} opts.askOnConfirm
 * @param {() => object | null} opts.plan   the plan on disk (null when there is none)
 * @param {boolean} opts.approveWrites     the host's current approveWrites setting
 * @param {string} opts.graphRoot
 * @returns {Card | null}
 */
export function cardFor(tool, args, { cards, askOnConfirm, plan, approveWrites, graphRoot }) {
  if (cards !== 'supported') return null
  args = args ?? {}
  if (tool === 'history_confirm' && args.gate === 'start') {
    // Built from the plan on disk, not from the agent's words: what exactly is being approved.
    let p = null
    try {
      p = plan()
    } catch {
      p = null
    }
    const all = p?.approveWrites === true || (p === null && approveWrites === true)
    if (!all && !askOnConfirm) return null
    const n = p?.delegations ?? '?'
    const where = p?.graphRoot ?? graphRoot
    return {
      kind: all ? 'approve_all_writes' : 'gate',
      reason: `history import: start writing (${n} delegations into ${where})`,
      en: all
        ? `Start the history import? This approves ALL writes of its ${n} memory-agent delegations into ${where} at once (approveWrites is on; there is no prompt per save).`
        : `Start the history import: ${n} memory-agent delegations writing into ${where}?`,
      zh: all
        ? `开始导入历史吗？这会一次批准它 ${n} 次记忆代理委派对 ${where} 的全部写入（approveWrites 已打开，之后不会每次写入都再问）。`
        : `开始导入历史：${n} 次记忆代理委派，写入 ${where}？`,
    }
  }
  if (tool === 'history_rollback' && args.confirmForeign === true) {
    return {
      kind: 'foreign_rollback',
      reason: 'history import: roll back the whole memory graph, discarding writes by other sessions',
      en: 'Roll back the whole memory graph and discard the listed writes by other sessions? The current state is kept as a backup.',
      zh: '回滚整张记忆图，并丢掉列出的其它会话写入的内容吗？当前状态会另存备份。',
    }
  }
  if (!askOnConfirm) return null
  if (tool === 'history_confirm') {
    return {
      kind: 'gate',
      reason: `history import: record the user's confirmation for gate "${args.gate}"`,
      en: `Confirm "${args.gate}" for the history import? (${String(args.userSaid ?? '').slice(0, 120)})`,
      zh: `确认历史导入的「${args.gate}」这一步吗？（${String(args.userSaid ?? '').slice(0, 120)}）`,
    }
  }
  if (tool === 'history_rollback') {
    return {
      kind: 'rollback',
      reason: 'history import: roll back the whole memory graph',
      en: `Roll back the whole memory graph (${args.to ?? 'last_batch'})? The current state is kept as a backup.`,
      zh: `把整张记忆图回滚（${args.to === 'before_import' ? '到导入之前' : '到上一批之前'}）吗？当前状态会另存备份。`,
    }
  }
  return null
}
