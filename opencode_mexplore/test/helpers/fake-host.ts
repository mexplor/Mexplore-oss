/**
 * A fake OpenCode 2.2.5 plugin host, implementing exactly the surface
 * `src/plugin/host.ts` declares and nothing else.
 *
 * It is a scriptable stand-in, not a simulator: the interesting behavior is
 * that a child's "model" is a function the test supplies. When `prompt` reaches
 * a child, that function runs — it calls the registered graph-tool executors
 * with the child's own session ID, then leaves an assistant message behind —
 * and `wait` resolves once it returns. Everything else records calls so a test
 * can assert on the conversation between the plugin and the host.
 *
 * @module mexplore/test/helpers/fake-host
 */
import type {
  HostEvent,
  HostModelRequestEvent,
  HostAssistantContent,
  HostCommandInvocation,
  HostContext,
  HostHookEvent,
  HostMessage,
  HostModelInfo,
  HostProviderInfo,
  HostSessionInfo,
  HostToolContext,
  HostToolInfo,
} from '../../src/plugin/host'

export const NOT_FOUND = Object.assign(new Error('session not found'), { _tag: 'Session.NotFoundError' })

export interface FakeChild {
  info: HostSessionInfo
  permissions: Array<{ action: string; resource: string; effect: string }>
  messages: HostMessage[]
  removed: boolean
  interrupted: number
  /** The scripted run; resolves when this child's `wait` may return. */
  run?: Promise<void>
  promptText?: string
}

export type ChildScript = (child: FakeChild, host: FakeHost) => Promise<void>

export interface FakeHostOptions {
  /** The model a parent session resolves to in its `context` hook. */
  models?: Array<Partial<HostModelInfo> & { providerID: string; id: string }>
  /** Whether a key is connected to the `mexplore` integration. */
  keyConnected?: boolean
  /** Sessions that already exist, for the crash sweep. */
  existing?: HostSessionInfo[]
  /** Storage seed. */
  storage?: Record<string, unknown>
  /** Agent ids the host reports. */
  agents?: string[]
  /** The connected credential's secret, as `connection.resolve` reveals it. */
  credential?: string
  /** Extra providers, as `provider.list()` reports them (settings verbatim). */
  providers?: HostProviderInfo[]
  /** A second provider's connected credential, by provider id. */
  credentials?: Record<string, string>
  /** Providers that have a connection but no resolvable secret (rotation, env). */
  connectionIDs?: string[]
  /** This instance's owner token, so a sweep test can model "this generation". */
  ownerToken?: string
  /** The call budget the plugin was configured with. */
  timeoutMs?: number
  /**
   * Install a `permission.assert`. Default: absent, which is the SEC-002
   * "proceed without it" case; `'allow'` resolves immediately (a stock install);
   * `'deny'` rejects with a tagged decline.
   */
  permission?: 'allow' | 'deny' | false
}

export class FakeHost {
  readonly ctx: HostContext
  readonly tools = new Map<string, HostToolInfo>()
  readonly sessions = new Map<string, FakeChild>()
  readonly storage = new Map<string, unknown>()
  readonly hooks: Record<'context' | 'compaction' | 'generate', Array<(event: HostHookEvent) => Promise<void> | void>> = {
    context: [],
    compaction: [],
    generate: [],
  }
  /** Live event subscribers: pushing an event feeds every subscriber. */
  readonly eventQueue: HostEvent[] = []
  private eventWaiters: Array<(event: HostEvent) => void> = []
  private eventClosed = false
  /** `model.request` callbacks, in registration order. */
  readonly requestHooks: Array<(event: HostModelRequestEvent) => Promise<void> | void> = []
  readonly commands = new Map<string, { name: string; description?: string; execute: (input: HostCommandInvocation) => Promise<void> }>()
  readonly replies: Array<{ sessionID: string; text: string }> = []
  /** Every permission assertion the plugin made, in order. */
  readonly permissionAsserts: unknown[] = []
  /** Every RPC definition the server part registered, and its handlers. */
  readonly rpcDefinitions: Array<{ id: string; methods: Record<string, unknown> }> = []
  readonly rpcHandlers = new Map<string, (input: never) => Promise<unknown>>()
  readonly calls = {
    create: [] as unknown[],
    prompt: [] as Array<{ sessionID: string; text: string }>,
    remove: [] as string[],
    interrupt: [] as string[],
    list: 0,
    reload: 0,
    generate: [] as unknown[],
  }
  /** The latest `provider.add` input, replaced on every reload. */
  providerAdditions: Array<{ info: HostProviderInfo; models: HostModelInfo[] }> = []
  integrationMethods: Array<{ integrationID: string; method: unknown }> = []
  /** Set to fail `/mexplore test` with this error. */
  generateError?: Error
  generateText = 'ok'
  /** Set a child's `outcome` before its run finishes. */
  outcomeFor: ((child: FakeChild) => HostSessionInfo['outcome'] | undefined) | undefined
  /** Runs when a child is prompted. Defaults to a plain assistant reply. */
  script: ChildScript = async (child) => {
    child.messages.push(assistant('done'))
  }
  /** Mutable so a test can rotate a credential mid-call. */
  readonly options: FakeHostOptions
  private nextID = 0

  constructor(options: FakeHostOptions = {}) {
    this.options = options
    for (const [key, value] of Object.entries(options.storage ?? {})) this.storage.set(key, value)
    for (const info of options.existing ?? []) {
      this.sessions.set(info.id, { info, permissions: [], messages: [], removed: false, interrupted: 0 })
    }
    this.ctx = this.makeContext()
  }

  // ---------------------------------------------------------------- scripting

  /** Replace the child script reads: it gets (childID, args) and returns a result. */
  scriptTools(): (sessionID: string, tool: string, args: unknown) => unknown {
    return (sessionID, tool, args) => this.executeTool(tool, args, sessionID)
  }

  /** Run a registered tool exactly as the host would for `sessionID`. */
  async executeTool(tool: string, args: unknown, sessionID: string): Promise<unknown> {
    const definition = this.tools.get(tool)
    if (definition === undefined) throw new Error(`tool ${tool} is not registered`)
    const context: HostToolContext = {
      sessionID,
      agent: 'summary',
      messageID: 'msg_fake',
      id: 'call_fake',
      signal: new AbortController().signal,
      progress: async () => {},
    }
    return definition.execute(args, context)
  }

  /** Fire a hook with a well-formed event, returning the event for assertions. */
  async trigger(
    kind: 'context' | 'compaction' | 'generate',
    input: { sessionID: string; model?: { providerID: string; id: string }; tools?: string[] },
  ): Promise<HostHookEvent> {
    const event: HostHookEvent = {
      sessionID: input.sessionID,
      model: input.model ?? { providerID: 'anthropic', id: 'claude-sonnet-5' },
      agent: 'build',
      system: [{ type: 'text', text: 'You are a helpful agent.' }],
      messages: [],
      options: {},
      tools: Object.fromEntries(
        (input.tools ?? []).map((name) => [name, { description: `${name} (host)`, input: { type: 'object' } }]),
      ),
    }
    for (const callback of this.hooks[kind]) await callback(event)
    return event
  }

  /** Run `/mexplore <text>` through the registered command. */
  async command(sessionID: string, text: string): Promise<string> {
    const definition = this.commands.get('mexplore-settings')
    if (definition === undefined) throw new Error('the mexplore-settings command is not registered')
    this.replies.length = 0
    await definition.execute({ sessionID, prompt: { text }, delivery: 'queue' })
    return this.replies.map((reply) => reply.text).join('\n')
  }

  /**
   * Fire the `model.request` hook for one session, the way the host does before
   * each model call, and return the event so a test can read the endpoint back.
   */
  async fireRequestHook(sessionID: string, baseURL = 'https://from-provider/v1'): Promise<HostModelRequestEvent> {
    const event: HostModelRequestEvent = {
      sessionID,
      agent: 'summary',
      model: { providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' },
      kind: 'primary',
      baseURL,
      headers: {},
    }
    for (const hook of this.requestHooks) await hook(event)
    return event
  }

  /**
   * Emit one server event, as the bus would. Buffered until consumed, so a test
   * can emit before the plugin's `for await` starts.
   */
  emit(type: string, data: Record<string, unknown>): void {
    const event: HostEvent = { type, data: data as HostEvent['data'] }
    const waiter = this.eventWaiters.shift()
    if (waiter !== undefined) waiter(event)
    else this.eventQueue.push(event)
  }

  /** Close every subscription, as a plugin unload does. */
  closeEvents(): void {
    this.eventClosed = true
    for (const waiter of this.eventWaiters.splice(0)) {
      void waiter
    }
  }

  /** How many subscribers are attached (the plugin should attach exactly one). */
  get subscriberCount(): number {
    return this.subscribers
  }

  private subscribers = 0

  private async *eventStream(types: readonly string[] | undefined): AsyncIterable<HostEvent> {
    this.subscribers += 1
    try {
      for (;;) {
        const event = await this.nextEvent()
        if (event === undefined) return
        if (types !== undefined && types.length > 0 && !types.includes(event.type)) continue
        yield event
      }
    } finally {
      this.subscribers -= 1
    }
  }

  private async nextEvent(): Promise<HostEvent | undefined> {
    const queued = this.eventQueue.shift()
    if (queued !== undefined) return queued
    if (this.eventClosed) return undefined
    return new Promise<HostEvent | undefined>((resolve) => {
      this.eventWaiters.push(resolve as (event: HostEvent) => void)
    })
  }

  /** Fire `model.request` for a specific provider, to check the hook's guard. */
  async fireRequestHookFor(
    sessionID: string,
    model: { providerID: string; id: string },
    baseURL = 'https://from-provider/v1',
  ): Promise<HostModelRequestEvent> {
    const event: HostModelRequestEvent = { sessionID, agent: 'summary', model, kind: 'primary', baseURL, headers: {} }
    for (const hook of this.requestHooks) await hook(event)
    return event
  }

  /** What the `model.request` hook would set for `sessionID` (or `undefined`). */
  async baseURLFromHook(sessionID: string): Promise<string | undefined> {
    return (await this.fireRequestHook(sessionID, 'https://from-provider/v1')).baseURL
  }

  /** Call a registered RPC method the way the TUI part would, over the wire. */
  async callRpc(id: string, method: string, input: unknown): Promise<unknown> {
    const handler = this.rpcHandlers.get(`${id}.${method}`)
    if (handler === undefined) throw new Error(`RPC ${id}.${method} is not registered`)
    return handler(input as never)
  }

  /** Every tool call result the fake recorded, in order. */
  childChildren(): FakeChild[] {
    return [...this.sessions.values()]
  }

  // -------------------------------------------------------------------- host

  private makeContext(): HostContext {
    const self = this
    const ctx: HostContext = {
      options: {},
      tool: {
        transform: async (callback) => {
          callback({
            add: (tool) => {
              self.tools.set(tool.name, tool)
            },
          })
          return { dispose: async () => {} }
        },
      },
      session: {
        create: async (input) => {
          self.calls.create.push(input)
          const info: HostSessionInfo = {
            id: self.id(),
            ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            time: { created: Date.now(), updated: Date.now() },
          }
          self.sessions.set(info.id, {
            info,
            permissions: input.permissions ?? [],
            messages: [],
            removed: false,
            interrupted: 0,
          })
          return info
        },
        prompt: async (input) => {
          self.calls.prompt.push({ sessionID: input.sessionID, text: input.text })
          const child = self.sessions.get(input.sessionID)
          if (child === undefined) throw NOT_FOUND
          child.promptText = input.text
          // Non-blocking, like the host: `wait` is what blocks.
          child.run = (async () => {
            await self.script(child, self)
          })()
          // A scripted failure must not become an unhandled rejection.
          void child.run.catch(() => {})
          return { id: 'inbox_fake' }
        },
        wait: async ({ sessionID }) => {
          const child = self.sessions.get(sessionID)
          if (child?.run !== undefined) await child.run.catch(() => {})
        },
        context: async ({ sessionID }) => {
          const child = self.sessions.get(sessionID)
          if (child === undefined) throw NOT_FOUND
          return [...child.messages]
        },
        get: async ({ sessionID }) => {
          const child = self.sessions.get(sessionID)
          if (child === undefined || child.removed) throw NOT_FOUND
          const outcome = self.outcomeFor?.(child) ?? child.info.outcome
          return { ...child.info, ...(outcome === undefined ? {} : { outcome }) }
        },
        remove: async ({ sessionID }) => {
          self.calls.remove.push(sessionID)
          const child = self.sessions.get(sessionID)
          if (child === undefined || child.removed) throw NOT_FOUND
          child.removed = true
        },
        interrupt: async ({ sessionID }) => {
          self.calls.interrupt.push(sessionID)
          const child = self.sessions.get(sessionID)
          if (child === undefined) throw NOT_FOUND
          child.interrupted += 1
          return { interrupted: true }
        },
        list: async (input) => {
          self.calls.list += 1
          const alive = [...self.sessions.values()].filter((child) => !child.removed)
          const start = input?.cursor === undefined ? 0 : Number(input.cursor)
          const limit = input?.limit ?? 100
          const page = alive.slice(start, start + limit)
          const next = start + limit < alive.length ? String(start + limit) : null
          return { data: page.map((child) => child.info), cursor: { next } }
        },
        synthetic: async (input) => {
          self.replies.push({ sessionID: input.sessionID, text: input.text })
          return { id: 'inbox_synthetic' }
        },
        hook: (async (name: 'context' | 'compaction' | 'generate' | 'model.request', callback: never) => {
          if (name === 'model.request') self.requestHooks.push(callback as never)
          else self.hooks[name].push(callback as never)
          return { dispose: async () => {} }
        }) as never,
      },
      integration: {
        transform: async (callback) => {
          const integrations = new Map<string, { id: string; name: string }>()
          callback({
            update: (id, update) => {
              const current = integrations.get(id) ?? { id, name: id }
              update(current)
              integrations.set(id, current)
            },
            method: {
              update: (input) => {
                self.integrationMethods.push({ integrationID: input.integrationID, method: input.method })
              },
            },
          })
          return { dispose: async () => {} }
        },
        connection: {
          active: async (id) => {
            if (self.options.credentials?.[id] !== undefined) return { id }
            if (self.options.connectionIDs?.includes(id) === true) return { id }
            return id === 'mexplore' && self.options.keyConnected === true ? { id } : undefined
          },
          // The secret the plugin scrubs out of diagnostics, per provider and
          // resolved per use (so a test can rotate it mid-call).
          resolve: async (connection) => {
            const id = (connection as { id?: string } | undefined)?.id
            const key =
              id === undefined
                ? self.options.credential
                : (self.options.credentials?.[id] ?? (id === 'mexplore' ? self.options.credential : undefined))
            return key === undefined ? undefined : { type: 'key', key }
          },
        },
      },
      provider: {
        list: async () => ({ data: (self.options.providers ?? []) }),
        get: async ({ providerID }) => {
          const found = (self.options.providers ?? []).find((provider) => provider.id === providerID)
          if (found === undefined) throw new Error(`Provider not found: ${providerID}`)
          return found
        },
        transform: async (callback) => {
          self.providerCallbacks.push(callback)
          self.replayProvider(callback)
          return { dispose: async () => {} }
        },
        reload: async () => {
          self.calls.reload += 1
          self.providerAdditions = []
          for (const callback of self.providerCallbacks) self.replayProvider(callback)
        },
      },
      model: {
        list: async () => ({
          data: (self.options.models ?? []).map((model) => ({
            id: model.id,
            modelID: model.id,
            providerID: model.providerID,
            name: model.name ?? model.id,
            capabilities: model.capabilities ?? { tools: true, input: ['text'], output: ['text'] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: model.status ?? 'active',
            enabled: model.enabled ?? true,
            limit: model.limit ?? { context: 200_000, output: 32_000 },
          })),
        }),
      },
      agent: {
        list: async () => ({ data: (self.options.agents ?? ['summary', 'build', 'plan']).map((id) => ({ id })) }),
      },
      event: {
        // A real async iterable, like the host's: a test pushes with `emit()`.
        subscribe: (options?: { types?: readonly string[] }) => self.eventStream(options?.types),
      },
      rpc: {
        register: async (definition, handlers) => {
          self.rpcDefinitions.push(definition)
          for (const [name, handler] of Object.entries(handlers)) {
            self.rpcHandlers.set(`${definition.id}.${name}`, handler as (input: never) => Promise<unknown>)
          }
          return { dispose: async () => {} }
        },
      },
      ...(self.options.permission === undefined || self.options.permission === false
        ? {}
        : {
            permission: {
              assert: async (input: unknown) => {
                self.permissionAsserts.push(input)
                if (self.options.permission === 'deny') {
                  throw Object.assign(new Error('Permission declined by the user'), {
                    _tag: 'Permission.DeclinedError',
                  })
                }
              },
            },
          }),
      command: {
        transform: async (callback) => {
          callback({
            add: (definition) => {
              self.commands.set(definition.name, definition)
            },
          })
          return { dispose: async () => {} }
        },
      },
      storage: {
        get: async (key) => self.storage.get(key),
        set: async (key, value) => {
          self.storage.set(key, value)
        },
        remove: async (key) => {
          self.storage.delete(key)
        },
      },
      experimental: {
        generate: {
          text: async (input) => {
            self.calls.generate.push(input)
            if (self.generateError !== undefined) throw self.generateError
            return { text: self.generateText }
          },
        },
      },
    }
    return ctx
  }

  private readonly providerCallbacks: Array<(editor: {
    add: (input: { info: HostProviderInfo; models: HostModelInfo[] }) => void
  }) => void> = []

  private replayProvider(callback: (editor: { add: (input: { info: HostProviderInfo; models: HostModelInfo[] }) => void }) => void): void {
    callback({ add: (input) => this.providerAdditions.push(input) })
  }

  private id(): string {
    this.nextID += 1
    return `ses_fake${String(this.nextID).padStart(4, '0')}`
  }
}

/** One completed assistant message carrying `text`. */
export function assistant(text: string, extra: Partial<HostMessage> = {}): HostMessage {
  const content: HostAssistantContent[] = [{ type: 'text', text }]
  return {
    type: 'assistant',
    time: { created: Date.now(), completed: Date.now() },
    content,
    ...extra,
  }
}

/** A failed assistant message. */
export function failedAssistant(message: string): HostMessage {
  return {
    type: 'assistant',
    time: { created: Date.now() },
    content: [],
    finish: 'error',
    error: { type: 'provider.error', message },
  }
}
