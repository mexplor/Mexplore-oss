/**
 * One model-request hook for `context`, `compaction` and `generate` (REQ-007,
 * REQ-018).
 *
 * One function, because the decision is identical in all three: an OWNED child
 * keeps exactly its tier's graph tools and loses everything else; every other
 * session loses every graph tool. Only the narrowing differs by event —
 * `event.system` is replaced on `context` ONLY, so a compaction request keeps
 * OpenCode's own compaction instructions instead of being handed memory
 * guidance (which would produce a summary of the wrong thing).
 *
 * The brief is appended on `context` only, and only when the request actually
 * advertises `mexplore`. Hook filtering is catalog visibility, not execution
 * authorization, which is why the executors re-check ownership (REQ-019).
 *
 * @module mexplore/plugin/hooks
 */
import type { HostHookEvent, HostModelRequestEvent } from './host'
import type { ChildRegistry } from './lifecycle'
import type { ModelRef } from './types'
import { USAGE_BRIEF } from './prompt'
import { PROVIDER_ID } from './config'

const GRAPH_TOOL_PREFIX = 'memory_'

/** No session gets this many parent models remembered; ids are opaque ULIDs. */
const MODEL_CACHE_LIMIT = 500

/** Remembers each parent session's resolved model (REQ-005 step 3). */
export class ParentModelCache {
  private readonly models = new Map<string, ModelRef>()

  set(sessionID: string, model: ModelRef): void {
    // Re-insert on write so the Map's own order is the recency order.
    this.models.delete(sessionID)
    this.models.set(sessionID, { providerID: model.providerID, id: model.id })
    if (this.models.size > MODEL_CACHE_LIMIT) {
      const oldest = this.models.keys().next()
      if (!oldest.done) this.models.delete(oldest.value)
    }
  }

  get(sessionID: string): ModelRef | undefined {
    return this.models.get(sessionID)
  }
}

/** No caller keeps this many proven roots remembered. */
const ROOT_CACHE_LIMIT = 500

/**
 * Remembers each caller session's ROOT chat session (write-session provenance
 * #317). Same recency-bounded shape as {@link ParentModelCache}: re-insert on
 * write so the Map's own order is recency, and evict the oldest past the limit.
 *
 * Only a PROVEN root is ever stored. A failed walk is deliberately not cached:
 * one host hiccup must not pin `walk-failed` on a session for the rest of the
 * plugin's lifetime, so the next call retries.
 */
export class RootSessionCache {
  private readonly roots = new Map<string, string>()

  set(sessionID: string, root: string): void {
    this.roots.delete(sessionID)
    this.roots.set(sessionID, root)
    if (this.roots.size > ROOT_CACHE_LIMIT) {
      const oldest = this.roots.keys().next()
      if (!oldest.done) this.roots.delete(oldest.value)
    }
  }

  get(sessionID: string): string | undefined {
    return this.roots.get(sessionID)
  }
}

export interface HookDeps {
  registry: ChildRegistry
  parentModels: ParentModelCache
}

export type HookKind = 'context' | 'compaction' | 'generate'

/**
 * Apply the hook's decision to an event in place. Exported separately from the
 * registration so a test can drive it without a host.
 */
export function applyHook(event: HostHookEvent, kind: HookKind, deps: HookDeps): void {
  const owned = deps.registry.get(event.sessionID)
  if (owned !== undefined) {
    shapeOwnedChild(event, kind, owned.call.toolDefs(), owned.call.renderPrompt())
    return
  }
  // Everyone else: no graph tool, ever (REQ-007, AC-004). This also covers a
  // child of ours whose teardown already removed it from the map.
  for (const name of Object.keys(event.tools)) {
    if (name.startsWith(GRAPH_TOOL_PREFIX)) delete event.tools[name]
  }
  if (kind !== 'context') return
  deps.parentModels.set(event.sessionID, { providerID: event.model.providerID, id: event.model.id })
  if (event.tools.mexplore === undefined) return
  appendBriefOnce(event)
}

/**
 * The child's request: its tier's tools with that profile's descriptions, and
 * (on `context`) the memory prompt in place of the agent's own.
 */
function shapeOwnedChild(
  event: HostHookEvent,
  kind: HookKind,
  defs: readonly { name: string; description: string; input: Record<string, unknown> }[],
  prompt: string,
): void {
  const keep = new Set(defs.map((def) => def.name))
  // Keep ONLY the tier's tools: an owned child must never see shell, fs, web,
  // subagent or code-mode tools either (SEC-003).
  for (const name of Object.keys(event.tools)) {
    if (!keep.has(name)) delete event.tools[name]
  }
  for (const def of defs) {
    const tool = event.tools[def.name]
    if (tool === undefined) continue
    tool.description = def.description
  }
  if (kind !== 'context') return
  event.system = [{ type: 'text', text: prompt }]
}

/**
 * Pin every request of an OWNED child to the endpoint that child started
 * against (REQ-021, AC-024).
 *
 * This is what makes `/mexplore base-url` take effect on the very next call: the
 * provider record is reloaded immediately with the new URL, and a call already
 * in flight keeps its own endpoint because its requests are re-pointed here, per
 * request, rather than by the provider's single `settings.baseURL`.
 *
 * ONLY a request for the memory provider itself is re-pointed. OpenCode lets a
 * child compact through a DIFFERENT configured model (`session/compaction.ts`),
 * and the core swaps the route endpoint without swapping authentication
 * (`session/model-request.ts`), so overriding a foreign provider's baseURL would
 * send that provider's request — and its credential — to the memory endpoint.
 * A parent request is likewise never touched.
 */
export function applyRequestHook(event: HostModelRequestEvent, deps: HookDeps): void {
  if (event.model.providerID !== PROVIDER_ID) return
  const endpoint = deps.registry.endpointFor(event.sessionID)
  if (endpoint !== undefined) event.baseURL = endpoint
}

/** Exactly one brief per request, however many times the hook runs (AC-014). */
function appendBriefOnce(event: HostHookEvent): void {
  const present = event.system.some((part) => part.type === 'text' && part.text.includes(USAGE_BRIEF))
  if (present) return
  event.system.push({ type: 'text', text: USAGE_BRIEF })
}
