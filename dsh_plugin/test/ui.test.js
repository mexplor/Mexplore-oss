/**
 * The memory-graph panel: manifest and patch entries, the Host routes under
 * /mexplor/api against a real graph over real HTTP, and the generated Client
 * module (loader registration, and a server render with React 18 when the
 * dev dependencies are installed).
 */
process.env.TZ = 'UTC'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { addEdge, attach, createNode, outEdges } from '../lib/graph.js'
import * as ui from '../lib/bundle/ui.js'
import { SETTINGS_SERVICE, state, withDefaults } from '../lib/bundle/state.js'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const hasModule = (name) => {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

let tmp
let graphRoot
const ids = {}
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-ui-'))
  graphRoot = path.join(tmp, 'graph')
  await fsp.mkdir(graphRoot)
  ids.a = await createNode(graphRoot, { description: 'Alex prefers tea over coffee', body: 'Oolong in the afternoon.', type: 'preference' })
  ids.b = await createNode(graphRoot, { description: 'Kickoff decision for the panel', body: 'Reuse mexplore_ui.', type: 'decision' })
  await attach(graphRoot, ids.b, 'notes.txt', 'hello from an attachment\n')
  await addEdge(graphRoot, ids.a, ids.b, { type: 'relates-to' })
})
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------- manifest

test('package.json exports the ui row, the client module and their display resources', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./ui'], './lib/bundle/ui.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.deepEqual(pkg.dsh.client, { platform: 'web', immediately: true, inject: [] })
  for (const lang of ['en', 'zh']) {
    const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, pkg.exports['./ui/locale/*.json'].replace('*', lang)), 'utf8')).meta
    assert.ok(meta.title && meta.description, `ui ${lang} metadata`)
  }
  assert.equal(pkg.exports['./ui/icon'], './icon.svg')
  assert.ok(pkg.files.includes('client.js'))
  assert.equal(pkg.scripts['build:ui'], 'node scripts/build-ui.mjs')
  assert.match(pkg.scripts.test, /test\/ui\.test\.js/)
  for (const dep of Object.keys(pkg.dependencies ?? {})) assert.fail(`runtime dependency ${dep}: the bundle must load without an install`)
})

test('the bundle patch inserts the ui row, on by default', () => {
  const text = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- id: memory-graph-ui\n\s+name: dsh-mexplore\n\s+config:\n\s+panel: true\n/)
})

// ---------------------------------------------------------------- config and graph root

test('ui config: defaults, and loud failures on unknown or malformed fields', () => {
  assert.deepEqual(ui.resolveUiConfig({}), { graphRoot: undefined, watch: true })
  assert.deepEqual(ui.resolveUiConfig({ graphRoot: '~/m', watch: false }), { graphRoot: '~/m', watch: false })
  assert.throws(() => ui.resolveUiConfig({ root: '/x' }), /unknown field `root`/)
  assert.throws(() => ui.resolveUiConfig({ graphRoot: '' }), /graphRoot/)
  assert.throws(() => ui.resolveUiConfig({ watch: 'yes' }), /watch/)
})

test('graph root: row config, then the memory agent row, then the direct row, then the default', () => {
  const ctxWith = (service) => ({ get: (key) => (key === SETTINGS_SERVICE ? service : undefined) })
  const saved = state.directGraphRoot
  try {
    state.directGraphRoot = '~/direct-graph'
    assert.equal(ui.currentGraphRoot(ctxWith(undefined), { graphRoot: '/explicit' }), path.resolve('/explicit'))
    assert.equal(ui.currentGraphRoot(ctxWith({ plugin: { graphRoot: '/agent-graph' } }), {}), path.resolve('/agent-graph'))
    assert.equal(ui.currentGraphRoot(ctxWith(undefined), {}), path.join(os.homedir(), 'direct-graph'))
    state.directGraphRoot = undefined
    assert.equal(ui.currentGraphRoot(ctxWith(undefined), {}), path.join(os.homedir(), withDefaults({}).graphRoot.slice(2)))
  } finally {
    state.directGraphRoot = saved
  }
})

// ---------------------------------------------------------------- Host routes over HTTP

/** A DSH web server stand-in: exact/prefix routes like dsh-host-webserver, on a real ephemeral port. */
async function startHost({ graphRootValue, rejection, config = {}, servicePort = false }) {
  const routes = []
  const effects = []
  let server
  const ctx = {
    webServer: {
      // dsh-host-webserver exposes `port` once bound; leave it out to test the socket fallback.
      get port() {
        return servicePort ? server?.address()?.port : undefined
      },
      register(route) {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
    connection: { requestRejection: () => rejection?.() },
    get: () => undefined,
    effect(fn) {
      effects.push(fn())
    },
  }
  ui.apply(ctx, { graphRoot: graphRootValue, ...config })
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const route = routes.find((r) => (r.kind === 'exact' ? pathname === r.path : pathname === r.path || pathname.startsWith(`${r.path}/`)))
    if (!route) {
      res.writeHead(404).end()
      return
    }
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    routes,
    async close() {
      for (const dispose of effects.reverse()) await dispose?.()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('the row registers one prefix route and serves meta, graph, node, file and search', async () => {
  const host = await startHost({ graphRootValue: graphRoot })
  try {
    assert.deepEqual(host.routes.map((r) => [r.kind, r.path]), [['prefix', '/mexplor/api']])

    const meta = await (await fetch(`${host.base}/mexplor/api/meta`)).json()
    assert.equal(meta.graphRoot, path.resolve(graphRoot))
    assert.equal(meta.nodeCount, 2)
    assert.equal(meta.runCount, 0)
    assert.equal(meta.source, 'service')

    const graph = await (await fetch(`${host.base}/mexplor/api/graph`)).json()
    assert.deepEqual(graph.nodes.map((n) => n.id).sort(), [ids.a, ids.b].sort())
    assert.equal(graph.edges.length, 1)

    const node = await (await fetch(`${host.base}/mexplor/api/node/${ids.b}`)).json()
    assert.equal(node.description, 'Kickoff decision for the panel')
    assert.ok(node.attachments.some((a) => a.name === 'notes.txt'))

    const file = await fetch(`${host.base}/mexplor/api/node/${ids.b}/file/notes.txt`)
    assert.equal(file.status, 200)
    assert.match(file.headers.get('content-type'), /^text\/plain/)
    assert.equal(await file.text(), 'hello from an attachment\n')

    const search = await (await fetch(`${host.base}/mexplor/api/search?q=oolong`)).json()
    assert.deepEqual(search.ids, [ids.a])

    const usage = await (await fetch(`${host.base}/mexplor/api/usage`)).json()
    assert.equal(usage.unavailable, true)
    const runs = await (await fetch(`${host.base}/mexplor/api/runs`)).json()
    assert.equal(runs.unavailable, true)
  } finally {
    await host.close()
  }
})

test('the panel and the graph engine count the same edges; a non-symlink entry points at graph-maintain', async () => {
  const root = path.join(tmp, 'nonsymlink-graph')
  await fsp.mkdir(root)
  const n = {}
  for (const k of ['a', 'b', 'c', 'd']) n[k] = await createNode(root, { description: `node ${k}` })
  await addEdge(root, n.a, n.b)
  await addEdge(root, n.b, n.c)
  await fsp.mkdir(path.join(root, n.a, '__edges__', n.c)) // hand-made directory "edge", both halves
  await fsp.mkdir(path.join(root, n.c, '__edges__', n.a))
  await fsp.writeFile(path.join(root, n.a, '__edges__', n.d), '') // and a file
  const engine = new Set()
  for (const id of Object.values(n)) for (const dst of await outEdges(root, id)) engine.add([id, dst].sort().join('|'))
  const host = await startHost({ graphRootValue: root })
  try {
    const graph = await (await fetch(`${host.base}/mexplor/api/graph`)).json()
    assert.equal(engine.size, 2)
    assert.equal(graph.edges.length, engine.size)
    const nonSymlink = graph.warnings.filter((w) => w.startsWith('edge entry is not a symlink'))
    assert.equal(nonSymlink.length, 3)
    for (const w of nonSymlink) assert.match(w, /run graph-maintain --apply/)
  } finally {
    await host.close()
  }
})

test('only GET and HEAD; HEAD has no body', async () => {
  const host = await startHost({ graphRootValue: graphRoot })
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${host.base}/mexplor/api/graph`, { method })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    }
    const head = await fetch(`${host.base}/mexplor/api/graph`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal((await head.arrayBuffer()).byteLength, 0)
  } finally {
    await host.close()
  }
})

/** Raw request, so the path reaches the server exactly as written (fetch would normalize it). */
function rawGet(base, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { path: rawPath }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('bad ids, traversal and paths outside the API are refused', async () => {
  const host = await startHost({ graphRootValue: graphRoot })
  try {
    assert.equal((await rawGet(host.base, '/mexplor/api/node/not-a-ulid')).status, 400)
    assert.equal((await rawGet(host.base, `/mexplor/api/node/${ids.b}/file/..%2F..%2Fnode.md`)).status, 400)
    assert.equal((await rawGet(host.base, `/mexplor/api/node/${ids.b}/file/node.md`)).status, 404)
    assert.equal((await rawGet(host.base, `/mexplor/api/node/${ids.b}/file/%2e%2e%2fnode.md`)).status, 400)
    // A bare `%2e%2e` segment is a dot segment: URL parsing resolves it inside the API.
    const dots = await rawGet(host.base, `/mexplor/api/node/${ids.b}/file/%2e%2e`)
    assert.equal(JSON.parse(dots.body).id, ids.b)
    assert.equal((await rawGet(host.base, '/mexplor/api/../../etc/passwd')).status, 404)
    assert.equal((await rawGet(host.base, '/mexplor/api/%2e%2e/%2e%2e/etc/passwd')).status, 404)
    assert.equal((await rawGet(host.base, '/mexplor/api')).status, 404)
    const nested = await rawGet(host.base, '/mexplor/api/nope')
    assert.equal(nested.status, 404)
  } finally {
    await host.close()
  }
})

test('a request the DSH connection rejects never reaches the graph', async () => {
  for (const status of [401, 403]) {
    const host = await startHost({ graphRootValue: graphRoot, rejection: () => status })
    try {
      const res = await fetch(`${host.base}/mexplor/api/graph`)
      assert.equal(res.status, status)
      assert.doesNotMatch(await res.text(), /tea|Kickoff/)
    } finally {
      await host.close()
    }
  }
})

/** Raw request with chosen headers: fetch will not send a Host of our choosing. */
function rawRequest(base, rawPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { path: rawPath, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('a Desktop-like request (Host app, Origin dsh-app://app) is served once the DSH connection check passes', async () => {
  for (const servicePort of [true, false]) {
    const host = await startHost({ graphRootValue: graphRoot, servicePort })
    try {
      const headers = { host: 'app', origin: 'dsh-app://app', referer: 'dsh-app://app/', 'sec-fetch-site': 'cross-site', cookie: 'dsh=1' }
      const graph = await rawRequest(host.base, '/mexplor/api/graph', headers)
      assert.equal(graph.status, 200, graph.body)
      assert.deepEqual(JSON.parse(graph.body).nodes.map((n) => n.id).sort(), [ids.a, ids.b].sort())
      const usage = await rawRequest(host.base, '/mexplor/api/usage', headers)
      assert.equal(usage.status, 200, usage.body)
      assert.equal(JSON.parse(usage.body).unavailable, true)
    } finally {
      await host.close()
    }
  }
})

/** createUiHandler with a spy in place of createMemoryGraphUi, on a real HTTP server. */
async function startSpy({ rejection, port } = {}) {
  const created = []
  const requests = []
  const createUi = (options) => {
    created.push(options)
    let current = options.port
    return {
      graphRoot: options.graphRoot,
      rootExisted: true,
      subscriberCount: 0,
      get port() {
        return current
      },
      setPort(next) {
        current = next
        created.push({ setPort: next })
      },
      async handle(request) {
        requests.push(request)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
      close() {},
    }
  }
  const handlerSet = ui.createUiHandler({ graphRoot: () => graphRoot, watch: false, reject: () => rejection, createUi, ...(port ? { port } : {}) })
  const server = http.createServer((req, res) => handlerSet.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    created,
    requests,
    async close() {
      handlerSet.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('the inner request is normalized: loopback Host on the real port, no Origin, Referer, Sec-Fetch or Cookie', async () => {
  const spy = await startSpy()
  try {
    const res = await rawRequest(spy.base, '/mexplor/api/search?q=tea', {
      host: 'app',
      origin: 'dsh-app://app',
      referer: 'dsh-app://app/',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      cookie: 'dsh_session=secret',
      authorization: 'Bearer x',
      accept: 'application/json',
    })
    assert.equal(res.status, 200)
    assert.equal(spy.created.length, 1)
    assert.equal(spy.created[0].port, spy.port)
    assert.ok(spy.created[0].port > 0)
    assert.equal(spy.requests.length, 1)
    const inner = spy.requests[0]
    assert.equal(inner.url, `http://127.0.0.1:${spy.port}/api/search?q=tea`)
    assert.deepEqual([...inner.headers.keys()].sort(), ['accept', 'host'])
    assert.equal(inner.headers.get('host'), `127.0.0.1:${spy.port}`)
    assert.equal(inner.headers.get('accept'), 'application/json')
    assert.deepEqual(ui.FORWARDED_HEADERS, ['accept'])
  } finally {
    await spy.close()
  }
})

test('the port comes from the web server service when it has one, and a change reaches the app', async () => {
  let servicePort = 4321
  const spy = await startSpy({ port: (req) => ui.listeningPort({ port: servicePort }, req) })
  try {
    assert.equal((await rawRequest(spy.base, '/mexplor/api/meta', {})).status, 200)
    assert.equal(spy.created[0].port, 4321)
    assert.equal(spy.requests[0].headers.get('host'), '127.0.0.1:4321')
    servicePort = 4322
    assert.equal((await rawRequest(spy.base, '/mexplor/api/meta', {})).status, 200)
    assert.deepEqual(spy.created[1], { setPort: 4322 })
    assert.equal(spy.requests[1].headers.get('host'), '127.0.0.1:4322')
  } finally {
    await spy.close()
  }
  assert.equal(ui.listeningPort(undefined, { socket: { localPort: 9 } }), 9)
  assert.equal(ui.listeningPort({ port: undefined }, { socket: {} }), undefined)
  assert.equal(ui.listeningPort({ port: 0 }, {}), undefined)
})

test('an unknown listening port is a 503, never a request with port 0', async () => {
  const spy = await startSpy({ port: () => undefined })
  try {
    assert.equal((await rawRequest(spy.base, '/mexplor/api/graph', {})).status, 503)
    assert.equal(spy.created.length, 0)
  } finally {
    await spy.close()
  }
})

test('a request the DSH connection check rejects never reaches createApp', async () => {
  for (const status of [401, 403]) {
    const spy = await startSpy({ rejection: status })
    try {
      const res = await rawRequest(spy.base, '/mexplor/api/graph', { host: 'app', origin: 'dsh-app://app' })
      assert.equal(res.status, status)
      assert.equal(spy.created.length, 0)
      assert.equal(spy.requests.length, 0)
    } finally {
      await spy.close()
    }
  }
})

test('a missing graph root is reported and never created; it is picked up once it exists', async () => {
  const missing = path.join(tmp, 'not-yet')
  const host = await startHost({ graphRootValue: missing })
  try {
    const graph = await (await fetch(`${host.base}/mexplor/api/graph`)).json()
    assert.deepEqual(graph.nodes, [])
    assert.ok(graph.warnings.some((w) => /unavailable/.test(w)), JSON.stringify(graph.warnings))
    await (await fetch(`${host.base}/mexplor/api/meta`)).json()
    assert.equal(fs.existsSync(missing), false)

    await fsp.mkdir(missing)
    await createNode(missing, { description: 'First memory after the panel opened', type: 'journal' })
    const later = await (await fetch(`${host.base}/mexplor/api/graph`)).json()
    assert.equal(later.nodes.length, 1)
  } finally {
    await host.close()
  }
})

/** Open the SSE stream and resolve with the socket plus a reader of decoded chunks. */
function openEvents(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/mexplor/api/events`, (res) => {
      res.setEncoding('utf8')
      const chunks = []
      const waiters = []
      res.on('data', (chunk) => {
        chunks.push(chunk)
        for (const w of [...waiters]) if (w.test(chunks.join(''))) waiters.splice(waiters.indexOf(w), 1) && w.resolve()
      })
      resolve({
        res,
        req,
        text: () => chunks.join(''),
        until(pattern, ms) {
          return new Promise((ok, fail) => {
            const w = { test: (t) => pattern.test(t), resolve: ok }
            if (w.test(chunks.join(''))) return ok()
            waiters.push(w)
            setTimeout(() => fail(new Error(`no ${pattern} in ${ms} ms: ${JSON.stringify(chunks.join(''))}`)), ms).unref()
          })
        },
      })
    })
    req.on('error', reject)
  })
}

test('events: the stream opens with a graph hint, reports a new node, and leaves no subscriber when closed', { timeout: 30_000 }, async () => {
  const live = path.join(tmp, 'live')
  await fsp.mkdir(live)
  await createNode(live, { description: 'Seed node for the live test', type: 'trivia' })
  const handlerSet = ui.createUiHandler({ graphRoot: () => live, watch: true })
  const server = http.createServer((req, res) => handlerSet.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const stream = await openEvents(base)
    assert.equal(stream.res.headers['content-type'], 'text/event-stream; charset=utf-8')
    await stream.until(/data: \{"kind":"graph"\}/, 5_000)
    assert.equal(handlerSet.instance.subscriberCount, 1)

    const before = stream.text().length
    await createNode(live, { description: 'Node written while the panel watches', type: 'journal' })
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        if (/data: \{"kind":"(graph|node)"/.test(stream.text().slice(before))) {
          clearInterval(iv)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(iv)
        reject(new Error('no live update within 15 s'))
      }, 15_000).unref()
    })

    stream.req.destroy()
    const deadline = Date.now() + 5_000
    while (handlerSet.instance.subscriberCount !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    assert.equal(handlerSet.instance.subscriberCount, 0)

    handlerSet.sweep(0)
    assert.equal(handlerSet.instance, null)
  } finally {
    handlerSet.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---------------------------------------------------------------- generated files

test('lib/ui-server.js is plain Node: no Bun, only node: built-ins', async () => {
  const text = fs.readFileSync(path.join(pkgDir, 'lib/ui-server.js'), 'utf8')
  assert.doesNotMatch(text, /\bbun:/)
  if (hasModule('esbuild')) {
    const { assertNoBun } = await import('../scripts/build-ui.mjs')
    await assertNoBun(text, 'lib/ui-server.js')
  }
  const imports = [...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  for (const spec of imports) assert.match(spec, /^node:/, spec)
})

/** Evaluate client.js the way the Web client does, against a stand-in module loader. */
function loadClient(requireImpl) {
  const source = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8')
  const loads = []
  const fakeWindow = Object.create(globalThis.window ?? null)
  fakeWindow.__ModuleLoader__ = { load: (mod) => loads.push(mod) }
  // A classic script referencing `window`; `new Function` both compiles and scopes it.
  new Function('window', source)(fakeWindow)
  assert.equal(loads.length, 1)
  const mod = loads[0]
  return { mod, plugin: mod.factory(requireImpl) }
}

function fakeSlots() {
  const registered = []
  return {
    registered,
    slots: {
      inject(owner, fn) {
        fn()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

test('client.js registers module dsh-mexplore with a sidebar entry and a main panel', () => {
  const stubReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Component: class {},
  }
  const requested = []
  const { mod, plugin } = loadClient((name) => {
    requested.push(name)
    return name === 'react' ? stubReact : {}
  })
  assert.equal(mod.id, 'dsh-mexplore')
  assert.deepEqual(plugin.inject, ['slots'])
  // The factory must not evaluate the bundled explorer (d3, marked, ...) yet.
  assert.deepEqual(requested, ['react', 'react/jsx-runtime'])

  const { registered, slots } = fakeSlots()
  for (const lang of ['zh-CN', 'en']) {
    registered.length = 0
    plugin.apply({ slots, get: (key) => (key === 'locale' ? { getLocale: () => ({ id: lang }) } : undefined) })
    const sidebar = registered.find((r) => r.options.name === 'sidebar.panellist')
    const main = registered.find((r) => r.options.name === 'main')
    assert.equal(sidebar.options.id, 'memory-graph')
    assert.equal(main.options.key, 'memory-graph')
    assert.equal(sidebar.options.label(), 'Mexplore')
    assert.equal(typeof main.component, 'function')
  }
})

test('client.js renders the panel with React 18 and reads the graph through /mexplor/api', { skip: !hasModule('react-test-renderer') && 'react-test-renderer not installed (npm install for dev dependencies)' }, async () => {
  const React = require('react')
  const renderer = require('react-test-renderer')
  assert.match(React.version, /^18\./)
  const host = await startHost({ graphRootValue: graphRoot })
  const saved = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  const fetched = []
  const sources = []
  try {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.window = { innerWidth: 1440, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {} }
    globalThis.fetch = (url, init) => {
      fetched.push(url)
      return saved.fetch(host.base + url, init)
    }
    globalThis.EventSource = class {
      constructor(url) {
        this.url = url
        this.onopen = this.onerror = this.onmessage = null
        sources.push(this)
      }
      close() {
        this.closed = true
      }
    }
    const table = { react: React, 'react/jsx-runtime': require('react/jsx-runtime') }
    const { plugin } = loadClient((name) => table[name])
    const { registered, slots } = fakeSlots()
    plugin.apply({ slots, get: () => undefined })
    const main = registered.find((r) => r.options.name === 'main')

    let tree
    await renderer.act(async () => {
      tree = renderer.create(React.createElement(main.component))
    })
    const deadline = Date.now() + 5_000
    const text = () => JSON.stringify(tree.toJSON())
    while (!text().includes('Alex prefers tea over coffee') && Date.now() < deadline) {
      await renderer.act(() => new Promise((r) => setTimeout(r, 25)))
    }
    assert.match(text(), /Alex prefers tea over coffee/)
    assert.match(text(), /mxg-root/)
    assert.ok(fetched.includes('/mexplor/api/meta') && fetched.includes('/mexplor/api/graph'), JSON.stringify(fetched))
    assert.ok(fetched.every((u) => u.startsWith('/mexplor/api/')), JSON.stringify(fetched))
    assert.deepEqual(sources.map((s) => s.url), ['/mexplor/api/events'])

    await renderer.act(async () => {
      tree.unmount()
    })
    assert.equal(sources[0].closed, true)
    const icon = registered.find((r) => r.options.name === 'sidebar.panellist')
    assert.equal(renderer.create(React.createElement(icon.component, { size: 18 })).toJSON().type, 'svg')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    await host.close()
  }
})

test('the bun:sqlite task reader is swapped by resolved path, whatever the import text', { skip: (!hasModule('esbuild') || !fs.existsSync(path.join(pkgDir, '../mexplore_ui/src'))) && 'build tools or mexplore_ui sources not present' }, async () => {
  const esbuild = require('esbuild')
  const { tasksStubPlugin } = await import('../scripts/build-ui.mjs')
  const dir = await fsp.mkdtemp(path.join(tmp, 'stub-'))
  const tasksFile = path.join(pkgDir, '../mexplore_ui/src/server/usage/tasks.ts')
  await fsp.writeFile(path.join(dir, 'tasks.ts'), 'export const local = "own tasks file"\n')
  await fsp.writeFile(path.join(dir, 'entry.js'), `import { readTasks } from ${JSON.stringify(tasksFile.slice(0, -3))}\nimport { local } from './tasks.ts'\nexport { readTasks, local }\n`)
  const stats = { swapped: 0 }
  const out = await esbuild.build({ entryPoints: [path.join(dir, 'entry.js')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', nodePaths: [path.join(pkgDir, 'node_modules')], plugins: [tasksStubPlugin(stats)] })
  const text = out.outputFiles[0].text
  assert.equal(stats.swapped, 1)
  assert.match(text, /own tasks file/)
  assert.doesNotMatch(text, /bun:sqlite/)
})

test('the committed client.js and lib/ui-server.js match a fresh build', { skip: (!hasModule('esbuild') || !fs.existsSync(path.join(pkgDir, '../mexplore_ui/src'))) && 'build tools or mexplore_ui sources not present' }, async () => {
  const { buildUi } = await import('../scripts/build-ui.mjs')
  const { serverText, clientText, css } = await buildUi({ write: false })
  assert.equal(serverText, fs.readFileSync(path.join(pkgDir, 'lib/ui-server.js'), 'utf8'), 'run npm run build:ui')
  assert.equal(clientText, fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8'), 'run npm run build:ui')
  assert.doesNotMatch(css, /(^|[\s,}])(:root|html|body)\s*[{,]/)
  for (const name of ['ping', 'blink', 'spin', 'rise', 'halo', 'slide-in', 'sheet-in']) {
    assert.doesNotMatch(css, new RegExp(`@keyframes ${name}\\b`))
    assert.match(css, new RegExp(`@keyframes mxg-${name}\\b`))
  }
})
