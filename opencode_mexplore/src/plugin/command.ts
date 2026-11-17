/**
 * `/mexplore`: every memory setting, from inside OpenCode, with no file edit and
 * no restart (REQ-021).
 *
 * The reply goes through ONE helper, {@link reply}, so the transport is
 * swappable: `ctx.session.synthetic({ resume: false })` admits a message without
 * waking the model, and whether the TUI shows it is an SP-3 question. Nothing
 * in this file may echo the API key: it is never read here at all, only asked
 * for by presence (`ctx.integration.connection.active`), and `/mexplore key`
 * only explains the `/connect` route. A key typed into a command would be saved
 * with the session, so the argument form is refused outright.
 *
 * @module mexplore/plugin/command
 */
import type { AvailableModel } from './diagnostics'
import { baseURLProblem } from './diagnostics'
import { hostGenerateText, type HostContext } from './host'
import type { ResolvedGraphRoot } from './config'
import {
  COMMAND_NAME,
  PROVIDER_ID,
  STORAGE_KEYS,
} from './config'
import {
  categoricalProviderError,
  makeSanitizer,
  redactSecrets,
  refreshSanitizer,
  type Sanitizer,
} from './redact'
import { memoryProviderUse, needsCategoricalErrors, providerUse, type CredentialSources } from './credentials'
import type { Settings } from './settings'
import { readUsage as readUsageImpl, resolveUsageDir, summarizeUsage } from './usage-log'
import { BUN_REQUIRED, startUi, stopUi, uiReply } from './ui'
import { formatModelRef, providerConfig, readSettings, replaceSettings, resolveModel } from './settings'
import type { ModelRef, ModelSource } from './types'

/** The one reply helper. Swappable on purpose (SP-3 checks visibility). */
export type Reply = (sessionID: string, text: string) => Promise<void>

export function syntheticReply(ctx: HostContext): Reply {
  return async (sessionID, text) => {
    // The command sanitized this already (`runCommandText`). This is the shape
    // BACKSTOP for anything that reached the transport by another route.
    await ctx.session.synthetic({ sessionID, text: redactSecrets(text), description: 'mexplore', resume: false })
  }
}

export interface CommandDeps {
  ctx: HostContext
  reply: Reply
  graphRoot: ResolvedGraphRoot
  /** The live settings object: the provider transform reads this same object. */
  settings: Settings
  /** Serializes every WRITE, so two finishing commands cannot interleave. */
  writers?: WriterQueue
  /** Called after a change so the transform replays with the new values. */
  reloadProvider: () => Promise<void>
  /** Reports problems found at setup, before any command changed anything. */
  diagnostic: () => Promise<string | undefined>
  /** The parent's cached model, for the `parent-fallback` status line. */
  parentModel?: (sessionID: string) => ModelRef | undefined
  /** Collects the credentials replies must be scrubbed of (lazily). */
  credentialSources?: CredentialSources
  /** Where the usage log writes, and whether it is on (Lane B). */
  usageDir?: string
  usageEnabled?: boolean
  /** 2a placeholder guards on the manage profile (default on). */
  placeholderGuards?: boolean
  /** Replaces the usage reader in tests. */
  readUsage?: typeof readUsageImpl
  /** The `/mexplore ui` surface, overridable so a test needs no real server. */
  ui?: UiControls
}

/** The dashboard controls `/mexplore ui` needs (Lane B, item 5). */
export interface UiControls {
  start: (input: { graphRoot: string; usageDir: string }) => Promise<{ url: string; port: number }>
  stop: (graphRoot: string) => Promise<boolean>
  url: (graphRoot: string) => string | undefined
  bun: () => boolean
}

// The two names live in `config.ts` (diagnostics names them in its fix text, and
// this module already imports diagnostics); re-exported so a caller of the
// command module has one place to look.
export { COMMAND_NAME, TUI_COMMAND_NAME } from './config'

/**
 * The session a TUI-issued RPC is attributed to when the TUI could not name one.
 *
 * The parent-model lookup is the ONLY thing a session is used for, and a TUI
 * invocation may come from the home screen, where there is no session. Missing
 * the cached model then only changes one status line to `default`; it must never
 * block a settings change.
 */
export const TUI_COMMAND_SESSION = 'mexplore:tui'

/** How long a `test` invocation waits for its one tiny request. */
const TEST_BOUND_MS = 30_000

export const COMMAND_DESCRIPTION =
  'Inspect and change mexplore memory settings: model, base URL, key, test, reset.'

/**
 * Usage text, shared by the bare command and every parse failure.
 *
 * `command` is the label the caller was invoked under — `/mexplore` in the TUI,
 * `/mexplore-settings` on desktop and web — so help always names a command the
 * user can actually type where they are. It defaults to the server command's
 * name, which is the one that exists in every client.
 */
/** `realpath`, falling back to the input when the directory does not exist. */
async function realpathOf(target: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(target).catch(() => target)
}

/** The usage summary's window, in days (Lane B, item 4). */
export const USAGE_WINDOW_DAYS = 30

export function commandUsage(command: string = COMMAND_NAME): string {
  const at = `/${command}`
  return [
    `${at} — show status`,
    `${at} model <model-id> — another model on the mexplore provider (same base URL and key)`,
    `${at} model <provider/model> — any OpenCode model (uses that provider's own key)`,
    `${at} base-url <url> — the mexplore provider base URL`,
    `${at} key — how to set or replace the API key`,
    `${at} test — one tiny request to the memory model`,
    `${at} reset — back to the defaults (the key is kept)`,
    `${at} usage — token usage for the last ${USAGE_WINDOW_DAYS} days (this graph)`,
    `${at} ui [stop] — the local usage dashboard`,
    `${at} help — this text`,
  ].join('\n')
}

/**
 * The one implementation of every mexplore settings subcommand, returning the
 * reply TEXT (REQ-021).
 *
 * Two callers share it, and neither owns the text: the server command posts it
 * through `ctx.session.synthetic`, and the RPC method behind the TUI part hands
 * it back so the TUI can show it in a dialog. Keeping it a pure
 * `args -> string` function is what stops the two surfaces from drifting.
 *
 * `text` is the raw argument text the user typed: the TUI sends the slash
 * arguments, the server command sends `prompt.text`. A leading `/mexplore` or
 * `/mexplore-settings` is tolerated because some clients keep it.
 *
 * Serialized through the writer queue, reads included: two invocations must not
 * finish out of order, or the provider could serve an older value than storage.
 */
export async function runCommandText(
  deps: CommandDeps,
  input: { sessionID: string; text: string; label?: string },
): Promise<string> {
  // ONE sanitize for every transport. Both the server command's synthetic reply
  // and the RPC the TUI shows call this function, so scrubbing here is the only
  // place that cannot be bypassed (AC-025, SEC-006). A failure reply is scrubbed
  // too: it quotes the argument the user typed, which may be a pasted key.
  const sanitize = await sanitizerFor(deps, input)
  const label = input.label ?? COMMAND_NAME
  const dispatch = async (): Promise<string> => sanitize.text(await dispatchCommand(deps, { ...input, label }))
  if (deps.writers === undefined) return dispatch()
  return deps.writers.run(dispatch)
}

/**
 * The credentials a reply must be scrubbed of.
 *
 * A `/mexplore test` exercises the SELECTED model, which may be another
 * provider's — so that provider's key is collected too, not just ours. With no
 * provider named (the general case) the memory provider plus whatever the
 * selected model uses is the safe superset.
 */
async function credentialsFor(deps: CommandDeps, model: ModelRef | undefined): Promise<string[]> {
  if (deps.credentialSources === undefined) return []
  return deps.credentialSources.collect([
    memoryProviderUse(),
    ...(model === undefined || model.providerID === PROVIDER_ID ? [] : [providerUse(model.providerID)]),
  ])
}

/** A sanitizer bound to those credentials, refreshed now (rotation is followed). */
async function sanitizerFor(deps: CommandDeps, input: { sessionID: string }): Promise<Sanitizer> {
  const settings = await readSettings(deps.ctx.storage)
  const hasKey = (await deps.ctx.integration.connection.active(PROVIDER_ID)) !== undefined
  const model = resolveForStatus(settings, hasKey, deps.parentModel?.(input.sessionID)).model
  const sanitize = makeSanitizer(() => credentialsFor(deps, model))
  await refreshSanitizer(sanitize)
  return sanitize
}

/**
 * Run one `/mexplore` invocation and post its reply with the configured
 * transport (the server command's synthetic message).
 */
export async function runCommand(
  deps: CommandDeps,
  input: { sessionID: string; text: string; label?: string },
): Promise<void> {
  const text = await runCommandText(deps, input)
  await deps.reply(input.sessionID, text)
}

async function dispatchCommand(
  deps: CommandDeps,
  input: { sessionID: string; text: string; label: string },
): Promise<string> {
  // Strip whichever label the client sent: `/mexplore` (TUI) or
  // `/mexplore-settings` (desktop/web). Both reach the same subcommands.
  const text = input.text.trim().replace(/^\/(?:mexplore-settings|mexplore)\b/, '').trim()
  const [head, ...rest] = text.length === 0 ? [] : text.split(/\s+/)
  const argument = rest.join(' ').trim()

  if (head === undefined || head === 'status') return statusText(deps, input.sessionID, input.label)
  if (head === 'model') return setModel(deps, argument, input.label)
  if (head === 'base-url' || head === 'base_url' || head === 'baseurl') {
    return setBaseURL(deps, argument, input.label)
  }
  if (head === 'key') {
    // A key typed here would be saved with the session, so the argument form is
    // refused outright — and never echoed back (AC-025).
    return argument.length === 0
      ? KEY_TEXT
      : `Refused: a key is never accepted as a command argument — command text can be saved with the session, and nothing was stored.\n\n${KEY_TEXT}`
  }
  if (head === 'test') return testModel(deps, input.sessionID, input.label)
  if (head === 'reset') return reset(deps)
  if (head === 'usage') return usageText(deps)
  if (head === 'ui') return uiText(deps, argument)
  if (head === 'help') {
    return helpText(input.label, {
      enabled: deps.usageEnabled !== false,
      dir: deps.usageDir ?? resolveUsageDir(),
    })
  }
  return `Unknown \`/${input.label} ${head}\` subcommand.\n\n${commandUsage(input.label)}`
}

/**
 * `/mexplore usage` — the last 30 days for THIS graph (Lane B, item 4).
 *
 * Read from the log, not from live state: the question is "what have I spent",
 * which outlives any one process.
 */
async function usageText(deps: CommandDeps): Promise<string> {
  if (deps.usageEnabled === false) {
    return 'mexplore usage log is off (`usageLog: false` in the plugin options), so nothing has been recorded by this OpenCode.'
  }
  const dir = deps.usageDir ?? resolveUsageDir()
  const read = deps.readUsage ?? readUsageImpl
  // Records carry the graph's REAL path (the contract says so), so the filter has
  // to compare against a realpath too — on macOS `/tmp` is `/private/tmp`, and a
  // lexical path would match nothing and report a misleading "no calls".
  const records = await read(dir, {
    days: USAGE_WINDOW_DAYS,
    graphRoot: await realpathOf(deps.graphRoot.path),
  })
  return `${summarizeUsage(records, USAGE_WINDOW_DAYS)}\nLog: ${dir}`
}

/**
 * `/mexplore ui` and `/mexplore ui stop` (Lane B, item 5).
 *
 * The reply carries the tokenised URL the UI handed back, plus what it takes to
 * shut it down — a URL nobody can stop is a port leak waiting for the next
 * reload.
 */
async function uiText(deps: CommandDeps, argument: string): Promise<string> {
  const controls = deps.ui
  if (controls !== undefined && !controls.bun()) return BUN_REQUIRED
  // The guard is about the RUNTIME, not the implementation: the UI server is
  // `Bun.serve`, so a Node build of OpenCode cannot host it.
  if (controls === undefined && typeof Bun === 'undefined') return BUN_REQUIRED

  const [action] = argument.length === 0 ? [] : argument.split(/\s+/)
  const graphRoot = deps.graphRoot.path
  const usageDir = deps.usageDir ?? resolveUsageDir()

  if (action === 'stop') {
    const stopped = controls === undefined ? await stopUi(graphRoot) : await controls.stop(graphRoot)
    return stopped
      ? 'mexplore usage UI stopped.'
      : 'No mexplore usage UI is running for this graph in this OpenCode process.'
  }
  if (action !== undefined) {
    return `Usage: /${COMMAND_NAME} ui [stop] — start the usage dashboard, or stop it.`
  }
  try {
    const started =
      controls === undefined
        ? await startUi({ graphRoot, usageDir })
        : await controls.start({ graphRoot, usageDir })
    return uiReply(started.url).join('\n')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `mexplore: could not start the usage UI — ${detail}`
  }
}

/**
 * `/mexplore help` — the welcome text (Lane B, item 7).
 *
 * One text for both surfaces: what memory does, the three setup steps, where
 * memory and the usage log live, how to turn the log off, and the promise that
 * saves are announced.
 */
export function helpText(
  label: string = COMMAND_NAME,
  usage: { enabled: boolean; dir: string } = { enabled: true, dir: '~/.local/state/mexplore' },
): string {
  return [
    'mexplore — long-term memory for OpenCode',
    '',
    'The agent uses it on its own: it recalls before decisions, and saves durable decisions,',
    'preferences, corrections and outcomes. Every save is announced in the reply as "saved to memory: …".',
    '',
    'Setup:',
    '  1. Start a conversation: memory inherits its model and provider credentials by default.',
    `  2. Optional: /${label} model <provider/model> — select an independent memory model.`,
    `  3. Check it: /${label} test; /${label} ui opens the dashboard.`,
    '',
    `No separate key is needed for inherited or host-provider models. /${label} reset restores inheritance.`,
    '',
    `Memory lives in a graph directory on this machine; /${label} status shows where.`,
    usage.enabled
      // The ACTUAL resolved directory, not a hardcoded default (review copy fix
      // a): a user who moved it with XDG_STATE_HOME must see their own path.
      ? `Token usage is logged to ${usage.dir} (one JSON line per call: numbers only).`
      : 'Token usage logging is off (the plugin option usageLog: false).',
    `  ${usage.enabled ? 'Turn it off with the plugin option usageLog: false; ' : ''}see /${label} usage.`,
    '',
    commandUsage(label),
  ].join('\n')
}

const KEY_TEXT = [
  'The memory API key lives in OpenCode\'s credential store, not in plugin settings or command text.',
  '',
  'Set or replace it: run `/connect` → mexplore and paste the key (masked input).',
  'Remove it: `opencode auth logout mexplore`.',
  '',
  'This key is optional: inherited and host-provider models use their own credentials.',
  'For a custom mexplore provider, configure both `/mexplore base-url <url>` and `/mexplore model <model-id>` before connecting its key.',
].join('\n')

async function statusText(deps: CommandDeps, sessionID: string, label: string): Promise<string> {
  // A READ: it never writes the live object the provider transform closes over.
  const settings = await readSettings(deps.ctx.storage)
  const hasKey = (await deps.ctx.integration.connection.active(PROVIDER_ID)) !== undefined
  const resolved = resolveForStatus(settings, hasKey, deps.parentModel?.(sessionID))
  const provider = providerConfig(settings)
  const lines = [
    'mexplore memory',
    '',
    `model: ${resolved.model === undefined ? '(none yet — start a conversation or finish the explicit memory model setup)' : formatModelRef(resolved.model)} (source: ${resolved.source})`,
    `base URL: ${provider.baseURL || '(not configured; inherited models use their host provider)'}${settings.baseURL === undefined ? '' : ' (custom)'}`,
    `key: ${hasKey ? 'connected (optional custom provider)' : 'missing (optional; inherited and host-provider models use their own credentials)'}`,
    `graph: ${deps.graphRoot.path} (source: ${deps.graphRoot.source})`,
    `usage log: ${deps.usageEnabled === false ? 'off' : `on (${deps.usageDir ?? resolveUsageDir()})`}`,
    `placeholder guards: ${deps.placeholderGuards === false ? 'off' : 'on (manage writes need a real body)'}`,
  ]
  const diagnostic = await deps.diagnostic()
  if (diagnostic !== undefined) lines.push('', `problem: ${diagnostic}`)
  lines.push('', commandUsage(label))
  return lines.join('\n')
}

function resolveForStatus(
  settings: Settings,
  hasKey: boolean,
  parentModel: ModelRef | undefined,
): { model: ModelRef | undefined; source: ModelSource } {
  const resolved = resolveModel({ settings, hasKey, ...(parentModel === undefined ? {} : { parentModel }) })
  return resolved ?? { model: undefined, source: settings.mexploreModel === undefined ? 'parent-fallback' : 'default' }
}

/**
 * `model <x>` (via `/mexplore` in the TUI, `/mexplore-settings` elsewhere):
 *   - `provider/model` selects any OpenCode model, validated against
 *     `ctx.model.list()` (enabled AND tool-capable) and stored as `model`;
 *   - a bare id means a model served by the mexplore provider at the current
 *     base URL, stored as `mexploreModel` and applied by a provider reload.
 */
async function setModel(deps: CommandDeps, argument: string, label: string): Promise<string> {
  if (argument.length === 0) {
    return `Usage: /${label} model <model-id> | <provider/model>\n\n${commandUsage(label)}`
  }
  if (/\s/.test(argument)) {
    return `Refused: "${argument}" is not a single model id. Nothing was stored.`
  }
  // The CONNECTED key is refused by identity, not by shape: an opaque key looks
  // like any other id, and storing it would put a credential in plugin storage
  // (AC-025).
  // The CONNECTED key is refused by identity, not by shape: an opaque key looks
  // like any other id, and storing it would put a credential in plugin storage
  // AND in the startup log (AC-025). Raw and both encoded forms count.
  if (await carriesCredential(deps, argument)) {
    return 'Refused: that contains the connected memory API key, not a model id, and nothing was stored. Memory settings never hold a key — use `/connect` → mexplore.'
  }
  if (looksSecret(argument)) {
    return 'Refused: that looks like a credential, not a model id, and nothing was stored. Memory settings never hold a key — use `/connect` → mexplore.'
  }
  // A FULL ref into our OWN provider is the bare-model route: `model
  // mexplore/deepseek-v4-pro` must store `mexploreModel=deepseek-v4-pro`. Storing
  // it as a `provider/model` selection would clear `mexploreModel` and reload a
  // provider that no longer registers the selected model (Major 9).
  const ownPrefix = `${PROVIDER_ID}/`
  if (argument.startsWith(ownPrefix) && !argument.slice(ownPrefix.length).includes('/')) {
    return setBareModel(deps, argument.slice(ownPrefix.length), label)
  }
  if (argument.includes('/')) {
    const models = (await deps.ctx.model.list()).data
    const match = models.find((model) => `${model.providerID}/${model.id}` === argument)
    const problem = unavailable(match)
    if (problem !== undefined) {
      return `Refused: ${argument} — ${problem}. Nothing was stored.`
    }
    await deps.ctx.storage.set(STORAGE_KEYS.model, argument)
    await deps.ctx.storage.remove(STORAGE_KEYS.mexploreModel)
    deps.settings.model = argument
    delete deps.settings.mexploreModel
    await deps.reloadProvider()
    return `Memory model set to ${argument} (source: selected). It uses that provider's own key and base URL. Takes effect on the next mexplore call.`
  }
  if (argument.includes('#')) {
    return `Refused: "${argument}" — variants are not supported for a memory model. Nothing was stored.`
  }
  return setBareModel(deps, argument, label)
}

/**
 * The bare-model route: a model served by the memory provider at its current
 * base URL. Stored as `mexploreModel`, which the provider registers, so the
 * selection is always what the next call runs on.
 */
async function setBareModel(deps: CommandDeps, modelID: string, label: string): Promise<string> {
  if (modelID.length === 0) {
    return `Usage: /${label} model <model-id> | <provider/model>\n\n${commandUsage(label)}`
  }
  if (modelID.includes('#')) {
    return `Refused: "${modelID}" — variants are not supported for a memory model. Nothing was stored.`
  }
  await deps.ctx.storage.set(STORAGE_KEYS.mexploreModel, modelID)
  await deps.ctx.storage.remove(STORAGE_KEYS.model)
  deps.settings.mexploreModel = modelID
  delete deps.settings.model
  await deps.reloadProvider()
  const { baseURL } = providerConfig(deps.settings)
  return [
    `Memory model set to ${PROVIDER_ID}/${modelID}${baseURL ? ` on ${baseURL}` : `; configure /${label} base-url <url> before using it`}. Takes effect on the next mexplore call once its endpoint and key are configured.`,
    `The provider cannot check a bare model id in advance: run \`/${label} test\` to confirm it answers.`,
  ].join('\n')
}

function unavailable(match: AvailableModel | undefined): string | undefined {
  if (match === undefined) return 'that model is not available in this OpenCode'
  if (!match.enabled) return 'that model is disabled'
  if (!match.capabilities.tools) return 'that model cannot call tools, and the memory agent needs tool calls'
  return undefined
}

async function setBaseURL(deps: CommandDeps, argument: string, label: string): Promise<string> {
  if (argument.length === 0) {
    return `Usage: /${label} base-url <url>\n\n${commandUsage(label)}`
  }
  // Credential check FIRST: a rejection message quotes the URL back, and a URL
  // carrying a key must not be repeated to the user or a log (SEC-006).
  if (await carriesCredential(deps, argument)) {
    return 'Refused: that URL contains the connected memory API key, and nothing was stored. The key belongs in `/connect` → mexplore, not in the base URL.'
  }
  if (hasCredential(argument)) {
    return 'Refused: that URL carries a credential (a query parameter or user info), and nothing was stored. The key belongs in `/connect` → mexplore, not in the base URL.'
  }
  const problem = baseURLProblem(argument)
  if (problem !== undefined) {
    return `Refused: ${argument} — ${problem}. Nothing was stored.`
  }
  await deps.ctx.storage.set(STORAGE_KEYS.baseURL, argument)
  deps.settings.baseURL = argument
  await deps.reloadProvider()
  return `Memory provider base URL set to ${argument}. A call already running keeps its own endpoint; the next call uses this one.`
}

/**
 * `/mexplore test`: one tiny request through the memory model, so a wrong model,
 * URL or key shows up immediately (AC-026). It never starts a child session.
 */
async function testModel(deps: CommandDeps, sessionID: string, label = COMMAND_NAME): Promise<string> {
  const settings = await readSettings(deps.ctx.storage)
  const hasKey = (await deps.ctx.integration.connection.active(PROVIDER_ID)) !== undefined
  // The same resolution a real call uses, including the parent fallback: testing
  // a different model than the one calls would run makes the answer worthless.
  const resolved = resolveForStatus(settings, hasKey, deps.parentModel?.(sessionID))
  if (resolved.model === undefined) {
    return `Cannot test: no usable memory model is known yet. Start a conversation to inherit its model, or run \`/${label} model <provider/model>\`. A custom mexplore model needs an explicit base URL, model id and \`/connect\` → mexplore key.`
  }
  const generateText = hostGenerateText(deps.ctx)
  if (generateText === undefined) {
    return 'Cannot test: this OpenCode version gives plugins no text-generation API (neither `experimental.generate` nor `generate`). Update OpenCode.'
  }
  const started = Date.now()
  try {
    // Bounded: `/mexplore test` shares the command queue, so a provider that
    // never answers must not lock out the very command that fixes it.
    const result = await withTimeout(
      generateText({
        prompt: 'Reply with the single word: ok',
        model: resolved.model,
      }),
      TEST_BOUND_MS,
    )
    const latency = Date.now() - started
    const reply = (result.text ?? '').trim().slice(0, 200)
    return `OK — ${formatModelRef(resolved.model)} answered in ${latency} ms${reply.length === 0 ? '' : `: "${reply}"`}.`
  } catch (error) {
    // A provider error is the one string here that is NOT ours, and `/mexplore
    // test` runs the SELECTED model — possibly another provider's, with its own
    // key. Refresh against THAT provider before quoting anything (AC-025).
    const sanitize = makeSanitizer(() => credentialsFor(deps, resolved.model))
    await refreshSanitizer(sanitize)
    // When that provider's key could not be resolved, exact redaction is
    // impossible, so the body is dropped and only the category is reported.
    const known = await credentialsFor(deps, resolved.model).catch(() => [] as string[])
    const detail =
      resolved.model.providerID !== PROVIDER_ID && needsCategoricalErrors([providerUse(resolved.model.providerID)], known)
        ? categoricalProviderError(resolved.model.providerID, error)
        : errorText(error)
    return `FAILED — ${formatModelRef(resolved.model)}: ${sanitize.text(detail)}\n\nCheck the model id, the base URL (\`/${label} status\`) and the key (\`/connect\` → mexplore).`
  }
}

async function reset(deps: CommandDeps): Promise<string> {
  await Promise.all([
    deps.ctx.storage.remove(STORAGE_KEYS.model),
    deps.ctx.storage.remove(STORAGE_KEYS.mexploreModel),
    deps.ctx.storage.remove(STORAGE_KEYS.baseURL),
  ])
  replaceSettings(deps.settings, {})
  await deps.reloadProvider()
  return 'Memory settings reset: memory will inherit the current OpenCode session model. No custom endpoint or model is selected. The connected key was not touched (`opencode auth logout mexplore` removes it).'
}

/**
 * Is this argument shaped like a credential? A model id is a short slug; a key
 * is long and opaque, and `model <key>` would both store it in plugin
 * storage and echo it into a persisted reply (AC-025: the key is never stored).
 */
function looksSecret(argument: string): boolean {
  // Only shapes that are NEVER a model id: a key prefix, a bare hex key, a JWT.
  // A length rule would reject real ids such as
  // `openrouter/meta-llama/llama-3.3-70b-instruct` (AC-021).
  return /^(sk|pk|rk)-/i.test(argument) || /^[0-9a-f]{32,}$/i.test(argument) || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(argument)
}

/**
 * Does `value` contain the connected credential, raw OR encoded? (AC-025, SEC-006)
 *
 * A key can ride into a setting as a substring — `opaque+proxy/key` inside a
 * model id or a `?api_key=` URL — and an encoded copy (`%2B`, `%2F`, or
 * `encodeURI`'s `+` for a space) is still the credential. Both encode forms are
 * checked, so storage never holds one and the startup log never prints one.
 */
async function carriesCredential(deps: CommandDeps, value: string): Promise<boolean> {
  const resolved = await credentialsFor(deps, undefined).catch(() => [] as string[])
  if (resolved.length === 0) return false
  const haystack = value.toLowerCase()
  // Case-insensitive: `%2B` and `%2b` are the same byte, and a real URL mixes
  // them freely. Lowercasing both sides avoids enumerating hex-case variants.
  return resolved.some((credential) =>
    forms(credential).some((form) => haystack.includes(form.toLowerCase())),
  )
}

/**
 * The credential in every form a client might send it.
 *
 * Two encoders, because they disagree in exactly the cases that matter:
 * `encodeURIComponent` leaves `/` alone (so a key containing a slash is never
 * escaped by it), while an RFC 3986 "everything reserved" escape turns `/` into
 * `%2F`. Hex case differs too (`%2f` === `%2F`), and a form body may use `+`
 * for a space. All of them are checked, raw included.
 */
function forms(credential: string): string[] {
  const results = new Set<string>([credential, encodeURIComponent(credential)])
  const fullEscape = [...credential]
    .map((char) => (/[A-Za-z0-9\-_.!~*'()]/.test(char) ? char : `%${hexByte(char)}`))
    .join('')
  for (const form of [encodeURIComponent(credential), fullEscape]) {
    results.add(form)
    results.add(form.toLowerCase())
    results.add(form.replace(/%20/g, '+'))
    results.add(form.replace(/%20/g, '+').toLowerCase())
  }
  return [...results].filter((form) => form.length > 0)
}

/** One character's UTF-8 bytes as `%XX` escapes (handles non-ASCII correctly). */
function hexByte(char: string): string {
  return [...new TextEncoder().encode(char)]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join('%')
}

/** Does this URL carry a credential the plugin must never persist (SEC-006)? */
function hasCredential(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username.length > 0 || url.password.length > 0) return true
    for (const key of url.searchParams.keys()) {
      if (/^(api[_-]?key|key|token|access_token|secret|password|auth)$/i.test(key)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Run `work` with a deadline. `TEST_BOUND_MS` is generous — a tiny prompt — and
 * only exists so a hung provider cannot block the command queue.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/**
 * One-at-a-time command execution.
 *
 * `/mexplore` mutations are read-modify-write against `ctx.storage` plus an
 * in-place update of the live settings object the provider transform reads. Two
 * of them overlapping can finish out of order, leaving the provider serving the
 * older value while storage holds the newer one — a state no later reload
 * repairs, because the transform replays the live object. Serializing makes the
 * last writer the last one to finish.
 */
export class WriterQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    // The chain survives a failed command, or one failure would strand the rest.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
