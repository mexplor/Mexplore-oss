/**
 * Which credentials are in play for one call, and how they are collected
 * (AC-025, SEC-006).
 *
 * **The memory model is not always ours.** `/mexplore model anthropic/claude-sonnet-5`
 * — and the parent-model fallback (REQ-005 step 3) — run the child on a
 * THIRD-PARTY provider, whose API key this plugin never otherwise sees. A
 * provider error echoes the key it was handed ("Invalid API key 'AbCdEf…'"), and
 * an opaque key need not match any shape rule, so shape scrubbing alone cannot
 * promise it will not reach a transcript. The sanitizer therefore collects the
 * ACTUAL credentials of the provider in use and replaces every occurrence.
 *
 * Each provider is asked in both ways OpenCode can hold a key:
 *
 *   - **the credential store**: `integration.connection.active(id)` →
 *     `connection.resolve(...)`, which yields `{ type: "key", key }` or
 *     `{ type: "oauth", access, refresh, … }`. The core maps those onto the
 *     request as `apiKey` / `authToken` / `accessToken` depending on the package
 *     (`core/src/model-resolver.ts:385-403`), so `key`, `access` and `refresh`
 *     are all collected — the string, not the field name, is what gets echoed.
 *   - **literal provider settings**: `settings.apiKey` / `authToken` /
 *     `accessToken` on the provider record. Verified on 2.2.5: `provider.list()`
 *     returns `ProviderInfo.settings` VERBATIM and unredacted (a probe against
 *     the real binary returned the configured literal key), so a key set in
 *     `opencode.json` is scrubbed too.
 *
 * Resolution is a FUNCTION called at each scrub, not a snapshot taken at call
 * start, so a `/connect` rotation mid-call is followed: the new key is the one
 * that authenticates the child's next request, and so the one an error quotes.
 *
 * Nothing here is stored, logged or returned: the strings live for one scrub.
 *
 * @module mexplore/plugin/credentials
 */
import type { HostContext } from './host'
import { PROVIDER_ID } from './config'

/** Provider-settings fields that can hold a literal credential. */
export const SETTING_SECRET_KEYS = ['apiKey', 'authToken', 'accessToken'] as const

/** Credential-value fields a resolved connection can carry. */
const CREDENTIAL_FIELDS = ['key', 'access', 'refresh', 'token'] as const

/** Headers whose value is the secret itself. */
const SECRET_HEADERS = /^(authorization|x-api-key|api-key|auth-token)$/i

/** Anything shorter than this is not treated as a secret worth blanking. */
const MIN_SECRET_LENGTH = 8

/** One provider whose credential this call could send. */
export interface ProviderUnderUse {
  readonly providerID: string
  /** True for the `mexplore` provider, whose key comes from its integration. */
  readonly memoryProvider: boolean
}

/**
 * Collects credentials in play, lazily.
 *
 * `collect` is called at each scrub with the providers the text could have come
 * from, so a rotation between steps is followed and an unrelated provider is
 * never consulted.
 */
export interface CredentialSources {
  collect: (providers: readonly ProviderUnderUse[]) => Promise<string[]>
}

/** The memory provider, described for a `collect` call. */
export function memoryProviderUse(providerID = PROVIDER_ID): ProviderUnderUse {
  return { providerID, memoryProvider: true }
}

/** Any other provider, described for a `collect` call. */
export function providerUse(providerID: string): ProviderUnderUse {
  return { providerID, memoryProvider: providerID === PROVIDER_ID }
}

/**
 * Build the collector over `ctx`.
 *
 * A lookup that throws (a provider removed mid-call, a credential store that is
 * down) contributes nothing rather than failing the scrub: a diagnostic must
 * still be safe when the catalogue is the broken part.
 */
export function makeCredentialSources(
  ctx: Pick<HostContext, 'integration' | 'provider'>,
): CredentialSources {
  return {
    async collect(providers) {
      const ids = [...new Set(providers.map((provider) => provider.providerID))]
      const [fromSettings, fromStore] = await Promise.all([
        Promise.all(ids.map((id) => literalSettings(ctx, id))),
        Promise.all(ids.map((id) => connectionSecret(ctx, id))),
      ])
      return [...new Set([...fromSettings.flat(), ...fromStore.flat()])].filter(
        (secret) => secret.length >= MIN_SECRET_LENGTH,
      )
    },
  }
}

/** A literal credential configured in `opencode.json` for one provider. */
async function literalSettings(
  ctx: Pick<HostContext, 'provider'>,
  providerID: string,
): Promise<string[]> {
  let settings: Record<string, unknown> | undefined
  try {
    const record = await ctx.provider.get({ providerID })
    settings = (record?.settings ?? undefined) as Record<string, unknown> | undefined
  } catch {
    // A provider the catalogue does not know contributes nothing.
    return []
  }
  if (settings === null || settings === undefined || typeof settings !== 'object') return []
  const found: string[] = []
  for (const key of SETTING_SECRET_KEYS) {
    const value = settings[key]
    if (typeof value === 'string') found.push(value)
  }
  // A configured header can hold `Authorization: Bearer …`: the SECRET is the
  // value after the scheme, not the whole header.
  const headers = settings.headers
  if (headers !== null && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string' || !SECRET_HEADERS.test(name)) continue
      found.push(value.replace(/^\s*(?:bearer|token|basic)\s+/i, '').trim())
    }
  }
  return found
}

/** The connected credential for one provider, resolved NOW (rotation is followed). */
async function connectionSecret(
  ctx: Pick<HostContext, 'integration'>,
  providerID: string,
): Promise<string[]> {
  try {
    const connection = await ctx.integration.connection.active(providerID)
    if (connection === undefined || connection === null) return []
    const value = (await ctx.integration.connection.resolve(connection)) as Record<string, unknown> | undefined
    if (value === null || typeof value !== 'object') return []
    return CREDENTIAL_FIELDS.flatMap((field) => {
      const candidate = value[field]
      return typeof candidate === 'string' ? [candidate] : []
    })
  } catch {
    return []
  }
}

/**
 * Should this call report provider failures CATEGORICALLY rather than by body?
 *
 * When no credential could be resolved for a provider that is not ours, exact
 * redaction cannot be guaranteed — an ambient `ANTHROPIC_API_KEY`, a cloud
 * metadata token, an OAuth refresh that failed. For those, the raw body is
 * dropped and only the type and HTTP status are reported, so nothing unscrubbed
 * can reach a transcript because no raw text is reported at all. The memory
 * provider keeps its detail: its key is one we resolve, and a wrong key there is
 * exactly what a user needs named.
 */
export function needsCategoricalErrors(
  providers: readonly ProviderUnderUse[],
  resolved: readonly string[],
): boolean {
  if (resolved.length > 0) return false
  return providers.some((provider) => !provider.memoryProvider)
}
