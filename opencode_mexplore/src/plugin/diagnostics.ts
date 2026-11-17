/**
 * Setup diagnostics (REQ-014).
 *
 * OpenCode V2 has no doctor command, and a wrong graph root or a stale model
 * selection would otherwise surface only as a swallowed run failure (an
 * unreachable agent shows up as `outcome: "failed"` at idle). So the checks run
 * once at setup, and a problem becomes ONE actionable error on the first
 * `mexplore` call: what is wrong, where it came from, and the exact command or
 * env var that fixes it.
 *
 * Nothing here is fatal to loading the plugin: a session that can still use
 * `/mexplore` must be able to run it, even when memory itself is broken.
 *
 * @module mexplore/plugin/diagnostics
 */
import fsp from 'node:fs/promises'
import type { GraphRootSource } from './config'
import type { Settings } from './settings'
import { COMMAND_NAME } from './config'

/** One resolved model the host reports (the slice of `ctx.model.list()` used). */
export interface AvailableModel {
  providerID: string
  id: string
  enabled: boolean
  capabilities: { tools: boolean }
}

export interface DiagnosticInput {
  graphRoot: string
  graphRootSource: GraphRootSource
  settings: Settings
  models: readonly AvailableModel[]
  /** Agent ids the host reports; `undefined` when the host cannot list them. */
  agents?: readonly string[]
}

/** The child's base agent (SP-1). A missing one fails every call at run time. */
export const REQUIRED_AGENT = 'summary'

/**
 * The first actionable problem, or `undefined` when everything checks out.
 * Order is the order the user can act on: a broken graph root breaks every
 * call, a missing agent breaks every call and is invisible otherwise (an
 * unknown agent only shows up as `outcome: "failed"`), a broken model selection
 * breaks the calls that need a model.
 */
export async function diagnose(input: DiagnosticInput): Promise<string | undefined> {
  return (await checkGraphRoot(input)) ?? checkAgent(input) ?? checkModel(input) ?? checkBaseURL(input)
}

function checkAgent(input: DiagnosticInput): string | undefined {
  if (input.agents === undefined) return undefined
  if (input.agents.includes(REQUIRED_AGENT)) return undefined
  return [
    `mexplore: the built-in \`${REQUIRED_AGENT}\` agent this plugin runs memory calls on is missing from this OpenCode.`,
    'Fix: update OpenCode to a 2.2.x release whose built-in agent list includes it, or remove the plugin.',
  ].join(' ')
}

/** Where the graph root came from, as the error and the startup line word it. */
export function describeGraphRootSource(source: GraphRootSource): string {
  return source === 'option' ? 'the plugin option `graphRoot`' : source === 'env' ? '`MEXPLORE_GRAPH_ROOT`' : 'the default location'
}

/**
 * The graph root must be creatable and writable. A missing root is created by
 * dsh on first write, so creating it here is not a change in behavior — only an
 * earlier failure with a better message.
 */
async function checkGraphRoot(input: DiagnosticInput): Promise<string | undefined> {
  const from = describeGraphRootSource(input.graphRootSource)
  try {
    await fsp.mkdir(input.graphRoot, { recursive: true })
    await fsp.access(input.graphRoot, fsp.constants.W_OK)
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return [
      `mexplore: the memory graph directory ${JSON.stringify(input.graphRoot)} (from ${from}) is not writable (${reason}).`,
      input.graphRootSource === 'option'
        ? 'Fix: point the `graphRoot` plugin option at a writable directory.'
        : 'Fix: set MEXPLORE_GRAPH_ROOT to a writable directory, or fix the permissions of this one.',
    ].join(' ')
  }
}

/**
 * A stored `/mexplore model <provider/model>` selection must still be a real,
 * enabled, tool-capable model. A bare memory-provider model id cannot be
 * checked in advance — that is what `/mexplore test` is for.
 */
function checkModel(input: DiagnosticInput): string | undefined {
  const selected = input.settings.model
  if (selected === undefined) return undefined
  const match = input.models.find((model) => `${model.providerID}/${model.id}` === selected)
  if (match !== undefined && match.enabled && match.capabilities.tools) return undefined
  const why =
    match === undefined
      ? 'that model is not available'
      : match.enabled
        ? 'that model cannot call tools'
        : 'that model is disabled'
  return [
    `mexplore: the memory model ${JSON.stringify(selected)} (from \`/${COMMAND_NAME} model\`) cannot be used — ${why}.`,
    `Fix: run \`/${COMMAND_NAME} model <provider/model>\` with an enabled, tool-capable model, or \`/${COMMAND_NAME} reset\` to inherit the current session's model.`,
  ].join(' ')
}

function checkBaseURL(input: DiagnosticInput): string | undefined {
  // A selected host model uses that host provider, not any old custom settings.
  if (input.settings.model !== undefined) return undefined
  const baseURL = input.settings.baseURL
  if (baseURL === undefined) {
    return input.settings.mexploreModel === undefined
      ? undefined
      : `mexplore: a custom memory model needs an explicit endpoint. Run \`/${COMMAND_NAME} base-url <url>\`, or \`/${COMMAND_NAME} reset\` to inherit the current session's model.`
  }
  const problem = baseURLProblem(baseURL)
  if (problem === undefined) return undefined
  return [
    `mexplore: the stored memory provider URL ${JSON.stringify(baseURL)} (from \`/${COMMAND_NAME} base-url\`) is not usable — ${problem}.`,
    `Fix: run \`/${COMMAND_NAME} base-url <url>\` with an https:// URL, or \`/${COMMAND_NAME} reset\` to inherit the current session's model.`,
  ].join(' ')
}

/**
 * `https://` anywhere; `http://` only to the loopback interface, because a
 * memory key over plain http to a remote host is a leak (REQ-021).
 */
export function baseURLProblem(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'it is not a valid URL'
  }
  if (url.protocol === 'https:') return undefined
  if (url.protocol !== 'http:') return `only https:// (or http:// to localhost) is accepted, not ${url.protocol}`
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    ? undefined
    : 'http:// is only accepted for localhost or 127.0.0.1'
}
