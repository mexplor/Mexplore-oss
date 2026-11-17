/**
 * `history_import_help`: what the main agent gets for 「导入历史」 / "import my history" while the
 * direct memory tools are on. The import itself (the `memory-graph-history` row) loads only with the
 * memory agent switch, because the memory agent is its only writer. Without this tool, a direct-mode
 * agent asked to import had no import tool at all and improvised one: in a 2026-11 DSH session it wrote
 * its own script that put nodes into the graph and made every edge an empty directory, bypassing the
 * write checks, the cursor and the rollback.
 *
 * The direct row registers it, so it exists exactly while the import cannot run (the two switches are
 * alternatives; with the agent switch on, the history row's own tools answer instead). It imports and
 * writes nothing: it reads the node count and returns the steps to switch over.
 *
 * @module dsh-mexplore/bundle/history-help
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defineTool } from '../tool.js'
import { ULID_RE } from '../graph.js'
import { JOB_DEFAULTS } from '../import/index.js'
import { DEFAULT_GRAPH_ROOT } from './state.js'

export const HELP_TOOL_NAME = 'history_import_help'

/** The switch names as the Plugins page shows them (locale/direct, locale/agent, locale/history). */
export const SWITCHES = Object.freeze({
  direct: { id: 'memory-graph-direct', en: 'Mexplore · Memory tools (direct)', zh: 'Mexplore · 直接挂载记忆工具' },
  agent: { id: 'memory-graph-agent', en: 'Mexplore · Memory agent', zh: 'Mexplore · 记忆代理' },
  history: { id: 'memory-graph-history', en: 'Mexplore · Import history', zh: 'Mexplore · 导入历史' },
})

const DESCRIPTION = [
  'Call this when the user asks to import past conversations or chat history into memory (「导入历史」,',
  '"import my history"). The history import does not run while the direct memory tools are on; this',
  'returns the exact steps to switch it on and why. It imports and writes nothing itself.',
].join('\n')

function expandHome(p) {
  if (p === '~') return os.homedir()
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

/** Live nodes, counted the way the import's size precondition counts them. */
function countNodes(root) {
  try {
    return fs.readdirSync(root).filter((d) => ULID_RE.test(d) && fs.existsSync(path.join(root, d, 'node.md'))).length
  } catch {
    return 0
  }
}

/**
 * The answer, in English with the Chinese switch names beside the English ones; the agent relays it in
 * the user's language.
 * @param {{graphRoot: string, nodeCount: number, maxExistingNodes?: number}} opts
 */
export function helpText({ graphRoot, nodeCount, maxExistingNodes = JOB_DEFAULTS.maxExistingNodes }) {
  const { direct, agent, history } = SWITCHES
  const custom = graphRoot !== DEFAULT_GRAPH_ROOT
  const lines = [
    'The history import is not available right now, and nothing has been imported.',
    '',
    `Why: the import only runs with the "${agent.en}" switch on, because the memory agent is its only writer. Each imported conversation goes through the memory agent's write checks, with a snapshot of the graph before every batch, a cursor to resume from, and whole-graph rollback. With the direct memory tools there is no such writer.`,
    'Do not import any other way: never write an import script, and never create nodes or edges in the graph with shell, file or script tools. Hand-made nodes and edges skip all of the above, and an edge that is not a symlink is not an edge.',
    '',
    'Steps for the user:',
    `1. In Plugins, open Mexplore. Turn OFF "${direct.en}" (「${direct.zh}」, ${direct.id}) and turn ON "${agent.en}" (「${agent.zh}」, ${agent.id}). "${history.en}" (「${history.zh}」, ${history.id}) then loads by itself. No restart is needed for the switches.`,
  ]
  if (custom) {
    lines.push(
      `2. This chat's memory graph is ${graphRoot}, set by a cordis.patch.yml override on ${direct.id}. The memory agent uses ${DEFAULT_GRAPH_ROOT} unless its own row says otherwise, so give it the same graph (skip this if ${agent.id} already has it): in the profile's cordis.patch.yml (DeepSeek Harness Desktop: ~/.dsh/profiles/desktop/cordis.patch.yml; back the file up first; an override replaces the row's whole config) add`,
      `     - id: ${agent.id}`,
      `       config: { graphRoot: ${graphRoot} }`,
      '   then restart DeepSeek Harness.',
    )
  } else {
    lines.push(`2. Both switches use the same graph (${graphRoot}), so cordis.patch.yml needs no change.`)
  }
  lines.push(
    '3. Open a new chat and say 「导入历史」 / "import my history". The agent then walks through the scan, four confirmations (scope, privacy, mode, start) and the batches.',
    '',
    nodeCount > maxExistingNodes
      ? `Note: this version imports only into an empty or small graph (at most ${maxExistingNodes} existing nodes), and this graph has ${nodeCount}. Point the memory agent's graphRoot at a new empty directory for the import, and switch back later.`
      : `Note: this version imports only into an empty or small graph (at most ${maxExistingNodes} existing nodes); this graph has ${nodeCount}, so it qualifies.`,
  )
  return lines.join('\n')
}

/** Register the tool for the direct row; `graphRoot` is the row's resolved (unexpanded) config value. */
export function registerHistoryHelp(ctx, graphRoot) {
  const definition = defineTool({
    name: HELP_TOOL_NAME,
    description: DESCRIPTION,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => ({ text: helpText({ graphRoot, nodeCount: countNodes(expandHome(graphRoot)) }) }),
    // A read, like memory_search: no approval card in any access mode.
    presentCall: (args) => ({ card: 'generic', title: 'History import: how to turn it on', kind: 'read', rawInput: args }),
  })
  definition.isConcurrencySafe = () => true
  ctx.effect(() => ctx.tools.register(definition))
}
