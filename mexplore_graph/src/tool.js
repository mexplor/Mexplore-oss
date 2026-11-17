/**
 * The slice of the dsh tool contract this plugin needs, implemented locally.
 *
 * `@deepseek-ai/dsh-tools` ships inside the dsh installation but the registry
 * publishes an older line to npm, so an out-of-tree plugin that imported it
 * would pin a version it cannot resolve. A tool definition is a plain object,
 * and `ToolRuntime.register` asserts only the shape — so the definition is
 * built here, against the same enforced JSON Schema subset
 * (`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/
 * `enum`/`const` plus annotations) the registry checks.
 *
 * @module dsh-mexplore/tool
 */

/** Invalid model-generated arguments. Mirrors the registry's own failure text. */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

/**
 * Trusted preparation, keyed by the exact definition object `defineTool`
 * returned.
 *
 * The dsh runtime wrapper has to decide whether a write call was rejected
 * BEFORE any handler ran — the difference between "the graph is unchanged"
 * and "the graph may have changed". A thrown error cannot supply that: a
 * handler that already wrote can throw a `ToolArgsError` with the same class,
 * code and message, or replay an old one. So the only acceptable evidence is
 * about the CALL itself, not the exception: the wrapper runs this preparation
 * itself and, only when it reports violations, never calls `execute`.
 *
 * The registry is a private WeakMap so nothing is added to the definition the
 * registry (or a caller) can see or forge: a definition is trusted only if
 * `defineTool` built it in this module instance, and the entry dies with the
 * definition object.
 */
const preparations = new WeakMap()

/**
 * Audited-refusal provenance (issue #245), keyed by the exact definition
 * `defineTool` returned — the same private-weakmap discipline as
 * `preparations`, and for the same reason: no error text, class, code, result
 * shape or model-supplied field can mint trust.
 *
 * A definition may DECLARE a finite list of refusal codes
 * (`options.auditedRefusals`). For each `execute` call this module then:
 *
 *   1. joins the per-(definition, exec) invocation GROUP before preparation
 *      runs. Overlapping same-exec calls POISON the epoch, so none of them can
 *      mint a proof; poison survives returning to zero, and only a new SERIAL
 *      call (active === 0) starts a clean epoch. This is what stops one
 *      invocation's proof being consumed for another's interleaved error —
 *      an older proof can never be revived by a later call, even one rejected
 *      during preparation;
 *   2. passes the handler a scoped `refuse(code, error)` helper as the third
 *      `execute` argument (existing handlers ignore it). The helper brands the
 *      ORIGINAL error object only for its own record, only in a clean serial
 *      epoch, and only when that record is current; it returns that same error
 *      unchanged;
 *   3. only if this very invocation exits by throwing that same branded error
 *      does its record become settleable. A handler that catches the branded
 *      error, wraps it, replays an older one, or throws anything else leaves
 *      no proof.
 *
 * On top of the epoch checks, an Error object may witness at most ONE invocation
 * (`seenRefusalErrors`, below): every thrown weak-key object — branded,
 * unbranded, preparation, no-code tool or non-object-exec — is recorded, and
 * every `refuse` attempt marks its object whether or not it is allowed to
 * brand. Two SERIAL invocations throwing the same Error are therefore not
 * interchangeable to a delayed consumer, which epoch/poison checks alone could
 * not distinguish.
 *
 * Consumption (`consumeAuditedRefusal`) is once-only, requires the same
 * definition and exec object, a clean epoch that is back to `active === 0`,
 * the still-current record and the exact error identity. A delayed consumer
 * after a newer serial call began finds a different `current` record and gets
 * nothing, and the newer call cannot have branded an Error an earlier call
 * already threw. A non-object/absent `exec` never gets a helper or a proof:
 * there is no identity to bind to, and withholding trust only leaves an error
 * unknown.
 *
 * What the proof MEANS is deliberately narrow: this invocation reached a
 * handler branch the source audit established runs before any graph content is
 * modified. It is not a sandbox, not a mutation detector, and says nothing
 * about filesystem activity outside node content (lock coordination is
 * explicitly excluded, and lock-release failure revokes the proof). A trusted
 * author calling the helper after a mutation is still an unsafe
 * implementation; the per-branch audit is the trust boundary.
 */
const auditedRefusalRegistries = new WeakMap()

/**
 * Brand-once Error uniqueness, shared across ALL definitions (#245 review 2).
 *
 * A proof must belong to the exact invocation that threw its error, but a
 * consumer only ever sees `(definition, exec, error)` — so two SERIAL
 * invocations that throw the SAME Error object would otherwise be
 * indistinguishable to a delayed consumer: A could consume B's later proof for
 * the shared error. A fresh slot/epoch cannot tell them apart, because the
 * epochs are serial and both legitimate.
 *
 * The fix is an invariant on the Error identity itself: an Error object is
 * seen at most once. EVERY thrown weak-key object is recorded here — an
 * unbranded handler throw, a preparation throw, a throw from a definition that
 * declares no codes, and every scoped `refuse` attempt (whether or not it was
 * allowed to brand). Only a NEVER-SEEN object may mint a new brand; once any
 * invocation has thrown or attempted to brand it, no later invocation can.
 * Primitives can never be branded at all.
 *
 * This is provenance bookkeeping, not a mutation detector: it says nothing
 * about what a handler did, only that one Error object can witness one call.
 * A WeakSet keeps no strong references; exhaustively reused Error objects
 * simply stop producing proofs (the conservative direction).
 */
const seenRefusalErrors = new WeakSet()

/**
 * The trusted preparation for a definition built by `defineTool`, or
 * `undefined` for anything else (a legacy/hand-built definition).
 *
 * The returned function performs the FULL preparation the execute boundary
 * performs — `coerce` then `validate` — and returns:
 *
 *   `{ args, violations }`
 *
 * `args` is the coerced value; `violations` is the validation result for it
 * (an empty array means the call would be admitted). It does not run the
 * handler, it must have no graph/filesystem side effects, and it may throw if
 * a caller-supplied `coerce` throws: a preparation that did not complete is
 * NOT evidence of anything, so the wrapper records an ordinary unproven error
 * and does not invoke (or retry through) `execute`.
 *
 * @param definition - the value the plugin registered, before any wrapping.
 * @returns the preparation function, or undefined when unknown.
 */
export function trustedPreparationFor(definition) {
  if ((typeof definition !== 'object' || definition === null) && typeof definition !== 'function') return undefined
  return preparations.get(definition)
}

function isWeakKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/**
 * Begin one invocation for (definition, exec), or `undefined` when no proof is
 * possible.
 *
 * A non-object/absent `exec` gets NO helper and NO proof: there is no identity
 * to bind a proof to, and guessing one is exactly the transfer this protocol
 * must prevent. Direct plugin callers still see the unchanged error; only the
 * trust is withheld (the conservative direction).
 *
 * Object execs share a per-exec GROUP. A group is a single epoch of serial
 * invocations:
 *
 *   - `active` counts in-flight invocations;
 *   - starting a call while another is in flight (`active` becomes > 1)
 *     POISONS the whole epoch — any overlap is unprovable, because the two
 *     calls' errors and effects can interleave in ways no per-call record can
 *     untangle;
 *   - poison is NOT cleared just because `active` returns to 0 (an old proof
 *     must not revive); only a NEW call starting when `active === 0` resets the
 *     epoch;
 *   - `current` is the record of the latest call, and a record is only
 *     consumable while it is still `current`.
 *
 * Every call gets its own record, returned here and captured by its helper.
 */
function beginInvocation(registry, exec) {
  if (!isWeakKey(exec)) return undefined
  let group = registry.groups.get(exec)
  if (group === undefined) {
    group = { active: 0, poisoned: false, current: undefined }
    registry.groups.set(exec, group)
  }
  // A serial start (nothing in flight) begins a clean epoch.
  if (group.active === 0) group.poisoned = false
  group.active += 1
  if (group.active > 1) group.poisoned = true
  const record = { group, branded: undefined }
  group.current = record
  return record
}

/** Finish one invocation. Poison deliberately survives `active` reaching 0. */
function endInvocation(record) {
  const group = record.group
  if (group.active > 0) group.active -= 1
}

/**
 * The audited-refusal code this thrown error carries for THIS invocation, or
 * `undefined` when there is no valid proof.
 *
 * Consumed at most once, and only while the epoch is serial and unpoisoned:
 * `active === 0`, the group is not poisoned, and the consuming call is the
 * group's `current` record. Any overlap — including a consumer delayed until
 * after a newer serial call began — therefore yields nothing. Cross-
 * definition, cross-exec, replayed, wrapped or replaced errors fail the same
 * identity checks. A missing or non-object exec never yields a proof.
 *
 * @param definition - the definition object the plugin registered.
 * @param exec - the exact exec value passed to `execute` for this call.
 * @param error - the exact error `execute` threw.
 * @returns the closed refusal code, or undefined.
 */
export function consumeAuditedRefusal(definition, exec, error) {
  if (!isWeakKey(definition) || !isWeakKey(exec)) return undefined
  const registry = auditedRefusalRegistries.get(definition)
  if (registry === undefined) return undefined
  const group = registry.groups.get(exec)
  if (group === undefined || group.poisoned || group.active !== 0) return undefined
  const record = group.current
  if (record === undefined) return undefined
  const branded = record.branded
  if (branded === undefined || branded.settled !== true || branded.consumed) return undefined
  if (branded.error !== error) return undefined
  branded.consumed = true
  return branded.code
}

/**
 * A scoped helper that brands one original error for exactly one record.
 *
 * The brand-once check runs FIRST, for every weak-key error and regardless of
 * whether the attempt is otherwise allowed: an attempt that is denied (an
 * undeclared code, a poisoned epoch, a superseded record, an overlap, a second
 * brand) still MARKS the Error as seen, so that same object can never be
 * branded by a later invocation. A primitive error is returned untouched and
 * never branded.
 *
 * When the object is unseen, the attempt may brand only if this is the ONLY
 * in-flight call of a clean, serial epoch and its record is still current.
 */
function makeRefusalHelper(registry, record) {
  return function refuse(code, error) {
    if (!isWeakKey(error)) return error
    const alreadySeen = seenRefusalErrors.has(error)
    seenRefusalErrors.add(error)
    if (alreadySeen) return error
    const group = record.group
    if (group.poisoned) return error
    if (group.active !== 1) return error
    if (group.current !== record) return error
    if (!registry.codes.has(code)) return error
    if (record.branded !== undefined) return error
    record.branded = { error, code, settled: false, consumed: false }
    return error
  }
}

/** Does a JSON value satisfy one declared scalar or composite type? */
function typeMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    default: return false
  }
}

/** How many declared names an undeclared-property violation will list (#263). */
const DECLARED_PROPERTY_SAMPLE = 12

/**
 * The exact separator `validate` puts before an undeclared-property remedy.
 * Single-sourced so {@link restateDeclaredPropertiesRemedy} cannot drift from
 * the message it edits.
 */
const DECLARED_PROPERTIES_SEPARATOR = ' — declared properties: '

/**
 * The remedy an undeclared-property violation carries (#263 A2): the names the
 * caller may actually use, bounded for an error message. Empty when nothing is
 * declared (then there is nothing useful to say).
 *
 * Exported because a caller can PUBLISH a narrower schema than the definition
 * validates against — the restricted A2A wrapper strips `from_path` from
 * `memory_attach` while the definition's own preparation (the non-execution
 * proof) still validates the original schema. Such a caller restates this same
 * remedy with the names it really accepts; the violation itself, and therefore
 * the proof, stays the definition's own.
 */
export function declaredPropertiesRemedy(properties) {
  const names = Object.keys(properties)
  if (names.length === 0) return ''
  const shown = names.slice(0, DECLARED_PROPERTY_SAMPLE)
  const more = names.length > DECLARED_PROPERTY_SAMPLE ? `, and ${names.length - DECLARED_PROPERTY_SAMPLE} more` : ''
  return `${shown.join(', ')}${more}`
}

/**
 * Restate ONLY the remedy suffix of a top-level undeclared-property violation
 * against a different property set (#263 A2). Used by a caller that publishes a
 * narrower schema than the definition validates against, so the remedy names
 * what the caller may actually pass.
 *
 * Deliberately narrow: the violation's own claim (`arguments.<key> is not a
 * declared property`) is never touched, a nested path is never touched, and
 * anything that is not this exact violation is returned verbatim. The
 * rejection itself, and the proof it carries, remain the definition's.
 */
export function restateDeclaredPropertiesRemedy(violation, properties) {
  const at = violation.indexOf(DECLARED_PROPERTIES_SEPARATOR)
  const head = at < 0 ? violation : violation.slice(0, at)
  if (!/^arguments\.[^.[\]]+ is not a declared property$/.test(head)) return violation
  const remedy = declaredPropertiesRemedy(properties)
  return remedy === '' ? head : `${head}${DECLARED_PROPERTIES_SEPARATOR}${remedy}`
}

/**
 * Collect every violation of `schema` by `value`, in schema-walk order.
 * Covers exactly the subset these tools declare: typed properties, required
 * lists, `additionalProperties: false`, `items`, and `enum`.
 */
export function validate(schema, value, path = 'arguments') {
  const violations = []
  if (!typeMatches(schema.type, value)) {
    violations.push(`${path} must be ${schema.type}`)
    return violations
  }
  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push(`${path}.${key} is required`)
    }
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key]
      if (property === undefined) {
        if (schema.additionalProperties === false) {
          // #263 A2: naming only the offending key leaves the model to guess
          // what the call may carry, and the retry repeats the same field. The
          // declared set is the remedy; it is bounded because a wide schema
          // must not mint a wall of error text.
          const declared = declaredPropertiesRemedy(properties)
          violations.push(
            `${path}.${key} is not a declared property${declared === '' ? '' : `${DECLARED_PROPERTIES_SEPARATOR}${declared}`}`,
          )
        }
        continue
      }
      if (entry === undefined) continue
      violations.push(...validate(property, entry, `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => violations.push(...validate(schema.items, entry, `${path}[${index}]`)))
  }
  return violations
}

/**
 * Build a registry-ready tool definition that validates its arguments before
 * `execute` sees them, the way the first-party `defineTool` does.
 *
 * `coerce`, when given, runs on the raw arguments BEFORE validation (F78,
 * #171): the one place a tool can repair a shape the model reliably gets
 * wrong — a nested object argument arriving as its own JSON serialization —
 * without loosening the schema it advertises. Its contract is
 * repair-or-leave-alone: it returns the arguments (rewritten or untouched)
 * and never throws, so everything it declines to repair still fails through
 * `validate` with the same violations it always drew.
 *
 * Two further obligations are load-bearing, because this whole pipeline is no
 * longer only an execute-time detail (26102111):
 *
 *   - NO SIDE EFFECTS. `coerce` and `validate` must not read or write the
 *     graph, the filesystem or any other durable state. The dsh runtime wrapper
 *     runs the preparation as a precheck which, when it reports violations,
 *     must prove nothing happened. A preparation that mutates state turns a
 *     "rejected" call into a real write the receipts would deny.
 *   - REPEATABLE. An admitted call runs the preparation twice — once by the
 *     wrapper's precheck and once inside `execute`, which is passed the
 *     ORIGINAL arguments exactly as before. Coercing the same input must yield
 *     the same repaired arguments every time (the real repair is idempotent:
 *     an already-parsed nested object is left alone).
 *
 * A per-tool hook, not a repair folded into the shared `validate()`, on
 * purpose (review of #176 — decided, recorded here so it is not relitigated):
 * inside `validate` the parse would apply to every object-typed property of
 * all seven tools instead of the one argument with an observed failure, and
 * would turn a predicate into a transformer besides — the more surprising
 * change for a wider blast radius. Nor would it shrink the surface: unless
 * `validate` also returned the repaired value, `presentCall` would still
 * render the uncoerced arguments, and the replay-card gap this hook closes
 * would come straight back.
 *
 * PER-TOOL SEMANTICS (26102311). Some argument contradictions cannot be
 * expressed in the enforced JSON Schema subset — "`supersedes` only makes sense
 * when creating", "an append cannot carry a description". `semantic`, when
 * given, is the per-tool destination for exactly those PURE rules. It runs
 * inside the same trusted preparation as `coerce` and `validate`, and only
 * when the schema pass reported no violations: a call that is not even
 * schema-shaped is rejected on the schema alone, so the hook never has to
 * re-check types. It returns an array of violation strings — empty means
 * admitted — in the same shape `validate` returns.
 *
 * `semantic` inherits both load-bearing obligations stated above, and it is
 * the reason they are stated for the whole pipeline: the runtime wrapper's
 * rejection evidence is this preparation's violation list, so a violation here
 * proves the handler was never entered. It must therefore be:
 *
 *   - SIDE-EFFECT FREE — no graph, filesystem, session, clock or config reads.
 *     A semantic hook that touches durable state turns a "rejected" call into a
 *     real change the receipts would deny. Rules that need state (an id that
 *     exists, a node this session has read, an attachment that traces to the
 *     turn) stay in the handler, where uncertainty is reported honestly.
 *   - SYNCHRONOUS and DETERMINISTIC — the preparation runs twice for an
 *     admitted call (wrapper precheck, then `execute`), so the same coerced
 *     arguments must yield the same violations both times. No promises, no
 *     randomness, no mutation of `args`.
 *
 * AUDITED REFUSALS (#245). `options.auditedRefusals`, when given, is the finite
 * list of codes this tool may mint through the scoped `refuse(code, error)`
 * helper passed as `execute`'s third argument. Declaring the list is what makes
 * the provenance registry exist; a definition that declares nothing receives
 * no refusal helper or proof. Its thrown object is still preserved and tracked.
 *
 * @param options - name, description, raw JSON Schemas, presenters, execute,
 *   optional coerce and semantic validation, optional finite audited refusal
 *   codes.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function defineTool(options) {
  const parameters = options.parameters
  const coerce = options.coerce ?? ((args) => args)
  const semantic = options.semantic ?? (() => [])
  const check = (args) => validate(parameters, args)
  // Violations for an ALREADY-COERCED call: schema first, semantics only when
  // the schema passed. Shared by `prepare` (both execute and the trusted
  // wrapper entry) and `presentCall`, so the card a replayed call renders
  // matches the verdict its execution received.
  const violationsFor = (args) => {
    const violations = check(args)
    if (violations.length > 0) return violations
    const semanticViolations = semantic(args)
    if (!Array.isArray(semanticViolations)) {
      // A contract violation by the tool author, not by the caller. Throwing
      // leaves the preparation incomplete — which the wrapper records as an
      // uncertain error, never as proof that nothing ran.
      throw new Error('tool semantic validation returned no violation list')
    }
    if (!semanticViolations.every((violation) => typeof violation === 'string')) {
      throw new Error('tool semantic validation returned malformed violations')
    }
    return semanticViolations
  }
  // The one preparation pipeline. `execute` and the trusted wrapper entry below
  // both run exactly this, so a rejection seen by the wrapper is the same
  // rejection `execute` would have raised.
  const prepare = (args) => {
    const repaired = coerce(args)
    return { args: repaired, violations: violationsFor(repaired) }
  }
  const declaredCodes = options.auditedRefusals
  if (
    declaredCodes !== undefined &&
    (!Array.isArray(declaredCodes) || !declaredCodes.every((code) => typeof code === 'string' && code.length > 0))
  ) {
    throw new Error('tool audited refusal codes must be an array of non-empty strings')
  }
  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const registry = auditedRefusalRegistries.get(definition)
      // Count/conjoin the invocation on EVERY entry, BEFORE preparation, so an
      // overlapping same-exec pair poisons its epoch even when one of them is
      // rejected during preparation, and an older proof cannot be resurrected
      // through a later call that never reached a handler.
      const record = registry === undefined ? undefined : beginInvocation(registry, exec)
      try {
        const prepared = prepare(args)
        if (prepared.violations.length > 0) throw new ToolArgsError(prepared.violations)
        // `await` even this pass-through so an asynchronous rejection is caught
        // by the outer handler below (and the thrown Error is recorded) rather
        // than escaping after this function has already returned a promise.
        if (record === undefined) return await options.execute(prepared.args, exec, undefined)
        const refuse = makeRefusalHelper(registry, record)
        try {
          return await options.execute(prepared.args, exec, refuse)
        } catch (error) {
          // A proof settles only when THIS invocation exits with the exact
          // branded error. Swallowed (normal return), wrapped, replaced, or an
          // older error replayed from another call settles nothing.
          if (record.branded !== undefined) {
            if (record.branded.error === error) record.branded.settled = true
            else record.branded = undefined
          }
          throw error
        }
      } catch (error) {
        // EVERY thrown weak-key object is brand-once for the whole module: an
        // unbranded handler throw, a preparation throw, a throw from a tool
        // that declares no codes, and a non-object-exec call all consume this
        // Error's one chance to witness an invocation. That is what stops a
        // later serial invocation (possibly in another definition) from
        // branding an Error some earlier call already threw.
        if (isWeakKey(error)) seenRefusalErrors.add(error)
        throw error
      } finally {
        // Decrement on EVERY exit, including a preparation failure. Poison is
        // retained: returning to zero alone never revives an old epoch.
        if (record !== undefined) endInvocation(record)
      }
    },
  }
  preparations.set(definition, prepare)
  if (declaredCodes !== undefined) {
    auditedRefusalRegistries.set(definition, {
      codes: new Set(declaredCodes),
      // Per-definition, per-exec; WeakMap keyed by the exec object so no
      // unbounded global map accumulates entries for dead execs.
      groups: new WeakMap(),
    })
  }
  // Presenters run against logged arguments too, which may predate a schema
  // change — fall back to the generic card rather than throwing on replay.
  // Coerced and checked through the SAME pipeline as execution (schema then
  // semantics), so a logged call that needed the repair, or that a semantic
  // rule refuses, renders the same card its execution saw (or the generic one).
  if (options.presentCall) {
    definition.presentCall = (args) => {
      const repaired = coerce(args)
      return violationsFor(repaired).length > 0 ? undefined : options.presentCall(repaired)
    }
  }
  return definition
}
