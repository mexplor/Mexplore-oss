// The plugin deployment over real HTTP: capability token, Host allowlist,
// cross-site refusal, plugin-mode meta/runs/usage, and the service mode that
// must keep working unchanged.
//
// Nothing here touches production data; fixtures live in `os.tmpdir()`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createApp, cookieValue, tokensMatch } from '../src/server/app.ts'
import { Store } from '../src/server/store.ts'
import { JsonlRunSource } from '../src/server/usage/jsonl-source.ts'
import type { Meta, RunsPage, UsageSummary } from '../src/shared/types.ts'
import { cleanupTemps, newNode, serveOnEphemeralPort, tempDir } from './helpers.ts'

interface Harness {
  base: string
  port: number
  token: string
  graphRoot: string
  usageDir: string
  app: ReturnType<typeof createApp>
  stop(): Promise<void>
}

const harnesses: Harness[] = []

/** A token no other harness shares: real instances mint one per start (#8). */
const freshToken = (): string => crypto.randomBytes(16).toString('hex')

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    graphRoot: '/unset',
    pluginVersion: '0.1.0',
    ...overrides,
  }
}

function writeUsage(dir: string, records: readonly unknown[]): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'usage-2026-11.jsonl'),
    records.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    'utf8',
  )
}

/** A plugin-mode server on an ephemeral port, with a dist dir holding a shell. */
async function startPluginHarness(options: { dist?: boolean; token?: string } = {}): Promise<Harness> {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'plugin http node')
  const usageDir = path.join(base, 'usage')
  writeUsage(usageDir, [
    record({ callId: 'r1', authority: 'read', graphRoot }),
    record({ callId: 'm1', authority: 'manage', ts: '2026-11-01T11:00:00.000Z', graphRoot, tokens: null, usageStatus: 'unknown', latencyMs: null }),
    record({ callId: 'elsewhere', graphRoot: '/other/graph' }),
  ])

  let distDir: string | undefined
  if (options.dist !== false) {
    distDir = path.join(base, 'dist')
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>shell</title>\n', 'utf8')
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)\n', 'utf8')
  }

  const token = options.token ?? freshToken()
  const store = new Store({
    graphRoot,
    runs: new JsonlRunSource({ usageDir, graphRoot, now: () => Date.parse('2026-11-02T00:00:00.000Z') }),
    debounceMs: 20,
    reconcileMs: 600_000,
    taskPollMs: 600_000,
  })
  store.start()

  const holder: { server: ReturnType<typeof Bun.serve> | null } = { server: null }
  const app = createApp({
    store,
    graphRoot,
    source: 'plugin',
    label: 'opencode plugin',
    ...(distDir === undefined ? {} : { distDir }),
    token,
    tz: 'UTC',
    // Bound below; `setListeningPort` reports the real port immediately after.
    port: 0,
    server: { timeout: (request, seconds) => holder.server?.timeout(request, seconds) },
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 30,
    fetch: (request) => app.handle(request),
  })
  holder.server = server
  app.setListeningPort(server.port as number)

  const harness: Harness = {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    token,
    graphRoot,
    usageDir,
    app,
    async stop() {
      store.close()
      await server.stop(true)
    },
  }
  harnesses.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of harnesses) await harness.stop()
  cleanupTemps()
})

afterEach(() => {
  // every harness stays alive for the whole file so ports are not reused
})

/**
 * The `${name}=${value}` pair this server sets, for a harness.
 *
 * The cookie NAME is per-server (`mexplore_session_<port>`, finding #8): two
 * dashboards on one host must not overwrite each other, so the name is read from
 * the app rather than hardcoded.
 */
const cookieFor = (h: Harness): string => `${h.app.sessionCookieName()}=${encodeURIComponent(h.token)}`

describe('capability token', () => {
  test('the exchange sets an HttpOnly SameSite=Strict cookie and redirects to the path', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/?t=${h.token}`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    const cookie = response.headers.get('set-cookie') ?? ''
    // A per-server name (finding #8), not a shared constant.
    const name = h.app.sessionCookieName()
    expect(name).toBe(`mexplore_session_${h.port}`)
    expect(cookie).toContain(`${name}=`)
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite=strict')
    expect(cookie).toContain('Path=/')
    // The token is the cookie value, round-tripped exactly.
    expect(cookieValue(cookie, name)).toBe(h.token)
  })

  test('the redirect never leaves this host, even for a path starting with //', async () => {
    const h = await startPluginHarness()
    for (const path of ['//evil.example/x', '///evil.example', '//']) {
      const response = await fetch(`${h.base}${path}?t=${h.token}`, { redirect: 'manual' })
      expect(response.status).toBe(302)
      const location = response.headers.get('location') ?? ''
      expect(location.startsWith('/')).toBe(true)
      expect(location.startsWith('//')).toBe(false)
    }
  })

  test('a wrong or missing token never yields the cookie', async () => {
    const h = await startPluginHarness()
    const wrong = await fetch(`${h.base}/?t=not-the-token`, { redirect: 'manual' })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  test('#8: two live servers on one host keep separate cookies, so neither is logged out', async () => {
    // A real browser cookie jar is keyed by (host, path) — NOT by port — so two
    // servers on 127.0.0.1 share ONE jar. With a fixed cookie name the second
    // exchange would overwrite the first server's cookie, and the first
    // dashboard's /api and SSE would start answering 401. This is that jar.
    const jar = new Map<string, string>()
    const applySetCookie = (response: Response): void => {
      const header = response.headers.get('set-cookie')
      if (header === null) return
      const pair = header.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) return
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    const cookieHeader = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')

    const first = await startPluginHarness()
    const second = await startPluginHarness()
    expect(first.port).not.toBe(second.port)

    // Both exchanges land in the same jar, in order.
    applySetCookie(await fetch(first.base + `/?t=${first.token}`, { redirect: 'manual' }))
    const firstPairCount = jar.size
    applySetCookie(await fetch(second.base + `/?t=${second.token}`, { redirect: 'manual' }))
    // The second server's cookie did NOT replace the first one's.
    expect(jar.size).toBe(firstPairCount + 1)
    expect([...jar.keys()].sort()).toEqual(
      [`mexplore_session_${first.port}`, `mexplore_session_${second.port}`].sort(),
    )

    // Both servers still authorise the same browser.
    for (const h of [first, second]) {
      const meta = await fetch(`${h.base}/api/meta`, { headers: { Cookie: cookieHeader() } })
      expect([h.port, meta.status]).toEqual([h.port, 200])
      const graph = await fetch(`${h.base}/api/graph`, { headers: { Cookie: cookieHeader() } })
      expect([h.port, graph.status]).toEqual([h.port, 200])
    }

    // And each server refuses the OTHER's token, so the names are not the only
    // thing separating them.
    const cross = await fetch(`${second.base}/api/meta`, {
      headers: { Cookie: `mexplore_session_${second.port}=${encodeURIComponent(first.token)}` },
    })
    expect(cross.status).toBe(401)
  })

  test('#8: the per-port cookie name is what the exchange sets and what validation reads', async () => {
    const h = await startPluginHarness()
    const name = h.app.sessionCookieName()
    expect(name).toBe(`mexplore_session_${h.port}`)

    const exchange = await fetch(`${h.base}/?t=${h.token}`, { redirect: 'manual' })
    const set = exchange.headers.get('set-cookie') ?? ''
    expect(set.startsWith(`${name}=`)).toBe(true)

    // A cookie under the OLD shared name is not accepted: the name is the fix.
    const legacy = await fetch(`${h.base}/api/meta`, {
      headers: { Cookie: `mexplore_session=${encodeURIComponent(h.token)}` },
    })
    expect(legacy.status).toBe(401)
  })

  test('the shell is 401 without the cookie and 200 with it', async () => {
    const h = await startPluginHarness()
    const anonymous = await fetch(`${h.base}/`, { redirect: 'manual' })
    expect(anonymous.status).toBe(401)
    expect((await anonymous.text()).toLowerCase()).toContain('not authorised')

    const authed = await fetch(`${h.base}/`, { headers: { Cookie: cookieFor(h) } })
    expect(authed.status).toBe(200)
    expect(await authed.text()).toContain('shell')
  })

  test('#12: every encoding of the shell path is gated, not just the literal one', async () => {
    const h = await startPluginHarness()
    // Auth classifies the DECODED, RESOLVED asset, so these all resolve to
    // index.html and all must be 401. The old raw-string check let
    // `/index%2ehtml` and `/%69ndex.html` through with 200 (the static server
    // decoded, the auth check did not).
    const shellPaths = [
      '/',
      '/index.html',
      '/index%2ehtml',
      '/%69ndex.html',
      '/assets/../index.html',
      '/deep/link/that/does/not/exist',
    ]
    for (const pathname of shellPaths) {
      const anonymous = await fetch(`${h.base}${pathname}`, { redirect: 'manual' })
      expect([pathname, anonymous.status]).toEqual([pathname, 401])
      expect([pathname, (await anonymous.text()).toLowerCase().includes('not authorised')]).toEqual([pathname, true])

      const authed = await fetch(`${h.base}${pathname}`, { headers: { Cookie: cookieFor(h) } })
      expect([pathname, authed.status]).toEqual([pathname, 200])
      expect([pathname, await authed.text()]).toEqual([pathname, '<!doctype html><title>shell</title>\n'])
    }
  })

  test('#12: a real asset stays public under every encoding', async () => {
    const h = await startPluginHarness()
    for (const pathname of ['/assets/app.js', '/assets/%61pp.js', '/assets/./app.js']) {
      const response = await fetch(`${h.base}${pathname}`)
      expect([pathname, response.status]).toEqual([pathname, 200])
      expect([pathname, await response.text()]).toEqual([pathname, 'console.log(1)\n'])
    }
  })

  test('#12: HEAD is gated exactly like GET', async () => {
    const h = await startPluginHarness()
    for (const pathname of ['/', '/index%2ehtml', '/%69ndex.html']) {
      const anonymous = await fetch(`${h.base}${pathname}`, { method: 'HEAD', redirect: 'manual' })
      expect([pathname, anonymous.status]).toEqual([pathname, 401])
    }
  })

  test('every /api endpoint needs the cookie, including attachments and events', async () => {
    const h = await startPluginHarness()
    for (const pathname of [
      '/api/meta',
      '/api/graph',
      '/api/usage',
      '/api/runs',
      '/api/search?q=x',
      '/api/events',
      `/api/node/${'0'.repeat(26)}`,
      `/api/node/${'0'.repeat(26)}/file/x.txt`,
    ]) {
      const anonymous = await fetch(`${h.base}${pathname}`, { redirect: 'manual' })
      expect([pathname, anonymous.status]).toEqual([pathname, 401])
    }
    const authed = await fetch(`${h.base}/api/meta`, { headers: { Cookie: cookieFor(h) } })
    expect(authed.status).toBe(200)
  })

  test('a wrong cookie value is rejected (constant-time compare, not a prefix match)', async () => {
    const h = await startPluginHarness()
    for (const value of [h.token.slice(0, -1), `${h.token}x`, '', h.token.slice(0, 8)]) {
      const response = await fetch(`${h.base}/api/meta`, {
        headers: { Cookie: `${h.app.sessionCookieName()}=${value}` },
      })
      expect(response.status).toBe(401)
    }
  })

  test('static assets are served without the cookie; only the shell is gated', async () => {
    const h = await startPluginHarness()
    const asset = await fetch(`${h.base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('console.log')
  })

  test('SSE streams with the cookie and delivers hints', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/events`, {
      headers: { Cookie: cookieFor(h), Accept: 'text/event-stream' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && !text.includes('"kind":"graph"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel()
    expect(text).toContain(': connected')
    expect(text).toContain('"kind":"graph"')
  })
})

describe('plugin-mode payloads', () => {
  test('meta reports the plugin source and label with no config path or state dir', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/meta`, { headers: { Cookie: cookieFor(h) } })
    const meta = (await response.json()) as Meta
    expect(meta.source).toBe('plugin')
    expect(meta.label).toBe('opencode plugin')
    expect(meta.configPath).toBeUndefined()
    expect(meta.stateDir).toBeUndefined()
    expect(meta.graphRoot).toBe(h.graphRoot)
    // Two rows: the third record belongs to another graph.
    expect(meta.runCount).toBe(2)
  })

  test('runs are the usage log rows, sorted, with the null-usage run present', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/runs?from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z&sort=createdAt&dir=asc`, {
      headers: { Cookie: cookieFor(h) },
    })
    const page = (await response.json()) as RunsPage
    expect(page.unavailable).toBeUndefined()
    expect(page.runs.map((run) => run.taskId)).toEqual(['r1', 'm1'])
    expect(page.runs[0]?.usage).toMatchObject({ inputTokens: 900, cacheReadTokens: 100, totalTokens: 1090 })
    // Missing usage is null + unknown, never zero.
    expect(page.runs[1]?.usage).toBeNull()
    expect(page.runs[1]?.usageStatus).toBe('unknown')
    expect(page.runs[1]?.latencyMs).toBeNull()
  })

  test('usage aggregates read and manage separately', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/usage?from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z&tz=UTC`, {
      headers: { Cookie: cookieFor(h) },
    })
    const summary = (await response.json()) as UsageSummary
    expect(summary.unavailable).toBeUndefined()
    expect(summary.read.runs).toBe(1)
    expect(summary.manage.runs).toBe(1)
    expect(summary.combined.usageRuns).toEqual({ complete: 1, partial: 0, unknown: 1 })
    expect(summary.combined.totals.totalTokens).toBe(1090)
  })

  test('an unreadable usage directory reports unavailable with a plugin-mode warning', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'broken usage node')
    const real = path.join(base, 'real-usage')
    writeUsage(real, [record({ graphRoot })])
    const usageDir = path.join(base, 'usage')
    fs.symlinkSync(real, usageDir)

    const store = new Store({
      graphRoot,
      runs: new JsonlRunSource({ usageDir, graphRoot }),
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
    })
    try {
      expect(store.runsUnavailable()).toBe(true)
      expect(store.runs().warnings.join('\n')).toContain('symlink')
    } finally {
      store.close()
    }
  })
})

describe('Host allowlist (SEC-001, DNS rebinding)', () => {
  test('a foreign Host is refused with 403', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/meta`, {
      headers: { Cookie: cookieFor(h), Host: 'attacker.example' },
    })
    expect(response.status).toBe(403)
  })

  test('a foreign Host is refused on static paths too, and on the token exchange', async () => {
    const h = await startPluginHarness()
    for (const pathname of ['/', `/assets/app.js`, `/?t=${h.token}`]) {
      const response = await fetch(`${h.base}${pathname}`, {
        headers: { Host: `attacker.example:${h.port}` },
        redirect: 'manual',
      })
      expect([pathname, response.status]).toEqual([pathname, 403])
    }
  })

  test('the correct port under 127.0.0.1, localhost and [::1] is accepted', async () => {
    const h = await startPluginHarness()
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, `[::1]:${h.port}`]) {
      const response = await fetch(`${h.base}/api/meta`, { headers: { Cookie: cookieFor(h), Host: host } })
      expect([host, response.status]).toEqual([host, 200])
    }
  })

  test('the right host on the WRONG port is refused', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/meta`, {
      headers: { Cookie: cookieFor(h), Host: `127.0.0.1:${h.port + 1}` },
    })
    expect(response.status).toBe(403)
  })

  test('a request with NO Host header is refused (fail closed, not fail open)', async () => {
    // An HTTP/1.0 client sends no Host, so there is no name to check: serving it
    // would be exactly the DNS-rebinding hole the allowlist exists to close.
    const h = await startPluginHarness()
    const bare = new Request(`${h.base}/api/meta`, { headers: { Cookie: cookieFor(h) } })
    bare.headers.delete('host')
    const response = await h.app.handle(bare)
    expect(response.status).toBe(403)
  })

  test('an app that has not been told its port refuses everything until it is', async () => {
    // `port: 0` is "bound, but the caller has not reported the real port yet".
    // This used to mean "allow every host" — a permanent hole for any caller that
    // forgot `setListeningPort`. It is now a loud 403 instead.
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'unreported port node')
    const usageDir = path.join(base, 'usage')
    fs.mkdirSync(usageDir, { recursive: true })
    const store = new Store({
      graphRoot,
      runs: new JsonlRunSource({ usageDir, graphRoot }),
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
    })
    store.start()
    const app = createApp({ store, graphRoot, source: 'plugin', port: 0, token: 'tok-unreported' })
    try {
      // Same-origin Host for a port that is NOT 0 — still refused, because the
      // app does not know any port yet.
      for (const host of ['127.0.0.1:43191', 'localhost:43191', 'attacker.example']) {
        const response = await app.handle(
          new Request('http://127.0.0.1:43191/api/meta', { headers: { Host: host } }),
        )
        expect([host, response.status]).toEqual([host, 403])
      }
      // Shell and assets are refused too: no request of any kind gets through.
      const shell = await app.handle(new Request('http://127.0.0.1:43191/', { headers: { Host: '127.0.0.1:43191' } }))
      expect(shell.status).toBe(403)

      // Reporting the port opens it for that port only.
      app.setListeningPort(43191)
      const opened = await app.handle(
        new Request('http://127.0.0.1:43191/api/meta', {
          headers: { Host: '127.0.0.1:43191', Cookie: 'x' },
        }),
      )
      // 401 (no valid cookie), not 403: the Host check passed.
      expect(opened.status).toBe(401)
      const foreign = await app.handle(
        new Request('http://attacker.example/api/meta', { headers: { Host: 'attacker.example' } }),
      )
      expect(foreign.status).toBe(403)
    } finally {
      store.close()
    }
  })
})

describe('cross-site refusal (SEC-001)', () => {
  test('a cross-site Sec-Fetch-Site header is refused on /api/*', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/graph`, {
      headers: { Cookie: cookieFor(h), 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toContain('cross-site')
  })

  test('a foreign Origin is refused on /api/*', async () => {
    const h = await startPluginHarness()
    for (const origin of ['https://evil.example', `http://127.0.0.1:${h.port + 1}`, 'null']) {
      const response = await fetch(`${h.base}/api/graph`, {
        headers: { Cookie: cookieFor(h), Origin: origin },
      })
      expect([origin, response.status]).toEqual([origin, 403])
    }
  })

  test('a same-origin Origin is accepted', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/graph`, {
      headers: { Cookie: cookieFor(h), Origin: `http://127.0.0.1:${h.port}`, 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(response.status).toBe(200)
  })

  test('no CORS headers are ever emitted', async () => {
    const h = await startPluginHarness()
    for (const [pathname, headers] of [
      ['/api/meta', { Cookie: cookieFor(h), Origin: 'https://evil.example' }],
      ['/api/meta', { Cookie: cookieFor(h) }],
      ['/', { Cookie: cookieFor(h) }],
    ] as const) {
      const response = await fetch(`${h.base}${pathname}`, { headers })
      for (const name of response.headers.keys()) {
        expect(name.toLowerCase().startsWith('access-control-')).toBe(false)
      }
    }
  })
})

describe('anti-framing headers', () => {
  test('X-Frame-Options and a frame-ancestors CSP are on every response', async () => {
    const h = await startPluginHarness()
    for (const pathname of ['/', '/api/meta', '/assets/app.js']) {
      const response = await fetch(`${h.base}${pathname}`, { headers: { Cookie: cookieFor(h) } })
      expect([pathname, response.headers.get('x-frame-options')]).toEqual([pathname, 'DENY'])
      expect([pathname, response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")]).toEqual([pathname, true])
      expect([pathname, response.headers.get('x-content-type-options')]).toEqual([pathname, 'nosniff'])
    }
  })

  test('HTTP method handling keeps 405 and adds the headers', async () => {
    const h = await startPluginHarness()
    const response = await fetch(`${h.base}/api/meta`, {
      method: 'POST',
      headers: { Cookie: cookieFor(h) },
    })
    expect(response.status).toBe(405)
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('service mode is unchanged', () => {
  test('no token, no cookie: /api answers immediately and there is no label', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'service mode node')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(stateDir, { recursive: true })

    const store = new Store({
      graphRoot,
      stateDir,
      debounceMs: 20,
      reconcileMs: 600_000,
      taskPollMs: 600_000,
    })
    store.start()
    // Service mode differs from plugin mode only in the token: it still has to
    // report its port, exactly like the CLI does through `boot()`.
    const app = createApp({
      store,
      configPath: '/tmp/conf/test_1.json',
      graphRoot,
      stateDir,
      tz: 'UTC',
      port: 0,
    })
    const server = serveOnEphemeralPort(app, { idleTimeout: 30 })
    try {
      const metaResponse = await fetch(`http://127.0.0.1:${server.port}/api/meta`)
      expect(metaResponse.status).toBe(200)
      const meta = (await metaResponse.json()) as Meta
      expect(meta.source).toBe('service')
      expect(meta.configPath).toBe('/tmp/conf/test_1.json')
      expect(meta.stateDir).toBe(stateDir)
      expect(meta.label).toBeUndefined()

      // The service's "task database could not be opened" path is still reachable.
      const usage = (await (await fetch(`http://127.0.0.1:${server.port}/api/usage`)).json()) as UsageSummary
      expect(usage.unavailable).toBe(true)
      const warning = await fetch(`http://127.0.0.1:${server.port}/api/graph`)
      expect(warning.status).toBe(200)
    } finally {
      store.close()
      await server.stop(true)
    }
  })

  test('the token helpers compare exactly and parse cookies', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    expect(tokensMatch('abc', 'ab')).toBe(false)
    expect(tokensMatch('abc', null)).toBe(false)
    expect(cookieValue('a=1; mexplore_session=tok; b=2', 'mexplore_session')).toBe('tok')
    expect(cookieValue('a=1', 'mexplore_session')).toBeNull()
    expect(cookieValue(null, 'mexplore_session')).toBeNull()
  })
})
