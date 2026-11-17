/**
 * Tool registration (REQ-001, REQ-019).
 *
 * ONE `ctx.tool.transform` registers `mexplore` and every graph tool, all with
 * `options: { codemode: false }`. That option is load-bearing, not cosmetic: a
 * plugin tool defaults into Code Mode's `execute` catalog and never appears in
 * `event.tools`, which would break three things at once — the brief never
 * fires, the hook's deletion does nothing, and the parent could reach
 * `memory_*` through `execute` (REQ-019).
 *
 * The graph-tool executors are thin: they resolve the owned child by
 * `context.sessionID`, refuse a non-owner or an out-of-tier tool, and delegate
 * to `GraphCall.execute`. Ownership is checked HERE, not only in the hook,
 * because hook filtering controls what the model SEES, not what may run.
 *
 * @module mexplore/plugin/tools
 */
import { Error as ToolError } from '@opencode/plugin/promise/tool'
import type { GraphRuntime } from '../graph/index'
import { MANAGE_TOOL_NAMES } from '../graph/index'
import type { HostContext, HostToolContext, HostToolEditor } from './host'
import { MEXPLORE_DESCRIPTION, MEXPLORE_INPUT_SCHEMA, normalizeInput } from './input'
import type { ChildRegistry } from './lifecycle'

export const MEXPLORE_TOOL = 'mexplore'

/** What `mexplore` needs from the plugin to run a call. */
export interface MexploreExecutor {
  (input: unknown, context: HostToolContext): Promise<{ content: string; metadata: Record<string, unknown> }>
}

export interface ToolRegistrationDeps {
  runtime: GraphRuntime
  registry: ChildRegistry
  mexplore: MexploreExecutor
}

/**
 * The graph-tool names registered directly. The manage tier is the superset
 * (read ⊂ manage), and `memory_merge`/`memory_restore` are never in it
 * (SEC-001). `from_path` is already stripped from `memory_attach` by A1.
 */
const GRAPH_TOOL_NAMES: readonly string[] = MANAGE_TOOL_NAMES

export async function registerTools(ctx: HostContext, deps: ToolRegistrationDeps): Promise<void> {
  await ctx.tool.transform((editor: HostToolEditor) => {
    editor.add({
      name: MEXPLORE_TOOL,
      description: MEXPLORE_DESCRIPTION,
      input: MEXPLORE_INPUT_SCHEMA,
      options: { codemode: false },
      execute: async (input, context) =>
        refuse(() => {
          // A child may never nest a memory call inside itself: the hook already
          // hides the tool, and this executor makes it structural (REQ-003).
          if (deps.registry.isOwned(context.sessionID)) {
            throw new Error('mexplore: a memory call cannot start another memory call')
          }
          return deps.mexplore(input, context)
        }),
    })

    // Every graph tool is registered once, with the MANAGE profile's schema and
    // description: which of them a given child may actually call is decided by
    // its session permissions, the hook's tool set, and the executor's tier
    // check — never by what the registry happens to know about one child.
    for (const def of deps.runtime.toolDefs('manage')) {
      if (!GRAPH_TOOL_NAMES.includes(def.name)) continue
      editor.add({
        name: def.name,
        description: def.description,
        input: def.input,
        options: { codemode: false },
        execute: async (input, context) =>
          refuse(() => deps.registry.executeGraphTool(def.name, input, context.sessionID)),
      })
    }
  })
}

/**
 * Turn a failure into a `Tool.Error`, which is what the host shows the model as
 * a `tool.execution` error (REQ-019, REQ-020). The message is kept verbatim — a
 * child must be able to READ the remedy — the plugin's own categorical code
 * rides along in `metadata`, and the ORIGINAL error is kept as `error`.
 *
 * The `error` field matters for SEC-002: a permission decline arrives as a
 * tagged `Permission.DeclinedError`, and the host recovers it by digging the
 * cause out of the `Tool.Error`. Dropping it would turn the user's own "no" into
 * a vague tool failure the model could retry.
 */
async function refuse<T extends { content: string; metadata?: Record<string, unknown> }>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof ToolError) throw error
    const message = error instanceof Error ? error.message : String(error)
    const code = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? ((error as { code: string }).code)
      : undefined
    throw new ToolError({
      message,
      ...(error instanceof Error ? { error } : {}),
      ...(code === undefined ? {} : { metadata: { code } }),
    })
  }
}

/** Normalize the `mexplore` input once, before a child exists. */
export function readRequest(input: unknown): ReturnType<typeof normalizeInput> {
  return normalizeInput(input)
}
