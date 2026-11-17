/**
 * The slice of `@opencode/plugin`'s promise context this plugin actually uses,
 * declared structurally.
 *
 * Structural types keep the plugin loadable under `bun test` with a fake
 * context, and keep the dependency one-directional: `@opencode/plugin` is a
 * devDependency for types only (REQ-017d), and the host supplies the real
 * module at runtime. Every signature here is copied from the published 2.2.5
 * types (`@opencode/plugin/dist/promise/*.d.ts`).
 *
 * @module mexplore/plugin/host
 */
import type { ModelRef } from './types'

/** A session's token totals, as `SessionInfo` reports them. */
export interface HostTokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface HostSessionInfo {
  id: string
  parentID?: string
  agent?: string
  model?: ModelRef
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  metadata?: Record<string, unknown>
  time: { created: number; updated: number }
  title?: string
  /**
   * The session's cumulative spend. Used to CROSS-CHECK the event capture on the
   * completed path — never to replace it, and never added to it.
   */
  cost?: number
  tokens?: HostTokenUsage
}

export interface HostAssistantContent {
  type: string
  text?: string
}

export interface HostMessage {
  type: string
  time?: { created: number; completed?: number }
  content?: HostAssistantContent[]
  finish?: string
  error?: { type?: string; message?: string }
}

export interface HostToolDefinition {
  description: string
  input: unknown
}

/** The hook event for `context`, `compaction` and `generate`. */
export interface HostHookEvent {
  sessionID: string
  model: ModelRef
  agent: string
  system: Array<{ type: 'text'; text: string; metadata?: Record<string, unknown> }>
  messages: unknown[]
  options: Record<string, unknown>
  tools: Record<string, HostToolDefinition>
}

/**
 * The `model.request` event: one per model call, before the request is sent.
 * Mutating `baseURL` re-points THIS request (and nothing else).
 */
export interface HostModelRequestEvent {
  readonly sessionID: string
  readonly agent: string
  readonly model: ModelRef
  readonly kind: 'primary' | 'compaction' | 'title' | 'generate'
  baseURL?: string
  headers: Record<string, string>
}

export interface HostToolContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal: AbortSignal
  progress: (update: Record<string, unknown>) => Promise<void>
}

export interface HostToolInfo {
  name: string
  description: string
  input: unknown
  options?: { codemode?: boolean }
  execute: (input: unknown, context: HostToolContext) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

export interface HostToolEditor {
  add(tool: HostToolInfo): void
}

export interface HostIntegrationEditor {
  update(id: string, update: (integration: { id: string; name: string }) => void): void
  readonly method: {
    update(input: {
      integrationID: string
      method: { type: 'key'; label?: string }
    }): void
  }
}

export interface HostProviderInfo {
  id: string
  name: string
  activation: 'auto' | 'enabled' | 'disabled'
  package: string
  integrationID?: string
  settings?: Record<string, unknown>
}

export interface HostModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: unknown[]
  time: { released: number }
  cost: unknown[]
  status: 'alpha' | 'beta' | 'deprecated' | 'active'
  enabled: boolean
  limit: { context: number; output: number }
}

export interface HostProviderEditor {
  add(input: { info: HostProviderInfo; models: HostModelInfo[] }): void
}

export interface HostCommandInvocation {
  sessionID: string
  prompt: { text: string }
  delivery: 'steer' | 'queue'
}

export interface HostCommandEditor {
  add(definition: {
    name: string
    description?: string
    execute: (input: HostCommandInvocation) => Promise<void>
  }): void
}

export interface HostRegistration {
  dispose: () => Promise<void>
}

/** Everything the plugin reaches through `ctx`. */
export interface HostContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly tool: {
    transform: (callback: (editor: HostToolEditor) => void) => Promise<HostRegistration>
  }
  /**
   * Optional (SEC-002): a host without `assert` runs manage calls without a
   * prompt, which is the default anyway. Absent must never fail a write.
   */
  readonly permission?: {
    assert: (input: {
      sessionID: string
      agent?: string
      action: string
      resources: string[]
      save?: string[]
      metadata?: Record<string, unknown>
      source?: { type: 'tool'; messageID: string; id: string }
    }) => Promise<void>
  }
  readonly session: {
    create: (input: {
      parentID?: string
      title?: string
      agent?: string
      model?: ModelRef
      metadata?: Record<string, unknown>
      permissions?: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>
    }) => Promise<HostSessionInfo>
    prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    wait: (input: { sessionID: string }) => Promise<void>
    context: (input: { sessionID: string }) => Promise<HostMessage[]>
    get: (input: { sessionID: string }) => Promise<HostSessionInfo>
    remove: (input: { sessionID: string }) => Promise<void>
    interrupt: (input: { sessionID: string }) => Promise<{ interrupted: boolean }>
    list: (input?: { limit?: number; cursor?: string }) => Promise<{
      data: HostSessionInfo[]
      cursor: { next?: string | null }
    }>
    synthetic: (input: {
      sessionID: string
      text: string
      description?: string
      resume?: boolean
    }) => Promise<unknown>
    /**
     * Session hooks. `context`/`compaction`/`generate` carry the system prompt
     * and tool set; `model.request` runs once per model call and its `baseURL`
     * and `headers` are mutable, which is how a child keeps the endpoint it
     * started against (REQ-021, AC-024).
     */
    hook: {
      (
        name: 'context' | 'compaction' | 'generate',
        callback: (event: HostHookEvent) => Promise<void> | void,
      ): Promise<HostRegistration>
      (
        name: 'model.request',
        callback: (event: HostModelRequestEvent) => Promise<void> | void,
      ): Promise<HostRegistration>
    }
  }
  readonly integration: {
    transform: (callback: (editor: HostIntegrationEditor) => void) => Promise<HostRegistration>
    connection: {
      active: (integrationID: string) => Promise<unknown>
      /**
       * The connection's secret value (`Credential.Value`, a tagged union:
       * `{ type: "key", key }` for this integration). Resolved per use, never
       * kept: it exists only long enough to scrub it out of a diagnostic.
       */
      resolve: (connection: unknown) => Promise<unknown>
    }
  }
  readonly provider: {
    transform: (callback: (editor: HostProviderEditor) => void) => Promise<HostRegistration>
    reload: () => Promise<void>
    /**
     * The provider catalogue. `settings` is returned VERBATIM by the host — a
     * literal `apiKey`/`authToken`/`accessToken` from `opencode.json` included
     * (verified on 2.2.5), which is why the sanitizer may read it.
     */
    list: () => Promise<{ data: HostProviderInfo[] }>
    get: (input: { providerID: string }) => Promise<HostProviderInfo>
  }
  readonly model: {
    list: () => Promise<{ data: HostModelInfo[] }>
  }
  /** Optional: only REQ-014's agent-existence check uses it. */
  readonly agent?: {
    list: () => Promise<{ data: Array<{ id: string }> }>
  }
  readonly command: {
    transform: (callback: (editor: HostCommandEditor) => void) => Promise<HostRegistration>
  }
  readonly storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    remove: (key: string) => Promise<void>
  }
  /**
   * RPC registration (REQ-021, TUI part). The definition is a plain object and
   * the handlers a plain map, so the host's generic signature is erased here:
   * the server part passes the same `MexploreRpc` the TUI part calls through.
   */
  readonly rpc: {
    register: (
      definition: { id: string; methods: Record<string, unknown>; events: Record<string, unknown> },
      handlers: Record<string, (input: never, context: never) => Promise<unknown>>,
    ) => Promise<{ dispose: () => Promise<void> }>
  }
  /**
   * The server event bus (`@opencode/plugin/promise/event.ts`).
   *
   * An async iterable, so it is consumed with `for await` and ends when the
   * plugin scope is closed. `types` narrows the stream server-side; every event
   * carries `data.sessionID`, which is what filters it to our own children.
   */
  readonly event: {
    subscribe: (options?: { types?: readonly string[] }) => AsyncIterable<HostEvent>
  }
  /**
   * One-shot text generation, used only by `/mexplore test`. OpenCode 2.2.0
   * added `experimental.generate`; before that (2.0, 2.1) only the top-level
   * `generate` exists, which 2.2 keeps as a deprecated alias. Both are
   * optional here so the plugin picks whichever the running host has.
   */
  readonly experimental?: {
    generate?: { text: GenerateText }
  }
  readonly generate?: { text: GenerateText }
}

export type GenerateText = (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>

/** The host's text-generation call: `experimental.generate` (2.2+) or `generate` (2.0, 2.1). */
export function hostGenerateText(ctx: Pick<HostContext, 'experimental' | 'generate'>): GenerateText | undefined {
  const experimental = ctx.experimental?.generate
  if (experimental !== undefined && typeof experimental.text === 'function') return (input) => experimental.text(input)
  const legacy = ctx.generate
  if (legacy !== undefined && typeof legacy.text === 'function') return (input) => legacy.text(input)
  return undefined
}

/** One server event, as much of it as this plugin reads. */
export interface HostEvent {
  readonly type: string
  readonly data?: {
    readonly sessionID?: string
    readonly tokens?: Partial<{
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
      cacheRead: number
      cacheWrite: number
    }>
    readonly cost?: number
  }
}
