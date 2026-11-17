/**
 * State shared by the three bundle rows (direct tools, `memory_agent`, and
 * the memory preset's tools).
 *
 * The rows load from one package, so Node gives them one instance of this
 * module, and a plain object is enough to carry per-delegation records from
 * `memory_agent` to the child's tools. Settings travel as a Cordis service
 * instead (SETTINGS_SERVICE), because they must also order the rows. Nothing
 * here is persisted.
 *
 * @module dsh-mexplore/bundle/state
 */

/** Where memory lives when the deployment does not say. */
export const DEFAULT_GRAPH_ROOT = '~/.dsh/memory-graph'

/**
 * Index lines in the prompt. 30, not the plugin's own 200: on LongMemEval
 * (2026-11-05 read ablation) direct tools with a 200-line index answered
 * worse than with 30, while the memory agent was unaffected.
 */
export const DEFAULT_MAX_INDEX_ENTRIES = 30

/**
 * Cordis service the `memory_agent` row provides (its resolved settings). The
 * preset rows inject it, so they load only after that row, reload when its
 * config changes, and do not load at all while the memory agent is off.
 */
export const SETTINGS_SERVICE = 'mexplorMemoryAgent'

/** Preset ids the bundle ships for the memory agent's two authority tiers. */
export const READ_PRESET = 'mexplor-memory-read'
export const MANAGE_PRESET = 'mexplor-memory-manage'

export const state = {
  /** Number of live direct-mode rows; `memory_agent` refuses while any run. */
  directActive: 0,
  /** Graph root of the live direct-mode row (raw config string), for the panel. */
  directGraphRoot: undefined,
  /** childId -> delegation record (see agent.js). */
  delegations: new Map(),
}

/**
 * The plugin config a bundle row hands to the core plugin: the deployment's
 * own fields win, and only missing ones take the bundle defaults.
 */
export function withDefaults(config = {}) {
  return {
    graphRoot: DEFAULT_GRAPH_ROOT,
    maxIndexEntries: DEFAULT_MAX_INDEX_ENTRIES,
    ...config,
  }
}
