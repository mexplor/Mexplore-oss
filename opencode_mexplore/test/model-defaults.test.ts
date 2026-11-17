import { afterEach, describe, expect, test } from 'bun:test'
import { resolveModel, providerConfig } from '../src/plugin/settings'
import { memoryProvider } from '../src/plugin/provider'
import { assistant } from './helpers/fake-host'
import { makeFixture, type Fixture } from './helpers/plugin'

const PARENT = 'ses_parent0000000000000000000'
const CHAT = { providerID: 'host', id: 'chat-model' }
const OTHER_CHAT = { providerID: 'host', id: 'other-chat-model' }
const MEMORY = { providerID: 'host', id: 'memory-model' }
const MODELS = [CHAT, OTHER_CHAT, MEMORY]
const CUSTOM = { mexploreModel: 'custom-memory-model', baseURL: 'https://memory.example.com/v1' }
const fixtures: Fixture[] = []

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.dispose()
})

async function fresh(storage: Record<string, unknown> = {}, keyConnected = false): Promise<Fixture> {
  const value = await makeFixture({ models: MODELS, storage, keyConnected })
  fixtures.push(value)
  return value
}

async function context(host: Fixture['host'], model = CHAT): Promise<void> {
  await host.trigger('context', { sessionID: PARENT, model, tools: ['mexplore'] })
}

async function recall(host: Fixture['host']) {
  return await host.executeTool('mexplore', { message: 'recall release notes' }, PARENT) as {
    content: string
    metadata: { model: string; modelSource: string }
  }
}

describe('public model defaults', () => {
  for (const keyConnected of [false, true]) {
    test(`a fresh install inherits the current chat model (separate key: ${keyConnected})`, async () => {
      const { host } = await fresh({}, keyConnected)
      await context(host)
      const result = await recall(host)
      expect(result.metadata).toMatchObject({ model: 'host/chat-model', modelSource: 'parent-fallback' })
      expect((host.calls.create[0] as { model: unknown }).model).toEqual(CHAT)
      expect(result.content).toContain('inherited from the current OpenCode session')
      expect(result.content).not.toContain('no mexplore key connected')
      const status = await host.command(PARENT, '/mexplore status')
      expect(status).toContain(keyConnected ? 'key: connected' : 'key: missing (optional')
      expect(status).not.toContain('missing — run /connect')
      expect(host.storage.size).toBe(0)
    })
  }

  test('a fresh custom provider has no endpoint, model or enabled route', () => {
    expect(providerConfig({})).toEqual({ baseURL: '', modelID: '' })
    const provider = memoryProvider({})
    expect(provider.models).toEqual([])
    expect(provider.info.activation).toBe('disabled')
    expect(provider.info.settings).toEqual({})
  })

  test('a connected key alone does not supply a model before a chat exists', async () => {
    const { host } = await fresh({}, true)
    await expect(recall(host)).rejects.toThrow('no memory model is available')
    expect(host.calls.create).toHaveLength(0)
  })

  test('inheritance follows the host model on the next call', async () => {
    const { host } = await fresh({}, true)
    await context(host)
    expect((await recall(host)).metadata.model).toBe('host/chat-model')
    await context(host, OTHER_CHAT)
    expect((await recall(host)).metadata.model).toBe('host/other-chat-model')
    expect(host.storage.size).toBe(0)
  })

  test('an explicit memory model is independent of the chat model', async () => {
    const { host, plugin } = await fresh({}, true)
    await context(host)
    await host.command(PARENT, '/mexplore model host/memory-model')
    expect((await recall(host)).metadata).toMatchObject({ model: 'host/memory-model', modelSource: 'selected' })
    expect(plugin.parentModels.get(PARENT)).toEqual(CHAT)
    await context(host, OTHER_CHAT)
    expect((await recall(host)).metadata.model).toBe('host/memory-model')
    expect(plugin.parentModels.get(PARENT)).toEqual(OTHER_CHAT)
  })

  test('reset restores inheritance even with a connected custom-provider key', async () => {
    const { host } = await fresh(CUSTOM, true)
    await context(host)
    expect((await recall(host)).metadata.model).toBe('mexplore/custom-memory-model')
    expect(await host.command(PARENT, '/mexplore reset')).toContain('inherit the current OpenCode session model')
    expect((await recall(host)).metadata.model).toBe('host/chat-model')
    expect(host.storage.size).toBe(0)
    expect(await host.ctx.integration.connection.active('mexplore')).toBeDefined()
    expect(host.providerAdditions.at(-1)?.models).toEqual([])
    expect(host.providerAdditions.at(-1)?.info.activation).toBe('disabled')
  })

  for (const missing of ['endpoint', 'key'] as const) {
    test(`an explicit custom override missing its ${missing} never silently falls back`, async () => {
      const settings = missing === 'endpoint' ? { mexploreModel: CUSTOM.mexploreModel } : CUSTOM
      expect(resolveModel({ settings, hasKey: missing !== 'key', parentModel: CHAT })).toBeUndefined()
      const { host } = await fresh(settings, missing !== 'key')
      await context(host)
      await expect(recall(host)).rejects.toThrow()
      expect(host.calls.create).toHaveLength(0)
    })
  }

  test('an endpoint and key without a selected memory model still inherit the host', async () => {
    const { host } = await fresh({ baseURL: CUSTOM.baseURL }, true)
    await context(host)
    expect((await recall(host)).metadata.model).toBe('host/chat-model')
    expect(host.providerAdditions.at(-1)?.models).toEqual([])
  })

  test('a native host override does not depend on custom endpoint settings', () => {
    expect(resolveModel({ settings: { model: 'host/memory-model' }, hasKey: false, parentModel: CHAT }))
      .toEqual({ model: MEMORY, source: 'selected' })
  })

  test('custom model names come from the configured id, not a built-in vendor', () => {
    const provider = memoryProvider(CUSTOM)
    expect(provider.models[0]?.name).toBe('custom-memory-model (memory)')
  })

  test('reset during admission never gives an already resolved custom call an empty endpoint', async () => {
    const { host, plugin } = await fresh(CUSTOM, true)
    await context(host)
    const list = host.ctx.model.list
    let count = 0
    let release = () => {}
    let reached = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const waiting = new Promise<void>((resolve) => { reached = resolve })
    host.ctx.model.list = async () => {
      // The first lookup is diagnostics; the second is after model resolution.
      if (++count === 2) {
        reached()
        await held
      }
      return list()
    }
    const endpoints: Array<string | undefined> = []
    host.script = async (child) => {
      endpoints.push(plugin.registry.endpointFor(child.info.id))
      child.messages.push(assistant('done'))
    }
    const call = recall(host)
    try {
      await waiting
      await host.command(PARENT, '/mexplore reset')
    } finally {
      release()
    }
    expect((await call).metadata.model).toBe('mexplore/custom-memory-model')
    expect(endpoints).toEqual([CUSTOM.baseURL])
    expect(host.storage.size).toBe(0)
    host.ctx.model.list = list
    expect((await recall(host)).metadata.model).toBe('host/chat-model')
  })

  test('reset during a custom call keeps that child alive and changes only later calls', async () => {
    const { host, plugin } = await fresh(CUSTOM, true)
    await context(host)
    let release = () => {}
    let started = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    let count = 0
    host.script = async (child) => {
      if (++count === 1) {
        started()
        await held
      }
      child.messages.push(assistant('done'))
    }
    const slow = recall(host)
    try {
      await entered
      await host.command(PARENT, '/mexplore reset')
      expect(host.providerAdditions.at(-1)?.models.map((model) => model.id)).toEqual([CUSTOM.mexploreModel])
      expect(host.providerAdditions.at(-1)?.info.settings).toEqual({ baseURL: CUSTOM.baseURL })
      expect((await recall(host)).metadata.model).toBe('host/chat-model')
    } finally {
      release()
      await slow
    }
    expect(plugin.leases.size()).toBe(0)
    expect(host.providerAdditions.at(-1)?.models).toEqual([])
  })
})
