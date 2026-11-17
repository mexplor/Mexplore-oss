/**
 * The mexplore graph adapter (lane A1): a typed wrapper over this repo's
 * `dsh_plugin`, with no dependency on `@opencode/plugin`.
 *
 * What it owns:
 *
 *   - LOADING (REQ-006): dsh_plugin is applied TWICE, once per prompt profile,
 *     each apply into its own capturing proxy context. The tools and the prompt
 *     a call sees come from the instance matching that call's authority, so a
 *     read child is never handed write guidance and never sees a write tool.
 *   - EXECUTION (REQ-010): every tool call runs under a fresh exec whose agent
 *     id is the CALL id and whose history is the caller's message plus evidence
 *     only. Two mexplore calls therefore never share read-before-write state,
 *     and the child's own output can never vouch for its own writes.
 *   - THE WRITE FENCE (REQ-011): writes are serialized inside one call, and one
 *     uncertain or partial write latches the fence for the rest of that call.
 *     Proven non-executions — schema rejections and audited pre-mutation
 *     refusals — do not latch, so the model can read and retry.
 *   - THE REPORT (REQ-012): every write and every traversal edge is recorded
 *     from the REAL dsh result, never from the child's prose, so the footer
 *     says what actually landed.
 *   - THE CAP (SEC-004): rendered results stay below the host's spill limits so
 *     a memory read never creates a `tool-output/` file.
 *
 * SEC-001 is structural: `memory_merge` and `memory_restore` are never exposed,
 * and `memory_attach.from_path` is stripped from the schema AND rejected before
 * dsh runs (plus dsh's own `attachFromPath:false`).
 *
 * @module mexplore/graph
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUDITED_REFUSAL_TOOLS,
  GraphToolError,
  FROM_PATH_REFUSAL_CODE,
  TIER_REFUSAL_CODE,
  WRITE_FENCE_CODE,
  WRITE_FENCE_MESSAGE,
  WriteFence,
  auditedRefusalCode,
  isWriteTool,
  knownPartialMutation,
  precheckArguments,
  toError,
} from './fence'
import {
  BODY_OFFSET_DESCRIPTION,
  BODY_OFFSET_PARAM,
  BodyOffsetError,
  assertBodyOffset,
  pageBody,
  readNodeBody,
  rewriteBodyHints,
} from './body'
import { buildHistory, makeExec, type CallOrigin } from './history'
import { loadDshModules, type DshModules, type DshToolDefinition } from './load'
import { beginPromptCapture, renderCapturedPrompt, type CapturedPrompt } from './prompt'
import { SerialQueue } from './queue'
import { byteLength, joinBlocks, renderContent, type CutInfo, type RenderedContent } from './render'
import type { Authority, EdgeRecord, Evidence, GraphConfig, GraphReport, ToolDef, ToolResult, WriteRecord } from './types'

export type { Authority, EdgeRecord, Evidence, GraphConfig, GraphReport, ToolDef, ToolResult, WriteRecord } from './types'
export { GraphToolError, knownPartialMutation, precheckArguments, TIER_REFUSAL_CODE, WRITE_FENCE_CODE, WRITE_FENCE_MESSAGE } from './fence'
export { MAX_CONTENT_BYTES, MAX_CONTENT_LINES, capContent } from './render'
export {
  BODY_OFFSET_DESCRIPTION,
  BODY_OFFSET_PARAM,
  BODY_VIEW_CHARS,
  BodyOffsetError,
  assertBodyOffset,
  continuationLine,
  cutLine,
  endOfBodyLine,
  pageBody,
  readNodeBody,
  rewriteBodyHints,
} from './body'
export type { BodyPage } from './body'
export type { HistoryMessage } from './history'
export type { CallOrigin, ExecProvenance, ProvenanceReason } from './history'

/** Tools a read call may reach, in the order they are advertised. */
export const READ_TOOL_NAMES: readonly string[] = Object.freeze(['memory_search', 'memory_read', 'memory_read_file'])
/** Tools a manage call may reach: the read set plus the two write routes. */
export const MANAGE_TOOL_NAMES: readonly string[] = Object.freeze([...READ_TOOL_NAMES, 'memory_write', 'memory_attach'])
/** Never exposed at any authority, and never registered here (SEC-001). */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = Object.freeze(['memory_merge', 'memory_restore'])

/**
 * Refused before dsh runs: this call truncated the file's page, so the child has
 * not seen the bytes a replacement would destroy (review Major 1).
 */
export const UNDELIVERED_OVERWRITE_CODE = 'UNDELIVERED_OVERWRITE'

/** The extra sentence the restricted runtime adds to `memory_attach`. */
const RESTRICTED_ATTACH_NOTE =
  '\n\n(restricted runtime: only `content` is accepted; `from_path` is rejected.)'

/** Length of the body prefix used as a write's description when none is given. */
const BODY_PREFIX_CHARS = 80

/** The exact JSON Schema `memory_attach` is advertised with: `from_path` gone. */
function stripFromPath(parameters: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(parameters)
  const properties = clone.properties
  if (clone !== null && typeof clone === 'object' && properties !== null && typeof properties === 'object') {
    delete (properties as Record<string, unknown>).from_path
  }
  return clone
}

/**
 * The advertised JSON Schema for `memory_read`: dsh's own, plus the optional
 * `body_offset` this runtime adds for body continuation.
 *
 * `body_offset` is NOT a dsh argument — it never reaches a dsh definition — so
 * the property is added to the advertised copy only, and it is stripped again
 * before dsh executes.
 */
function withBodyOffset(parameters: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(parameters)
  const properties = clone.properties as Record<string, unknown> | undefined
  if (properties === null || typeof properties !== 'object') return clone
  properties[BODY_OFFSET_PARAM] = {
    type: 'integer',
    description: BODY_OFFSET_DESCRIPTION,
  }
  return clone
}

/**
 * The same arguments with `body_offset` removed.
 *
 * The parameter exists only in the ADVERTISED schema; dsh's own definition does
 * not declare it, and dsh's `additionalProperties: false` would reject it. Used
 * for every `memory_read` that is not itself a continuation request.
 */
function withoutBodyOffset(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args
  const { [BODY_OFFSET_PARAM]: _dropped, ...rest } = args as Record<string, unknown>
  return rest
}

/** One applied dsh instance: its tools and its captured prompt section. */
interface ProfileInstance {
  definitions: Map<string, DshToolDefinition>
  prompt: CapturedPrompt
}

/** Wait for everything in flight; used by `settle()` and never by a tool call. */
function track<T>(set: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  set.add(promise)
  void promise.then(
    () => set.delete(promise),
    () => set.delete(promise),
  )
  return promise
}

/**
 * Apply dsh_plugin once, capturing its tools and its prompt section.
 *
 * The config is deliberately minimal and mirrors what the service wrapper
 * passes: no `indexSnapshot`, no `promptSnapshot`, no `batchWrites`, and no
 * `expectWrite` — the last three are process-lifetime concerns in a long-lived
 * server (CON-002), and `expectWrite` would install an exit hook in the host
 * process. `attachFromPath:false` is dsh's own refusal of `from_path`, belt to
 * this module's braces.
 */
function applyProfile(
  dsh: DshModules,
  config: GraphConfig,
  profile: 'read' | 'manage',
): ProfileInstance {
  const definitions = new Map<string, DshToolDefinition>()
  const capture = beginPromptCapture()
  const proxyCtx = {
    tools: {
      register(definition: DshToolDefinition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    inject(names: string[], callback: (promptCtx: unknown) => void) {
      if (!names.includes('systemPrompt')) return
      callback(capture.promptCtx)
    },
  }
  dsh.plugin.apply(proxyCtx, {
    graphRoot: config.graphRoot,
    attachFromPath: false,
    expectWrite: false,
    promptProfile: profile,
    // 2a guards belong to the WRITE surface, so they are armed on the manage
    // profile only — the same placement the A2A service uses. The read instance
    // has no write tool for them to guard.
    ...(profile === 'manage' && config.placeholderGuards === true ? { placeholderGuards: true } : {}),
    ...(profile === 'read' ? { indexCacheMs: 0 } : {}),
    ...(config.searchLimit === undefined ? {} : { searchLimit: config.searchLimit }),
    ...(config.maxIndexEntries === undefined ? {} : { maxIndexEntries: config.maxIndexEntries }),
  })
  for (const name of [...READ_TOOL_NAMES, ...MANAGE_TOOL_NAMES.slice(READ_TOOL_NAMES.length)]) {
    if (!definitions.has(name)) {
      throw new Error(`mexplore: dsh_plugin did not register ${name} for the ${profile} profile`)
    }
  }
  const prompt = capture.read()
  if (prompt === undefined) {
    throw new Error(`mexplore: dsh_plugin registered no system prompt section for the ${profile} profile`)
  }
  return { definitions, prompt }
}

/** What one tool executor saw, so recording never has to re-derive it. */
type ExecutionOutcome = { result: unknown; partial: boolean }

/**
 * One call's view of the graph: its authority, its fence, its queue, its
 * records. Created by `createCall` and discarded with it.
 */
export class GraphCall {
  readonly callId: string
  readonly authority: Authority
  private readonly runtime: GraphRuntime
  private readonly message: string
  private readonly evidence: readonly Evidence[]
  private readonly fence = new WriteFence()
  private readonly writes = new SerialQueue()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly records: WriteRecord[] = []
  private readonly recordedEdges: EdgeRecord[] = []
  /**
   * The root chat this call belongs to, resolved ONCE by the host adapter before
   * the child existed (write-session provenance #317). Read only to stamp
   * `exec.provenance`; it is never part of this call's authorization and never
   * reaches the model.
   */
  private readonly origin: CallOrigin
  /**
   * What this call's child has ACTUALLY received of each attachment, keyed by
   * `nodeId\0file`. dsh records a read as covering the whole page it read from
   * disk; when this adapter truncates that page, the child saw less, and a
   * replacement of the file must wait until the rest was really delivered
   * (review Major 1).
   */
  private readonly coverage = new Map<string, FileCoverage>()
  private toolCalls = 0

  constructor(
    runtime: GraphRuntime,
    options: {
      callId: string
      authority: Authority
      message: string
      evidence?: readonly Evidence[]
      /** The root chat, or why none could be proved. Defaults to no resolver. */
      origin?: CallOrigin
    },
  ) {
    this.runtime = runtime
    this.callId = options.callId
    this.authority = options.authority
    this.message = options.message
    this.evidence = options.evidence ?? []
    this.origin = options.origin ?? { session: null, reason: 'no-resolver' }
  }

  /** The tools this call may reach, in advertisement order. */
  toolNames(): string[] {
    return this.runtime.toolNames(this.authority)
  }

  /** The tool definitions this call is advertised, schemas verbatim. */
  toolDefs(): ToolDef[] {
    return this.runtime.toolDefs(this.authority)
  }

  /** The memory prompt for this call, `{{slots}}` resolved NOW. */
  renderPrompt(): string {
    return this.runtime.renderPrompt(this.authority)
  }

  /**
   * Run one graph tool.
   *
   * Order is deliberate: tier check, then the `from_path` rejection, then (for
   * writes) the fence, then the definition's own trusted preparation, and only
   * then dsh. Every step before the last is a PROVEN non-touch of the graph, so
   * none of them latches the fence and none of them is reported as a write.
   *
   * Errors thrown by dsh propagate unchanged — same message, so the child can
   * read the remedy — except that a fence/tier/from_path refusal carries the
   * categorical `code` this module owns.
   */
  async execute(tool: string, args: unknown): Promise<ToolResult> {
    this.toolCalls += 1
    const invocation = this.invoke(tool, args)
    return track(this.inflight, invocation)
  }

  /** Settle everything still in flight: a late write must never be reported as none. */
  async settle(): Promise<void> {
    // Two passes: a write can enqueue another task while the first is draining.
    for (;;) {
      await this.writes.idle()
      if (this.inflight.size === 0) return
      await Promise.allSettled([...this.inflight])
    }
  }

  /** What actually happened, from the tool results themselves. */
  report(): GraphReport {
    return {
      toolCalls: this.toolCalls,
      writes: this.records.map((record) => ({ ...record })),
      edges: this.recordedEdges.map((edge) => ({ ...edge })),
    }
  }

  /** The REQ-012 footer lines: one per landed write, one per wired edge. */
  footerLines(): string[] {
    const lines: string[] = []
    for (const write of this.records) {
      const name = write.description ?? '(no description)'
      const at = write.nodeId === undefined ? '' : ` (${write.nodeId})`
      lines.push(
        write.status === 'ok' ? `saved to memory: ${name}${at}` : `memory write incomplete: ${name}${at}`,
      )
    }
    for (const edge of this.recordedEdges) lines.push(`linked in memory: ${edge.from} → ${edge.to}`)
    return lines.length === 0 ? ['no writes'] : lines
  }

  // --------------------------------------------------------------- internals

  private definition(tool: string): DshToolDefinition {
    const definition = this.runtime.definitions(this.authority).get(tool)
    if (definition === undefined) {
      // Unreachable: the tier check already proved the tool is in this
      // authority's set, and load() refuses to return without every one.
      throw new GraphToolError(`mexplore: ${tool} is not registered for this call`, TIER_REFUSAL_CODE)
    }
    return definition
  }

  private async invoke(tool: string, args: unknown): Promise<ToolResult> {
    if (!this.toolNames().includes(tool)) {
      throw new GraphToolError(
        `mexplore: ${tool} is not available to a ${this.authority} call (available: ${this.toolNames().join(', ')})`,
        TIER_REFUSAL_CODE,
      )
    }
    if (tool === 'memory_attach' && hasOwn(args, 'from_path')) {
      throw new GraphToolError(
        'mexplore: memory_attach.from_path is not permitted by this runtime; pass the text as `content` instead',
        FROM_PATH_REFUSAL_CODE,
      )
    }
    if (isWriteTool(tool)) {
      // Serialized per call: two writes of one step must not interleave their
      // read-before-write state, and the fence must be observed in order.
      return this.writes.run(() => this.run(tool, args))
    }
    return this.run(tool, args)
  }

  private async run(tool: string, args: unknown): Promise<ToolResult> {
    const definition = this.definition(tool)
    const write = isWriteTool(tool)
    if (write && this.fence.isLatched()) {
      throw new GraphToolError(WRITE_FENCE_MESSAGE, WRITE_FENCE_CODE)
    }

    // Body continuation (review-2 Major 10): `body_offset` is OUR parameter, so
    // it is handled entirely here — the node body is served from dsh's graph
    // module and never reaches dsh's `memory_read`.
    if (tool === 'memory_read' && hasOwn(args, BODY_OFFSET_PARAM)) {
      return this.pageNodeBody(args)
    }
    // Stripped for every other path so dsh's own preparation never sees a
    // property its schema does not declare.
    if (tool === 'memory_read') args = withoutBodyOffset(args)

    // dsh's own preparation, run HERE for writes so a rejection is provably a
    // non-execution and never latches the fence (the wrapper's `precheck`).
    // Its ADMITTED result is the coerced argument object — dsh parses a
    // serialized `attach` string inside `coerce`, so every argument-driven
    // decision below must read the prepared form or a string-wrapped payload
    // would slip past it (review pass 2, Major 1).
    let preparedArgs: unknown = args
    if (write) {
      const precheck = precheckArguments(definition, args, this.runtime.dsh.tool)
      if (precheck.kind === 'rejected') {
        // The remedy suffix names only fields this runtime PUBLISHES: the
        // restricted `memory_attach` schema has no `from_path`, so a violation
        // must not point at it.
        const parameters = tool === 'memory_attach' ? stripFromPath(definition.parameters) : definition.parameters
        const properties = (parameters.properties ?? {}) as Record<string, unknown>
        const violations = precheck.violations.map((violation) =>
          this.runtime.dsh.tool.restateDeclaredPropertiesRemedy(violation, properties),
        )
        throw new Error(`invalid arguments: ${violations.join('; ')}`)
      }
      if (precheck.kind === 'uncertain') {
        // Instrumented preparation that did not complete: nothing is proven, and
        // re-running it through execute could fabricate a clean outcome.
        this.fence.latch()
        this.recordFailure(tool, args)
        throw precheck.error
      }
      if (precheck.kind === 'admitted') preparedArgs = precheck.args
      // SEC-001-adjacent: dsh records a read as covering the WHOLE page it read
      // from disk, but the child may have received less (this adapter's cap).
      // The child cannot vouch for bytes it never saw, so a replacement of that
      // file is refused until the rest was really delivered.
      await this.refuseUndeliveredOverwrite(tool, preparedArgs)
    }

    const edgeWatched = tool === 'memory_read' && typeof fromOf(args) === 'string'
    const edgeAlready = edgeWatched ? await this.edgeExists(fromOf(args) as string, idOf(args)) : false

    const outcome = await this.executeDefinition(definition, tool, args)
    if (write) this.recordWrite(tool, preparedArgs, outcome)
    if (edgeWatched && !edgeAlready) await this.recordEdgeIfWired(fromOf(args) as string, idOf(args))
    const text = joinBlocks(definition.output.render(args, outcome.result))
    // One delivery model for both the resume note and the overwrite gate.
    const delivery = tool === 'memory_read_file' ? pageDelivery(text, outcome.result) : undefined
    const rendered = renderContent(text, delivery === undefined ? undefined : (info) => delivery.note(info))
    if (delivery !== undefined) await this.recordDelivered(args, record(outcome.result), rendered, delivery)
    const content = tool === 'memory_read'
      ? await this.rewriteReadHints(args, text, rendered)
      : rendered.content
    return {
      content,
      metadata: { tool, truncated: rendered.truncated },
    }
  }

  /**
   * Serve one continuation page of a node BODY (review-2 Major 10).
   *
   * The child has no filesystem tools and `memory_read_file` refuses `node.md`,
   * so this is the only surface that can reach a body past dsh's 50,000-char cut
   * (or past this adapter's byte cap, which for non-ASCII bodies cuts sooner).
   *
   * Confinement lives in `readNodeBody`: dsh's `assertId` (a ULID pattern, which
   * is what makes the joined path un-traversable), the graph root, and dsh's own
   * per-node lock. It deliberately does NOT run dsh's `memory_read`, so a page
   * grants no write authorization — dsh's read-before-write state is untouched.
   */
  private async pageNodeBody(args: unknown): Promise<ToolResult> {
    const values = record(args)
    const id = idOf(args)
    if (id === undefined) {
      throw new BodyOffsetError('memory_read: `id` is required to continue a node body')
    }
    const node = await readNodeBody(this.runtime.dsh.graph, this.runtime.graphRoot, id)
    const offset = assertBodyOffset(values[BODY_OFFSET_PARAM], node.body.length)
    const page = pageBody({ id: node.id, description: node.description, body: node.body, offset })
    return {
      content: page.content,
      metadata: {
        tool: 'memory_read',
        // `truncated` is the host-facing flag: a page that is not the end means
        // more body exists, which is exactly what a truncated result means.
        truncated: !page.done,
        bodyOffset: page.offset,
        bodyNextOffset: page.end,
        bodyTotal: page.total,
        bodyDone: page.done,
      },
    }
  }

  /**
   * Replace a `memory_read` view's continuation hints with the one this surface
   * can honour.
   *
   * Two are wrong for a mexplore child: dsh's "read node.md … under the graph
   * root" (no filesystem tools) and this adapter's cap note (which says
   * `offset`, a `memory_read_file` argument that `memory_read` does not take).
   * Both become an exact `body_offset` continuation, computed from what was
   * actually DELIVERED.
   */
  private async rewriteReadHints(
    args: unknown,
    text: string,
    rendered: RenderedContent,
  ): Promise<string> {
    const id = idOf(args)
    if (id === undefined) return rendered.content
    let body: string
    try {
      // The body comes from the same confined reader the paging path uses, so
      // the hint's total and the offsets it names are the ones paging honours.
      body = (await readNodeBody(this.runtime.dsh.graph, this.runtime.graphRoot, id)).body
    } catch {
      // A read that succeeded cannot normally fail here; if it does, leave the
      // original text alone rather than invent an offset.
      return rendered.content
    }
    return rewriteBodyHints({
      text,
      // The DELIVERED BODY only: `rendered.content` also carries this adapter's
      // cap note, and counting the note as delivered body would overstate the
      // offset by its own length.
      deliveredBody: rendered.body,
      id,
      body,
    })
  }

  /** Call dsh and classify the outcome: a throw latches unless dsh proves no touch. */
  private async executeDefinition(
    definition: DshToolDefinition,
    tool: string,
    args: unknown,
  ): Promise<ExecutionOutcome> {
    const write = isWriteTool(tool)
    // A FRESH exec per invocation, carrying the same agent id: dsh's audited
    // refusal proof is per-(definition, exec), and overlapping calls on one exec
    // object would poison the epoch.
    const exec = makeExec(this.callId, () => buildHistory(this.message, this.evidence), this.origin)
    let result: unknown
    try {
      result = await definition.execute(args, exec)
    } catch (error) {
      const proven =
        write &&
        AUDITED_REFUSAL_TOOLS.includes(tool) &&
        auditedRefusalCode(definition, exec, error, this.runtime.dsh.tool) !== undefined
      if (proven) {
        // An audited pre-mutation refusal changed nothing: no latch, no footer
        // line, and the model may read and retry.
        throw toError(error)
      }
      if (write) {
        this.fence.latch()
        this.recordFailure(tool, args)
      }
      throw toError(error)
    }
    if (!write) return { result, partial: false }
    if (knownPartialMutation(result)) {
      this.fence.latch()
      return { result, partial: true }
    }
    return { result, partial: false }
  }

  private recordWrite(tool: string, args: unknown, outcome: ExecutionOutcome): void {
    const result = record(outcome.result)
    const nodeId = typeof result.id === 'string' ? result.id : idOf(args)
    const description = describeWrite(tool, args, result)
    this.records.push({
      tool: tool === 'memory_attach' ? 'memory_attach' : 'memory_write',
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(description === undefined ? {} : { description }),
      status: outcome.partial ? 'incomplete' : 'ok',
    })
  }

  private recordFailure(tool: string, args: unknown): void {
    if (!isWriteTool(tool)) return
    const nodeId = idOf(args)
    const description = describeWrite(tool, args, {})
    this.records.push({
      tool: tool === 'memory_attach' ? 'memory_attach' : 'memory_write',
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(description === undefined ? {} : { description }),
      status: 'failed',
    })
  }

  /**
   * `memory_read({from})` wires an edge when none existed (dsh's traversal
   * recording). dsh's result carries no "I created an edge" field, so the fact
   * is read off the graph: absent before, present after.
   */
  private async recordEdgeIfWired(from: string, to: string | undefined): Promise<void> {
    if (to === undefined) return
    if (!(await this.edgeExists(from, to))) return
    this.recordedEdges.push({ from, to })
  }

  private async edgeExists(from: string, to: string | undefined): Promise<boolean> {
    if (to === undefined) return false
    try {
      const edges = await this.runtime.dsh.graph.outEdges(this.runtime.graphRoot, from)
      return edges.includes(to)
    } catch {
      // A failed probe is never evidence: an unwired edge just goes unannounced.
      return false
    }
  }

  /**
   * Refuse a `memory_attach` that would REPLACE a file this call truncated.
   *
   * dsh's overwrite gate (`attach_overwrite_unseen`) authorizes a replacement
   * once the recorded ranges cover the file, and dsh records the page it read
   * from disk. When this adapter capped that page, the child received a prefix
   * and dsh still believes the tail was seen — so the gate would let the child
   * replace bytes it never read. That is the one authorization this module must
   * not delegate, so it is re-checked here against what was DELIVERED.
   *
   * A proven non-execution: nothing is read, nothing is written, so the fence
   * is deliberately not latched and the model can page the rest in.
   */
  private async refuseUndeliveredOverwrite(tool: string, args: unknown): Promise<void> {
    if (!isWriteTool(tool)) return
    const values = record(args)
    // `memory_write` carries its attachment inline (`attach: {filename, content}`);
    // the standalone route passes `filename` + `content`. Both REPLACE the file
    // under that name, so both are checked. `args` is the TRUSTED PREPARED form,
    // so a serialized `attach` string has already been parsed by dsh's `coerce`
    // (review pass 2, Major 1).
    const inline = record(values.attach)
    const nodeId = idOf(args)
    const file = tool === 'memory_attach'
      ? typeof values.filename === 'string' ? values.filename : undefined
      : typeof inline.filename === 'string' ? inline.filename : undefined
    const hasPayload = tool === 'memory_attach' ? hasOwn(values, 'content') : typeof inline.content === 'string'
    if (nodeId === undefined || file === undefined || !hasPayload) return
    // Identity, not name: `Report.md` and `report.md` are one file on a
    // case-insensitive filesystem, and a same-sized replacement is a DIFFERENT
    // file with its own (empty) coverage (review pass 2, Major 2).
    const seen = this.coverage.get(await this.fileKey(nodeId, file))
    // Nothing truncated in this call (or the file was never read here): dsh's
    // own gate is the whole story, and it will refuse an unseen overwrite.
    if (seen === undefined) return
    const deliveredTo = coveredTo(seen.ranges)
    if (deliveredTo >= seen.size) return
    const from = seen.ranges.length === 0 ? 0 : (seen.ranges[0] as [number, number])[0]
    throw new GraphToolError(
      `memory_attach: ${file} on ${nodeId} is only partly read in this call — bytes ${from}–${deliveredTo - 1} of ${seen.size} were delivered, and the rest was cut by the result limit, so replacing it now would discard content you have not seen. Nothing was written. Read the remaining pages with memory_read_file(id: "${nodeId}", file: ${JSON.stringify(file)}, offset: ${deliveredTo}) first, or store the replacement under a new filename.`,
      UNDELIVERED_OVERWRITE_CODE,
    )
  }

  /**
   * The coverage key for one attachment in this call: the FILE's identity
   * (`dev:ino`), falling back to its name only when the file cannot be stat'ed.
   *
   * dsh's own overwrite bookkeeping keys on the inode for exactly these two
   * reasons: a name is a spelling (`Report.md` / `report.md` are one file on a
   * case-insensitive filesystem), and every tool publish is a stage-and-rename,
   * so a replaced file is a NEW inode whose bytes are not the ones this call
   * was shown. `lstat`, like dsh's `fileIdentity`, so a symlink dropped into
   * agent space is its own identity.
   */
  private async fileKey(nodeId: string, file: string): Promise<string> {
    try {
      const stats = await fsp.lstat(path.join(this.runtime.graphRoot, nodeId, file))
      return `${nodeId}\u0000${stats.dev}:${stats.ino}`
    } catch {
      return coverageKey(nodeId, file)
    }
  }

  /**
   * Record what a `memory_read_file` page delivered to this call's child.
   *
   * A page dsh served whole is credited whole (its own reader ends the window
   * on a character boundary). A page this adapter truncated is credited only for
   * the part of its content that survived into the delivered text — the same
   * number the resume note names, so the record and what the child can actually
   * cite never diverge.
   *
   * Ranges are merged exactly like dsh's own bookkeeping, and authorization
   * requires a covered range STARTING AT 0: a page read out of order must never
   * vouch for the gap before it.
   */
  private async recordDelivered(
    args: unknown,
    result: Record<string, unknown>,
    rendered: RenderedContent,
    delivery: PageDelivery,
  ): Promise<void> {
    const nodeId = idOf(args)
    const file = typeof result.file === 'string'
      ? result.file
      : typeof record(args).file === 'string' ? (record(args).file as string) : undefined
    const offset = typeof result.offset === 'number' ? result.offset : undefined
    const size = typeof result.size === 'number' ? result.size : undefined
    if (nodeId === undefined || file === undefined || offset === undefined || size === undefined) return
    const key = await this.fileKey(nodeId, file)
    const prior = this.coverage.get(key)
    const delivered = delivery.delivered(rendered.body)
    this.coverage.set(key, {
      size,
      // Ranges describe ONE version of the file. The key already carries the
      // inode; the size check catches an out-of-band in-place edit that kept it
      // (same inode, different bytes) — ranges against the old bytes would
      // describe content the child can no longer cite.
      ranges: addRange(prior !== undefined && prior.size === size ? prior.ranges : [], offset, offset + delivered),
    })
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** One attachment's delivered-coverage record for a call. */
interface FileCoverage {
  /** File size in bytes, as the last page reported it. */
  size: number
  /** Merged `[start, end)` byte ranges this call's child has really received. */
  ranges: Array<[number, number]>
}

function coverageKey(nodeId: string, file: string): string {
  return `${nodeId}\u0000${file}`
}

/** Merge one `[start, end)` range into a sorted, non-overlapping list. */
function addRange(ranges: ReadonlyArray<readonly [number, number]>, start: number, end: number): Array<[number, number]> {
  if (end <= start) return ranges.map((range) => [range[0], range[1]] as [number, number])
  const merged: Array<[number, number]> = []
  const all = [...ranges.map((range) => [range[0], range[1]] as [number, number]), [start, end] as [number, number]]
    .sort((a, b) => a[0] - b[0])
  for (const range of all) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  return merged
}

/**
 * How far a contiguous coverage from byte 0 reaches. A gap stops it, so reading
 * page 3 without page 1 does NOT authorize a replacement of the whole file.
 */
function coveredTo(ranges: ReadonlyArray<readonly [number, number]>): number {
  const first = ranges[0]
  if (first === undefined || first[0] !== 0) return 0
  return first[1]
}

/**
 * What a `memory_read_file` page delivered to the child, in one place.
 *
 * dsh renders a page as `<header>`, blank line, `<content>`, then an optional
 * "more bytes" tail. This adapter's cap may cut that render anywhere, so the
 * bytes the child really received are derived from the DELIVERED body: the page
 * content starts at a known character index of the render, and the delivered
 * body is a prefix of that render, so the bytes past that index are exactly what
 * the child saw — clamped to the content's own length so the tail line is never
 * credited as content.
 *
 * One function serves both the resume note and the overwrite gate on purpose:
 * if the offset the model is told to continue from and the offset this module
 * believes was read could disagree, one of them is wrong.
 */
interface PageDelivery {
  /** Bytes of the page's content the delivered body carries. */
  delivered(body: string): number
  /** The absolute file offset to resume from, after a delivered body. */
  resume(body: string): number
  /** Bytes of the file still unread, when the page reports a total. */
  remaining(body: string): number | undefined
  /** The note that tells the model where to continue. */
  note(info: CutInfo): string
}

function pageDelivery(renderText: string, result: unknown): PageDelivery | undefined {
  const value = record(result)
  const content = typeof value.content === 'string' ? value.content : undefined
  const offset = typeof value.offset === 'number' ? value.offset : undefined
  if (content === undefined || offset === undefined) return undefined
  const size = typeof value.size === 'number' ? value.size : undefined
  const id = typeof value.id === 'string' ? value.id : ''
  const file = typeof value.file === 'string' ? value.file : ''
  const contentBytes = byteLength(content)
  // Where the content begins inside the render, as a CHARACTER index. -1 means
  // the render is not the shape this function understands.
  const start = content.length === 0 ? -1 : renderText.indexOf(content)
  const headerBytes = start < 0 ? undefined : byteLength(renderText.slice(0, start))
  const delivered = (body: string): number => {
    if (headerBytes === undefined) {
      // Unrecognizable render: credit everything only when nothing was cut.
      return body.length === renderText.length ? contentBytes : 0
    }
    // The delivered body is a prefix of the render, so everything from the
    // content's start is content — the clamp drops the "more bytes" tail.
    return Math.min(contentBytes, Math.max(0, byteLength(body) - headerBytes))
  }
  const resume = (body: string): number => offset + delivered(body)
  return {
    delivered,
    resume,
    remaining: (body) => (size === undefined ? undefined : Math.max(size - resume(body), 0)),
    note: (info) => {
      const left = size === undefined ? '' : `${Math.max(size - resume(info.keptText), 0)} bytes remain; `
      return `…[output truncated by mexplore at the host limit: ${left}continue this file with memory_read_file(id: "${id}", file: ${JSON.stringify(file)}, offset: ${resume(info.keptText)})]`
    },
  }
}

function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
}

function idOf(args: unknown): string | undefined {
  const value = record(args).id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function fromOf(args: unknown): string | undefined {
  const value = record(args).from
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The write's one-line description, from the ARGS (never from rendered prose):
 * `memory_write` uses its `description`, falling back to the first
 * {@link BODY_PREFIX_CHARS} chars of `body`; `memory_attach` has no description
 * of its own, so the attachment's name is the handle the footer announces.
 */
function describeWrite(tool: string, args: unknown, result: Record<string, unknown>): string | undefined {
  const values = record(args)
  if (tool === 'memory_attach') {
    const name = typeof values.filename === 'string' && values.filename.length > 0
      ? values.filename
      : typeof result.file === 'string' && result.file.length > 0
        ? result.file
        : undefined
    return name
  }
  if (typeof values.description === 'string' && values.description.trim().length > 0) return values.description
  if (typeof result.description === 'string' && result.description.trim().length > 0) return result.description
  const body = typeof values.body === 'string' ? values.body.trim() : ''
  if (body.length === 0) return undefined
  return body.slice(0, BODY_PREFIX_CHARS).replace(/\s+/g, ' ')
}

/**
 * One loaded graph: the two applied dsh instances plus the config they share.
 * Built once per process and reused by every call (REQ-003: a call gets fresh
 * STATE, not a fresh plugin).
 */
export class GraphRuntime {
  /** @internal the loaded dsh module graph, shared with the calls. */
  readonly dsh: DshModules
  readonly graphRoot: string
  readonly config: GraphConfig
  private readonly profiles: Record<Authority, ProfileInstance>

  constructor(dsh: DshModules, config: GraphConfig, profiles: Record<Authority, ProfileInstance>) {
    this.dsh = dsh
    this.config = config
    this.graphRoot = config.graphRoot
    this.profiles = profiles
  }

  /** @internal definitions for one authority (validated by `applyProfile`). */
  definitions(authority: Authority): Map<string, DshToolDefinition> {
    return this.profiles[authority].definitions
  }

  /** The tools one authority may reach. Manage is a superset of read. */
  toolNames(authority: Authority): string[] {
    const names = authority === 'manage' ? MANAGE_TOOL_NAMES : READ_TOOL_NAMES
    return names.filter((name) => this.profiles[authority].definitions.has(name))
  }

  /**
   * The advertised tool definitions: name, the description of the profile that
   * owns this authority, and the JSON Schema verbatim — with `from_path`
   * stripped from `memory_attach` (SEC-001).
   */
  toolDefs(authority: Authority): ToolDef[] {
    return this.toolNames(authority).map((name) => {
      const definition = this.profiles[authority].definitions.get(name) as DshToolDefinition
      const restricted = name === 'memory_attach'
      const input = restricted ? stripFromPath(definition.parameters) : structuredClone(definition.parameters)
      return {
        name,
        description: restricted ? `${definition.description}${RESTRICTED_ATTACH_NOTE}` : definition.description,
        input: name === 'memory_read' ? withBodyOffset(input) : input,
      }
    })
  }

  /** The `memory:graph` section for this authority, slots filled at call time. */
  renderPrompt(authority: Authority): string {
    return renderCapturedPrompt(this.profiles[authority].prompt)
  }

  /**
   * One call: its own authority, fence, queue and records.
   *
   * `origin` is the root chat the host adapter resolved for this call (or why it
   * could not). It is carried for attribution only — `callId` remains the
   * authorization key.
   */
  createCall(options: {
    callId: string
    authority: Authority
    message: string
    evidence: Evidence[]
    origin?: CallOrigin
  }): GraphCall {
    return new GraphCall(this, options)
  }
}

/**
 * Resolve the graph root the same way dsh does (`expandHome` then
 * `path.resolve`), so the edge probe in `GraphCall` reads the directory dsh
 * actually writes to. dsh expands a leading `~` against the real home.
 */
function resolveGraphRoot(graphRoot: string): string {
  const home = os.homedir()
  const expanded = graphRoot === '~' ? home : graphRoot.startsWith('~/') ? path.join(home, graphRoot.slice(2)) : graphRoot
  return path.resolve(expanded)
}

/**
 * Load dsh_plugin and apply it once per prompt profile.
 *
 * `indexCacheMs: 0` on the read instance: a mexplore call is one turn, so a
 * cached index is stale within the call, and the read profile's prompt is the
 * small one — paying the re-render is cheaper than serving a stale index.
 */
export async function loadGraph(config: GraphConfig): Promise<GraphRuntime> {
  if (typeof config.graphRoot !== 'string' || config.graphRoot.length === 0) {
    throw new Error('mexplore: `graphRoot` is required — the plugin must choose where memory lives')
  }
  const dsh = await loadDshModules()
  const resolved: GraphConfig = { ...config, graphRoot: resolveGraphRoot(config.graphRoot) }
  const profiles: Record<Authority, ProfileInstance> = {
    read: applyProfile(dsh, resolved, 'read'),
    manage: applyProfile(dsh, resolved, 'manage'),
  }
  return new GraphRuntime(dsh, resolved, profiles)
}
