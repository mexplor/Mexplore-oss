/**
 * Bundle row: direct tools. The core plugin, mounted for the main agent with
 * the bundle defaults filled in (graph root, 30-line index). Every core config
 * field is still accepted and passed through unchanged. It also registers
 * `history_import_help` (history-help.js): the history import runs only with
 * the memory agent switch, and this tells the user how to switch.
 *
 * Writes made here record the root chat they came from (design 26111000): the
 * row hands the core a `provenance(exec)` resolver that walks the calling
 * agent's session header to its root (bundle/provenance.js). A deployment may
 * pass its own `provenance` function and that one wins.
 *
 * @module dsh-mexplore/direct
 */

import * as core from '../index.js'
import { registerHistoryHelp } from './history-help.js'
import { chatResolver } from './provenance.js'
import { state, withDefaults } from './state.js'

export const name = 'memory-graph-direct'
export const inject = core.inject

/**
 * The config this row hands the core plugin: the bundle defaults, and a
 * `provenance(exec)` resolver that walks to the calling agent's root chat —
 * unless the deployment supplied its own, which then wins outright.
 */
export function directConfig(ctx, config = {}) {
  // The main agent here also holds shell and file tools, so its memory
  // section carries the hands-off rule (the deployment may still turn it off).
  const resolved = withDefaults({ handsOffRule: true, ...config })
  if (resolved.provenance === undefined) resolved.provenance = chatResolver(ctx)
  return resolved
}

export function apply(ctx, config = {}) {
  const resolved = directConfig(ctx, config)
  core.apply(ctx, resolved)
  // 「导入历史」 has no import tool in this mode (the history row needs the
  // memory agent); this one answers with the steps to switch over.
  registerHistoryHelp(ctx, resolved.graphRoot)
  state.directActive += 1
  // The memory-graph panel shows this graph while the agent row is off.
  state.directGraphRoot = resolved.graphRoot
  ctx.effect(() => () => {
    state.directActive -= 1
    if (state.directGraphRoot === resolved.graphRoot) state.directGraphRoot = undefined
  })
}
