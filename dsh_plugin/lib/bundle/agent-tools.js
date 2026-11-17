/**
 * Bundle row inside the memory presets: the memory agent's tools.
 *
 * One long-lived DSH process can run many children at once. Per-run state is
 * keyed by the child agent id that `memory_agent` reserved before startup.
 *
 * Policy:
 *   - authority tiers: read = memory_search, memory_read, memory_read_file;
 *     manage adds memory_write and memory_attach. memory_merge and
 *     memory_restore are never registered; memory_attach.from_path is removed
 *     from the schema and refused in execution;
 *   - the child sees no other tool: every global (host) tool is denied with
 *     `ctx.tools.restrict`, so no shell, file or third-party plugin tool
 *     reaches the memory agent (presets add their own tools; these presets
 *     add none besides the memory tools);
 *   - the write fence: after a write whose effect is uncertain or known to be
 *     partial, every later write in the same delegation is refused before it
 *     runs. A rejection proven by the tool's own argument preparation and an
 *     audited pre-mutation refusal do not latch it;
 *   - structured results (not rendered text) are recorded per call, and every
 *     memory_read_file page is re-read from disk and checked byte for byte, so
 *     `memory_agent` can ground citations and rebuild attachments verbatim.
 *
 * A call from any agent that is not a live `memory_agent` delegation of the
 * same authority is refused, so selecting the preset by hand as a session mode
 * gives a model that cannot touch memory.
 *
 * @module dsh-mexplore/agent-tools
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as core from '../index.js'
import { consumeAuditedRefusal, restateDeclaredPropertiesRemedy, trustedPreparationFor } from '../tool.js'
import { ULID_RE } from '../graph.js'
import { SETTINGS_SERVICE, state } from './state.js'

// The scope key DSH uses for per-agent tool views. It ships with every DSH
// installation and the runtime resolves installation packages for profile
// plugins; the package is not a dependency of this one, so a missing copy
// (tests, other hosts) just falls back to the global view.
let scopeOf
try {
  ;({ scopeOf } = await import('@deepseek-ai/dsh-scope'))
} catch {
  scopeOf = undefined
}

export const name = 'memory-graph-agent-tools'
export const inject = ['tools', SETTINGS_SERVICE]

export const READ_TOOLS = Object.freeze(['memory_search', 'memory_read', 'memory_read_file'])
export const MANAGE_TOOLS = Object.freeze([...READ_TOOLS, 'memory_write', 'memory_attach'])
export const WRITE_TOOLS = Object.freeze(['memory_write', 'memory_attach'])

/** Mirrors AUDITED_REFUSAL_CODES in the wrapper and contracts.ts. */
export const AUDITED_REFUSAL_CODES = Object.freeze([
  'update_unread',
  'update_stale',
  'update_contradicted_figure',
  'update_target_missing',
  'attach_overwrite_unseen',
  'supersede_unread',
  'supersede_stale',
  'supersede_target_missing',
  'link_target_missing',
])

export const WRITE_FENCE_CODE = 'WRITE_FENCE_LATCHED'
export const WRITE_FENCE_MESSAGE = `${WRITE_FENCE_CODE} — the write fence is latched for the rest of this run: an earlier write or attachment had an uncertain or partial effect, so no further memory_write or memory_attach can succeed (reads still work). Do not retry; finish by reporting what was written, what failed, and what remains pending.`

const RESERVED_FILES = new Set(['node.md', 'accessed.log', '__edges__', 'MAP.md'])
const MAX_RECORDED_RESULT_BYTES = 1024 * 1024
const MAX_VERIFY_FILE_BYTES = 8 * 1024 * 1024

export function restrictedToolNames(authority) {
  if (authority === 'read') return [...READ_TOOLS]
  if (authority === 'manage') return [...MANAGE_TOOLS]
  throw new Error(`memory agent tools require authority 'read' or 'manage', got ${JSON.stringify(authority)}`)
}

export function apply(ctx, config = {}) {
  const authority = config.authority
  const allowed = restrictedToolNames(authority)

  // Injected, so this row loads only after the memory_agent row and with its
  // current settings (graph root, index size, plugin fields). Reading module
  // state instead let a preset that loaded first fall back to the default
  // graph root (E2E: a manage write landed in ~/.dsh/memory-graph).
  const settings = ctx[SETTINGS_SERVICE]
  if (settings === undefined || settings === null) throw new Error('memory agent tools need the memory_agent row (dsh-mexplore/agent) to be on')
  const pluginConfig = { ...settings.plugin, promptProfile: authority }
  const graphRoot = pluginConfig.graphRoot

  const captured = new Map()
  const proxyCtx = {
    tools: {
      register(definition) {
        captured.set(definition.name, definition)
        return () => captured.delete(definition.name)
      },
    },
    inject(names, callback) {
      if (typeof ctx?.inject !== 'function') return () => {}
      return ctx.inject(names, callback)
    },
  }
  core.apply(proxyCtx, pluginConfig)

  for (const toolName of allowed) {
    const definition = captured.get(toolName)
    if (definition === undefined) throw new Error(`memory plugin did not register required tool: ${toolName}`)
    const isAttach = toolName === 'memory_attach'
    const parameters = isAttach ? stripFromPath(definition.parameters) : definition.parameters
    const description = isAttach
      ? `${definition.description}\n\n(memory agent: only \`content\` is accepted; \`from_path\` is rejected.)`
      : definition.description
    ctx.tools.register({
      ...definition,
      description,
      parameters,
      async execute(args, exec) {
        const record = state.delegations.get(exec?.agent?.id)
        if (record === undefined) {
          throw new Error('memory tools run only inside a memory_agent delegation; ask the main agent to call memory_agent')
        }
        if (record.authority !== authority) {
          throw new Error(`this delegation has authority '${record.authority}', not '${authority}'`)
        }
        if (isAttach && args !== null && typeof args === 'object' && Object.hasOwn(args, 'from_path')) {
          throw new Error('memory_attach.from_path is not permitted for the memory agent; pass `content` instead')
        }
        return executeRecorded({
          definition,
          args,
          exec,
          toolName,
          record,
          graphRoot,
          publishedProperties: isAttach ? parameters.properties : undefined,
        })
      },
    })
  }

  // Hide every inherited tool from the agent this preset composes.
  //
  // Not `allow: []`: E2E on DSH 0.2.2-rc.1 showed that hides the memory tools
  // too. A preset row registers into a layer the child agent INHERITS, so a
  // restriction on that layer covers them, while `restrict` validates names
  // against this row's own view, where they are local and cannot be named in
  // `allow`. Denying the other names leaves this row's registrations alone.
  //
  // The names come from this row's own view, not the global one: a plugin
  // switched on or installed while DSH runs (HMR) registers in a layer that is
  // not global but is still inherited. And the list cannot be taken once: the
  // preset row is applied when the profile is composed, not per delegation
  // (E2E: `memory_agent`, switched on from the Plugins page after the preset
  // loaded, reached the child). So the restriction is rebuilt on every
  // registry change: lift ours, read what is visible, deny it again. All of it
  // is synchronous, so no model step sees the gap; the nested `tools/change`
  // events our own lift and re-apply emit are ignored.
  let lift
  let rebuilding = false
  const rebuild = () => {
    if (rebuilding) return
    rebuilding = true
    try {
      lift?.()
      lift = undefined
      const otherNames = inheritedToolNames(ctx).filter((toolName) => !allowed.includes(toolName))
      if (otherNames.length > 0) lift = ctx.tools.restrict({ deny: otherNames })
    } finally {
      rebuilding = false
    }
  }
  rebuild()
  ctx.on('tools/change', rebuild)
  ctx.effect(() => () => {
    lift?.()
    lift = undefined
  })
}

/**
 * Names of the tools this row's context can see, own registrations included.
 * Uses DSH's `scopeOf` when the installation provides it (always, inside
 * DSH); outside DSH it falls back to the global view.
 */
export function inheritedToolNames(ctx) {
  if (typeof ctx.tools.definitions !== 'function') return []
  const scope = scopeOf === undefined ? undefined : scopeOf(ctx)
  const definitions = ctx.tools.definitions(scope)
  return [...new Set(definitions.map((definition) => definition.name))].filter((toolName) => toolName !== 'run_code')
}

/**
 * One guarded call. Records `{ tool, callId, outcome, verification? }` on the
 * delegation and applies the write fence with the wrapper's ordering.
 *
 * The exec handed to the memory tool is a shallow copy carrying
 * `provenance` (design 26111000): the value resolved once for this delegation
 * in agent.js. A copy, so `agent.id` — the per-child authorization key — and
 * every other field stay exactly as the host sent them, and the caller's exec
 * object is never mutated. Nothing is shared: the value comes from this
 * child's own record, so concurrent delegations stay isolated.
 *
 * The copy is CACHED per (record, caller exec), not made afresh per call: the
 * audited-refusal registry keys its serial-epoch bookkeeping on exec identity
 * (tool.js), so two calls that arrived on one exec object must still reach the
 * definition as one identity. A per-call copy would silently stop them from
 * poisoning each other's epoch.
 */
export async function executeRecorded({ definition, args, exec, toolName, record, graphRoot, publishedProperties }) {
  const writeTool = WRITE_TOOLS.includes(toolName)
  const childExec = childExecFor(record, exec)
  const callId = `${record.calls.length + 1}`
  const finish = (outcome, extra = {}) => record.calls.push({ tool: toolName, callId, outcome, ...extra })

  if (writeTool && record.fence.latched) {
    finish({ kind: 'error', error: WRITE_FENCE_CODE, executionStarted: false })
    const refusal = new Error(WRITE_FENCE_MESSAGE)
    refusal.code = WRITE_FENCE_CODE
    throw refusal
  }

  const prechecked = precheckArguments(definition, args)
  if (prechecked.kind === 'rejected') {
    const violations =
      publishedProperties === undefined
        ? prechecked.violations
        : prechecked.violations.map((violation) => restateDeclaredPropertiesRemedy(violation, publishedProperties))
    const message = `invalid arguments: ${violations.join('; ')}`
    finish({ kind: 'error', error: message, executionStarted: false })
    throw new Error(message)
  }
  if (prechecked.kind === 'uncertain') {
    if (writeTool) record.fence.latched = true
    finish({ kind: 'error', error: String(prechecked.error?.message ?? prechecked.error) })
    throw prechecked.error
  }

  // Optional observers set by the caller of delegate() through `onRecord` (the history import hashes the
  // nodes a write touches right before and after it). They never affect the write; their errors are ignored.
  if (writeTool) callHook(record, 'beforeWrite', { tool: toolName, args })
  let result
  try {
    result = await definition.execute(args, childExec)
  } catch (error) {
    const consumed = writeTool ? consumeAuditedRefusal(definition, childExec, error) : undefined
    const code = typeof consumed === 'string' && AUDITED_REFUSAL_CODES.includes(consumed) ? consumed : undefined
    if (writeTool && code === undefined) record.fence.latched = true
    finish(
      code === undefined
        ? { kind: 'error', error: String(error?.message ?? error) }
        : { kind: 'error', error: String(error?.message ?? error), executionStarted: true, auditedRefusal: code },
    )
    throw error
  }

  const verification = toolName === 'memory_read_file' ? await verifyReadFile(graphRoot, result) : undefined
  const serialized = safeStringify(result)
  const oversized = serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RECORDED_RESULT_BYTES
  if (writeTool && (oversized || knownPartialMutation(result))) record.fence.latched = true
  if (writeTool) callHook(record, 'afterWrite', { tool: toolName, args, result })
  finish(
    { kind: 'result', result: oversized ? { omitted: true, reason: 'result exceeded the recording cap' } : result },
    verification === undefined ? {} : { verification },
  )
  return result
}

/**
 * The exec a memory tool receives: the caller's own object when the record
 * carries no provenance (nothing to add), else one shallow copy per
 * (record, caller exec) pair. See executeRecorded for why it is cached.
 */
function childExecFor(record, exec) {
  if (record.provenance === undefined || record.provenance === null) return exec
  if (exec === null || typeof exec !== 'object') return exec
  const seen = (record.execs ??= new WeakMap())
  const cached = seen.get(exec)
  if (cached !== undefined) return cached
  // The provenance is attached to a copy; every other field — agent.id above
  // all — is the host's own, unchanged.
  const childExec = { ...exec, provenance: record.provenance }
  seen.set(exec, childExec)
  return childExec
}

function callHook(record, name, payload) {
  const hook = record.hooks?.[name]
  if (typeof hook !== 'function') return
  try {
    hook(payload)
  } catch {
    // an observer must never change the outcome of a write
  }
}

/**
 * The definition's own trusted preparation, run as a precheck (same three-way
 * contract as the wrapper's `precheckArguments`).
 */
export function precheckArguments(definition, args) {
  const prepare = trustedPreparationFor(definition)
  if (typeof prepare !== 'function') return { kind: 'unknown' }
  let prepared
  try {
    prepared = prepare(args)
  } catch (error) {
    return { kind: 'uncertain', error }
  }
  if (prepared === null || typeof prepared !== 'object') {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned no result') }
  }
  const violations = prepared.violations
  if (!Array.isArray(violations)) {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned no violation list') }
  }
  if (violations.length === 0) return { kind: 'admitted' }
  if (!violations.every((violation) => typeof violation === 'string')) {
    return { kind: 'uncertain', error: new Error('tool argument preparation returned malformed violations') }
  }
  return { kind: 'rejected', violations }
}

/** A successful write that reports an attachment or edge it did not make. */
export function knownPartialMutation(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  if (typeof result.attach_failed === 'string' && result.attach_failed.length > 0) return true
  if (!Array.isArray(result.links)) return false
  return result.links.some((link) => link !== null && typeof link === 'object' && link.status === 'failed')
}

/**
 * Re-read the attachment from disk and check that the returned page is the raw
 * bytes. Same checks as the wrapper's `verifyReadFile`.
 */
export async function verifyReadFile(graphRoot, result) {
  try {
    if (result === null || typeof result !== 'object') throw new Error('result is not an object')
    const { id, file, size, offset, bytes, content, next_offset: nextOffset } = result
    if (typeof id !== 'string' || !ULID_RE.test(id)) throw new Error('result id is not a node id')
    if (!isPlainFilename(file)) throw new Error('result file is not a plain attachment name')
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('result size is invalid')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('result offset is invalid')
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('result bytes is invalid')
    if (offset + bytes > size) throw new Error('result window exceeds file size')
    if (typeof content !== 'string') throw new Error('result content is not text')
    if (size > MAX_VERIFY_FILE_BYTES) throw new Error(`attachment too large to verify (${size} bytes)`)

    const root = realDirectorySync(path.resolve(expandHome(graphRoot)))
    const nodeDir = path.join(root, id)
    const nodeStats = fs.lstatSync(nodeDir)
    if (!nodeStats.isDirectory() || nodeStats.isSymbolicLink()) throw new Error('node path is not a plain directory')
    const nodeReal = realDirectorySync(nodeDir)
    if (!isInside(root, nodeReal)) throw new Error('node path escapes the graph root')
    const filePath = path.join(nodeReal, file)
    if (path.dirname(path.resolve(filePath)) !== path.resolve(nodeReal)) throw new Error('attachment path escapes the node directory')

    const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new Error('attachment is not a regular file')
      if (stats.size !== size) throw new Error(`attachment size changed (result ${size}, disk ${stats.size})`)
      const full = Buffer.alloc(size)
      let read = 0
      while (read < full.length) {
        const chunk = await handle.read(full, read, full.length - read, read)
        if (chunk.bytesRead === 0) break
        read += chunk.bytesRead
      }
      if (read !== size) throw new Error(`attachment read short (${read} of ${size} bytes)`)
      const fileHash = sha256Hex(full)
      const page = full.subarray(offset, offset + bytes)
      const roundtrip = page.equals(Buffer.from(content, 'utf8'))
      const complete = nextOffset === undefined
      if (!complete && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)) throw new Error('next_offset is invalid')
      if (complete && offset + bytes !== size) throw new Error('result claims end of file at the wrong offset')
      if (!complete && nextOffset !== offset + bytes) throw new Error('next_offset does not continue this window')
      return {
        verified: roundtrip,
        ...(roundtrip ? {} : { reason: 'returned text does not round-trip to the raw bytes (invalid UTF-8 or altered content)' }),
        nodeId: id,
        attachment: file,
        size,
        offset,
        bytes,
        complete,
        fileHash,
        version: `${size}:${fileHash}`,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return { verified: false, reason: String(error?.message ?? error) }
  }
}

function stripFromPath(parameters) {
  const clone = structuredClone(parameters)
  if (clone && typeof clone === 'object' && clone.properties && typeof clone.properties === 'object') {
    delete clone.properties.from_path
    if (Array.isArray(clone.required)) clone.required = clone.required.filter((key) => key !== 'from_path')
  }
  return clone
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function isPlainFilename(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === path.basename(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.startsWith('.') &&
    !value.includes('\u0000') &&
    !RESERVED_FILES.has(value)
  )
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function realDirectorySync(target) {
  const real = fs.realpathSync(target)
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a directory: ${target}`)
  return real
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
