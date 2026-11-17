/**
 * Lane A2 — the OpenCode wiring: tools, hooks, lifecycle, model resolution,
 * the `/mexplore` command, the graph root and the setup diagnostics.
 *
 * The fake host (`test/helpers/fake-host.ts`) implements exactly the surface
 * `src/plugin/host.ts` declares. The child's "model" is scripted per test: when
 * a child is prompted, the script calls the registered graph-tool executors with
 * that child's session ID and then leaves an assistant message behind.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { MANAGE_TOOL_NAMES, READ_TOOL_NAMES } from '../src/graph/index'
import { resolveGraphRoot } from '../src/plugin/config'
import { COMMAND_NAME, TUI_COMMAND_NAME, runCommandText } from '../src/plugin/command'
import { MEXPLORE_TOOL } from '../src/plugin/tools'
import { MexploreRpc } from '../src/rpc'
import tuiPlugin, { replyText, showReply } from '../src/tui'
import { redact } from '../src/plugin/redact'
import { USAGE_BRIEF } from '../src/plugin/prompt'
import { baseURLProblem } from '../src/plugin/diagnostics'
import { assistant, failedAssistant } from './helpers/fake-host'
import { CUSTOM_PROVIDER_SETTINGS, makeFixture, tempRoot, withEnv, type Fixture } from './helpers/plugin'
import { seedLinkTarget, withFailedEdge } from './helpers/partial-write'

const fixtures: Fixture[] = []

async function fixture(options: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const created = await makeFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.dispose()
})

const PARENT = 'ses_parent0000000000000000000'

/** Pinned owner token, so a sweep test can model "this generation". */
const THIS_TOKEN = 'this-generation-token'

/** A model list with one usable OpenCode model, for the parent-fallback branch. */
const ANTHROPIC = [{ providerID: 'anthropic', id: 'claude-sonnet-5' }]

/** Every tool name the plugin registers. */
const ALL_TOOLS = ['memory_attach', 'memory_read', 'memory_read_file', 'memory_search', 'memory_write', 'mexplore']

/** Capture a thrown error, so assertions can look at a ToolError's message. */
async function failure(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure, but the call succeeded')
}

/** The plugin's categorical code, which rides in the ToolError's metadata. */
function codeOf(error: unknown): string | undefined {
  return (error as { metadata?: { code?: string } } | null)?.metadata?.code
}

// ------------------------------------------------------------ tools & hooks

describe('tool registration (REQ-001, REQ-019)', () => {
  test('every tool is registered directly, with codemode disabled', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    expect([...host.tools.keys()].sort()).toEqual(ALL_TOOLS)
    for (const [name, tool] of host.tools) {
      expect({ name, codemode: tool.options?.codemode }).toEqual({ name, codemode: false })
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })

  test('the mexplore schema has no session input (AC-003)', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    const schema = host.tools.get('mexplore')?.input as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties).sort()).toEqual(['authority', 'evidence', 'message'])
  })

  test('merge and restore are never registered (SEC-001)', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    expect(host.tools.has('memory_merge')).toBe(false)
    expect(host.tools.has('memory_restore')).toBe(false)
    const attach = host.tools.get('memory_attach')?.input as { properties: Record<string, unknown> }
    expect(Object.keys(attach.properties)).not.toContain('from_path')
  })

  test('a non-owned session cannot call a graph tool through its executor (AC-019)', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    const error = await failure(() => host.executeTool('memory_search', { query: 'x' }, PARENT))
    expect(error.message).toContain('only available inside an mexplore call')
  })
})

describe('model-request hooks (REQ-007, REQ-018)', () => {
  test('the parent loses every memory_ tool and gains the brief exactly once (AC-004, AC-014)', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    const tools = ['mexplore', 'memory_search', 'memory_write', 'read', 'bash']
    const first = await host.trigger('context', { sessionID: PARENT, tools })
    expect(Object.keys(first.tools).sort()).toEqual(['bash', 'mexplore', 'read'])
    // Twice over the same event: still one copy, not two.
    await host.hooks.context[0]?.(first)
    const briefs = first.system.filter((part) => part.text === USAGE_BRIEF)
    expect(briefs).toHaveLength(1)
    expect(first.system.at(-1)?.text).toBe(USAGE_BRIEF)
  })

  test('no brief without the mexplore tool, and none on compaction or generate (AC-015)', async () => {
    const { host } = await fixture({ models: ANTHROPIC })
    const withoutTool = await host.trigger('context', { sessionID: PARENT, tools: ['read', 'memory_search'] })
    expect(withoutTool.system.some((part) => part.text === USAGE_BRIEF)).toBe(false)
    expect(withoutTool.tools.memory_search).toBeUndefined()

    const compaction = await host.trigger('compaction', { sessionID: PARENT, tools: ['mexplore', 'memory_read'] })
    expect(compaction.system.some((part) => part.text === USAGE_BRIEF)).toBe(false)
    const generate = await host.trigger('generate', { sessionID: PARENT, tools: ['mexplore'] })
    expect(generate.system.some((part) => part.text === USAGE_BRIEF)).toBe(false)
  })

  test('the context hook caches the parent model for the fallback branch (REQ-005 step 3)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: false })
    await host.trigger('context', {
      sessionID: PARENT,
      model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
      tools: ['mexplore'],
    })
    expect(plugin.parentModels.get(PARENT)).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-5' })
  })

  test('an owned child gets exactly its tier tools, its profile descriptions and the memory prompt', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childEvent: Awaited<ReturnType<typeof host.trigger>> | undefined
    let childID: string | undefined
    host.script = async (child, host) => {
      childID = child.info.id
      // The hook must have shaped the request before the model answers, and the
      // tools we are given must be the tier's own.
      childEvent = await host.trigger('context', {
        sessionID: child.info.id,
        tools: ['mexplore', 'memory_search', 'memory_read', 'memory_read_file', 'memory_write', 'memory_attach', 'bash', 'skill'],
      })
      child.messages.push(assistant('unknown'))
    }
    await host.executeTool('mexplore', { message: 'anything?', authority: 'manage' }, PARENT)
    expect(childID).toBeDefined()
    const event = childEvent as NonNullable<typeof childEvent>
    expect(Object.keys(event.tools).sort()).toEqual([...MANAGE_TOOL_NAMES].sort())
    expect(event.tools.mexplore).toBeUndefined()
    expect(event.tools.bash).toBeUndefined()
    // The description is the profile's, not the host's placeholder.
    const profile = plugin.runtime.toolDefs('manage').find((def) => def.name === 'memory_write')
    expect(event.tools.memory_write?.description).toBe(profile?.description as string)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]?.text).toContain('memory_search')
    expect(event.system[0]?.text).not.toContain(USAGE_BRIEF)
  })

  test('a read child is reduced to the read tier alone (AC-005)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childEvent: Awaited<ReturnType<typeof host.trigger>> | undefined
    host.script = async (child, host) => {
      childEvent = await host.trigger('context', {
        sessionID: child.info.id,
        tools: ['memory_search', 'memory_read', 'memory_read_file', 'memory_write', 'memory_attach', 'write'],
      })
      child.messages.push(assistant('unknown'))
    }
    await host.executeTool('mexplore', { message: 'anything?', authority: 'read' }, PARENT)
    const event = childEvent as NonNullable<typeof childEvent>
    expect(Object.keys(event.tools).sort()).toEqual([...READ_TOOL_NAMES].sort())
    expect(event.tools.write).toBeUndefined()
  })

  test('on compaction a child keeps its tools but not the memory system prompt', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let compaction: Awaited<ReturnType<typeof host.trigger>> | undefined
    host.script = async (child, host) => {
      compaction = await host.trigger('compaction', {
        sessionID: child.info.id,
        tools: ['memory_search', 'memory_read', 'memory_read_file', 'memory_write', 'memory_attach', 'bash', 'mexplore'],
      })
      child.messages.push(assistant('unknown'))
    }
    await host.executeTool('mexplore', { message: 'anything?', authority: 'manage' }, PARENT)
    const event = compaction as NonNullable<typeof compaction>
    // Tier tools the request offered are kept; anything outside the tier goes.
    expect(Object.keys(event.tools).sort()).toEqual([...MANAGE_TOOL_NAMES].sort())
    expect(event.system.map((part) => part.text)).toEqual(['You are a helpful agent.'])
  })
})

// -------------------------------------------------------------- basic calls

describe('call isolation (REQ-003, REQ-010, AC-010)', () => {
  test('two parallel calls from one parent get separate children and separate state', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const seen: string[] = []
    host.script = async (child, host) => {
      seen.push(child.info.id)
      await host.executeTool('memory_search', { query: 'parallel' }, child.info.id)
      child.messages.push(assistant('ok'))
    }
    const [first = { metadata: {} }, second = { metadata: {} }] = (await Promise.all([
      host.executeTool('mexplore', { message: 'one' }, PARENT),
      host.executeTool('mexplore', { message: 'two' }, PARENT),
    ])) as Array<{ metadata: Record<string, unknown> }>
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(first.metadata.toolCalls).toBe(1)
    expect(second.metadata.toolCalls).toBe(1)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('an injected from_path is rejected and nothing is read from disk (AC-010)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let rejection: Error | undefined
    host.script = async (child, host) => {
      rejection = await failure(() =>
        host.executeTool('memory_attach', { id: '01AAAAAAAAAAAAAAAAAAAAAAAA', from_path: '/etc/passwd' }, child.info.id),
      )
      child.messages.push(assistant('refused'))
    }
    const result = (await host.executeTool('mexplore', { message: 'attach it', authority: 'manage' }, PARENT)) as {
      content: string
    }
    expect(rejection?.message).toContain('from_path is not permitted')
    expect(result.content).toContain('no writes')
  })

})

describe('a full manage call (REQ-002, REQ-012, AC-016)', () => {
  test('writes a node, reports it in the footer, and cleans the child up', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child, host) => {
      childID = child.info.id
      await host.executeTool(
        'memory_write',
        { description: 'bananas are yellow', body: 'The user said so on 2026-11-05.' },
        child.info.id,
      )
      child.messages.push(assistant('Stored it.'))
    }
    const result = (await host.executeTool(
      'mexplore',
      { message: 'remember that bananas are yellow', authority: 'manage' },
      PARENT,
    )) as { content: string; metadata: Record<string, unknown> }

    expect(result.content.startsWith('Stored it.')).toBe(true)
    expect(result.content).toContain('saved to memory: bananas are yellow (')
    expect(result.content).not.toContain('no writes')

    const writes = result.metadata.writes as Array<{ status: string; nodeId?: string }>
    expect(writes).toHaveLength(1)
    expect(writes[0]?.status).toBe('ok')
    expect(result.metadata.toolCalls).toBe(1)
    expect(result.metadata.authority).toBe('manage')
    expect(result.metadata.model).toBe('mexplore/deepseek-v4.1-flash-1017')
    expect(result.metadata.modelSource).toBe('default')
    expect(result.metadata.graphRoot).toBe(plugin.graphRoot.path)
    expect(result.metadata.graphRootSource).toBe('option')

    // The node really landed on disk.
    const id = writes[0]?.nodeId as string
    await fsp.access(path.join(plugin.graphRoot.path, id, 'node.md'))

    // AC-003: no child id anywhere in the result.
    expect(childID).toBeDefined()
    expect(result.content).not.toContain(childID as string)
    expect(JSON.stringify(result.metadata)).not.toContain(childID as string)

    // Cleaned up: removed once, and the owned map is empty.
    expect(host.calls.remove).toEqual([childID as string])
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    expect(host.sessions.get(childID as string)?.removed).toBe(true)
  })

  test('the child is created with the summary agent, deny-all permissions and no id in its title', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    await host.executeTool('mexplore', { message: 'anything?', authority: 'manage' }, PARENT)
    const created = host.calls.create[0] as {
      parentID: string
      agent: string
      title: string
      model: { providerID: string; id: string }
      permissions: Array<{ action: string; resource: string; effect: string }>
      metadata: Record<string, unknown>
    }
    expect(created.parentID).toBe(PARENT)
    expect(created.agent).toBe('summary')
    expect(created.model).toEqual({ providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' })
    expect(created.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
    expect(created.permissions.slice(1).map((rule) => rule.action)).toEqual([...MANAGE_TOOL_NAMES])
    expect(created.permissions.every((rule) => rule.effect !== 'ask')).toBe(true)
    expect(created.metadata.mexploreChild).toBe(true)
    expect(created.metadata.ownerPid).toBe(process.pid)
    expect(typeof created.metadata.createdAt).toBe('number')
    expect(created.title).not.toContain('ses_')

    // SEC-003: the deny-all first rule covers shell, fs, web, subagent AND the
    // Code Mode `execute` tool — no allow rule names any of them.
    const allowed = new Set(created.permissions.slice(1).map((rule) => rule.action))
    for (const name of ['execute', 'shell', 'write', 'edit', 'websearch', 'subagent', 'task']) {
      expect(allowed.has(name)).toBe(false)
    }
  })

  test('a traversal edge is announced in the footer and reported in metadata (REQ-012)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let from = ''
    let to = ''
    host.script = async (child, host) => {
      const write = async (description: string): Promise<string> => {
        const result = (await host.executeTool('memory_write', { description, body: description }, child.info.id)) as {
          content: string
        }
        return /(\d[0-9A-Z]{25})/.exec(result.content)?.[1] ?? ''
      }
      from = await write('alpha topic')
      to = await write('beta topic')
      await host.executeTool('memory_read', { id: to, from }, child.info.id)
      child.messages.push(assistant('linked them'))
    }
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.content).toContain(`linked in memory: ${from} → ${to}`)
    expect(result.metadata.edges).toEqual([{ from, to }])
  })

  test('a read call advertises only the read tier and reports no writes (AC-005)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.executeTool('mexplore', { message: 'do I know x?', authority: 'read' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.content).toContain('no writes')
    expect(result.metadata.authority).toBe('read')
    expect(result.metadata.writes).toEqual([])
  })

  test('an out-of-tier tool is refused for a read child (AC-019)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let refusal: Error | undefined
    host.script = async (child, host) => {
      const error = await failure(() => host.executeTool('memory_write', { description: 'd', body: 'b' }, child.info.id))
      refusal = error
      child.messages.push(assistant('refused'))
    }
    await host.executeTool('mexplore', { message: 'read only', authority: 'read' }, PARENT)
    expect(refusal?.message).toContain('not available to a read call')
  })

  test('the executor refuses any session that is not the owned child, mid-call too', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let otherRefusal: Error | undefined
    host.script = async (child, host) => {
      otherRefusal = await failure(() => host.executeTool('memory_search', { query: 'x' }, 'ses_somebody_else'))
      child.messages.push(assistant('fine'))
    }
    await host.executeTool('mexplore', { message: 'q', authority: 'read' }, PARENT)
    expect(otherRefusal?.message).toContain('does not own one')
  })

  test('a child cannot start a nested memory call (REQ-003)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let nested: Error | undefined
    host.script = async (child, host) => {
      nested = await failure(() => host.executeTool('mexplore', { message: 'inner' }, child.info.id))
      child.messages.push(assistant('fine'))
    }
    await host.executeTool('mexplore', { message: 'outer' }, PARENT)
    expect(nested?.message).toContain('cannot start another memory call')
    expect(host.calls.create).toHaveLength(1)
  })

  test('a partial write latches the fence, and the footer reports it (AC-008)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const peer = await seedLinkTarget(plugin.runtime)
    let refused: Error | undefined
    host.script = async (child, host) => {
      // Fail the actual edge syscall against an existing peer, after the node
      // was published: a real partial, not a missing-target pre-write refusal.
      await withFailedEdge(peer, () => host.executeTool(
        'memory_write',
        { description: 'partial write', body: 'b', links: [peer] },
        child.info.id,
      ))
      refused = await failure(() =>
        host.executeTool('memory_write', { description: 'second write', body: 'b' }, child.info.id),
      )
      child.messages.push(assistant('done what I could'))
    }
    const result = (await host.executeTool('mexplore', { message: 'write twice', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(refused?.message).toContain('WRITE_FENCE_LATCHED')
    expect(result.content).toContain('memory write incomplete: partial write')
    expect(result.content).not.toContain('saved to memory: second write')
    const writes = result.metadata.writes as Array<{ status: string }>
    expect(writes.map((write) => write.status)).toEqual(['incomplete'])
  })
})

// -------------------------------------------------------------------- model

describe('model resolution (REQ-005, AC-007)', () => {
  test('branch 1: a stored provider/model selection wins', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      storage: { model: 'anthropic/claude-sonnet-5' },
    })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.model).toBe('anthropic/claude-sonnet-5')
    expect(result.metadata.modelSource).toBe('selected')
    const created = host.calls.create[0] as { model: unknown }
    expect(created.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-5' })
  })

  test('branch 2: a connected key uses the memory provider, honouring a stored model id', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      storage: { mexploreModel: 'deepseek-v4-pro', baseURL: CUSTOM_PROVIDER_SETTINGS.baseURL },
    })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      metadata: Record<string, unknown>
    }
    expect(result.metadata.model).toBe('mexplore/deepseek-v4-pro')
    expect(result.metadata.modelSource).toBe('default')
    const created = host.calls.create[0] as { model: unknown }
    expect(created.model).toEqual({ providerID: 'mexplore', id: 'deepseek-v4-pro' })
  })

  test('branch 3: no key, stored selection or not, falls back to the parent model with the note', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: false })
    await host.trigger('context', { sessionID: PARENT, model: { providerID: 'anthropic', id: 'claude-sonnet-5' }, tools: ['mexplore'] })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.model).toBe('anthropic/claude-sonnet-5')
    expect(result.metadata.modelSource).toBe('parent-fallback')
    expect(result.content).toContain(
      'note: memory agent ran on anthropic/claude-sonnet-5 (inherited from the current OpenCode session; no memory model override configured)',
    )
  })

  test('a stored selection wins over the connected key', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      storage: { model: 'anthropic/claude-sonnet-5', mexploreModel: 'deepseek-v4-pro' },
    })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      metadata: Record<string, unknown>
    }
    expect(result.metadata).toMatchObject({ model: 'anthropic/claude-sonnet-5', modelSource: 'selected' })
  })

  test('no model at all is an actionable error, and no child is created', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: false })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('no memory model is available')
    expect(error.message).toContain('/connect')
    expect(host.calls.create).toHaveLength(0)
  })
})

// ----------------------------------------------------------------- failure

describe('child failure detection (REQ-020, AC-020)', () => {
  test('a failed outcome names the assistant error, and the child is still removed', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(failedAssistant('401 invalid api key'))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('memory model failed')
    expect(error.message).toContain('401 invalid api key')
    expect(host.calls.remove).toEqual([childID as string])
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('an assistant message carrying error fails the call even when the outcome says nothing', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child) => {
      child.messages.push(failedAssistant('rate limited'))
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('rate limited')
    expect(error.message).not.toContain('no writes')
  })

  test('no assistant message at all fails the call instead of returning empty text', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async () => {}
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('no assistant reply')
  })

  test('an assistant message that never completed fails the call', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child) => {
      child.messages.push({ type: 'assistant', time: { created: Date.now() }, content: [{ type: 'text', text: 'half' }] })
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('did not finish')
  })

  test('an interrupted outcome is reported as an abort', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child) => {
      child.info.outcome = 'interrupted'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(codeOf(error)).toBe('ABORTED')
  })
})

// --------------------------------------------------------------- lifecycle

describe('lifecycle (REQ-004, AC-006)', () => {
  test('a failing remove keeps the child owned and says so, and dispose retries it (REQ-004)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    // Removal fails for a reason that is NOT "not found": the transcript is
    // still there, so forgetting it would leak a session silently.
    const original = host.ctx.session.remove
    let failOnce = true
    Object.assign(host.ctx.session, {
      remove: async (input: { sessionID: string }) => {
        if (failOnce) {
          failOnce = false
          throw new Error('database is locked')
        }
        return original(input)
      },
    })
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as { content: string }
    expect(result.content).toContain('ok')
    expect(plugin.registry.ownedSessionIDs()).toEqual([childID as string])

    // dispose retries the removal, and the retry succeeds.
    Object.assign(host.ctx.session, { remove: original })
    await plugin.registry.dispose()
    expect(host.sessions.get(childID as string)?.removed).toBe(true)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('dispose catches a child whose create is still in flight (REQ-004)', async () => {
    const { host, plugin, dispose } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const original = host.ctx.session.create
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        const info = await original(input)
        await held
        return info
      },
    })
    // The call is stuck inside `create` when dispose runs.
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    await Bun.sleep(5)
    const disposed = dispose()
    release()
    const error = await pending
    await disposed
    Object.assign(host.ctx.session, { create: original })

    // No child survives, no matter which side won the race.
    expect(codeOf(error)).toBe('ABORTED')
    for (const child of host.sessions.values()) {
      if (child.info.metadata?.mexploreChild === true) expect(child.removed).toBe(true)
    }
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a call started after dispose is refused without creating anything', async () => {
    const { host, plugin, dispose } = await fixture({ models: ANTHROPIC, keyConnected: true })
    await dispose()
    const error = await failure(() => host.executeTool('mexplore', { message: 'late' }, PARENT))
    expect(codeOf(error)).toBe('ABORTED')
    expect(host.calls.create).toHaveLength(0)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('an abort during the prompt tears the child down without waiting for a wait', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const controller = new AbortController()
    const original = host.ctx.session.prompt
    let childID: string | undefined
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.assign(host.ctx.session, {
      prompt: async (input: { sessionID: string; text: string }) => {
        childID = input.sessionID
        await held
        return original(input)
      },
    })
    const pending = failure(() =>
      host.tools.get('mexplore')?.execute(
        { message: 'q' },
        {
          sessionID: PARENT,
          agent: 'build',
          messageID: 'msg',
          id: 'call',
          signal: controller.signal,
          progress: async () => {},
        },
      ) as Promise<unknown>,
    )
    for (let i = 0; i < 200 && childID === undefined; i += 1) await Bun.sleep(1)
    controller.abort()
    const error = await pending
    release()
    Object.assign(host.ctx.session, { prompt: original })

    expect(codeOf(error)).toBe('ABORTED')
    expect(childID).toBeDefined()
    expect(host.sessions.get(childID as string)?.removed).toBe(true)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a blocked graph write cannot hold cleanup past the bound (REQ-004)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child, host) => {
      childID = child.info.id
      // A write that never settles: teardown must not wait for it before
      // interrupting, or the child outlives the cleanup bound entirely.
      void host.executeTool('memory_write', { description: 'never finishes', body: 'b' }, child.info.id).catch(() => {})
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (child.interrupted > 0) resolve()
          else setTimeout(check, 1)
        }
        setTimeout(check, 1)
      })
    }
    const controller = new AbortController()
    const pending = failure(() =>
      host.tools.get('mexplore')?.execute(
        { message: 'q', authority: 'manage' },
        {
          sessionID: PARENT,
          agent: 'build',
          messageID: 'msg',
          id: 'call',
          signal: controller.signal,
          progress: async () => {},
        },
      ) as Promise<unknown>,
    )
    for (let i = 0; i < 200 && childID === undefined; i += 1) await Bun.sleep(1)
    controller.abort()
    const error = await pending
    expect(codeOf(error)).toBe('ABORTED')
    expect(host.calls.interrupt).toContain(childID as string)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a write that landed is announced even when the run then fails (REQ-012)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child, host) => {
      await host.executeTool('memory_write', { description: 'landed before the crash', body: 'b' }, child.info.id)
      child.messages.push(failedAssistant('provider went away'))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT))
    expect(error.message).toContain('memory model failed')
    expect(error.message).toContain('saved to memory: landed before the crash')
    // Not a claim about the whole run.
    expect(error.message).not.toContain('no writes')
  })

  test('a failed run with no writes adds no footer at all', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child) => {
      child.messages.push(failedAssistant('rate limited'))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).not.toContain('no writes')
    expect(error.message).not.toContain('saved to memory')
  })

  test('an abort mid-wait interrupts and removes the child, and a second removal is harmless', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const controller = new AbortController()
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      // Hang: only the abort ends this call.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (child.interrupted > 0) resolve()
          else setTimeout(check, 1)
        }
        setTimeout(check, 1)
      })
    }
    const pending = failure(() =>
      host.tools.get('mexplore')?.execute(
        { message: 'slow', authority: 'read' },
        {
          sessionID: PARENT,
          agent: 'build',
          messageID: 'msg',
          id: 'call',
          signal: controller.signal,
          progress: async () => {},
        },
      ) as Promise<unknown>,
    )
    // Let the child be created and prompted.
    for (let i = 0; i < 200 && childID === undefined; i += 1) await Bun.sleep(1)
    controller.abort()
    const error = await pending
    expect(codeOf(error)).toBe('ABORTED')
    expect(host.calls.interrupt).toEqual([childID as string])
    expect(host.calls.remove).toEqual([childID as string])
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    // AC-006: removing again is not an error — `true` means the session is gone.
    await expect(plugin.registry.remove(childID as string)).resolves.toBe(true)
  })

  test('an abort after the child exists but before the prompt removes it too', async () => {    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const controller = new AbortController()
    controller.abort()
    const error = await failure(() =>
      host.tools.get('mexplore')?.execute(
        { message: 'q' },
        {
          sessionID: PARENT,
          agent: 'build',
          messageID: 'msg',
          id: 'call',
          signal: controller.signal,
          progress: async () => {},
        },
      ) as Promise<unknown>,
    )
    expect(codeOf(error)).toBe('ABORTED')
    // A child may or may not have been created (create is not given the signal);
    // if it was, it must be gone.
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    for (const child of host.sessions.values()) {
      if (child.info.metadata?.mexploreChild === true) expect(child.removed).toBe(true)
    }
    expect(host.calls.prompt).toHaveLength(0)
  })

  test('a prompt failure still removes the child and reports the host error', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const original = host.ctx.session.prompt
    Object.assign(host.ctx.session, {
      prompt: async () => {
        throw new Error('inbox write failed')
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('inbox write failed')
    expect(host.calls.remove).toHaveLength(1)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    Object.assign(host.ctx.session, { prompt: original })
  })

  test('a timeout interrupts, removes, and reports the budget as an actionable error', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 25 })
    host.script = async () => {
      // Never resolves: the timeout must win.
      await new Promise<void>(() => {})
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(codeOf(error)).toBe('TIMEOUT')
    expect(error.message).toContain('timeoutMs')
    expect(host.calls.interrupt).toHaveLength(1)
    expect(host.calls.remove).toHaveLength(1)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a healthy call reports timedOut: false and aborted: false', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as { metadata: Record<string, unknown> }
    expect(result.metadata).toMatchObject({ timedOut: false, aborted: false })
  })

  test('the timeout interrupts immediately and never reads a partial answer (Major 9)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 30 })
    host.script = async (child) => {
      child.messages.push(assistant('partial answer'))
      // The model finished writing, but the run never goes idle: the budget wins.
      await new Promise<void>(() => {})
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('did not answer within')
    expect(error.message).toContain('timeoutMs')
    // Interrupted, not inspected: a stopped call must not keep running.
    expect(host.calls.interrupt).toHaveLength(1)
    // The partial prose is NOT passed off as the answer.
    expect(error.message).not.toContain('partial answer')
  })

  test('one deadline covers startup: a stalled create cannot outlive the budget', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        await held
        return original(input)
      },
    })
    const started = Date.now()
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    const elapsed = Date.now() - started
    release()
    Object.assign(host.ctx.session, { create: original })
    expect(error.message).toContain('did not answer within')
    // Bounded by the call budget, not by the host's create.
    expect(elapsed).toBeLessThan(2_000)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a stalled prompt is bounded by the same deadline', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.prompt
    Object.assign(host.ctx.session, {
      prompt: async () => {
        await held
        return { id: 'inbox' }
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    release()
    Object.assign(host.ctx.session, { prompt: original })
    expect(error.message).toContain('did not answer within')
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a completed wait is never interrupted', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    expect(host.calls.interrupt).toEqual([])
  })

  test('two sequential calls use different child ids (AC-002 at unit level)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const seen: string[] = []
    host.script = async (child) => {
      seen.push(child.info.id)
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'same question' }, PARENT)
    await host.executeTool('mexplore', { message: 'same question' }, PARENT)
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    // The first child is gone from the host, not reused.
    expect(host.sessions.get(seen[0] as string)?.removed).toBe(true)
  })

  test('dispose removes every child still owned (REQ-004)', async () => {
    const { host, plugin, dispose } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      await held
      child.messages.push(assistant('late'))
    }
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    for (let i = 0; i < 200 && childID === undefined; i += 1) await Bun.sleep(1)
    expect(plugin.registry.ownedSessionIDs()).toEqual([childID as string])

    await dispose()
    expect(host.calls.remove).toContain(childID as string)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])

    // The in-flight call sees its child vanish; it must still end cleanly.
    release()
    const error = await pending
    expect(codeOf(error)).toBe('ABORTED')
  })
})

// ------------------------------------------------------------- crash sweep

describe('crash sweep (AC-022)', () => {
  test('only a DEAD pid is swept; any live pid vetoes, whatever the age or token (AC-022)', async () => {
    const deadPid = 999_999
    const livePid = process.ppid
    const now = Date.now()
    const twoHours = 2 * 60 * 60 * 1000
    const sessions = [
      {
        id: 'ses_dead_owner',
        time: { created: now, updated: now },
        metadata: { mexploreChild: true, ownerPid: deadPid, ownerToken: 'dead-token', createdAt: now },
      },
      {
        // Live foreign owner, far older than any call budget: must NOT be deleted.
        id: 'ses_live_foreign_old',
        time: { created: now - twoHours, updated: now },
        metadata: { mexploreChild: true, ownerPid: livePid, ownerToken: 'live-token', createdAt: now - twoHours },
      },
      { id: 'ses_not_a_child', time: { created: now, updated: now }, metadata: {} },
      {
        // Our own pid and token: this instance's child, never swept.
        id: 'ses_this_generation',
        time: { created: now - twoHours, updated: now },
        metadata: { mexploreChild: true, ownerPid: process.pid, ownerToken: THIS_TOKEN, createdAt: now - twoHours },
      },
      {
        // Our pid, DIFFERENT token: a SIBLING plugin instance in the same server
        // (another project), which is alive. Its child must survive.
        id: 'ses_sibling_instance_old',
        time: { created: now - twoHours, updated: now },
        metadata: { mexploreChild: true, ownerPid: process.pid, ownerToken: 'sibling', createdAt: now - twoHours },
      },
    ]
    const { host } = await fixture({ models: ANTHROPIC, existing: sessions, ownerToken: THIS_TOKEN })
    expect(host.calls.remove.sort()).toEqual(['ses_dead_owner'])
    expect(host.sessions.get('ses_live_foreign_old')?.removed).toBe(false)
    expect(host.sessions.get('ses_not_a_child')?.removed).toBe(false)
    expect(host.sessions.get('ses_this_generation')?.removed).toBe(false)
    expect(host.sessions.get('ses_sibling_instance_old')?.removed).toBe(false)
  })

  test('pages through the session list', async () => {
    const now = Date.now()
    const many = Array.from({ length: 130 }, (_, index) => ({
      id: `ses_dead_${String(index).padStart(3, '0')}`,
      time: { created: now, updated: now },
      metadata: { mexploreChild: true, ownerPid: 999_999, createdAt: now },
    }))
    const { host } = await fixture({ models: ANTHROPIC, existing: many })
    expect(host.calls.list).toBeGreaterThan(1)
    expect(host.calls.remove).toHaveLength(130)
  })
})

// ---------------------------------------------------------------- command

describe('/mexplore command (REQ-021)', () => {
  const stored = { model: 'anthropic/claude-sonnet-5', mexploreModel: 'deepseek-v4-pro', baseURL: 'https://proxy.example.com/v1' }

  test('status shows the model, its source, the base URL, the key and the graph root', async () => {
    const { host, root } = await fixture({ models: ANTHROPIC, keyConnected: false, storage: stored })
    const text = await host.command(PARENT, '/mexplore status')
    expect(text).toContain('anthropic/claude-sonnet-5')
    expect(text).toContain('source: selected')
    expect(text).toContain('https://proxy.example.com/v1 (custom)')
    expect(text).toContain('key: missing')
    expect(text).toContain(root)
    expect(host.replies[0]?.sessionID).toBe(PARENT)
  })

  test('a bare command is status', async () => {
    const { host, root } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore')
    expect(text).toContain('mexplore memory')
    expect(text).toContain('key: connected')
    expect(text).toContain(root)
    expect(text).toContain('mexplore/deepseek-v4.1-flash-1017')
  })

  test('model <provider/model> is validated, stored as model, and reloads the provider (AC-021)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore model anthropic/claude-sonnet-5')
    expect(text).toContain('Memory model set to anthropic/claude-sonnet-5')
    expect(host.storage.get('model')).toBe('anthropic/claude-sonnet-5')
    expect(host.calls.reload).toBe(1)
    expect(plugin.settings.model).toBe('anthropic/claude-sonnet-5')
    const status = await host.command(PARENT, '/mexplore status')
    expect(status).toContain('source: selected')
  })

  test('an unknown or non-tool-capable provider/model is refused and nothing is stored (AC-021)', async () => {
    const { host } = await fixture({
      models: [
        ...ANTHROPIC,
        { providerID: 'openai', id: 'no-tools', capabilities: { tools: false, input: ['text'], output: ['text'] } },
        { providerID: 'openai', id: 'disabled', enabled: false },
      ],
      keyConnected: true,
    })
    for (const [argument, expected] of [
      ['anthropic/does-not-exist', 'not available'],
      ['openai/no-tools', 'cannot call tools'],
      ['openai/disabled', 'disabled'],
    ] as const) {
      const text = await host.command(PARENT, `/mexplore model ${argument}`)
      expect(text).toContain('Refused')
      expect(text).toContain(expected)
      expect(host.storage.has('model')).toBe(false)
    }
    expect(host.calls.reload).toBe(0)
  })

  test('a bare model id is stored as mexploreModel, clears model, and reloads (AC-024)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, storage: { model: 'anthropic/claude-sonnet-5', baseURL: CUSTOM_PROVIDER_SETTINGS.baseURL } })
    const text = await host.command(PARENT, '/mexplore model deepseek-v4-pro')
    expect(text).toContain('mexplore/deepseek-v4-pro')
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-pro')
    expect(host.storage.has('model')).toBe(false)
    expect(host.calls.reload).toBe(1)
    const added = host.providerAdditions.at(-1)
    expect(added?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro'])
  })

  test('base-url accepts https and loopback http, and refuses anything else (AC-024)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const ok = await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')
    expect(ok).toContain('set to https://proxy.example.com/v1')
    expect(host.storage.get('baseURL')).toBe('https://proxy.example.com/v1')
    const local = await host.command(PARENT, '/mexplore base-url http://127.0.0.1:8080/v1')
    expect(local).toContain('set to http://127.0.0.1:8080/v1')
    for (const bad of ['ftp://x', 'http://example.com', 'not a url']) {
      const text = await host.command(PARENT, `/mexplore base-url ${bad}`)
      expect(text).toContain('Refused')
    }
    expect(host.storage.get('baseURL')).toBe('http://127.0.0.1:8080/v1')
    expect(baseURLProblem('https://a/b')).toBeUndefined()
    expect(baseURLProblem('http://localhost:1')).toBeUndefined()
    expect(baseURLProblem('http://[::1]:1')).toBeUndefined()
    expect(baseURLProblem('http://192.168.1.2')).toBeDefined()
  })

  test('a base-url change reaches the next provider transform', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')
    expect((host.providerAdditions.at(-1)?.info.settings as { baseURL: string }).baseURL).toBe('https://proxy.example.com/v1')
  })

  test('key never accepts an argument and never echoes one (AC-025)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const secret = 'sk-super-secret-key-value'
    const plain = await host.command(PARENT, '/mexplore key')
    expect(plain).toContain('/connect')
    expect(plain).toContain('opencode auth logout mexplore')

    const refused = await host.command(PARENT, `/mexplore key ${secret}`)
    expect(refused).toContain('Refused')
    expect(refused).toContain('/connect')
    for (const text of [plain, refused]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain('sk-')
    }
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
    // And no reply, log line or storage entry ever carried it.
    expect(JSON.stringify(host.replies)).not.toContain(secret)
  })

  test('test reports OK and the latency (AC-026)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('OK')
    expect(text).toContain('ms')
    expect(host.calls.generate).toHaveLength(1)
    expect((host.calls.generate[0] as { model: unknown }).model).toEqual({
      providerID: 'mexplore',
      id: 'deepseek-v4.1-flash-1017',
    })
    // No child was created for a test.
    expect(host.calls.create).toHaveLength(0)
  })

  test('test reports the provider error, with any credential scrubbed (AC-025, AC-026)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const secret = 'sk-live-abcdef1234567890'
    host.generateError = new Error(`401 unauthorized: Incorrect API key provided: ${secret}`)
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('FAILED')
    expect(text).toContain('401 unauthorized')
    expect(text).not.toContain(secret)
    expect(text).toContain('sk-***')
    // A synthetic reply is persisted, so this string must stay clean.
    expect(JSON.stringify(host.replies)).not.toContain(secret)
  })

  test('test uses the parent-fallback model when that is what calls would run (REQ-021)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: false })
    await host.trigger('context', {
      sessionID: PARENT,
      model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
      tools: ['mexplore'],
    })
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('OK')
    expect((host.calls.generate[0] as { model: unknown }).model).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-5',
    })
  })

  test('test reports the provider error (AC-026)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.generateError = new Error('401 unauthorized')
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('FAILED')
    expect(text).toContain('401 unauthorized')
  })

  test('test refuses when no model is known at all', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: false })
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('Cannot test')
    expect(host.calls.generate).toHaveLength(0)
  })

  test('a change is visible to the transform REPLAYED on reload, not just the first run (AC-024)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    // The captured settings object the transform closes over is the same one the
    // command mutates: if the plugin replaced it, the replay would still serve
    // the old value and no restart would appear to help.
    const before = plugin.settings
    await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')
    await host.command(PARENT, '/mexplore model deepseek-v4-pro')
    expect(plugin.settings).toBe(before)

    // Simulate the host replaying the transform from scratch (a real reload).
    host.providerAdditions = []
    await host.ctx.provider.reload()
    const replayed = host.providerAdditions.at(-1)
    expect((replayed?.info.settings as { baseURL: string }).baseURL).toBe('https://proxy.example.com/v1')
    expect(replayed?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro'])

    // And the next call resolves through the new settings.
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as { metadata: Record<string, unknown> }
    expect(result.metadata.model).toBe('mexplore/deepseek-v4-pro')
    expect((host.calls.create.at(-1) as { model: { id: string } }).model.id).toBe('deepseek-v4-pro')
  })

  test('commands are serialized, so two overlapping writes cannot finish out of order', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    // Make the FIRST command slow, so it would finish LAST were it not queued.
    const original = host.ctx.storage.set
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let stalled = false
    Object.assign(host.ctx.storage, {
      set: async (key: string, value: unknown) => {
        if (key === 'mexploreModel' && !stalled) {
          stalled = true
          await held
        }
        return original(key, value)
      },
    })

    const first = host.command(PARENT, '/mexplore model deepseek-v4-pro')
    await Bun.sleep(5)
    const second = host.command(PARENT, '/mexplore model deepseek-v4-flash')
    // The second waits its turn; nothing is stored until the first finishes.
    await Bun.sleep(10)
    expect(host.storage.get('mexploreModel')).toBe(CUSTOM_PROVIDER_SETTINGS.mexploreModel)
    release()
    await Promise.all([first, second])
    Object.assign(host.ctx.storage, { set: original })

    // Last writer wins, in storage AND in the live object the transform reads.
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-flash')
    expect(plugin.settings.mexploreModel).toBe('deepseek-v4-flash')
    host.providerAdditions = []
    await host.ctx.provider.reload()
    expect(host.providerAdditions.at(-1)?.models.map((model) => model.id)).toContain('deepseek-v4-flash')
  })

  test('a key pasted as an argument is refused, never stored and never echoed (AC-025)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const secret = 'sk-live-0123456789abcdefghij'
    for (const command of [`/mexplore model ${secret}`, `/mexplore base-url ${secret}`]) {
      const text = await host.command(PARENT, command)
      expect(text).not.toContain(secret)
    }
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
    expect(JSON.stringify(host.replies)).not.toContain(secret)
    // A real model id still works.
    expect(await host.command(PARENT, '/mexplore model deepseek-v4-pro')).toContain('deepseek-v4-pro')
  })

  test('a base-url change applies to the NEXT call while a running call keeps its own (AC-024)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const childIDs: string[] = []
    // Captured INSIDE the call: a child is removed by its own teardown, so its
    // endpoint must be read while it still exists.
    const endpointsDuringCall: Array<string | undefined> = []
    host.script = async (child) => {
      childIDs.push(child.info.id)
      endpointsDuringCall.push(plugin.registry.endpointFor(child.info.id))
      if (childIDs.length === 1) {
        await held
        child.messages.push(assistant('slow done'))
        return
      }
      child.messages.push(assistant('next done'))
    }

    const slow = host.executeTool('mexplore', { message: 'slow' }, PARENT)
    for (let i = 0; i < 200 && childIDs.length === 0; i += 1) await Bun.sleep(1)
    const firstChild = childIDs[0] as string
    expect(plugin.registry.endpointFor(firstChild)).toBe('https://memory.example.com/v1')

    const reply = await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')
    expect(reply).toContain('proxy.example.com')
    // Applied IMMEDIATELY: the provider serves the new URL while the old call runs.
    expect((host.providerAdditions.at(-1)?.info.settings as { baseURL: string }).baseURL).toBe(
      'https://proxy.example.com/v1',
    )

    // The next call starts on the NEW endpoint, even though the first is running.
    await host.executeTool('mexplore', { message: 'next' }, PARENT)
    const nextChild = childIDs[1] as string
    expect(endpointsDuringCall).toEqual([
      'https://memory.example.com/v1',
      'https://proxy.example.com/v1',
    ])

    expect(nextChild).toBeDefined()
    release()
    await slow
  })

  test('reset clears all three keys and keeps any key connection (AC-027)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, storage: stored })
    const text = await host.command(PARENT, '/mexplore reset')
    expect(text).toContain('inherit the current OpenCode session model')
    expect(host.storage.has('model')).toBe(false)
    expect(host.storage.has('mexploreModel')).toBe(false)
    expect(host.storage.has('baseURL')).toBe(false)
    expect(plugin.settings).toEqual({})
    expect(host.calls.reload).toBe(1)
    // No custom route remains after reset, and the key is untouched.
    const added = host.providerAdditions.at(-1)
    expect(added?.info.activation).toBe('disabled')
    expect(added?.info.settings).toEqual({})
    expect(added?.models).toEqual([])
  })

  test('an unknown subcommand shows the usage and changes nothing', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore-settings nonsense')
    expect(text).toContain('Unknown')
    // The server command names ITSELF in help: `/mexplore-settings`, not the
    // TUI-only `/mexplore`.
    expect(text).toContain('/mexplore-settings model')
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
  })
})

// ------------------------------------------------------ provider & setup

describe('memory provider and integration (REQ-021)', () => {
  test('the integration registers one key method and a name', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    expect(host.integrationMethods).toEqual([
      { integrationID: 'mexplore', method: { type: 'key', label: 'mexplore memory API key' } },
    ])
  })

  test('the provider is enabled, openai-compatible, bound to the integration, with one active (listed) model', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const added = host.providerAdditions.at(-1)
    expect(added?.info).toMatchObject({
      id: 'mexplore',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      integrationID: 'mexplore',
      settings: { baseURL: 'https://memory.example.com/v1' },
    })
    expect(added?.models).toHaveLength(1)
    expect(added?.models[0]).toMatchObject({
      id: 'deepseek-v4.1-flash-1017',
      providerID: 'mexplore',
      status: 'active',
      enabled: true,
      limit: { context: 1_000_000 },
      capabilities: { tools: true },
    })
  })

  test('stored values are used for the transform, loaded before it runs', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: true,
      storage: { mexploreModel: 'deepseek-v4-pro', baseURL: 'https://proxy.example.com/v1' },
    })
    const added = host.providerAdditions.at(-1)
    expect((added?.info.settings as { baseURL: string }).baseURL).toBe('https://proxy.example.com/v1')
    expect(added?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro'])
  })
})

describe('graph root resolution (REQ-016, AC-011)', () => {
  test('the option wins, with source "option"', async () => {
    const root = await tempRoot()
    try {
      const { plugin } = await withEnv({ MEXPLORE_GRAPH_ROOT: '/tmp/from-env' }, () =>
        makeFixture({ models: ANTHROPIC, graphRoot: root }),
      )
      expect(plugin.graphRoot).toEqual({ path: root, source: 'option' })
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  test('the env var wins when there is no option, with source "env"', async () => {
    const root = await tempRoot()
    const fixtureUnderEnv = await withEnv({ MEXPLORE_GRAPH_ROOT: root, XDG_DATA_HOME: undefined }, () =>
      makeFixture({ models: ANTHROPIC, graphRoot: null }),
    )
    try {
      expect(fixtureUnderEnv.plugin.graphRoot).toEqual({ path: root, source: 'env' })
    } finally {
      await fixtureUnderEnv.dispose()
    }
  })

  test('otherwise the XDG data home is used, with source "default"', async () => {
    const dataHome = await tempRoot('mexplore-xdg-')
    const built = await withEnv({ MEXPLORE_GRAPH_ROOT: undefined, XDG_DATA_HOME: dataHome }, () =>
      makeFixture({ models: ANTHROPIC, graphRoot: null }),
    )
    try {
      expect(built.plugin.graphRoot).toEqual({
        path: path.join(dataHome, 'mexplore', 'graph'),
        source: 'default',
      })
    } finally {
      await built.dispose()
      await fsp.rm(dataHome, { recursive: true, force: true })
    }
  })

  test('a relative XDG_DATA_HOME is ignored, per the XDG spec', () => {
    // Pure resolution: nothing is created, so the machine's real home is never touched.
    const resolved = resolveGraphRoot({}, { XDG_DATA_HOME: 'relative/data' })
    expect(resolved).toEqual({
      path: path.join(os.homedir(), '.local', 'share', 'mexplore', 'graph'),
      source: 'default',
    })
  })

  test('~ is expanded against the real home and the path is absolute', () => {
    expect(resolveGraphRoot({ graphRoot: '~/tilde-graph' }, {})).toEqual({
      path: path.join(os.homedir(), 'tilde-graph'),
      source: 'option',
    })
    expect(resolveGraphRoot({ graphRoot: '~' }, {}).path).toBe(os.homedir())
  })

  test('a relative option path and a relative env path are made absolute', () => {
    const fromOption = resolveGraphRoot({ graphRoot: 'relative/graph' }, {})
    expect(fromOption).toEqual({ path: path.resolve('relative/graph'), source: 'option' })
    const fromEnv = resolveGraphRoot({}, { MEXPLORE_GRAPH_ROOT: 'relative/env-graph' })
    expect(fromEnv).toEqual({ path: path.resolve('relative/env-graph'), source: 'env' })
  })

  test('blank options and env values are ignored, so the next source wins', () => {
    expect(resolveGraphRoot({ graphRoot: '   ' }, { MEXPLORE_GRAPH_ROOT: '/tmp/from-env' })).toEqual({
      path: '/tmp/from-env',
      source: 'env',
    })
    expect(resolveGraphRoot({}, { MEXPLORE_GRAPH_ROOT: '  ', XDG_DATA_HOME: '/tmp/xdg' })).toEqual({
      path: '/tmp/xdg/mexplore/graph',
      source: 'default',
    })
  })

  test('metadata carries the resolved root and its source on every result (AC-001)', async () => {
    const root = await tempRoot()
    try {
      const { host } = await makeFixture({ models: ANTHROPIC, keyConnected: true, graphRoot: root })
      const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
        metadata: Record<string, unknown>
      }
      expect(result.metadata).toMatchObject({ graphRoot: root, graphRootSource: 'option' })
      await host.sessions.clear()
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})

describe('setup diagnostics (REQ-014, AC-009)', () => {
  test('an unwritable graph root yields one actionable error naming path, source and fix', async () => {
    const parent = await tempRoot('mexplore-unwritable-')
    const blocked = path.join(parent, 'file')
    await fsp.writeFile(blocked, 'not a directory')
    const root = path.join(blocked, 'graph')
    try {
      const { host } = await makeFixture({ models: ANTHROPIC, keyConnected: true, graphRoot: root })
      const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
      expect(error.message).toContain(root)
      expect(error.message).toContain('graphRoot')
      expect(error.message).toContain('Fix:')
      // One error, and no child was started.
      expect(host.calls.create).toHaveLength(0)
    } finally {
      await fsp.rm(parent, { recursive: true, force: true })
    }
  })

  test('a stored model that disappeared yields an actionable error and no child', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, storage: { model: 'gone/model-1' } })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('gone/model-1')
    // Fix text names the SERVER command, which exists in every client.
    expect(error.message).toContain('/mexplore-settings model')
    expect(host.calls.create).toHaveLength(0)
  })

  test('a stored model that lost tool support is refused', async () => {
    const { host } = await fixture({
      models: [{ providerID: 'x', id: 'y', capabilities: { tools: false, input: ['text'], output: ['text'] } }],
      keyConnected: true,
      storage: { model: 'x/y' },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('cannot call tools')
  })

  test('a malformed stored base URL is reported', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, storage: { baseURL: 'ftp://x' } })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('ftp://x')
    expect(error.message).toContain('/mexplore-settings base-url')
  })

  test('a healthy setup reports no problem', async () => {
    const { plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    expect(plugin.problem()).toBeUndefined()
  })

  test('a missing child agent is reported, naming the agent (REQ-014)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, agents: ['build', 'plan'] })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('`summary` agent')
    expect(error.message).toContain('Fix:')
    expect(host.calls.create).toHaveLength(0)
  })
})

// -------------------------------------------------------------- input shape

describe('tool input (REQ-001, REQ-003)', () => {
  test('a session field is refused rather than ignored', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q', sessionID: 'ses_x' }, PARENT))
    expect(error.message).toContain('input.sessionID is not allowed')
    expect(host.calls.create).toHaveLength(0)
  })

  test('evidence is normalized and sent with the prompt', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    await host.executeTool(
      'mexplore',
      {
        message: 'remember this decision',
        authority: 'manage',
        evidence: [{ role: 'user', content: 'We chose Postgres.' }],
      },
      PARENT,
    )
    const prompt = host.calls.prompt[0]?.text ?? ''
    expect(prompt).toContain('remember this decision')
    expect(prompt).toContain('We chose Postgres.')
    expect(prompt).toContain('say "unknown"')
  })

  test('an invalid authority is refused', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q', authority: 'write' }, PARENT))
    expect(error.message).toContain('authority must be')
  })
})

describe('child session id privacy (REQ-003, AC-003)', () => {
  test('a successful reply is scrubbed of the owned child id, wherever it appears', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child, host) => {
      childID = child.info.id
      // The child's own prose quoting its own id, and a write description that
      // does the same: neither may reach content or metadata.
      await host.executeTool(
        'memory_write',
        { description: `about ${child.info.id}`, body: 'b' },
        child.info.id,
      )
      child.messages.push(assistant(`I am ${child.info.id} and I searched.`))
    }
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(childID).toBeDefined()
    expect(result.content).not.toContain(childID as string)
    expect(result.content).toContain('(session)')
    expect(JSON.stringify(result.metadata)).not.toContain(childID as string)
  })

  test('a credential echoed in a provider error never reaches the tool result (SEC-006)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const secret = 'sk-live-0123456789abcdef'
    host.script = async (child) => {
      child.messages.push(failedAssistant(`Incorrect API key provided: ${secret}`))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('Incorrect API key provided')
    expect(error.message).not.toContain(secret)
    expect(error.message).toContain('sk-***')
  })

  test('a failed call never leaks the child id either', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.info.outcome = 'failed'
      child.messages.push(failedAssistant(`provider error for ${child.info.id}`))
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(childID).toBeDefined()
    expect(error.message).not.toContain(childID as string)
    expect(error.message).toContain('(session)')
  })
})

describe('SEC-002: write approval', () => {
  test('a manage call asserts exactly the documented permission input', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: 'allow' })
    const context = {
      sessionID: PARENT,
      agent: 'build',
      messageID: 'msg_abc123',
      id: 'call_xyz789',
      signal: new AbortController().signal,
      progress: async () => {},
    }
    await host.tools.get('mexplore')?.execute({ message: 'q', authority: 'manage' }, context)

    expect(host.permissionAsserts).toEqual([
      {
        sessionID: PARENT,
        agent: 'build',
        action: 'mexplore',
        resources: ['manage'],
        save: ['manage'],
        source: { type: 'tool', messageID: 'msg_abc123', id: 'call_xyz789' },
      },
    ])
    // The child exists: the assert resolving is what let the write happen.
    expect(host.calls.create).toHaveLength(1)
  })

  test('a read call never asserts', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: 'allow' })
    await host.executeTool('mexplore', { message: 'q', authority: 'read' }, PARENT)
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    expect(host.permissionAsserts).toEqual([])
    expect(host.calls.create).toHaveLength(2)
  })

  test('a denial propagates and creates no child (AC-012)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: 'deny' })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT))

    // The host's own decline reaches the model, unwrapped by any plugin message.
    expect(error.message).toContain('Permission declined by the user')
    expect((error as { error?: { _tag?: string } }).error?._tag).toBe('Permission.DeclinedError')
    // Nothing ran: no child, no graph call, nothing owned.
    expect(host.calls.create).toHaveLength(0)
    expect(host.calls.prompt).toHaveLength(0)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a host without a permission API proceeds without one (never fail closed)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: false })
    expect((host.ctx as { permission?: unknown }).permission).toBeUndefined()
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
    }
    expect(result.content).toContain('no writes')
    expect(host.calls.create).toHaveLength(1)
  })

  test('the child itself carries no ask rule, whatever the user configured (REQ-008)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: 'allow' })
    await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)
    const created = host.calls.create[0] as { permissions: Array<{ effect: string }> }
    expect(created.permissions.every((rule) => rule.effect !== 'ask')).toBe(true)
  })

  test('the assert runs before the child is created', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, permission: 'allow' })
    const order: string[] = []
    const originalCreate = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof originalCreate>[0]) => {
        order.push('create')
        return originalCreate(input)
      },
    })
    const originalAssert = host.ctx.permission?.assert
    Object.assign(host.ctx.permission as object, {
      assert: async (input: unknown) => {
        order.push('assert')
        return originalAssert?.(input as never)
      },
    })
    await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)
    expect(order).toEqual(['assert', 'create'])
  })
})

// ------------------------------------------------------------------ redaction

describe('redaction (REQ-003, AC-025, SEC-006)', () => {
  /** Every value here is a credential shape a provider or host error really uses. */
  const SECRETS = [
    'sk-live-abcdef123456',
    'sk-proj-AbC123dEf456GhI789',
    'pk-test-0123456789abcdef',
    '0123456789abcdef0123456789abcdef',
    '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi',
  ]

  test('credential shapes are masked wherever a provider error puts them', () => {
    for (const secret of SECRETS) {
      for (const template of [
        `Incorrect API key provided: ${secret}`,
        `authorization: Bearer ${secret}`,
        `failed with api_key=${secret}`,
        `https://host/v1?api_key=${secret}`,
        `request failed with key: ${secret}`,
      ]) {
        expect(redact(template)).not.toContain(secret)
      }
    }
    // …and a bare `key "…"` / `token: …` label is covered too.
    expect(redact('token: abcdef1234567890abcdef')).not.toContain('abcdef1234567890abcdef')
  })

  test('identifiers the caller needs survive untouched', () => {
    // A broad "long opaque token" rule would eat all of these; each is real
    // content a footer, an error or a status reply legitimately carries.
    for (const keep of [
      '01J00000000000000000000011',
      '/var/folders/aa/synthetic_profile_00000000000000/T/mexplore-plugin-abc123',
      'openrouter/meta-llama/llama-3.3-70b-instruct',
      'mexplore/deepseek-v4.1-flash-1017',
      'https://memory.example.com/v1',
    ]) {
      expect(redact(`refused ${keep} — see the message`)).toContain(keep)
    }
  })

  test('a quoted model id is not mistaken for a credential', () => {
    const text = 'Refused: "openrouter/meta-llama/llama-3.3-70b-instruct" is not available'
    expect(redact(text)).toContain('openrouter/meta-llama/llama-3.3-70b-instruct')
  })

  test('session ids go, including the specific owned one', () => {
    expect(redact('error for ses_abc123DEF456')).toContain('(session)')
    expect(redact('error for mysession01', 'mysession01')).not.toContain('mysession01')
  })
})

describe('hardening from review (SEC-006, REQ-004, AC-021, AC-024)', () => {
  test('a credential-carrying base URL is refused, not stored (SEC-006)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    for (const url of [
      'https://example.com/v1?api_key=sk-live-123456789abcdef',
      'https://user:pass@example.com/v1',
      'https://example.com/v1?token=abcdef',
    ]) {
      const text = await host.command(PARENT, `/mexplore base-url ${url}`)
      expect(text).toContain('Refused')
      expect(text).toContain('credential')
    }
    expect(host.storage.get('baseURL')).toBe(CUSTOM_PROVIDER_SETTINGS.baseURL)
    // A plain URL still works.
    expect(await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')).toContain('set to')
  })

  test('a long but real model id is accepted (AC-021)', async () => {
    const longId = 'meta-llama/llama-3.3-70b-instruct'
    const { host } = await fixture({
      models: [...ANTHROPIC, { providerID: 'openrouter', id: longId }],
      keyConnected: true,
    })
    const text = await host.command(PARENT, `/mexplore model openrouter/${longId}`)
    expect(text).toContain(`openrouter/${longId}`)
    expect(text).not.toContain('credential')
    expect(host.storage.get('model')).toBe(`openrouter/${longId}`)
  })

  test('"session table not found" is a real failure, not a removal (REQ-004)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    Object.assign(host.ctx.session, {
      remove: async () => {
        throw new Error('session table not found')
      },
    })
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    // The transcript is still there, so ownership (and the model lease) must stay.
    expect(plugin.registry.ownedSessionIDs()).toEqual([childID as string])
    expect(plugin.leases.size()).toBe(1)
  })

  test('a removal that succeeds after its deadline still releases the child (AC-024)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    const original = host.ctx.session.remove
    Object.assign(host.ctx.session, {
      remove: async (input: { sessionID: string }) => {
        await held
        return original(input)
      },
    })
    // A budget of 0 ms: the deadline always wins, then the real removal lands.
    await plugin.registry.remove(childID ?? 'none', 0)
    release()
    await Bun.sleep(10)
    Object.assign(host.ctx.session, { remove: original })
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    expect(plugin.leases.size()).toBe(0)
  })

  test('a failed lease publication releases the lease and reports it (REQ-021)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const original = host.ctx.provider.reload
    Object.assign(host.ctx.provider, {
      reload: async () => {
        throw new Error('registry unavailable')
      },
    })
    // The child-creation path calls reload to publish the lease.
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.provider, { reload: original })
    expect(error.message).toContain('could not register the memory model')
    expect(plugin.leases.size()).toBe(0)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('/mexplore test falls back to ctx.generate on OpenCode before 2.2 (no experimental.generate)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const ctx = host.ctx as unknown as Record<string, unknown>
    const legacyCalls: unknown[] = []
    ctx.experimental = {}
    ctx.generate = {
      text: async (input: unknown) => {
        legacyCalls.push(input)
        return { text: 'ok' }
      },
    }
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('OK')
    expect(legacyCalls).toHaveLength(1)
    expect(text).not.toContain('undefined is not an object')
  })

  test('/mexplore test says so when the host has no generate API at all', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const ctx = host.ctx as unknown as Record<string, unknown>
    delete ctx.experimental
    delete ctx.generate
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('Cannot test')
    expect(text).toContain('Update OpenCode')
  })

  test('/mexplore test is bounded, so a hung provider cannot lock the queue (REQ-021)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    // A generate that never resolves. The bound lives in command.ts; wiring the
    // real 30 s wait here would make the suite slow, so this asserts the shape:
    // the command still RETURNS (with a failure) rather than hanging forever,
    // once the provider's promise is released.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.assign(host.ctx.experimental!.generate!, {
      text: async () => {
        await held
        throw new Error('provider went away')
      },
    })
    const testing = host.command(PARENT, '/mexplore test')
    await Bun.sleep(5)
    release()
    const text = await testing
    expect(text).toContain('FAILED')
    expect(text).toContain('provider went away')
    // The queue is free afterwards: a corrective command runs immediately.
    expect(await host.command(PARENT, '/mexplore base-url https://proxy.example.com/v1')).toContain('set to')
  })
})

// -------------------------------------------------- shared command + RPC (TUI)

describe('shared command function and RPC (REQ-021, TUI part)', () => {
  test('runCommandText returns the same text the server command posts', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const posted = await host.command(PARENT, '/mexplore status')
    const direct = await runCommandText(
      {
        ctx: host.ctx,
        reply: async () => {},
        graphRoot: plugin.graphRoot,
        settings: plugin.settings,
        reloadProvider: () => host.ctx.provider.reload(),
        diagnostic: async () => undefined,
        parentModel: () => undefined,
        // No real state dir: this hand-built deps object must name the same one
        // the fixture's plugin used, or `status` prints a different path.
        usageDir: (plugin as unknown as { usageDir: string }).usageDir,
      },
      { sessionID: PARENT, text: 'status' },
    )
    expect(direct).toBe(posted)
  })

  test('runCommandText tolerates a leading /mexplore and an empty argument list', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const deps = {
      ctx: host.ctx,
      reply: async () => {},
      graphRoot: plugin.graphRoot,
      settings: plugin.settings,
      reloadProvider: () => host.ctx.provider.reload(),
      diagnostic: async () => undefined,
      parentModel: () => undefined,
    }
    for (const text of ['', '   ', '/mexplore', '/mexplore status']) {
      expect(await runCommandText(deps, { sessionID: PARENT, text })).toContain('mexplore memory')
    }
  })

  test('the RPC is registered under the shared definition', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    expect(host.rpcDefinitions.map((definition) => definition.id)).toEqual([MexploreRpc.id])
    expect(Object.keys(host.rpcDefinitions[0]?.methods ?? {})).toEqual(['command'])
  })

  test('the RPC runs one subcommand and returns its text', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.callRpc(MexploreRpc.id, 'command', { args: 'model deepseek-v4-pro' })) as {
      text: string
    }
    expect(result.text).toContain('mexplore/deepseek-v4-pro')
    // The change really landed: the RPC is not a read-only echo.
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-pro')
    expect(host.calls.reload).toBeGreaterThan(0)
  })

  test('the RPC and the server command share the serialized writer queue', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const original = host.ctx.storage.set
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let stalled = false
    Object.assign(host.ctx.storage, {
      set: async (key: string, value: unknown) => {
        if (key === 'mexploreModel' && !stalled) {
          stalled = true
          await held
        }
        return original(key, value)
      },
    })
    const viaRpc = host.callRpc(MexploreRpc.id, 'command', { args: 'model deepseek-v4-pro' })
    await Bun.sleep(5)
    const viaServer = host.command(PARENT, '/mexplore model deepseek-v4-flash')
    await Bun.sleep(5)
    // The server command waits its turn behind the RPC.
    expect(host.storage.get('mexploreModel')).toBe(CUSTOM_PROVIDER_SETTINGS.mexploreModel)
    release()
    await Promise.all([viaRpc, viaServer])
    Object.assign(host.ctx.storage, { set: original })
    // Last writer wins, in storage and in the object the provider transform reads.
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-flash')
  })

  test('/mexplore key over RPC only explains /connect and stores nothing', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.callRpc(MexploreRpc.id, 'command', { args: 'key' })) as { text: string }
    expect(result.text).toContain('/connect')
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
    // A key pasted as an argument is refused, never echoed.
    const secret = 'sk-live-0123456789abcdefghij'
    const refused = (await host.callRpc(MexploreRpc.id, 'command', { args: `model ${secret}` })) as { text: string }
    expect(refused.text).not.toContain(secret)
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
  })

  test('an unknown subcommand still answers with the usage text over RPC', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.callRpc(MexploreRpc.id, 'command', { args: 'nonsense' })) as { text: string }
    expect(result.text).toContain('Unknown')
    expect(result.text).toContain('/mexplore model')
  })
})

describe('the TUI part (REQ-021)', () => {
  test('is a thin defined plugin with a stable id', () => {
    expect(tuiPlugin.id).toBe('mexplore.tui')
    expect(typeof tuiPlugin.setup).toBe('function')
  })

  test('registers one global slash command named mexplore that takes arguments', async () => {
    const layers: Array<() => unknown> = []
    const context = {
      keymap: {
        layer: (factory: () => unknown) => {
          layers.push(factory)
        },
      },
      client: { rpc: () => ({}) },
      ui: { dialog: { alert: async () => {} } },
    }
    await tuiPlugin.setup(context as never)
    expect(layers).toHaveLength(1)
    const layer = layers[0]?.() as {
      mode: string
      commands: Array<{ id: string; slash?: { name: string; arguments?: boolean }; run: unknown }>
    }
    expect(layer.mode).toBe('global')
    expect(layer.commands).toHaveLength(1)
    // Same name as the server command: the TUI's keymap gets first refusal, so
    // this one shadows it here and nowhere else.
    expect(layer.commands[0]?.slash).toEqual({ name: 'mexplore', arguments: true })
    expect(typeof layer.commands[0]?.run).toBe('function')
  })

  test('shows the RPC text in a dialog, with the latest session id', async () => {
    const calls: Array<{ args: string; sessionID?: string }> = []
    const alerts: Array<{ title: string; message: string }> = []
    const context = {
      client: {
        rpc: () => ({
          command: async (input: { args: string; sessionID?: string }) => {
            calls.push(input)
            return { text: `reply for ${input.args}` }
          },
        }),
      },
      data: { session: { list: () => [{ id: 'ses_old', time: { updated: 1 } }, { id: 'ses_new', time: { updated: 9 } }] } },
      ui: {
        // The route on screen wins over "most recently updated" (Minor 11).
        router: { current: () => ({ type: 'session', sessionID: 'ses_open' }) },
        dialog: { alert: async (options: { title: string; message: string }) => { alerts.push(options) } },
      },
    }
    await showReply(context as never, 'model deepseek-v4-pro')
    expect(calls).toEqual([{ args: 'model deepseek-v4-pro', sessionID: 'ses_open' }])
    expect(alerts).toEqual([{ title: 'mexplore', message: 'reply for model deepseek-v4-pro' }])
  })

  test('the route on screen wins over the most recently updated session (Minor 11)', async () => {
    const calls: Array<{ args: string; sessionID?: string }> = []
    const context = {
      client: {
        rpc: () => ({
          command: async (input: { args: string; sessionID?: string }) => {
            calls.push(input)
            return { text: 'ok' }
          },
        }),
      },
      // A busy background session would win a "most recently updated" rule.
      data: { session: { list: () => [{ id: 'ses_background', time: { updated: 999 } }] } },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_foreground' }) } },
    }
    expect(await replyText(context as never, 'status')).toBe('ok')
    expect(calls).toEqual([{ args: 'status', sessionID: 'ses_foreground' }])
  })

  test('falls back to the newest session on a non-session route', async () => {
    const calls: Array<{ args: string; sessionID?: string }> = []
    const context = {
      client: {
        rpc: () => ({
          command: async (input: { args: string; sessionID?: string }) => {
            calls.push(input)
            return { text: 'ok' }
          },
        }),
      },
      data: { session: { list: () => [{ id: 'ses_only', time: { updated: 5 } }] } },
      ui: { router: { current: () => ({ type: 'home' }) } },
    }
    expect(await replyText(context as never, 'status')).toBe('ok')
    expect(calls).toEqual([{ args: 'status', sessionID: 'ses_only' }])
  })

  test('works from the home screen, where there is no session', async () => {
    const calls: Array<{ args: string; sessionID?: string }> = []
    const context = {
      client: {
        rpc: () => ({
          command: async (input: { args: string; sessionID?: string }) => {
            calls.push(input)
            return { text: 'ok' }
          },
        }),
      },
      data: { session: { list: () => [] } },
      ui: { dialog: { alert: async () => {} } },
    }
    await showReply(context as never, '')
    expect(calls).toEqual([{ args: '' }])
  })

  test('an unreachable server answers categorically, never with raw error text (Minor 11)', async () => {
    const secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz123456'
    const context = {
      client: {
        rpc: () => ({
          command: async () => {
            throw new Error(`connect ECONNREFUSED 127.0.0.1:4096 (key ${secret})`)
          },
        }),
      },
      ui: { dialog: { alert: async () => {} } },
    }
    const text = await replyText(context as never, 'status')
    expect(text).toContain("didn't answer")
    expect(text).toContain('use `/mexplore` in a new message')
    // Categorical only: no raw transport text, and no credential.
    expect(text).not.toContain(secret)
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('4096')
    expect(text).not.toContain('    at ')
  })

  test('a timeout is reported as a timeout, still without raw text', async () => {
    const context = {
      client: {
        rpc: () => ({
          command: async () => {
            throw new Error('request timed out after 30000ms to https://proxy.example/v1?api_key=sk-live-abc123')
          },
        }),
      },
      ui: { dialog: { alert: async () => {} } },
    }
    const text = await replyText(context as never, 'status')
    expect(text).toContain('timed out')
    expect(text).not.toContain('proxy.example')
    expect(text).not.toContain('sk-live-abc123')
  })

  test('end to end: the TUI text equals what the server command replies', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    // Stand in for `context.client.rpc(...)`: the real TUI would reach the same
    // handler over HTTP, which is what the harness's RPC check covers.
    const context = {
      client: {
        rpc: () => ({
          command: async (input: { args: string; sessionID?: string }) =>
            (await host.callRpc(MexploreRpc.id, 'command', input)) as { text: string },
        }),
      },
      ui: { dialog: { alert: async () => {} } },
    }
    const status = await replyText(context as never, 'status')
    expect(status).toContain('mexplore memory')
    expect(status).toContain('key: connected')

    const set = await replyText(context as never, 'base-url https://proxy.example.com/v1')
    expect(set).toContain('proxy.example.com')
    expect(host.storage.get('baseURL')).toBe('https://proxy.example.com/v1')
  })
})

// ------------------------------------------------- review round: Major 2, 3

describe('credential redaction of every transport (Major 2, Major 3)', () => {
  const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz123456'

  /** A provider error that quotes the key verbatim — the shape rules miss it. */
  function providerErrorEchoing(key: string): Error {
    return new Error(`Invalid API key '${key}'`)
  }

  test('the TUI/RPC reply is scrubbed of the ACTUAL connected key (Major 2)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    host.generateError = providerErrorEchoing(KEY)
    const result = (await host.callRpc(MexploreRpc.id, 'command', { args: 'test' })) as { text: string }
    expect(result.text).toContain('FAILED')
    expect(result.text).not.toContain(KEY)
    expect(result.text).toContain('<redacted>')
  })

  test('the server command reply is scrubbed the same way', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    host.generateError = providerErrorEchoing(KEY)
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).not.toContain(KEY)
    expect(text).toContain('<redacted>')
  })

  test('a key echoed in a child failure never reaches the tool result', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    host.script = async (child) => {
      child.messages.push(failedAssistant(`401 Unauthorized: invalid key ${KEY}`))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('memory model failed')
    expect(error.message).not.toContain(KEY)
    expect(error.message).toContain('<redacted>')
  })

  test('a key typed as a command argument is scrubbed out of the refusal itself', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    // The refusal quotes the argument back, so it must be scrubbed even when the
    // argument is what triggered the refusal.
    const text = await host.command(PARENT, `/mexplore model ${KEY}`)
    expect(text).not.toContain(KEY)
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
  })

  test('a credential-bearing URL is rejected before it is echoed (Major 3)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const url = 'https://user:s3cret-password@example.com/v1'
    const text = await host.command(PARENT, `/mexplore base-url ${url}`)
    expect(text).toContain('Refused')
    expect(text).toContain('credential')
    // Neither half of the user-info is repeated.
    expect(text).not.toContain('s3cret-password')
    expect(text).not.toContain('user:')
    expect(host.storage.get('baseURL')).toBe(CUSTOM_PROVIDER_SETTINGS.baseURL)
  })

  test('with no resolvable credential, shape rules still scrub', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.generateError = new Error('bad key sk-live-abcdef123456')
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).not.toContain('sk-live-abcdef123456')
  })

  test('the sanitizer scrubs a nested provider error body, not just the message', async () => {
    const { makeSanitizer, refreshSanitizer } = await import('../src/plugin/redact')
    const sanitize = makeSanitizer(async () => [KEY])
    await refreshSanitizer(sanitize)
    const scrubbed = sanitize.value({
      error: { message: `bad ${KEY}`, response: { body: `{"key":"${KEY}"}` } },
      list: [`${KEY}`],
    }) as { error: { message: string; response: { body: string } }; list: string[] }
    expect(JSON.stringify(scrubbed)).not.toContain(KEY)
  })
})

// ------------------------------------------------------ review round: Major 8

describe('the final answer is capped (Major 8, SEC-004)', () => {
  test('a huge answer is cut to the host limits and says so', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const huge = Array.from({ length: 5_000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n')
    host.script = async (child) => {
      child.messages.push(assistant(huge))
    }
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.truncated).toBe(true)
    expect(result.content.split('\n').length).toBeLessThan(1_950)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(48_000)
    expect(result.content).toContain('truncated')
  })

  test('a single enormous line is still cut under the byte limit', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child) => {
      child.messages.push(assistant('y'.repeat(200_000)))
    }
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.truncated).toBe(true)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThan(48_000)
  })

  test('the save announcements survive the cap, complete', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child, host) => {
      const huge = Array.from({ length: 5_000 }, (_, index) => `filler ${index} ${'z'.repeat(40)}`).join('\n')
      child.messages.push(assistant(huge))
      await host.executeTool(
        'memory_write',
        { description: 'the durable decision', body: 'b' },
        child.info.id,
      )
    }
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.truncated).toBe(true)
    // The complete footer survives, even though the answer was cut.
    expect(result.content).toContain('saved to memory: the durable decision (')
    const writes = result.metadata.writes as Array<{ description?: string }>
    expect(writes[0]?.description).toBe('the durable decision')
  })

  test('a normal answer is untouched', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.metadata.truncated).toBe(false)
    expect(result.metadata.incompleteSettlement).toBeUndefined()
  })
})

// ------------------------------------------------ review round: Major 6, 12

describe('failure paths keep the accounting honest (Major 6, 12)', () => {
  test('a failed wait reports its cause instead of "no reply" (Minor 12)', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const original = host.ctx.session.wait
    Object.assign(host.ctx.session, {
      wait: async () => {
        throw new Error('database is locked')
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    Object.assign(host.ctx.session, { wait: original })
    expect(error.message).toContain('could not be observed')
    expect(error.message).toContain('database is locked')
    expect(error.message).not.toContain('produced no text')
  })

  test('an unsettled write adds the warning to a FAILURE, not just a success (Major 6)', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    // A stub call whose write never settles: the only way to reach the branch,
    // since a real dsh write resolves quickly. `runCall` takes the call, so this
    // drives the real code path with one hanging collaborator.
    const pending: string[] = ['saved to memory: a slow write (01AAAAAAAAAAAAAAAAAAAAAAAA)']
    const call = {
      toolNames: () => [...MANAGE_TOOL_NAMES],
      toolDefs: () => [],
      renderPrompt: () => '',
      execute: async () => ({ content: 'ok' }),
      settle: () => new Promise<void>(() => {}),
      report: () => ({
        toolCalls: 1,
        writes: [{ tool: 'memory_write', nodeId: '01AAAAAAAAAAAAAAAAAAAAAAAA', description: 'a slow write', status: 'ok' }],
        edges: [],
      }),
      footerLines: () => [...pending],
    } as never
    const { runCall } = await import('../src/plugin/call')
    const { shapeSanitizer } = await import('../src/plugin/redact')
    host.script = async (child) => {
      child.messages.push(failedAssistant('provider vanished'))
      child.info.outcome = 'failed'
    }
    const error = await runCall(host.ctx, {
      parentSessionID: PARENT,
      currentBaseURL: () => 'https://example/v1',
      authority: 'manage',
      message: 'q',
      evidence: [],
      call,
      model: { providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' },
      modelSource: 'default',
      signal: new AbortController().signal,
      registry: plugin.registry,
      graphRoot: plugin.graphRoot,
      timeoutMs: 60_000,
      // The stub's write never settles; a short budget keeps the test quick while
      // exercising the same "expired" branch.
      cleanupBudgetMs: 60,
      sanitize: shapeSanitizer(),
    }).catch((value: unknown) => value as Error)
    // The landed write is announced, AND the accounting is admitted to be partial.
    expect((error as Error).message).toContain('saved to memory: a slow write')
    expect((error as Error).message).toContain('still in flight')
  })

  test('a failure after a landed write still announces it', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child, host) => {
      await host.executeTool('memory_write', { description: 'landed', body: 'b' }, child.info.id)
      child.messages.push(failedAssistant('provider vanished'))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT))
    expect(error.message).toContain('saved to memory: landed')
    expect(error.message).not.toContain('no writes')
  })

  test('a plugin-unload abort still reports pending graph work', async () => {
    const { host, plugin, dispose } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      await held
      child.messages.push(assistant('late'))
    }
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    for (let i = 0; i < 200 && childID === undefined; i += 1) await Bun.sleep(1)
    await dispose()
    release()
    const error = await pending
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
    expect(error.message).not.toContain('no writes')
  })
})

// ------------------------------------------- review round 2: Major 3, 5, 8, 9

describe('request hook pinning only the memory provider (Major 3)', () => {
  test('a third-party auxiliary request keeps its own endpoint', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('ok'))
    }
    await host.executeTool('mexplore', { message: 'q' }, PARENT)
    // Pin a child endpoint directly: the child is gone by now, so the registry is
    // told about one the way `create` would have.
    const registry = plugin.registry as unknown as { endpoints: Map<string, string> }
    registry.endpoints.set('ses_child', 'https://memory-endpoint/v1')

    // A compaction through ANOTHER provider: untouched, or its credential would
    // be sent to the memory endpoint.
    const foreign = await host.fireRequestHookFor('ses_child', {
      providerID: 'anthropic',
      id: 'claude-sonnet-5',
    })
    expect(foreign.baseURL).toBe('https://from-provider/v1')

    // A request for the memory provider itself IS pinned.
    const own = await host.fireRequestHookFor('ses_child', { providerID: 'mexplore', id: 'deepseek-v4-pro' })
    expect(own.baseURL).toBe('https://memory-endpoint/v1')
    expect(childID).toBeDefined()
  })
})

describe('a late create is always cleaned up (Major 5)', () => {
  test('a create that settles after the deadline is adopted and removed', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        await held
        return original(input)
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(codeOf(error)).toBe('TIMEOUT')

    // The host finally creates the session, long after the call gave up.
    release()
    await Bun.sleep(50)
    Object.assign(host.ctx.session, { create: original })

    const children = [...host.sessions.values()].filter((child) => child.info.metadata?.mexploreChild === true)
    expect(children.length).toBeGreaterThan(0)
    for (const child of children) expect(child.removed).toBe(true)
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a late create after dispose is still removed', async () => {
    const { host, plugin, dispose } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = host.ctx.session.create
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof original>[0]) => {
        await held
        return original(input)
      },
    })
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    await Bun.sleep(80)
    // Dispose starts a BOUNDED wait for the stalled create; release it just
    // before that bound, so disposal returns promptly and the late session is
    // adopted by the tracking (not by dispose's own snapshot).
    const disposing = dispose()
    await Bun.sleep(60)
    release()
    await disposing
    await pending
    await Bun.sleep(50)
    Object.assign(host.ctx.session, { create: original })

    // Nothing survives, even though dispose finished before the create did.
    for (const child of host.sessions.values()) {
      if (child.info.metadata?.mexploreChild === true) expect(child.removed).toBe(true)
    }
    expect(plugin.registry.ownedSessionIDs()).toEqual([])
  })

  test('a failed late removal stays owned for dispose to retry', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true, timeoutMs: 40 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalCreate = host.ctx.session.create
    const originalRemove = host.ctx.session.remove
    let failRemoval = true
    Object.assign(host.ctx.session, {
      create: async (input: Parameters<typeof originalCreate>[0]) => {
        await held
        return originalCreate(input)
      },
      remove: async (input: { sessionID: string }) => {
        if (failRemoval) {
          failRemoval = false
          throw new Error('database is locked')
        }
        return originalRemove(input)
      },
    })
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(codeOf(error)).toBe('TIMEOUT')
    release()
    await pending()
    Object.assign(host.ctx.session, { create: originalCreate })

    // The removal failed, so the session is still there and still tracked.
    const survivors = [...host.sessions.values()].filter(
      (child) => child.info.metadata?.mexploreChild === true && !child.removed,
    )
    expect(survivors).toHaveLength(1)
    // dispose retries it, now that removal works again.
    await plugin.registry.dispose()
    expect(host.sessions.get(survivors[0]!.info.id)?.removed).toBe(true)

    function pending(): Promise<void> {
      return Bun.sleep(50)
    }
  })
})

describe('settings reject the credential in any encoding (Major 8)', () => {
  const KEY = 'opaque+proxy/key123456'

  test('a model id containing the encoded key is refused', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    const encoded = encodeURIComponent(KEY)
    for (const argument of [KEY, encoded, encoded.replace(/%2F/g, '%2f')]) {
      const text = await host.command(PARENT, `/mexplore model ${argument}`)
      expect(text).toContain('Refused')
      expect(text).not.toContain(KEY)
    }
    expect(Object.fromEntries(host.storage)).toEqual(CUSTOM_PROVIDER_SETTINGS)
  })

  test('a base URL carrying the encoded key is refused', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    const url = `https://proxy.example.com/v1?k=${encodeURIComponent(KEY)}`
    const text = await host.command(PARENT, `/mexplore base-url ${url}`)
    expect(text).toContain('Refused')
    expect(text).not.toContain(KEY)
    expect(host.storage.get('baseURL')).toBe(CUSTOM_PROVIDER_SETTINGS.baseURL)
  })

  test('a harmless model id is still accepted', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true, credential: KEY })
    expect(await host.command(PARENT, '/mexplore model deepseek-v4-pro')).toContain('deepseek-v4-pro')
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-pro')
  })
})

describe('selecting our own provider by full ref (Major 9)', () => {
  test('mexplore/<id> normalizes to the bare-model route and stays served', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    // 1. a custom model on our own provider
    expect(await host.command(PARENT, '/mexplore model deepseek-v4-pro')).toContain('deepseek-v4-pro')
    // 2. the same model by full ref
    const picked = await host.command(PARENT, '/mexplore model mexplore/deepseek-v4-pro')
    expect(picked).toContain('mexplore/deepseek-v4-pro')
    // 3. it is stored as the bare model, and `model` is clear
    expect(host.storage.get('mexploreModel')).toBe('deepseek-v4-pro')
    expect(host.storage.has('model')).toBe(false)
    // 4. the provider still serves it, so the next call works
    host.providerAdditions = []
    await host.ctx.provider.reload()
    expect(host.providerAdditions.at(-1)?.models.map((model) => model.id)).toEqual(['deepseek-v4-pro'])
    const result = (await host.executeTool('mexplore', { message: 'q' }, PARENT)) as {
      metadata: Record<string, unknown>
    }
    expect(result.metadata.model).toBe('mexplore/deepseek-v4-pro')
  })
})

// ------------------------------------------- review round 2: Minor 11, 12, 13

describe('the total output stays inside the host budget (Minor 13)', () => {
  test('a huge footer plus a huge answer stays under both limits', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child, host) => {
      const huge = Array.from({ length: 3_000 }, (_, index) => `filler ${index}`).join('\n')
      child.messages.push(assistant(huge))
      // Twenty long descriptions: the footer alone is many kilobytes.
      for (let index = 0; index < 20; index += 1) {
        await host.executeTool(
          'memory_write',
          { description: `decision ${index} ${'d'.repeat(480)}`, body: 'b' },
          child.info.id,
        )
      }
    }
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    expect(result.content.split('\n').length).toBeLessThanOrEqual(1_900)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(45_000)
    // Every save announcement survives, complete.
    for (let index = 0; index < 20; index += 1) {
      expect(result.content).toContain(`saved to memory: decision ${index} `)
    }
    expect(result.metadata.truncated).toBe(true)
  })

  test('a footer larger than the whole cap keeps every save line and zeroes the answer', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    host.script = async (child, host) => {
      child.messages.push(assistant('an answer that must yield'))
      // Enough long descriptions that the footer alone exceeds 45,000 bytes.
      for (let index = 0; index < 110; index += 1) {
        await host.executeTool(
          'memory_write',
          { description: `w${index} ${'x'.repeat(480)}`, body: 'b' },
          child.info.id,
        )
      }
    }
    const result = (await host.executeTool('mexplore', { message: 'q', authority: 'manage' }, PARENT)) as {
      content: string
      metadata: Record<string, unknown>
    }
    // The answer is gone…
    expect(result.content.startsWith('\n\n') || result.content.startsWith('note:')).toBe(true)
    expect(result.content).not.toContain('an answer that must yield')
    // …but not one save announcement was dropped.
    for (let index = 0; index < 110; index += 1) expect(result.content).toContain(`saved to memory: w${index} `)
  })
})

describe('one cleanup budget for settlement and removal (Minor 12)', () => {
  test('a stalled settlement does not buy a second cleanup bound', async () => {
    const { host, plugin } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const call = {
      toolNames: () => [...MANAGE_TOOL_NAMES],
      toolDefs: () => [],
      renderPrompt: () => '',
      execute: async () => ({ content: 'ok' }),
      // Never settles: settlement eats the whole budget.
      settle: () => new Promise<void>(() => {}),
      report: () => ({ toolCalls: 0, writes: [], edges: [] }),
      footerLines: () => ['no writes'],
    } as never
    const { runCall } = await import('../src/plugin/call')
    const { shapeSanitizer } = await import('../src/plugin/redact')
    let childID: string | undefined
    host.script = async (child) => {
      childID = child.info.id
      child.messages.push(assistant('done'))
    }
    const started = Date.now()
    const result = (await runCall(host.ctx, {
      parentSessionID: PARENT,
      currentBaseURL: () => 'https://example/v1',
      authority: 'read',
      message: 'q',
      evidence: [],
      call,
      model: { providerID: 'mexplore', id: 'deepseek-v4.1-flash-1017' },
      modelSource: 'default',
      signal: new AbortController().signal,
      registry: plugin.registry,
      graphRoot: plugin.graphRoot,
      timeoutMs: 60_000,
      cleanupBudgetMs: 120,
      sanitize: shapeSanitizer(),
    })) as { metadata: Record<string, unknown> }
    const elapsed = Date.now() - started
    // ~ONE budget, not two: the removal may not grant itself another 120 ms.
    expect(elapsed).toBeLessThan(600)
    expect(result.metadata.incompleteSettlement).toBe(true)
    expect(childID).toBeDefined()
    expect(host.sessions.get(childID as string)?.removed).toBe(true)
  })
})

// ------------------------------------ review round 3: the model's OWN provider

describe('the sanitizer follows the provider the memory model uses (Major 4)', () => {
  const THIRD_PARTY_KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'

  /** A config selecting a third-party model, with that provider's key connected. */
  function thirdParty(extra: Record<string, unknown> = {}) {
    return {
      models: [...ANTHROPIC, { providerID: 'thirdparty', id: 'm1' }],
      keyConnected: true,
      storage: { model: 'thirdparty/m1' },
      credentials: { thirdparty: THIRD_PARTY_KEY },
      ...extra,
    }
  }

  test('a third-party opaque key echoed in a failing child is redacted', async () => {
    const { host } = await fixture(thirdParty())
    host.script = async (child) => {
      // The provider quotes the key verbatim; no shape rule would catch this one.
      child.messages.push(failedAssistant(`Invalid API key '${THIRD_PARTY_KEY}'`))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('memory model failed')
    expect(error.message).not.toContain(THIRD_PARTY_KEY)
    expect(error.message).toContain('<redacted>')
  })

  test('the parent-fallback model\'s provider key is redacted too', async () => {
    const { host } = await fixture({
      models: ANTHROPIC,
      keyConnected: false,
      credentials: { anthropic: THIRD_PARTY_KEY },
    })
    await host.trigger('context', {
      sessionID: PARENT,
      model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
      tools: ['mexplore'],
    })
    host.script = async (child) => {
      child.messages.push(failedAssistant(`401 for key ${THIRD_PARTY_KEY}`))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).not.toContain(THIRD_PARTY_KEY)
  })

  test('a literal settings.apiKey is redacted (the host exposes it verbatim)', async () => {
    const literal = 'literal-settings-key-abcdef123456'
    const { host } = await fixture(
      thirdParty({
        credentials: undefined,
        connectionIDs: ['thirdparty'],
        providers: [
          {
            id: 'thirdparty',
            name: 'Third',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { apiKey: literal, baseURL: 'https://third/v1' },
          },
        ],
      }),
    )
    host.script = async (child) => {
      child.messages.push(failedAssistant(`bad key: ${literal}`))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).not.toContain(literal)
    expect(error.message).toContain('<redacted>')
  })

  test('a key rotated mid-call is followed, and the new one is redacted', async () => {
    const oldKey = 'old-key-abcdef123456'
    const newKey = 'new-key-zyxwvu987654'
    const { host } = await fixture(
      thirdParty({ credentials: { thirdparty: oldKey } }),
    )
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.script = async (child) => {
      await held
      // By now `/connect` replaced the key; the provider quotes the NEW one.
      child.messages.push(failedAssistant(`401 for ${newKey}`))
      child.info.outcome = 'failed'
    }
    const pending = failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    await Bun.sleep(30)
    // Rotate the credential while the call is in flight.
    host.options.credentials = { thirdparty: newKey }
    release()
    const error = await pending
    expect(error.message).not.toContain(newKey)
    // The old key is no longer in play, but nothing leaks it either.
    expect(error.message).not.toContain(oldKey)
  })

  test('/mexplore test against a third-party model redacts its key', async () => {
    const { host } = await fixture(thirdParty())
    host.generateError = new Error(`Incorrect API key provided: ${THIRD_PARTY_KEY}`)
    const text = await host.command(PARENT, '/mexplore test')
    expect(text).toContain('FAILED')
    expect(text).not.toContain(THIRD_PARTY_KEY)
    expect(text).toContain('<redacted>')
  })

  test('with no resolvable key, a third-party failure is reported by category only', async () => {
    const { host } = await fixture(
      thirdParty({
        credentials: undefined,
        connectionIDs: ['thirdparty'],
        providers: [],
      }),
    )
    host.script = async (child) => {
      child.messages.push(failedAssistant('401 Unauthorized: key AbCdEfGhIjKlMnOpQrStUvWxYz012345 is invalid'))
      child.info.outcome = 'failed'
    }
    const error = await failure(() => host.executeTool('mexplore', { message: 'q' }, PARENT))
    expect(error.message).toContain('memory model failed')
    // The body is dropped; the status survives, which is what diagnosis needs.
    expect(error.message).toContain('401')
    expect(error.message).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz012345')
    expect(error.message).toContain('omitted')
  })
})

// ------------------------------------------ the server command's name (REQ-021)

describe('the server command is /mexplore-settings; the TUI keeps /mexplore', () => {
  test('the tool is still mexplore, and the TUI command still uses that name', () => {
    // The MODEL-facing tool never changed: only the server command's label did.
    expect(MEXPLORE_TOOL).toBe('mexplore')
    expect(COMMAND_NAME).toBe('mexplore-settings')
    expect(TUI_COMMAND_NAME).toBe('mexplore')
  })

  test('the server registers under the new name, with a description naming it', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    expect([...host.commands.keys()]).toEqual(['mexplore-settings'])
    const description = host.commands.get('mexplore-settings')?.description ?? ''
    expect(description).toContain('mexplore memory settings')
  })

  test('the server command works when invoked as /mexplore-settings', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore-settings status')
    expect(text).toContain('mexplore memory')
    expect(text).toContain('key: connected')
  })

  test('the server command\'s own help names /mexplore-settings, not /mexplore', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore-settings')
    expect(text).toContain('/mexplore-settings model')
    expect(text).toContain('/mexplore-settings reset')
    // A bare `/mexplore model` line would send a desktop user to a command they
    // do not have, so the label must be the server one throughout.
    expect(text).not.toMatch(/^\/mexplore model/m)
  })

  test('the TUI reply keeps /mexplore in its help, because that is its command', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const result = (await host.callRpc(MexploreRpc.id, 'command', { args: 'nonsense' })) as { text: string }
    expect(result.text).toContain('Unknown `/mexplore nonsense`')
    expect(result.text).toContain('/mexplore model')
    expect(result.text).not.toContain('/mexplore-settings')
  })

  test('both prefixes reach the same implementation', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const viaServerName = await host.command(PARENT, '/mexplore-settings status')
    const viaTuiName = await host.command(PARENT, '/mexplore status')
    expect(viaTuiName).toBe(viaServerName)
    // …and a bare argument list (no prefix) works too, as the TUI sends it.
    expect(await host.command(PARENT, 'status')).toContain('mexplore memory')
  })

  test('a settings change through the new name still lands', async () => {
    const { host } = await fixture({ models: ANTHROPIC, keyConnected: true })
    const text = await host.command(PARENT, '/mexplore-settings base-url https://proxy.example.com/v1')
    expect(text).toContain('proxy.example.com')
    expect(host.storage.get('baseURL')).toBe('https://proxy.example.com/v1')
  })
})
