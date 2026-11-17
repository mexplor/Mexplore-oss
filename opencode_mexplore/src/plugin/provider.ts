/**
 * The memory provider and its key integration (REQ-021).
 *
 * Both registrations are TRANSFORMS, and a transform callback is synchronous,
 * so neither may await `ctx.storage`. The plugin therefore loads the settings
 * BEFORE registering (see `setup`) and keeps one mutable object that the
 * transform closure captures; a WRITER updates it in place and then calls
 * `ctx.provider.reload()`, which replays the transform against the values now in
 * place — no restart (SP-3 verifies this on the real binary).
 *
 * **In-flight calls (REQ-021, AC-024).** A change must not disturb a call that is
 * already running, and OpenCode re-resolves a session's model on EVERY step:
 *
 *   - a MODEL is kept served by a lease ({@link ModelLeases}) for as long as a
 *     child holds it, because `editor.add` replaces the model list and dropping
 *     it would fail that child's next step;
 *   - each child's BASE URL is pinned by the request hook, so a settings change
 *     affects only later calls. Reset removes the custom selection but retains
 *     the leased provider/model record until existing children finish.
 *
 * The model is `active`, so OpenCode lists it (as "… (memory)") — including in
 * the model picker the TUI opens right after `/connect` → mexplore, which would
 * otherwise be empty (user decision, 2026-11-06). Picking it there switches the
 * CHAT model; memory calls never depend on that choice. `activation: "enabled"`
 * lets the resolver use it for a child that asks for it by id.
 *
 * @module mexplore/plugin/provider
 */
import type { HostContext, HostModelInfo, HostProviderInfo } from './host'
import type { Settings } from './settings'
import { providerConfig } from './settings'
import { MEMORY_CONTEXT_LIMIT, PROVIDER_ID, PROVIDER_PACKAGE } from './config'

const INTEGRATION_LABEL = 'mexplore memory API key'
const PROVIDER_NAME = 'mexplore memory'

/** The model's advertised output limit; the proxy streams far less. */
const MODEL_OUTPUT_LIMIT = 32_000

/**
 * Models a live child still holds, by model id, with a reference count. Read by
 * the (sync) provider transform; mutated only by the plugin.
 */
export class ModelLeases {
  private readonly counts = new Map<string, number>()

  /**
   * Hold a model open while a child runs.
   *
   * The MODEL has to be leased because `editor.add` replaces the model list, and
   * OpenCode re-resolves a session's model on every step — dropping it mid-call
   * would fail that child's next request. The base URL needs no lease: it is
   * pinned per request by the `model.request` hook instead (see `endpointFor`),
   * so a change can apply immediately to the next call (REQ-021, AC-024).
   */
  retain(modelID: string): void {
    this.counts.set(modelID, (this.counts.get(modelID) ?? 0) + 1)
  }

  release(modelID: string): void {
    const next = (this.counts.get(modelID) ?? 0) - 1
    if (next > 0) this.counts.set(modelID, next)
    else this.counts.delete(modelID)
  }

  ids(): string[] {
    return [...this.counts.keys()]
  }

  size(): number {
    let total = 0
    for (const count of this.counts.values()) total += count
    return total
  }
}

/** One memory model record. `status: active`: listed in pickers (see the module note). */
function memoryModel(modelID: string): HostModelInfo {
  return {
    id: modelID,
    modelID,
    providerID: PROVIDER_ID,
    name: `${modelID} (memory)`,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: MEMORY_CONTEXT_LIMIT, output: MODEL_OUTPUT_LIMIT },
  }
}

/**
 * Build the provider record from explicit settings plus live leases. Fresh
 * installs advertise no custom model; reset retains only models still in use.
 */
export function memoryProvider(
  settings: Settings,
  leases?: ModelLeases,
  leasedBaseURL?: string,
): { info: HostProviderInfo; models: HostModelInfo[] } {
  const current = providerConfig(settings)
  // A reset must not strand a child that still holds a model. Its request hook
  // keeps the original endpoint; the host still needs a valid provider record.
  const baseURL = current.baseURL || (leases?.size() ? leasedBaseURL ?? '' : '')
  const ids = new Set([
    ...(current.baseURL && current.modelID ? [current.modelID] : []),
    ...(leases?.ids() ?? []),
  ])
  const models = baseURL ? [...ids].map(memoryModel) : []
  const info: HostProviderInfo = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    activation: models.length > 0 ? 'enabled' : 'disabled',
    package: PROVIDER_PACKAGE,
    integrationID: PROVIDER_ID,
    // No endpoint or model is invented for a fresh install.
    settings: baseURL ? { baseURL } : {},
  }
  return { info, models }
}

export async function registerIntegration(ctx: HostContext): Promise<void> {
  await ctx.integration.transform((editor) => {
    editor.method.update({
      integrationID: PROVIDER_ID,
      method: { type: 'key', label: INTEGRATION_LABEL },
    })
    editor.update(PROVIDER_ID, (integration) => {
      integration.name = PROVIDER_NAME
    })
  })
}

/** Register the provider transform: one provider, the current model and URL. */
export async function registerProvider(
  ctx: HostContext,
  settings: Settings,
  leases: ModelLeases,
): Promise<void> {
  let lastBaseURL = providerConfig(settings).baseURL
  await ctx.provider.transform((editor) => {
    const current = providerConfig(settings).baseURL
    if (current) lastBaseURL = current
    editor.add(memoryProvider(settings, leases, lastBaseURL))
  })
}
