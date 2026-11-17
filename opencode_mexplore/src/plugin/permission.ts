/**
 * SEC-002: writes need no prompt by default, but a user's own `ask` rule must
 * still be honoured.
 *
 * OpenCode's default agent already allows everything (`schema/src/agent.ts`), so
 * `permission.assert({ action: "mexplore", resources: ["manage"] })` resolves
 * immediately on a stock install — it is not a prompt, it is a CONSULT. The only
 * user who sees a question is the one who added a rule like
 * `{ "action": "mexplore", "resource": "manage", "effect": "ask" }`, and
 * `save: ["manage"]` is what makes their "always allow" persist per project.
 *
 * Two rules this module exists to keep:
 *
 *   - **Absent is not denied.** A host without `ctx.permission.assert` proceeds,
 *     because the default is no prompt; failing closed would turn a security
 *     nicety into an outage on any host that drops the API.
 *   - **A refusal is the user's answer, not tool output.** A decline
 *     (`Permission.DeclinedError`) or a correction is rethrown untouched: the
 *     host turns it into the model-visible failure, and the plugin must not
 *     catch it and hand the refusal back as a normal result.
 *
 * @module mexplore/plugin/permission
 */
import type { HostContext } from './host'

/** The action a manage call asserts: `/mexplore`'s write authority. */
export const MANAGE_ACTION = 'mexplore'
export const MANAGE_RESOURCE = 'manage'

/** The invocation facts OpenCode needs to attribute a decision to this call. */
export interface ToolInvocation {
  sessionID: string
  agent: string
  messageID: string
  id: string
}

/**
 * Ask the host to approve a `manage` call, before any child exists.
 *
 * Returns when the request is allowed (immediately, on a stock install).
 * Rejects with the host's own error when it is denied — never with a message of
 * this plugin's making, so the user's "no" reaches the model as a refusal rather
 * than being re-described.
 */
export async function assertManage(ctx: HostContext, invocation: ToolInvocation): Promise<void> {
  const assert = ctx.permission?.assert
  // No permission API: proceed. The default agent allows everything, so this is
  // the same outcome a stock install gets — never fail closed (SEC-002).
  if (typeof assert !== 'function') return

  await assert({
    sessionID: invocation.sessionID,
    agent: invocation.agent,
    action: MANAGE_ACTION,
    resources: [MANAGE_RESOURCE],
    // Makes "always allow" persist for this project (permission.ts:151-158,332-341).
    save: [MANAGE_RESOURCE],
    source: { type: 'tool', messageID: invocation.messageID, id: invocation.id },
  })
}
