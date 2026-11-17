/**
 * Capturing dsh's `memory:graph` prompt section and its variable providers
 * (REQ-006, REQ-009).
 *
 * `promptProfile` is fixed when `apply` runs: the section TEMPLATE and every
 * provider closure capture it (`dsh_plugin/lib/index.js`). One profile is one
 * `apply`, so a read call cannot accidentally see write guidance.
 *
 * The template is a layout — it contains `{{slot}}` tokens (`{{memory_index}}`,
 * `{{memory_today}}`, …) whose values only the registered providers can supply.
 * Rendering therefore happens at CALL time, not load time: the index reflects
 * the graph as it is now, and the date is the day the call runs on. The static
 * text sits before the slots in the template, so the provider-side prompt cache
 * can reuse the unchanged prefix.
 *
 * @module mexplore/graph/prompt
 */

/** A dsh system-prompt variable provider (called per assembly). */
export type VariableProvider = ((context: unknown) => unknown) | string

/** The assemble context dsh hands a provider. No turn side effect is wanted. */
const EMPTY_ASSEMBLY_CONTEXT = {}

const SLOT_RE = /\{\{(\w+)\}\}/g

export interface CapturedPrompt {
  sectionName: string
  template: string
  variables: Map<string, VariableProvider>
}

/**
 * Render the section as dsh's own assembly would: every `{{slot}}` replaced by
 * its provider's value, and a slot with no registered provider rendered as ''
 * (the contract dsh has always relied on for `memory_append_line`).
 */
export function renderCapturedPrompt(captured: CapturedPrompt): string {
  const { template, variables } = captured
  return template.replace(SLOT_RE, (_match, key: string) => {
    const provider = variables.get(key)
    if (provider === undefined) return ''
    if (typeof provider === 'function') return String(provider(EMPTY_ASSEMBLY_CONTEXT))
    return String(provider)
  })
}

export interface PromptCapture {
  /** The fake context dsh_plugin's `inject` callback receives. */
  promptCtx: {
    systemPrompt: {
      section: (section: unknown) => () => void
      variable: (name: string, provider: VariableProvider) => () => void
    }
  }
  /** The one section dsh registered, once its `inject` callback has run. */
  read: () => CapturedPrompt | undefined
}

/**
 * A recording stand-in for `ctx.systemPrompt`. dsh registers variables and
 * then exactly one section inside a single `inject(['systemPrompt'], …)` call;
 * this records both and never assumes which arrives first.
 */
export function beginPromptCapture(): PromptCapture {
  const variables = new Map<string, VariableProvider>()
  let captured: CapturedPrompt | undefined

  const promptCtx = {
    systemPrompt: {
      section: (section: unknown) => {
        if (captured !== undefined) return () => {}
        const record = section as { name?: unknown; text?: unknown } | null
        if (record === null || typeof record !== 'object') return () => {}
        captured = {
          sectionName: typeof record.name === 'string' ? record.name : '(unnamed)',
          template: typeof record.text === 'string' ? record.text : '',
          variables,
        }
        return () => {
          captured = undefined
        }
      },
      variable: (name: string, provider: VariableProvider) => {
        // A provider registered after the section still belongs to it: the
        // template is rendered by slot name, not by registration order.
        variables.set(name, provider)
        return () => {
          variables.delete(name)
        }
      },
    },
  }

  return { promptCtx, read: () => captured }
}
