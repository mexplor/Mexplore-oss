/**
 * The three durable settings (REQ-021) and the model that results (REQ-005).
 *
 * These live in `ctx.storage`, namespaced by the plugin, and they are the only
 * durable state besides the graph itself. The API key is NOT one of them: it
 * lives in OpenCode's credential store, reached through the `mexplore`
 * integration, so no code path here can write, read back or log it.
 *
 * Providers reload their transforms synchronously and cannot await storage, so
 * the plugin loads these BEFORE registering anything and keeps the loaded copy
 * current itself. That is why every settings change here also calls
 * `ctx.provider.reload()` with the new values already captured.
 *
 * @module mexplore/plugin/settings
 */
import type { ModelRef, ModelSource } from './types'
import { PROVIDER_ID, STORAGE_KEYS } from './config'

/** The slice of `ctx.storage` this module uses. */
export interface StorageLike {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
}

/** The loaded settings, as the sync transforms read them. */
export interface Settings {
  /** `provider/model` selected with `/mexplore model <provider/model>`. */
  model?: string
  /** Bare model id served by the memory provider. */
  mexploreModel?: string
  /** The memory provider's base URL. */
  baseURL?: string
}

export async function readSettings(storage: StorageLike): Promise<Settings> {
  const [model, mexploreModel, baseURL] = await Promise.all([
    storage.get(STORAGE_KEYS.model),
    storage.get(STORAGE_KEYS.mexploreModel),
    storage.get(STORAGE_KEYS.baseURL),
  ])
  const settings: Settings = {}
  if (typeof model === 'string' && model.length > 0) settings.model = model
  if (typeof mexploreModel === 'string' && mexploreModel.length > 0) settings.mexploreModel = mexploreModel
  if (typeof baseURL === 'string' && baseURL.length > 0) settings.baseURL = baseURL
  return settings
}

/**
 * Overwrite `target` with `next` IN PLACE, keeping its identity.
 *
 * The provider transform closes over ONE settings object; replacing the
 * reference would leave the transform reading the old values forever, which is
 * exactly the bug `/mexplore model` must not have (REQ-021). Keys absent from
 * `next` are deleted, so a reset really does restore the defaults.
 *
 * Call this only from a WRITER — a command that has just changed storage. A
 * reader must never write the live object: a `/mexplore status` racing a
 * `/mexplore model` would publish the older snapshot it read first, and the
 * provider would keep serving that stale model until the next change.
 */
export function replaceSettings(target: Settings, next: Settings): Settings {
  delete target.model
  delete target.mexploreModel
  delete target.baseURL
  Object.assign(target, next)
  return target
}

/** Explicit custom-provider settings only; empty fields mean not configured. */
export function providerConfig(settings: Settings): { baseURL: string; modelID: string } {
  return {
    baseURL: settings.baseURL ?? '',
    modelID: settings.mexploreModel ?? '',
  }
}

/**
 * Split `provider/model` on the FIRST slash, the way OpenCode's `Model.Ref`
 * parses it: a model id may itself contain slashes (`openrouter/…`), a provider
 * id may not.
 */
export function parseModelRef(value: string): ModelRef | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

/** Everything model resolution needs, so it stays a pure decision. */
export interface ModelInputs {
  settings: Settings
  /** Whether a key is connected to the `mexplore` integration. */
  hasKey: boolean
  /** The parent's model, cached from its `context` hook (REQ-005 step 3). */
  parentModel?: ModelRef
}

export interface ResolvedModel {
  model: ModelRef
  source: ModelSource
}

/**
 * An explicit host provider/model wins, followed by an explicitly configured
 * mexplore endpoint/model/key. With no override, inherit the parent's model.
 * Connecting a key alone never changes model selection.
 *
 * An incomplete custom override returns undefined rather than silently using a
 * different model or an implicit endpoint. The caller reports how to fix it.
 * `default` is retained as the historical usage-record tag for custom-provider
 * calls; it no longer denotes a built-in model.
 */
export function resolveModel(inputs: ModelInputs): ResolvedModel | undefined {
  const selected = inputs.settings.model === undefined ? undefined : parseModelRef(inputs.settings.model)
  if (selected !== undefined) return { model: selected, source: 'selected' }
  if (inputs.settings.mexploreModel !== undefined) {
    const custom = providerConfig(inputs.settings)
    if (!inputs.hasKey || custom.baseURL.length === 0 || custom.modelID.length === 0) return undefined
    return { model: { providerID: PROVIDER_ID, id: custom.modelID }, source: 'default' }
  }
  if (inputs.parentModel !== undefined) return { model: inputs.parentModel, source: 'parent-fallback' }
  return undefined
}

/** Report inheritance without suggesting that a separate key is required. */
export function modelNote(resolved: ResolvedModel): string[] {
  if (resolved.source !== 'parent-fallback') return []
  return [
    `note: memory agent ran on ${formatModelRef(resolved.model)} (inherited from the current OpenCode session; no memory model override configured)`,
  ]
}
