// The `mexplore-ui/plugin` entry (the export the OpenCode plugin imports).
//
// Covers the contract for `startPluginUi` / `uiAssetsPresent`: importable with no
// side effects, no `bun:sqlite` at module scope, the tokenised URL, the port
// policy (default, EADDRINUSE -> OS-chosen, never adopting a foreign listener),
// and an idempotent `stop()`.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_PLUGIN_PORT, pluginUrl, startPluginUi, uiAssetsPresent } from '../src/plugin.ts'
import type { PluginUiHandle } from '../src/plugin.ts'
import { cleanupTemps, newNode, tempDir } from './helpers.ts'

const handles: PluginUiHandle[] = []

afterAll(async () => {
  for (const handle of handles.splice(0)) await handle.stop().catch(() => undefined)
  cleanupTemps()
})

function record(graphRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    callId: 'call-1',
    ts: '2026-11-01T10:00:00.000Z',
    finishedAt: '2026-11-01T10:00:09.000Z',
    authority: 'read',
    outcome: 'ok',
    latencyMs: 9_000,
    usageStatus: 'complete',
    tokens: { input: 900, output: 90, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
    costUsd: null,
    provider: 'mexplore',
    model: 'deepseek-v4.1-flash-1017',
    modelSource: 'default',
    steps: 2,
    graphRoot,
    pluginVersion: '0.1.0',
    ...overrides,
  }
}

/**
 * The `Set-Cookie` this server sent, as a `name=value` pair.
 *
 * The cookie NAME is per-server (`mexplore_session_<port>`) so two dashboards on
 * the same host cannot overwrite each other — reading it back from the response
 * is what a browser does, and it keeps these tests honest about the name.
 */
function sessionCookieOf(response: Response): { name: string; pair: string; value: string } {
  const setCookie = response.headers.get('set-cookie') ?? ''
  const pair = setCookie.split(';')[0] ?? ''
  const eq = pair.indexOf('=')
  return { name: pair.slice(0, eq), pair, value: decodeURIComponent(pair.slice(eq + 1)) }
}

interface Fixture {
  graphRoot: string
  usageDir: string
}

/** A graph + usage dir pair, as the plugin creates them before calling us. */
function fixture(): Fixture {
  const base = tempDir('mexplore-plugin-')
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'plugin entry node')
  const usageDir = path.join(base, 'usage')
  fs.mkdirSync(usageDir, { recursive: true })
  fs.writeFileSync(
    path.join(usageDir, 'usage-2026-11.jsonl'),
    // The plugin writes the graph's realpath (contract: `/abs/realpath/of/graph`).
    `${JSON.stringify(record(fs.realpathSync(graphRoot)))}\n`,
    'utf8',
  )
  return { graphRoot, usageDir }
}

describe('module shape', () => {
  test('importing the module has no side effects', () => {
    // If the import bound a port, this would be the second bind on the same one.
    expect(typeof DEFAULT_PLUGIN_PORT).toBe('number')
    expect(DEFAULT_PLUGIN_PORT).toBe(43191)
    expect(typeof startPluginUi).toBe('function')
    expect(typeof uiAssetsPresent).toBe('function')
  })

  test('the plugin module graph binds bun:sqlite nowhere at module scope', () => {
    // The contract: the module "must not import `bun:sqlite` at module scope on
    // this path (the JSONL source does not need sqlite)". Two shapes could bind
    // it at load time, and both are rejected here while the import graph is
    // walked from `src/plugin.ts`:
    //   * a VALUE `import … from 'bun:sqlite'` (`import type` is erased, so it is
    //     allowed);
    //   * a TOP-LEVEL `require('bun:sqlite')` outside any function.
    // `usage/tasks.ts` uses the lazy form inside `loadDatabase()`, which is what
    // keeps the service reader available without loading sqlite for the plugin.
    const root = path.resolve(import.meta.dir, '..')
    const seen = new Set<string>()
    const queue = [path.join(root, 'src', 'plugin.ts')]
    const offenders: string[] = []
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file) || !fs.existsSync(file)) continue
      seen.add(file)
      const text = fs.readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        if (!/bun:sqlite/.test(line)) continue
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        const valueImport = /^\s*import\s+(?!type\s)[^\n]*from\s+['"]bun:sqlite['"]/.test(line)
        const topLevelRequire = /^[^\s]/.test(line) && /require\(\s*['"]bun:sqlite['"]\s*\)/.test(line)
        const typeImportOk = /^\s*import\s+type\s/.test(line)
        if (valueImport || topLevelRequire) offenders.push(`${path.relative(root, file)}: ${trimmed}`)
        else if (!/from\s+['"]bun:sqlite['"]/.test(line) && !typeImportOk && !/require\(\s*['"]bun:sqlite['"]\s*\)/.test(line)) {
          offenders.push(`${path.relative(root, file)}: unrecognised bun:sqlite use: ${trimmed}`)
        }
      }
      for (const match of text.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[1] as string
        if (specifier.startsWith('.')) queue.push(path.resolve(path.dirname(file), specifier))
      }
    }
    expect(offenders).toEqual([])
    // The walk really reached the modules that could have pulled sqlite in.
    expect(seen.size).toBeGreaterThan(5)
    expect([...seen].some((file) => file.endsWith('store.ts'))).toBe(true)
    expect([...seen].some((file) => file.endsWith('tasks.ts'))).toBe(true)
  })

  test('uiAssetsPresent reports the built UI next to the package', () => {
    // The test suite runs from a checkout where dist/ was built; a package
    // without dist/ would answer false, which is the same function the plugin
    // preflights before starting a server.
    expect(uiAssetsPresent()).toBe(fs.existsSync(path.resolve(import.meta.dir, '..', 'dist', 'index.html')))
  })

  test('pluginUrl carries the token as a query parameter', () => {
    expect(pluginUrl(43191, 'abc')).toBe('http://127.0.0.1:43191/?t=abc')
    expect(pluginUrl(5000, 'a+/=')).toBe('http://127.0.0.1:5000/?t=a%2B%2F%3D')
  })
})

describe('startPluginUi', () => {
  test('starts on the requested port and its URL exchanges the token for a cookie', async () => {
    const { graphRoot, usageDir } = fixture()
    const handle = await startPluginUi({ graphRoot, usageDir, port: 0 })
    handles.push(handle)

    expect(handle.port).toBeGreaterThan(0)
    expect(handle.graphRoot).toBe(fs.realpathSync(graphRoot))
    expect(handle.url.startsWith(`http://127.0.0.1:${handle.port}/?t=`)).toBe(true)

    // The URL works end to end: exchange -> cookie -> /api/meta sees the plugin source.
    const exchange = await fetch(handle.url, { redirect: 'manual' })
    expect(exchange.status).toBe(302)
    const cookie = sessionCookieOf(exchange)
    expect(cookie.name).toBe(`mexplore_session_${handle.port}`)
    expect(cookie.value.length).toBeGreaterThan(20)

    const meta = await fetch(`http://127.0.0.1:${handle.port}/api/meta`, {
      headers: { Cookie: cookie.pair },
    })
    expect(meta.status).toBe(200)
    const body = (await meta.json()) as { source?: string; label?: string; runCount: number }
    expect(body.source).toBe('plugin')
    expect(body.label).toBe('opencode plugin')
    expect(body.runCount).toBe(1)

    // Without the cookie the shell is a 401 page.
    const anonymous = await fetch(`http://127.0.0.1:${handle.port}/`, { redirect: 'manual' })
    expect(anonymous.status).toBe(401)
  })

  test('a custom label reaches /api/meta', async () => {
    const { graphRoot, usageDir } = fixture()
    const handle = await startPluginUi({ graphRoot, usageDir, port: 0, label: 'opencode plugin (test)' })
    handles.push(handle)
    const exchange = await fetch(handle.url, { redirect: 'manual' })
    const cookie = sessionCookieOf(exchange)
    const body = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/meta`, { headers: { Cookie: cookie.pair } })
    ).json()) as { label?: string }
    expect(body.label).toBe('opencode plugin (test)')
  })

  test('each start mints its own token', async () => {
    const { graphRoot, usageDir } = fixture()
    const first = await startPluginUi({ graphRoot, usageDir, port: 0 })
    const second = await startPluginUi({ graphRoot, usageDir, port: 0 })
    handles.push(first, second)
    expect(first.url).not.toBe(second.url)
    expect(new URL(first.url).searchParams.get('t')).not.toBe(new URL(second.url).searchParams.get('t'))
  })

  test('an occupied port falls back to an OS-chosen one instead of adopting the listener', async () => {
    const { graphRoot, usageDir } = fixture()
    // Stand in a foreign listener on a port we then ask for.
    const foreign = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('foreign listener'),
    })
    try {
      const handle = await startPluginUi({ graphRoot, usageDir, port: foreign.port as number })
      handles.push(handle)
      expect(handle.port).not.toBe(foreign.port)
      expect(handle.port).toBeGreaterThan(0)
      // The foreign listener still answers for itself; we never took it over.
      const stillForeign = await fetch(`http://127.0.0.1:${foreign.port}/`)
      expect(await stillForeign.text()).toBe('foreign listener')
    } finally {
      await foreign.stop(true)
    }
  })

  test('two starts on the DEFAULT port land on different ports (no SO_REUSEPORT sharing)', async () => {
    // Regression: `Bun.serve({ development: false })` sets SO_REUSEPORT, so a
    // second process could bind the same default port and silently SHARE it —
    // defeating both the EADDRINUSE detection and the "never adopt a foreign
    // listener" policy. `reusePort: false` in `boot()` forces an exclusive bind.
    const { graphRoot, usageDir } = fixture()
    const first = await startPluginUi({ graphRoot, usageDir })
    const second = await startPluginUi({ graphRoot, usageDir })
    handles.push(first, second)
    expect(first.port).not.toBe(second.port)
    // Each answers with its OWN content, proving they are separate listeners and
    // not two handles onto one shared socket.
    const firstExchange = await fetch(first.url, { redirect: 'manual' })
    const secondExchange = await fetch(second.url, { redirect: 'manual' })
    expect(firstExchange.status).toBe(302)
    expect(secondExchange.status).toBe(302)
    expect(sessionCookieOf(firstExchange).name).toBe(`mexplore_session_${first.port}`)
    expect(sessionCookieOf(secondExchange).name).toBe(`mexplore_session_${second.port}`)
  })

  test('stop() is idempotent and releases the port', async () => {
    const { graphRoot, usageDir } = fixture()
    const handle = await startPluginUi({ graphRoot, usageDir, port: 0 })
    const port = handle.port
    await handle.stop()
    await handle.stop()
    // The port is free again: a fresh server can bind it.
    const rebuilt = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('ok') })
    await rebuilt.stop(true)
  })

  test('a missing graph root does not crash startup (the graph view reports it)', async () => {
    const base = tempDir('mexplore-plugin-missing-')
    const usageDir = path.join(base, 'usage')
    fs.mkdirSync(usageDir, { recursive: true })
    const handle = await startPluginUi({ graphRoot: path.join(base, 'no-graph'), usageDir, port: 0 })
    handles.push(handle)
    const exchange = await fetch(handle.url, { redirect: 'manual' })
    const cookie = sessionCookieOf(exchange)
    const graph = await fetch(`http://127.0.0.1:${handle.port}/api/graph`, {
      headers: { Cookie: cookie.pair },
    })
    expect(graph.status).toBe(200)
    const body = (await graph.json()) as { nodes: unknown[]; warnings: string[] }
    expect(body.nodes).toEqual([])
    expect(body.warnings.join('\n')).toMatch(/graph root/)
  })
})
