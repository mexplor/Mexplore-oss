/**
 * mexplore for OpenCode V2 — the plugin entry (lane A2).
 *
 * Wiring only: every decision lives in a sibling module, and this file orders
 * them. The order is fixed by the API, not by taste:
 *
 *   1. resolve the graph root and options (sync, no host calls);
 *   2. load the settings from `ctx.storage` FIRST — the provider transform is
 *      sync and reads the captured object;
 *   3. load the graph (A1) and run the diagnostics;
 *   4. register integration, provider, tools, hooks and command;
 *   5. sweep crash leftovers (AC-022).
 *
 * Nothing in step 3 is fatal: a broken graph root or a stale model selection
 * must not stop the plugin from loading, or `/mexplore` could never fix it. It
 * becomes ONE actionable error on the first `mexplore` call (REQ-014).
 *
 * @module mexplore
 */
import { Plugin } from '@opencode/plugin'
import { loadGraph, type CallOrigin, type GraphRuntime } from './graph/index'
import {
  DEFAULT_TIMEOUT_MS,
  PROVIDER_ID,
  readOptions,
  resolveGraphRoot,
} from './plugin/config'
import type { ResolvedGraphRoot } from './plugin/config'
import { PLUGIN_VERSION } from './plugin/config'
import { createUsage } from './plugin/usage-sink'
import { releaseUi, startUi, stopUi, uiUrl } from './plugin/ui'
import { resolveUsageDir } from './plugin/usage-log'
import { runCall, type CallResult, bounded } from './plugin/call'
import {
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  TUI_COMMAND_NAME,
  TUI_COMMAND_SESSION,
  WriterQueue,
  runCommand,
  runCommandText,
  syntheticReply,
  type CommandDeps,
} from './plugin/command'
import { MexploreRpc } from './rpc'
import { diagnose, type AvailableModel } from './plugin/diagnostics'
import type { HostContext } from './plugin/host'
import { ParentModelCache, RootSessionCache, applyHook, applyRequestHook } from './plugin/hooks'
import { normalizeInput } from './plugin/input'
import { ChildRegistry, MexploreError, newOwnerIdentity } from './plugin/lifecycle'
import { assertManage } from './plugin/permission'
import type { UsageSink } from './plugin/call'
import { makeSanitizer, refreshSanitizer } from './plugin/redact'
import {
  makeCredentialSources,
  memoryProviderUse,
  needsCategoricalErrors,
  providerUse,
  type CredentialSources,
} from './plugin/credentials'
import { ModelLeases, registerIntegration, registerProvider } from './plugin/provider'
import { formatModelRef, providerConfig, readSettings, resolveModel, type Settings } from './plugin/settings'
import { registerTools } from './plugin/tools'
import type { ModelRef, ModelSource } from './plugin/types'

/** Everything the wiring built, for tests and for the cleanup closure. */
export interface MexplorePlugin {
  graphRoot: ResolvedGraphRoot
  registry: ChildRegistry
  runtime: GraphRuntime
  settings: Settings
  parentModels: ParentModelCache
  /** The proven root chat of each caller session (#317). */
  roots: RootSessionCache
  /** The models live children still hold (REQ-021's in-flight guarantee). */
  leases: ModelLeases
  /** Where the usage log writes (Lane B). */
  usageDir: string
  /** False when `usageLog: false` turned it off. */
  usageEnabled: boolean
  /** The setup problem, if any (REQ-014). */
  problem: () => string | undefined
}

/**
 * Wire one plugin instance. Exported for tests; the default export is the
 * `Plugin.define` wrapper the host loads.
 */
export async function setupMexplore(ctx: HostContext): Promise<{ plugin: MexplorePlugin; dispose: () => Promise<void> }> {
  const options = readOptions(ctx.options)
  const graphRoot = resolveGraphRoot(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Loaded BEFORE any transform is registered: a transform callback is sync and
  // cannot await storage, so the transforms read this object instead.
  const settings = await readSettings(ctx.storage)
  const leases = new ModelLeases()
  const reloadProvider = (): Promise<void> => ctx.provider.reload()
  // The credentials a call can send, collected lazily at each scrub: the memory
  // provider's key AND the resolved model's provider key, so a third-party model
  // (or the parent fallback) is scrubbed with its own credential, and a key
  // rotated mid-call is followed (AC-025, SEC-006).
  const credentials = makeCredentialSources(ctx)
  // The usage log: ONE event subscription for the plugin's lifetime, and a sink
  // per call. `usageLog: false` skips both (Lane B, items 1 and 3).
  const usageDir = options.usageDir ?? resolveUsageDir()
  const usage = options.usageLog === false
    ? undefined
    : createUsage(ctx, {
        graphRoot: graphRoot.path,
        pluginVersion: PLUGIN_VERSION,
        usageDir,
        ...(options.eventProbe === true ? { probe: true } : {}),
      })
  // The owner token is fresh per setup, so a reused PID is never mistaken for
  // this instance. Tests may pin one to model "this generation".
  const owner = options.ownerToken === undefined
    ? newOwnerIdentity()
    : { pid: process.pid, token: options.ownerToken }
  // One token names this plugin instance in both the crash sweep and the UI
  // ownership set, so "my owner" means the same thing everywhere.
  const ownerToken = `${owner.pid}:${owner.token}`
  const registry = new ChildRegistry(ctx, timeoutMs, leases, reloadProvider, owner)
  const parentModels = new ParentModelCache()
  // Proven root chats, per caller session (write-session provenance #317). One
  // instance for the plugin's lifetime, like the parent-model cache.
  const roots = new RootSessionCache()

  const runtime = await loadGraph({
    graphRoot: graphRoot.path,
    ...(options.searchLimit === undefined ? {} : { searchLimit: options.searchLimit }),
    ...(options.maxIndexEntries === undefined ? {} : { maxIndexEntries: options.maxIndexEntries }),
    // 2a guards, ON unless the user turned them off (see `placeholderGuards`).
    placeholderGuards: options.placeholderGuards !== false,
  })

  let problem = await diagnoseNow(ctx, graphRoot)

  await registerIntegration(ctx)
  await registerProvider(ctx, settings, leases)
  logStartup(graphRoot, settings, problem, await keyConnected(ctx))
  await registerTools(ctx, {
    runtime,
    registry,
    mexplore: async (input, context) => {
      // REQ-014: re-checked per call, so a `/mexplore` fix takes effect at once
      // and a graph root broken later is reported on the very next call. Three
      // cheap host reads (a mkdir that usually no-ops, an access, a model list)
      // against a call that takes seconds anyway.
      problem = await diagnoseNow(ctx, graphRoot)
      if (problem !== undefined) throw new MexploreError(problem, 'SETUP_PROBLEM')
      return executeCall(ctx, {
        input,
        credentialSources: credentials,
        usage: usage?.sink,
        settings,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        toolCallID: context.id,
        signal: context.signal,
        registry,
        runtime,
        graphRoot,
        parentModels,
        roots,
        timeoutMs,
      })
    },
  })

  await ctx.session.hook('context', (event) => applyHook(event, 'context', { registry, parentModels }))
  await ctx.session.hook('compaction', (event) => applyHook(event, 'compaction', { registry, parentModels }))
  await ctx.session.hook('generate', (event) => applyHook(event, 'generate', { registry, parentModels }))
  // Per-request endpoint pinning: the reason a base-URL change can apply to the
  // NEXT call while one already running keeps the endpoint it started on (AC-024).
  await ctx.session.hook('model.request', (event) => applyRequestHook(event, { registry, parentModels }))

  const reply = syntheticReply(ctx)
  // One queue for the plugin's lifetime: two `/mexplore` commands finishing out
  // of order must not leave the provider serving the older value.
  const writers = new WriterQueue()
  // ONE dependency object for both surfaces: the server command and the RPC the
  // TUI part calls run the very same subcommand implementation (REQ-021), so
  // they cannot drift apart.
  const commandDeps: CommandDeps = {
    ctx,
    credentialSources: credentials,
    usageDir,
    usageEnabled: usage !== undefined,
    placeholderGuards: options.placeholderGuards !== false,
    ui: {
      // Ownership is this PLUGIN INSTANCE (review #3): repeated `/mexplore ui`
      // from one instance is idempotent, and dispose releases only this one.
      start: (input) => startUi({ ...input, owner: ownerToken }),
      stop: (graphRoot) => stopUi(graphRoot),
      url: (graphRoot) => uiUrl(graphRoot),
      // The UI server is `Bun.serve`: a Node build of OpenCode cannot host it.
      bun: () => typeof Bun !== 'undefined',
    },
    reply,
    graphRoot,
    settings,
    writers,
    reloadProvider,
    diagnostic: () => diagnoseNow(ctx, graphRoot),
    parentModel: (id) => parentModels.get(id),
  }

  // The SERVER command, `/mexplore-settings`: the one desktop and web use, and
  // the fallback for any client that does not shadow it. Its reply is a synthetic
  // message, which the TUI only renders after the next prompt — hence the TUI
  // part, whose `/mexplore` slash command shows the same text in a dialog.
  await ctx.command.transform((editor) => {
    editor.add({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      execute: async ({ sessionID, prompt }) => {
        await runCommand(commandDeps, { sessionID, text: prompt.text, label: COMMAND_NAME })
      },
    })
  })

  // The same implementation, reachable from the TUI part over RPC, so the TUI
  // can show the reply immediately instead of waiting for that synthetic message.
  await ctx.rpc.register(MexploreRpc, {
    command: async (input: { args: string; sessionID?: string }) => ({
      text: await runCommandText(commandDeps, {
        sessionID: input.sessionID ?? TUI_COMMAND_SESSION,
        text: input.args,
        // The TUI's slash command is `/mexplore`, so its help must say so.
        label: TUI_COMMAND_NAME,
      }),
    }),
  })

  // AC-022: only after registration, so the sweep cannot race a live child of
  // another OpenCode process that is still using the tools it needs.
  await registry.sweep().catch(() => 0)

  const plugin: MexplorePlugin = {
    graphRoot,
    registry,
    runtime,
    settings,
    parentModels,
    roots,
    leases,
    usageDir,
    usageEnabled: usage !== undefined,
    problem: () => problem,
  }
  return {
    plugin,
    dispose: async () => {
      try {
        await registry.dispose()
      } finally {
        usage?.dispose()
        // Release this instance's UI ownership and AWAIT the stop when it was the
        // last owner, so a reload can rebind the port (review #3).
        await releaseUi(graphRoot.path, ownerToken).catch(() => undefined)
      }
    },
  }
}

/** Re-run the setup checks against the CURRENT storage and model registry. */
async function diagnoseNow(ctx: HostContext, graphRoot: ResolvedGraphRoot): Promise<string | undefined> {
  const agents = await availableAgents(ctx)
  return diagnose({
    graphRoot: graphRoot.path,
    graphRootSource: graphRoot.source,
    settings: await readSettings(ctx.storage),
    models: await availableModels(ctx),
    ...(agents === undefined ? {} : { agents }),
  })
}

async function availableAgents(ctx: HostContext): Promise<string[] | undefined> {
  if (typeof ctx.agent?.list !== 'function') return undefined
  try {
    return ((await ctx.agent.list()).data ?? []).map((agent) => agent.id)
  } catch {
    // An agent list that cannot be read proves nothing either way.
    return undefined
  }
}

interface ExecuteInput {
  input: unknown
  sessionID: string
  /** The invocation facts a permission decision is attributed to (SEC-002). */
  agent: string
  messageID: string
  toolCallID: string
  signal: AbortSignal
  registry: ChildRegistry
  runtime: GraphRuntime
  graphRoot: ResolvedGraphRoot
  parentModels: ParentModelCache
  /** Proven roots of caller sessions (write-session provenance #317). */
  roots: RootSessionCache
  timeoutMs: number
  credentialSources: CredentialSources
  /** The usage sink, or `undefined` when the log is off. */
  usage?: UsageSink
  /** The LIVE settings object the provider transform reads. */
  settings: Settings
}

/** How long the whole root walk may take before it is `walk-failed`. */
export const ROOT_WALK_BOUND_MS = 2_000

/** How many `parentID` hops a walk may follow before it gives up. */
export const ROOT_WALK_MAX_HOPS = 8

/** The one answer every unsuccessful walk gives. */
const WALK_FAILED: CallOrigin = { session: null, reason: 'walk-failed' }

/**
 * The ROOT chat session of `sessionID` (write-session provenance #317).
 *
 * A mexplore call can be made from a subagent, and subagent chains two deep
 * occur, so `context.sessionID` is only the immediate caller. The root is the
 * last session with no `parentID` — the top-level conversation the user typed
 * into. A fork has no `parentID` either, so a fork is its own root; that needs
 * no special case.
 *
 * A wrong id is worse than a missing one (rule 2), so every uncertain outcome
 * is `walk-failed` rather than a guess: a throw (a 404 partway up), a deadline
 * expiry, an id that is not the one asked for, a cycle, or more than
 * {@link ROOT_WALK_MAX_HOPS} hops. The walk is bounded as a WHOLE by
 * {@link bounded}, so a host that answers slowly cannot multiply the deadline
 * by the depth of the chain.
 *
 * A successful root is cached per CALLER session (so a second call from the
 * same subagent costs nothing); a failure never is, so the next call retries.
 */
export async function rootSessionOf(
  ctx: HostContext,
  sessionID: string,
  cache?: RootSessionCache,
  options: { boundMs?: number } = {},
): Promise<CallOrigin> {
  // The TUI's slash command is attributed to a synthetic session that no host
  // session graph contains — and those calls never write. Cheap, explicit answer.
  if (sessionID === TUI_COMMAND_SESSION) return { ...WALK_FAILED }

  const cached = cache?.get(sessionID)
  if (cached !== undefined) return { session: cached }

  const visited = new Set<string>()
  let current = sessionID
  const walked = await bounded(options.boundMs ?? ROOT_WALK_BOUND_MS, async (): Promise<CallOrigin> => {
    for (let hop = 0; hop <= ROOT_WALK_MAX_HOPS; hop += 1) {
      // A cycle is never a root: the same id twice means the chain is broken.
      if (visited.has(current)) return { ...WALK_FAILED }
      visited.add(current)
      const info = await ctx.session.get({ sessionID: current })
      // The host must answer for the session that was asked for. A mismatch is
      // the one case where its answer might name a DIFFERENT chat, so it is
      // discarded rather than followed.
      if (info?.id !== current) return { ...WALK_FAILED }
      const parent = typeof info.parentID === 'string' ? info.parentID : ''
      if (parent.length === 0) return { session: current }
      current = parent
    }
    // More than ROOT_WALK_MAX_HOPS parents: the chain is longer than anything
    // this host produces, so nothing about it is trustworthy.
    return { ...WALK_FAILED }
  })
  // `undefined` covers both a deadline expiry and a throw (bounded swallows it).
  if (walked === undefined || walked.session === null) return { ...WALK_FAILED }
  cache?.set(sessionID, walked.session)
  return walked
}

/**
 * One `mexplore` call: resolve the model, create the child, run it, report.
 * Every refusal happens BEFORE a child exists, so a model problem never pays
 * for a session.
 */
async function executeCall(ctx: HostContext, input: ExecuteInput): Promise<CallResult> {
  // Normalization failures are the model's mistake and must say so verbatim.
  const request = normalizeInput(input.input)

  // SEC-002, BEFORE any child exists: a manage call consults the permission
  // system, so a user's own `mexplore/manage` ask rule is honoured and "always
  // allow" persists. On a stock install this resolves with no prompt; with no
  // permission API it is skipped (never fail closed). A refusal propagates
  // untouched — it is the user's answer, not tool output.
  if (request.authority === 'manage') {
    await assertManage(ctx, {
      sessionID: input.sessionID,
      agent: input.agent,
      messageID: input.messageID,
      id: input.toolCallID,
    })
  }

  // Read-only: the live object belongs to the writers (`/mexplore model|...`),
  // and a call must never publish a stale snapshot into it.
  const settings = await readSettings(ctx.storage)
  const hasKey = (await ctx.integration.connection.active(PROVIDER_ID)) !== undefined
  const parentModel = input.parentModels.get(input.sessionID)
  const resolved = resolveModel({
    settings,
    hasKey,
    ...(parentModel === undefined ? {} : { parentModel }),
  })
  if (resolved === undefined) {
    throw new MexploreError(
      [
        'mexplore: no memory model is available.',
        'Fix: start a conversation so memory can inherit its model, or run `/mexplore model <provider/model>` to select an OpenCode model. A custom mexplore provider needs an explicit base URL, model id and `/connect` → mexplore key.',
      ].join(' '),
      'NO_MODEL',
    )
  }
  assertUsable(settings, resolved.model, resolved.source, await availableModels(ctx))

  // The provider this call's child actually authenticates with — the memory
  // provider only when the memory model lives there (REQ-005's other branches
  // run on the user's own model, with the user's own key).
  const underUse =
    resolved.model.providerID === PROVIDER_ID
      ? [memoryProviderUse(), providerUse(PROVIDER_ID)]
      : [providerUse(resolved.model.providerID), memoryProviderUse()]
  const sanitize = makeSanitizer(
    () => input.credentialSources.collect(underUse),
  )
  // Resolve once now, so the very first scrub (and the categorical decision
  // below) sees the keys in force at admission.
  await refreshSanitizer(sanitize)

  // Write-session provenance (#317): the ROOT chat is resolved ONCE per call,
  // after the permission gate and BEFORE `runCall` creates the child session.
  // It rides along as attribution only — `callId` stays the authorization key.
  const origin = await rootSessionOf(ctx, input.sessionID, input.roots)

  return runCall(ctx, {
    parentSessionID: input.sessionID,
    authority: request.authority,
    message: request.message,
    evidence: request.evidence,
    call: input.runtime.createCall({
      callId: crypto.randomUUID(),
      authority: request.authority,
      message: request.message,
      evidence: request.evidence,
      origin,
    }),
    model: resolved.model,
    modelSource: resolved.source,
    signal: input.signal,
    registry: input.registry,
    graphRoot: input.graphRoot,
    timeoutMs: input.timeoutMs,
    // The LIVE object, never this call's storage snapshot: a `/mexplore base-url`
    // that landed while this call was resolving must be visible to it. If reset
    // cleared it meanwhile, retain this admitted call's explicit endpoint.
    currentBaseURL: () => providerConfig(input.settings).baseURL || providerConfig(settings).baseURL,
    sanitize,
    usage: input.usage,
    // Exact redaction is impossible for a provider whose key we cannot resolve,
    // so its failures are reported by category instead of by body.
    categoricalErrors:
      resolved.model.providerID !== PROVIDER_ID &&
      needsCategoricalErrors(underUse, await input.credentialSources.collect(underUse).catch(() => [])),
  })
}

/**
 * A selected model that vanished after setup must fail with a remedy, not with
 * a child that silently runs on nothing. `parent-fallback` is exempt: a
 * third-party model's tool support is the parent's own choice, and the result
 * reports `toolCalls: 0` honestly when it cannot call tools.
 */
function assertUsable(
  settings: Settings,
  model: ModelRef,
  source: ModelSource,
  models: readonly AvailableModel[],
): void {
  if (source === 'parent-fallback' || source === 'default') return
  const name = formatModelRef(model)
  const match = models.find((entry) => `${entry.providerID}/${entry.id}` === name)
  if (match !== undefined && match.enabled && match.capabilities.tools) return
  throw new MexploreError(
    [
      `mexplore: the selected memory model ${JSON.stringify(settings.model ?? name)} cannot be used —`,
      match === undefined
        ? 'that model is not available in this OpenCode.'
        : match.enabled
          ? 'that model cannot call tools.'
          : 'that model is disabled.',
      'Fix: run `/mexplore model <provider/model>` with an enabled, tool-capable model, or `/mexplore reset`.',
    ].join(' '),
    'MODEL_UNAVAILABLE',
  )
}

async function availableModels(ctx: HostContext): Promise<AvailableModel[]> {
  try {
    const listed = await ctx.model.list()
    return (listed.data ?? []).map((model) => ({
      providerID: model.providerID,
      id: model.id,
      enabled: model.enabled,
      capabilities: { tools: model.capabilities?.tools === true },
    }))
  } catch {
    // A registry that cannot be listed is not a diagnostics failure: the model
    // checks simply have nothing to check against.
    return []
  }
}

/**
 * One startup status line (REQ-021): graph root and its source, the memory
 * model, the base URL source, and whether the key is connected — never the key.
 */
function logStartup(
  graphRoot: ResolvedGraphRoot,
  settings: Settings,
  problem: string | undefined,
  keyConnected: boolean,
): void {
  const model = settings.model ?? (settings.mexploreModel === undefined ? 'inherit current session' : `${PROVIDER_ID}/${settings.mexploreModel}`)
  const baseURL = settings.baseURL === undefined ? 'not configured (host provider used by default)' : 'custom'
  const status = problem === undefined ? 'ready' : 'a problem was found; the first mexplore call will report it'
  process.stderr.write(
    `mexplore: graph ${graphRoot.path} (source: ${graphRoot.source}); model ${model}; base URL ${baseURL}; key ${keyConnected ? 'connected' : 'missing'}; ${status}\n`,
  )
}

/** Presence only: the key itself is never read, and never logged. */
async function keyConnected(ctx: HostContext): Promise<boolean> {
  try {
    return (await ctx.integration.connection.active(PROVIDER_ID)) !== undefined
  } catch {
    return false
  }
}

export default Plugin.define({
  id: 'mexplore',
  async setup(context): Promise<() => Promise<void>> {
    const { dispose } = await setupMexplore(context as unknown as HostContext)
    return dispose
  },
})
