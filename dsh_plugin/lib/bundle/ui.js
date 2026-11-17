/**
 * Bundle row: the read-only data routes behind the memory-graph panel.
 *
 * The panel itself is the Client module in client.js (sidebar icon + main
 * panel). This row serves what it reads, under the DSH web server's prefix
 * route `/mexplor/api/...`: mexplore_ui's read-only API (meta, graph,
 * node/:id, node/:id/file/:name, search, events), compiled for Node into
 * lib/ui-server.js. No extra process and no Bun.
 *
 * Config (all optional):
 *   graphRoot   graph to show. Default: the memory agent row's graph root when
 *               that row is on, else the direct tools row's, else
 *               ~/.dsh/memory-graph.
 *   watch       live updates through a filesystem watch (default true); false
 *               rescans the graph on each graph read instead.
 *
 * Requests pass the same Host/Origin and browser-login check as DSH's own API
 * (`connection.requestRejection`). Only GET and HEAD are served, nothing is
 * written, and a missing graph root is reported, never created. The scan and
 * the watch start on the first request, and stop after ten idle minutes with
 * no open event stream.
 *
 * Behind that check this row acts as a reverse proxy in front of mexplore_ui's
 * createApp (see `innerRequest`): createApp's own Host/Origin check (SEC-001)
 * defends a standalone loopback server against DNS rebinding and only accepts
 * `Host: 127.0.0.1:<its port>` with no foreign Origin. Inside DSH that job is
 * done by `connection.requestRejection`, which runs first and knows every DSH
 * transport (DSH Web, remote access, the Desktop `dsh-app://app/` origin). So
 * the browser's Host, Origin, Referer, Sec-Fetch-* and Cookie headers are not
 * forwarded: the inner request names `http://127.0.0.1:<DSH's listening port>`
 * and carries only an allowlist of headers createApp needs.
 *
 * @module dsh-mexplore/ui
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createMemoryGraphUi } from '../ui-server.js'
import { SETTINGS_SERVICE, state, withDefaults } from './state.js'

export const name = 'memory-graph-ui'
export const inject = ['webServer', 'connection']

/** Route owned on the web server; the panel's API base. */
export const ROUTE_PREFIX = '/mexplor/api'
/** Part of the request path stripped before mexplore_ui's router sees `/api/...`. */
const MOUNT = '/mexplor'
export const IDLE_CLOSE_MS = 10 * 60 * 1000

const KNOWN = new Set(['graphRoot', 'watch'])

export function resolveUiConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('memory-graph-ui config must be an object')
  for (const key of Object.keys(config)) {
    if (!KNOWN.has(key)) throw new Error(`memory-graph-ui config: unknown field \`${key}\``)
  }
  if (config.graphRoot !== undefined && (typeof config.graphRoot !== 'string' || config.graphRoot === '')) {
    throw new Error('memory-graph-ui config: `graphRoot` must be a non-empty string')
  }
  if (config.watch !== undefined && typeof config.watch !== 'boolean') {
    throw new Error('memory-graph-ui config: `watch` must be a boolean')
  }
  return { graphRoot: config.graphRoot, watch: config.watch !== false }
}

/** Same resolution as the core plugin's `graphRoot`: leading `~`, then absolute. */
export function resolveRootPath(raw) {
  let target = raw
  if (target === '~') target = os.homedir()
  else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2))
  return path.resolve(target)
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/** Which graph the panel shows; read per request because the other rows can switch at any time. */
export function currentGraphRoot(ctx, settings) {
  const agentRoot = safeGet(ctx, SETTINGS_SERVICE)?.plugin?.graphRoot
  const raw = settings.graphRoot ?? agentRoot ?? state.directGraphRoot ?? withDefaults({}).graphRoot
  return resolveRootPath(raw)
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(res.req?.method === 'HEAD' ? undefined : body)
}

/** Write a Fetch Response to a node:http response, cancelling the body when the client goes away. */
export async function pipeResponse(response, res, method) {
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
  if (method === 'HEAD' || response.body === null) {
    if (response.body !== null) await response.body.cancel().catch(() => {})
    res.end()
    return
  }
  const reader = response.body.getReader()
  let closed = false
  const onClose = () => {
    closed = true
    reader.cancel().catch(() => {})
  }
  res.once('close', onClose)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || closed) break
      if (!res.write(value)) {
        await new Promise((resolve) => {
          res.once('drain', resolve)
          res.once('close', resolve)
        })
      }
    }
  } catch {
    // the stream was cancelled because the client left
  } finally {
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}

/**
 * Browser headers copied onto the inner request. createApp reads only `host`,
 * `origin`, `sec-fetch-site` and `cookie` (mexplore_ui/src/server/app.ts); the
 * first is written here, the other three are exactly what must not pass (see
 * the module comment). `accept` is harmless and kept for content negotiation.
 */
export const FORWARDED_HEADERS = ['accept']

/** The port DSH's web server listens on: the service's own value, else the socket's. */
export function listeningPort(webServer, req) {
  const fromService = webServer?.port
  if (Number.isInteger(fromService) && fromService > 0) return fromService
  const fromSocket = req?.socket?.localPort
  if (Number.isInteger(fromSocket) && fromSocket > 0) return fromSocket
  return undefined
}

/**
 * The request createApp sees, built only after the DSH connection check passed:
 * loopback URL and Host on DSH's own port, the `/mexplor` mount removed, and
 * only the allowlisted headers.
 */
export function innerRequest(req, pathAndQuery, method, port) {
  const headers = { host: `127.0.0.1:${port}` }
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers?.[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  if (headers.accept === undefined) headers.accept = '*/*'
  return new Request(`http://127.0.0.1:${port}${pathAndQuery}`, { method, headers })
}

/**
 * The request handler, separated from Cordis for tests.
 * @param {object} deps
 * @param {() => string} deps.graphRoot - the root to show for this request
 * @param {boolean} deps.watch
 * @param {(req: import('node:http').IncomingMessage) => (401|403|undefined)} [deps.reject]
 * @param {(req: import('node:http').IncomingMessage) => (number|undefined)} [deps.port] - DSH's listening port
 * @param {typeof createMemoryGraphUi} [deps.createUi] - test seam
 */
export function createUiHandler({ graphRoot, watch, reject = () => undefined, port = (req) => listeningPort(undefined, req), createUi = createMemoryGraphUi, now = Date.now }) {
  let current = null
  let lastUsed = 0

  function instanceFor(root, listening) {
    // A root that did not exist when scanned is re-checked on each request, so
    // the panel picks the graph up as soon as the memory tools create it.
    if (current && (current.graphRoot !== root || (!current.rootExisted && fs.existsSync(root)))) {
      current.close()
      current = null
    }
    if (!current) current = createUi({ graphRoot: root, watch, port: listening })
    else if (current.port !== listening) current.setPort(listening)
    return current
  }

  async function handler(req, res) {
    const rejection = reject(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
      return
    }
    let url
    try {
      // WHATWG parsing collapses `..` and `%2e%2e` before the prefix check.
      url = new URL(req.url ?? '/', 'http://dsh.invalid')
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const listening = port(req)
    if (listening === undefined) {
      sendJson(res, 503, { error: 'listening port unknown' })
      return
    }
    try {
      const ui = instanceFor(graphRoot(), listening)
      lastUsed = now()
      const response = await ui.handle(innerRequest(req, url.pathname.slice(MOUNT.length) + url.search, method, listening))
      await pipeResponse(response, res, method)
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
      else if (!res.writableEnded) res.end()
    }
  }

  return {
    handler,
    /** Close the scan and watch when nobody used them for `idleMs` and no event stream is open. */
    sweep(idleMs = IDLE_CLOSE_MS) {
      if (current && current.subscriberCount === 0 && now() - lastUsed >= idleMs) {
        current.close()
        current = null
      }
    },
    get instance() {
      return current
    },
    close() {
      current?.close()
      current = null
    },
  }
}

export function apply(ctx, config = {}) {
  const settings = resolveUiConfig(config)
  const ui = createUiHandler({
    graphRoot: () => currentGraphRoot(ctx, settings),
    watch: settings.watch,
    reject: (req) => ctx.connection.requestRejection(req),
    // Read per request: the service knows its port only once it has bound.
    port: (req) => listeningPort(ctx.webServer, req),
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: ui.handler }))
  ctx.effect(() => {
    const timer = setInterval(() => ui.sweep(), 60_000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      ui.close()
    }
  })
}
