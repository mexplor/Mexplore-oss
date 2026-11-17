/**
 * Scrubbing before anything reaches the model, a session transcript or a log.
 *
 * Three invariants meet here, and each is cheap to state but easy to violate:
 *
 *   - **The child's session id never leaves the plugin** (REQ-003). A host or
 *     provider error can embed it, and so can a child's own prose or a write
 *     description.
 *   - **The credential actually in use never leaves the plugin** (AC-025,
 *     SEC-006). Shape rules alone are not enough: a provider echoes the key it
 *     was given ("Invalid API key 'AbCdEf…'"), and an opaque key need not look
 *     like anything in particular. So the REAL credentials are collected and
 *     every occurrence is replaced.
 *   - **Nothing survives by accident.** Every string produced for a model, a user
 *     or a log goes through one {@link Sanitizer}, so no call site has to
 *     remember the rules.
 *
 * **Which credentials?** Not just the memory integration's. A call can run on
 * another provider entirely (`/mexplore model anthropic/…`, or the parent-model
 * fallback), and that provider has its own key — a credential this plugin never
 * sees anywhere else. So the sanitizer is built from a {@link CredentialSource}
 * that names the provider in use and is asked AGAIN on every scrub: a key
 * rotated mid-call is followed, and a fallback call is scrubbed with the
 * fallback provider's key.
 *
 * The shape rules stay as a BACKSTOP for text that names a secret the plugin
 * cannot resolve (a key of some third service inside a host error). They are
 * deliberately NARROW — a blanket "long opaque token" rule would eat node ids,
 * absolute paths and long model ids (`openrouter/meta-llama/llama-3.3-70b-instruct`)
 * — so they are never the only defence. Where exact redaction cannot be
 * guaranteed at all, callers report provider failures CATEGORICALLY instead of
 * echoing the body (see `categoricalProviderError`).
 *
 * Credentials live only in memory, for the length of one scrub, and are never
 * stored, logged or returned.
 *
 * @module mexplore/plugin/redact
 */

/** What a credential is replaced with. Fixed, so a leak is easy to grep for. */
export const REDACTED = '<redacted>'

/** Provider keys and bearer tokens, in the forms error messages quote them. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `sk-…`, `sk-proj-…`, `pk-…`, `rk-…` style API keys, labelled or not.
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/gi, '$1-***'],
  // `Authorization: Bearer <token>` (and the bare "bearer <token>" form).
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***'],
  // `api_key: …`, `apiKey=…`, `"x-api-key": …`, `authorization: <scheme> …`.
  // Any auth scheme is swallowed with the value: a credential is the value, and
  // the scheme word must not shield it.
  [/((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?(?:basic|token|digest|bearer)?\s*)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***'],
  // A credential in a URL query string (`?api_key=…`, `&token=…`), which a
  // provider error or an echoed base URL can carry.
  [/([?&](?:api[_-]?key|key|token|access_token|secret)=)[^&\s"']+/gi, '$1***'],
  // `… provided: <token>` — the OpenAI/Anthropic "incorrect key" shape, where the
  // key is bare and unlabelled. Anchored on the label, never on the token alone;
  // the token may be QUOTED, and the scheme word of `Authorization: Basic …` /
  // `Authorization: Token …` is consumed along with it.
  [/(\b(?:key|token)\b[^:\n]{0,40}:\s*["'`]?(?:basic|token|digest)?\s*)[A-Za-z0-9._~+/=-]{16,}(["'`]?)/gi, '$1***$2'],
  // A quoted HEX run of key length: an OpenAI-style hex key often appears only
  // inside quotes. Hex only, 32+ chars — a quoted slug is a model id, not a key.
  [/["'`]([0-9a-f]{32,})["'`]/gi, '"***"'],
  // A JWT: three dot-separated base64url segments, always starting `eyJ`.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***'],
  // A signature/MAC blob after a signature-ish label.
  [/(\b(?:signature|sig|hmac|secret|credential)s?\b[^:\n]{0,20}:\s*)[A-Za-z0-9._~+/-]{16,}/gi, '$1***'],
]

/** Remove credentials by shape. A backstop, never the only defence. */
export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

/**
 * Remove session ids from `text`, including one specific id in case it does not
 * match the generic shape. `owned` is the child's own id: the one the model must
 * never learn (REQ-003, AC-003).
 */
export function redactSessionIDs(text: string, owned?: string): string {
  const result = owned === undefined || owned.length === 0 ? text : text.split(owned).join('(session)')
  return result.replace(/\bses_[A-Za-z0-9]+/g, '(session)')
}

/** Shape-only scrubbing, for call sites that hold no credential. */
export function redact(text: string, owned?: string): string {
  return redactSecrets(redactSessionIDs(text, owned))
}

/**
 * The credentials in play for one piece of work, resolved ON DEMAND.
 *
 * Called on every scrub rather than once, deliberately: `/connect` can replace a
 * key while a call is running, and the replacement is the one that authenticates
 * the child's next request — so it is the one an error will quote.
 */
export type CredentialSource = () => Promise<readonly string[]>

/**
 * A sanitizer bound to one credential source and one child (REQ-003, AC-025,
 * SEC-006). Built once per call; every string leaves through it.
 */
export interface Sanitizer {
  /** Scrub one string: the credentials, then session ids, then shapes. */
  text: (value: string) => string
  /** The same scrub, applied to every string leaf of a JSON-ish value. */
  value: (value: unknown) => unknown
  /**
   * A copy bound to one child's session id, which must never appear (REQ-003).
   * The child id only exists once the child does, so a call rebinds after
   * `create` instead of guessing.
   */
  own: (sessionID: string) => Sanitizer
  /**
   * The same scrub, synchronously, against the credentials resolved by the last
   * `text`/`value` call. Used where a string must be produced synchronously
   * after an async scrub already ran (a footer line, a metadata field).
   */
  last: (value: string) => string
}

/**
 * Shape + session scrubbing, with no credential source: the honest fallback when
 * a caller has nothing to compare against.
 */
export function shapeSanitizer(owned?: string): Sanitizer {
  return makeSyncSanitizer(async () => [], owned)
}

/**
 * Build a sanitizer over an async credential source.
 *
 * A source that throws, or returns nothing, degrades to shape-only scrubbing:
 * a diagnostic must still be safe when the credential store is what broke.
 */
export function makeSanitizer(source: CredentialSource, owned?: string): Sanitizer {
  return makeSyncSanitizer(source, owned)
}

/**
 * The implementation. `text`/`value` are synchronous, so the credentials are
 * refreshed by {@link Sanitizer.refresh} — called once at the start of every
 * result-producing step — and reused until the next refresh. That keeps a
 * single scrub cheap (a footer of twenty lines does not hit the credential
 * store twenty times) while still following a rotation between steps.
 */
function makeSyncSanitizer(source: CredentialSource, owned?: string): Sanitizer {
  let secrets: readonly string[] = []

  const clean = (value: string, id: string | undefined): string => {
    let result = value
    for (const secret of secrets) result = redactExact(result, secret)
    return redactSecrets(redactSessionIDs(result, id))
  }

  const make = (id: string | undefined): Sanitizer => ({
    text: (value) => clean(value, id),
    value: (value) => scrubValue(value, (leaf) => clean(leaf, id)),
    own: (sessionID) => make(sessionID),
    last: (value) => clean(value, id),
    // Internal: see `refresh`.
    refresh: async () => {
      const next = await Promise.resolve()
        .then(() => source())
        .catch(() => [] as readonly string[])
      secrets = [...next].filter((secret) => typeof secret === 'string' && secret.length >= 8)
    },
  }) as Sanitizer

  return make(owned)
}

/**
 * Refresh a sanitizer's credentials from its source (AC-025: a key rotated
 * mid-call is followed). Call before producing any output for a step.
 */
export async function refreshSanitizer(sanitizer: Sanitizer): Promise<void> {
  const refresh = (sanitizer as unknown as { refresh?: () => Promise<void> }).refresh
  if (refresh !== undefined) await refresh()
}

/**
 * Remove a credential VERBATIM, in the forms it can appear: bare, and
 * percent-encoded (a key inside a URL). Values under 8 characters are skipped —
 * blanking a short string would shred unrelated text without protecting
 * anything real.
 */
function redactExact(text: string, secret: string): string {
  let result = text.split(secret).join(REDACTED)
  const encoded = encodeURIComponent(secret)
  if (encoded !== secret) result = result.split(encoded).join(REDACTED)
  return result
}

/**
 * Rebuild a JSON-ish value with every string leaf scrubbed.
 *
 * Recursive on purpose: a provider error can sit in any field (`error.message`,
 * `error.response.body`, a nested `metadata`), and scrubbing only the top-level
 * message is exactly how a key reaches a transcript.
 */
function scrubValue(value: unknown, clean: (leaf: string) => string, depth = 0): unknown {
  if (depth > 12) return value
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, clean, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = scrubValue(item, clean, depth + 1)
  }
  return result
}

/**
 * A provider failure reported by CATEGORY rather than by body (SEC-006).
 *
 * Used when the failing provider is not the memory provider and its credential
 * could not be resolved: the error's type and HTTP status are useful for
 * diagnosis and carry no secret, while the body may quote the key it was given.
 * This is the "exact redaction is impossible" path, and it is deliberately
 * lossy.
 */
export function categoricalProviderError(providerID: string, error: unknown): string {
  const record = (error !== null && typeof error === 'object' ? error : {}) as {
    type?: unknown
    message?: unknown
    status?: unknown
    statusCode?: unknown
  }
  const type = typeof record.type === 'string' && record.type.length > 0 ? record.type : 'provider error'
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof record.statusCode === 'number'
        ? record.statusCode
        : statusFrom(record.message)
  const detail = status === undefined ? '' : ` (HTTP ${status})`
  return `${providerID} ${type}${detail} — the provider's message is omitted because its key could not be verified as absent`
}

/** An HTTP status the message mentions (`400`, `401`, …), or nothing. */
function statusFrom(message: unknown): number | undefined {
  if (typeof message !== 'string') return undefined
  const match = /\b(4\d\d|5\d\d)\b/.exec(message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}
