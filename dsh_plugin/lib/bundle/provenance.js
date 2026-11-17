/**
 * Bundle row: the DSH root-chat resolver behind write provenance.
 *
 * The graph engine records, per write, which conversation root caused it. The
 * engine itself never reads `agent.id` for that — it asks the host, through
 * `exec.provenance` or the `config.provenance(exec)` hook this bundle passes to
 * `core.apply` (design 26111000 §Rules 2-3). This module is that host side: DSH
 * gives every tool call the agent it ran in, and for a subagent that agent is
 * the CHILD, so the root is found by walking the durable session header up the
 * delegation chain.
 *
 * The walk follows the spike rule in design 26111000 §"DSH: finding the root":
 *
 *   - the header carries `parentSession`, `origin:'subagent'` and
 *     `delegationDepth` (`dsh-subagent`'s `childSessionMeta`, lib/index.js:346);
 *   - a plain fork also sets `parentSession`, but without `origin:'subagent'`,
 *     so only subagent hops are walked and a fork counts as its own root;
 *   - a live agent is resolved through the AgentRegistry's
 *     `ctx.get('agents').get(id)` (`dsh-agent` lib/index.js:596), the same
 *     lookup `dsh-subagent`'s private `liveLineage` uses (lib/index.js:1735-1747).
 *
 * A wrong id is worse than a missing one: anything short of positive proof is
 * `session:null` with a reason from the engine's closed set. The fallback is
 * never the immediate agent.
 *
 * @module dsh-mexplore/bundle/provenance
 */

/**
 * Parent hops allowed in one walk. A longer chain is reported as a failed walk,
 * never truncated to an intermediate ancestor (design 26111000 §Rules 2).
 */
export const MAX_HOPS = 8

/**
 * The live-Agent lookup for a plugin context: `ctx.get('agents').get(id)`.
 *
 * `ctx.get` is used rather than `ctx.agents` because it resolves a provided
 * service without an inject requirement (`cordis` lib/index.js:763), so a row
 * that never injected `agents` can still ask. When the profile has no agent
 * registry, or anything throws, every id resolves to `undefined` and a walk
 * needs one becomes `walk-failed` — never a guess.
 *
 * @param ctx - the bundle plugin context.
 * @returns `(id) => liveAgent | undefined`.
 */
export function agentLookup(ctx) {
  return (id) => {
    if (typeof id !== 'string' || id.length === 0) return undefined
    try {
      const agents = ctx?.get?.('agents')
      if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
      return agents.get(id)
    } catch {
      return undefined
    }
  }
}

/**
 * The root chat session of `agent`: `{session}` with the id verbatim, or
 * `{session:null, reason}` with `root-unverified` (no positive root signal) or
 * `walk-failed` (a lookup failed, hit a cycle, or exceeded {@link MAX_HOPS}).
 *
 * Never throws and never returns the agent it was given as a fallback: the
 * returned id is only ever an agent whose own header says it is a root.
 *
 * @param agent - the call's `exec.agent`.
 * @param lookup - `(id) => liveAgent | undefined`; see {@link agentLookup}.
 */
export function rootOf(agent, lookup) {
  let current = agent
  const seen = new Set()
  const firstId = idOf(agent)
  if (firstId !== undefined) seen.add(firstId)
  let hops = 0
  while (true) {
    const header = headerOf(current)
    // No header at all is no proof of anything: it is never a root id.
    if (header === undefined) return { session: null, reason: 'root-unverified' }
    // The spec's rule, verbatim: `origin !== 'subagent'` and NOT
    // `delegationDepth > 0` is a top-level agent. The loose comparison is
    // deliberate — a corrupt but truthy depth must make the header look like a
    // subagent so the walk fails closed, never pass it off as a root.
    const subagent = header.origin === 'subagent' || header.delegationDepth > 0
    if (!subagent) {
      const id = idOf(current)
      return id !== undefined ? { session: id } : { session: null, reason: 'root-unverified' }
    }
    const parentSession = header.parentSession
    if (typeof parentSession !== 'string' || parentSession.length === 0) return { session: null, reason: 'root-unverified' }
    if (hops >= MAX_HOPS || seen.has(parentSession)) return { session: null, reason: 'walk-failed' }
    hops += 1
    seen.add(parentSession)
    const parent = safeLookup(lookup, parentSession)
    // A parent that is not live cannot be verified, and a dead hop is not an
    // intermediate ancestor we may report instead.
    if (parent === undefined) return { session: null, reason: 'walk-failed' }
    current = parent
  }
}

/**
 * The `config.provenance(exec)` resolver a chat row hands to the engine: actor
 * and host plus the root of the calling agent. Built once per row, because the
 * walk is a plugin-context concern, not a per-call one.
 *
 * @param ctx - the bundle plugin context (for the live-agent lookup).
 */
export function chatResolver(ctx) {
  const lookup = agentLookup(ctx)
  return (exec) => ({ actor: 'chat', host: 'dsh', ...rootOf(exec?.agent, lookup) })
}

function headerOf(agent) {
  try {
    const header = agent?.session?.header
    return header !== null && typeof header === 'object' ? header : undefined
  } catch {
    return undefined
  }
}

function idOf(agent) {
  try {
    const id = agent?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

function safeLookup(lookup, id) {
  if (typeof lookup !== 'function') return undefined
  try {
    const agent = lookup(id)
    return agent === null ? undefined : agent
  } catch {
    return undefined
  }
}
