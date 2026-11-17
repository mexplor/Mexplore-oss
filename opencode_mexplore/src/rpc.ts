/**
 * The mexplore RPC contract (REQ-021, TUI part).
 *
 * One method, `command`: run a `/mexplore <args>` subcommand on the SERVER and
 * return its reply text. The server owns every part of the logic — storage,
 * provider reloads, the key's presence, the model registry — so the TUI part
 * never re-implements it, and the two surfaces cannot drift.
 *
 * This file is imported by both parts, which is why it is its own export
 * (`mexplore/rpc`): the server part registers an implementation against it, and
 * the TUI part turns its own `client.rpc(…)` into a typed call.
 *
 * Everything here is a PLAIN type or a plain JSON Schema — no host-only import —
 * so it loads in the server, the TUI and a test alike.
 *
 * @module mexplore/rpc
 */

/** The RPC id, which prefixes every method and event it emits. */
export const RPC_ID = 'mexplore'

/** What `command` accepts: the raw argument text after `/mexplore`. */
export const COMMAND_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    args: {
      type: 'string',
      description:
        'The raw argument text after `/mexplore`, exactly as typed: "" for status, or "model <id>", "base-url <url>", "key", "test", "reset".',
    },
    sessionID: {
      type: 'string',
      description:
        'The session the command was invoked from. Used only to read that session\'s cached parent model for the status line; not required.',
    },
  },
  required: ['args'],
  additionalProperties: false,
} as const

/** What `command` returns: the reply text, already scrubbed of credentials. */
export const COMMAND_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The reply to show the user, verbatim.' },
  },
  required: ['text'],
  additionalProperties: false,
} as const

/**
 * The shape of the definition, declared structurally.
 *
 * `Rpc.define` only validates the shape of a definition at type level; the
 * definition itself is a plain object, and `RpcPortableDefinition` is an
 * erased view of it. Typing it here (rather than importing `@opencode/plugin/rpc`)
 * keeps this module importable by anything, while the server and TUI parts use
 * the real `Rpc.define` at their call sites.
 */
export interface CommandInput {
  args: string
  sessionID?: string
}

export interface CommandOutput {
  text: string
}

/** The RPC definition, in the shape `Rpc.define` accepts. */
export const MexploreRpc = {
  id: RPC_ID,
  methods: {
    command: {
      input: COMMAND_INPUT_SCHEMA,
      output: COMMAND_OUTPUT_SCHEMA,
    },
  },
  events: {},
} as const

/**
 * The reply shown when the TUI cannot reach the server's RPC.
 *
 * Deliberately CATEGORICAL: the TUI cannot resolve the server's memory
 * credential, so a transport error's text may quote one (a URL with user-info, a
 * proxy message echoing a key). Reporting the category and the remedy keeps the
 * dialog useful without putting anything unscrubbed in it (AC-025, SEC-006).
 * The error itself is never interpolated; only its kind is used, and only to
 * pick between two fixed sentences.
 */
export function unavailableText(error: unknown): string {
  const kind = classify(error)
  return [
    `mexplore: the OpenCode server didn't answer (${kind}).`,
    'Try again, or use `/mexplore` in a new message. The plugin may still be loading, or the server may be restarting.',
  ].join(' ')
}

/** A coarse, credential-free label for a transport failure. */
function classify(error: unknown): string {
  if (error === null || error === undefined) return 'no reply'
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (text.includes('timeout') || text.includes('timed out')) return 'timed out'
  if (text.includes('refused') || text.includes('econnrefused')) return 'connection refused'
  if (text.includes('unauthorized') || text.includes('401')) return 'not authorized'
  if (text.includes('not found') || text.includes('404')) return 'not available here'
  return 'no reply'
}
