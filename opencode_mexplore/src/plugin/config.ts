/**
 * Options, defaults and the graph root (REQ-013, REQ-016).
 *
 * The graph root is the one thing every user must get right without being
 * asked, so it resolves automatically and the resolution is REPORTED: the
 * source travels in every result's metadata and in the startup log line, and
 * the default is never inside the plugin or the repo (a git-installed plugin's
 * directory is replaced on update, and this repo's `memory_fs/memories/` is
 * git-tracked, so user memories would be committed).
 *
 * @module mexplore/plugin/config
 */
import os from 'node:os'
import path from 'node:path'

/**
 * The plugin's own version, stamped into every usage record.
 *
 * A literal rather than a `package.json` read: at runtime the package directory
 * may be a git-checkout temp dir, and resolving a JSON file from inside a
 * compiled plugin is exactly the kind of thing that breaks on an install route.
 * A test keeps it honest against `package.json`.
 */
export const PLUGIN_VERSION = '0.3.1'

/** Default per-call budget (REQ-004, tentative per the spec). */
export const DEFAULT_TIMEOUT_MS = 180_000

/** How long teardown may take before the plugin stops waiting and logs (REQ-004). */
export const CLEANUP_BOUND_MS = 10_000

/**
 * The model-visible size cap on the final answer, matching the graph caps so a
 * child that pages through an attachment cannot spill the transcript to
 * `tool-output/` (SEC-004). Slightly under the graph numbers: the footer is
 * appended after the cap and must still fit.
 */
export const MAX_ANSWER_LINES = 1_900
export const MAX_ANSWER_BYTES = 45_000

/**
 * How long reading the child's final answer may take. Small on purpose: the
 * session is idle by then, so this only bounds a stalled host.
 */
export const INSPECT_BOUND_MS = 15_000

/**
 * The SERVER command's name.
 *
 * Deliberately not `mexplore`: the TUI owns that slash command and answers
 * instantly in a dialog (`src/tui.ts`), while this one is the deferred-reply
 * fallback every other client uses. A distinct name keeps the two surfaces from
 * being confused in help text, in the command palette, and in a user's config.
 *
 * It lives here, not in `command.ts`, because `command.ts` imports
 * `diagnostics.ts` and diagnostics' fix text has to name it — importing the
 * other way round would be a cycle.
 */
export const COMMAND_NAME = 'mexplore-settings'

/** The TUI's slash command, which shadows the server command inside the TUI. */
export const TUI_COMMAND_NAME = 'mexplore'

/** The memory provider's ID, and the integration that carries its key. */
export const PROVIDER_ID = 'mexplore'

/** Context metadata for the optional, explicitly configured custom provider. */
export const MEMORY_CONTEXT_LIMIT = 1_000_000

/** Provider package the memory provider is built on. */
export const PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible'

/** Storage keys (REQ-021). The API key is never one of them. */
export const STORAGE_KEYS = Object.freeze({
  /** `provider/model` chosen with `/mexplore model <provider/model>`. */
  model: 'model',
  /** Bare model id served by the memory provider. */
  mexploreModel: 'mexploreModel',
  /** The memory provider's base URL. */
  baseURL: 'baseURL',
})

/** Where a resolved graph root came from (REQ-016). */
export type GraphRootSource = 'option' | 'env' | 'default'

export interface ResolvedGraphRoot {
  path: string
  source: GraphRootSource
}

/** The normalized plugin options. Every one is optional (REQ-013). */
export interface MexploreOptions {
  graphRoot?: string
  timeoutMs?: number
  searchLimit?: number
  maxIndexEntries?: number
  /** Test-only: pin the crash sweep's owner token. Never set by users. */
  ownerToken?: string
  /** The usage log is ON by default; `usageLog: false` turns it off (Lane B). */
  usageLog?: boolean
  /** Test-only: relocate the usage directory instead of `$XDG_STATE_HOME`. */
  usageDir?: string
  /** Test-only: log which usage events actually arrived (integration evidence). */
  eventProbe?: boolean
  /**
   * dsh_plugin's 2a placeholder guards on the manage profile (default ON).
   *
   * `false` restores the plain library's behaviour; it exists so a user who
   * genuinely wants a body-less node can have one.
   */
  placeholderGuards?: boolean
}

export function readOptions(raw: Readonly<Record<string, unknown>> | undefined): MexploreOptions {
  // Defaults first: the log is on unless the user says otherwise.
  const options: MexploreOptions = { usageLog: readBoolean(raw?.usageLog) ?? true }
  const graphRoot = nonEmpty(raw?.graphRoot)
  if (graphRoot !== undefined) options.graphRoot = graphRoot
  const timeoutMs = positiveInt(raw?.timeoutMs)
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs
  const searchLimit = positiveInt(raw?.searchLimit)
  if (searchLimit !== undefined) options.searchLimit = searchLimit
  const maxIndexEntries = positiveInt(raw?.maxIndexEntries)
  if (maxIndexEntries !== undefined) options.maxIndexEntries = maxIndexEntries
  if (typeof raw?.ownerToken === 'string' && raw.ownerToken.length > 0) options.ownerToken = raw.ownerToken
  const usageDir = nonEmpty(raw?.usageDir)
  if (usageDir !== undefined) options.usageDir = path.resolve(usageDir)
  if (readBoolean(raw?.eventProbe) === true) options.eventProbe = true
  options.placeholderGuards = readBoolean(raw?.placeholderGuards) ?? true
  return options
}

/**
 * Resolve the graph root: option, then `MEXPLORE_GRAPH_ROOT`, then
 * `${XDG_DATA_HOME:-~/.local/share}/mexplore/graph`.
 *
 * A RELATIVE `XDG_DATA_HOME` is ignored, per the XDG spec, and the fallback is
 * used instead. `~` is expanded and the result always absolute, so the same
 * value reaches dsh on every route.
 */
export function resolveGraphRoot(
  options: MexploreOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedGraphRoot {
  const fromOption = nonEmpty(options.graphRoot)
  if (fromOption !== undefined) {
    return { path: absolutePath(fromOption), source: 'option' }
  }
  const fromEnv = nonEmpty(env.MEXPLORE_GRAPH_ROOT)
  if (fromEnv !== undefined) {
    return { path: absolutePath(fromEnv), source: 'env' }
  }
  const dataHome = nonEmpty(env.XDG_DATA_HOME)
  const base =
    dataHome !== undefined && path.isAbsolute(expandHome(dataHome))
      ? expandHome(dataHome)
      : path.join(os.homedir(), '.local', 'share')
  return { path: path.resolve(base, 'mexplore', 'graph'), source: 'default' }
}

/** Expand a leading `~` against the real home, then make the path absolute. */
export function absolutePath(input: string): string {
  return path.resolve(expandHome(input))
}

function expandHome(value: string): string {
  const input = value.trim()
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * A plugin option that must be a REAL boolean.
 *
 * `"false"` is a string, and treating it as truthy is the classic footgun: a
 * user who writes `usageLog: "false"` would keep logging. Strings are accepted
 * for the two unambiguous spellings, and anything else falls back to the default.
 */
function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'false') return false
  if (value === 'true') return true
  return undefined
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}
