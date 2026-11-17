// HTTP surface (SEC-001, SEC-002, §4 contracts).
//
// Only GET and HEAD. Every path-driven filesystem read goes through `SafeRoot`
// (fs-safe.ts) after identifier validation in guard.ts. No handler writes to
// disk, to the graph or to the state directory.

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

import type {
  Attachment,
  GraphResponse,
  Meta,
  NodeDetail,
  RunsPage,
  RunSourceKind,
  RunSummary,
  SearchResponse,
  SseEvent,
  Usage,
  UsageStatus,
} from '../shared/types.ts'
import { SafeRoot, type TrustedRoot } from './fs-safe.ts'
import { readProvenance } from './graph/provenance.ts'
import { isSinglePathSegment, isValidAttachmentName, isValidNodeId } from './guard.ts'
import type { Store } from './store.ts'
import {
  MAX_DAY_BUCKETS,
  buildUsageSummary,
  countDayBuckets,
  defaultRange,
  parseInstant,
} from './usage/stats.ts'

export interface AppOptions {
  store: Store
  /** Absent in plugin mode: there is no config file to show. */
  configPath?: string
  graphRoot: string
  /** Absent in plugin mode: the run source is the usage JSONL, not a state dir. */
  stateDir?: string
  /**
   * Which deployment is served. Defaults to `store.source`, which is what the
   * Store's run source says; `Meta.source` and the unavailable wording follow it.
   */
  source?: RunSourceKind
  /** Source label shown instead of the config name, e.g. `opencode plugin`. */
  label?: string
  /** Directory holding the built UI. Absent -> 503 text for non-/api GETs. */
  distDir?: string
  /** Root identity pinned at startup; a replaced graph root is refused (#1). */
  graphTrust?: TrustedRoot | null
  /** Server-local IANA zone reported as `tz`. */
  tz?: string
  now?: () => number
  /**
   * The listening server, when available. Used only to opt the SSE stream out of
   * Bun's per-request idle timer (`server.timeout(request, 0)`).
   */
  server?: { timeout?(request: Request, seconds: number): void }
  /**
   * Plugin mode's capability token. When present every `/api/*` request (and
   * `/api/events`) must carry it in this server's session cookie, and `index.html`
   * is 401 without it; `/?t=<token>` exchanges the query token for that cookie
   * and redirects to `/`. Absent means service mode, where the UI is reachable at
   * a plain loopback URL (the original behaviour).
   */
  token?: string
  /**
   * Port the server listens on — the only port the Host header may name (SEC-001).
   *
   * REQUIRED: an app that does not know its port cannot police the Host header,
   * so there is no "omitted" case that silently allows every host. A caller that
   * only learns the port after binding (the normal `Bun.serve({ port: 0 })`
   * sequence) passes `0` and then calls `setListeningPort`; while the port is `0`
   * EVERY request is refused, so a forgotten `setListeningPort` is a loud 403
   * rather than a permanent hole.
   */
  port: number
}

export interface HeadersLike {
  get(name: string): string | null
}

export interface RequestLike {
  method: string
  url: string
  headers: HeadersLike
}

const MAX_ATTACHMENT_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const MAX_RUN_LIMIT = 200
const DEFAULT_RUN_LIMIT = 50
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  })
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  })
}

function notFound(): Response {
  return json({ error: 'not found' }, 404)
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

/** Decode a path segment; null when the escaping is malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// ---- anti-framing / transport headers (item 4) ---------------------------

/**
 * Headers every response carries.
 *
 * The UI is a loopback page that renders a user's memory: it must never be
 * framed by another origin (clickjacking the node list or, worse, the
 * attachments view), and it must never be a CORS target — a page on
 * `evil.example` that can read `/api/graph` has already exfiltrated the graph.
 * `Content-Security-Policy` also forbids being the FRAME, and no
 * `Access-Control-Allow-*` header is ever emitted: cross-origin `fetch` from a
 * browser therefore fails at the preflight/response-read step.
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/**
 * Add the static security headers to a response this module built.
 *
 * The Web API's `Response` headers are immutable, so this rebuilds the response
 * around the same body. Any `Access-Control-*` header is stripped: the UI must
 * never be a CORS target, because a page on another origin that can READ
 * `/api/graph` has already exfiltrated the graph.
 */
function withHeaders(response: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) headers.set(name, value)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('access-control-')) headers.delete(name)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Plugin mode's CSP. The built bundle ships its own JS/CSS, and the React app
 * needs inline styles (`style=` attributes d3 writes), so `style-src` allows
 * `'unsafe-inline'`; there is no inline `<script>` in the build, so scripts stay
 * `'self'`-only. `connect-src 'self'` is what the SSE stream needs.
 */
const PLUGIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/** Service mode keeps its historical (script-free) page model but still refuses framing. */
const SERVICE_CSP = "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

const SESSION_COOKIE_PREFIX = 'mexplore_session'

/**
 * Cookie name for one server instance.
 *
 * Cookies are NOT port-scoped: two servers on 127.0.0.1 with the same cookie
 * name and `Path=/` overwrite each other, so opening a second dashboard (another
 * graph, another plugin instance) silently logs the first one out — its `/api/*`
 * and SSE requests start answering 401. The name therefore carries the listening
 * port, which is exactly what distinguishes two loopback servers; a plugin
 * reload onto the same port reuses the name, which is correct because the old
 * server is gone. An instance that never learned its port falls back to a
 * per-instance random suffix.
 */
export function sessionCookieNameFor(suffix: string | number): string {
  return `${SESSION_COOKIE_PREFIX}_${suffix}`
}

/** Constant-time comparison of a presented token against the expected one. */
export function tokensMatch(expected: string, presented: string | null | undefined): boolean {
  if (presented === null || presented === undefined) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, and the length of the expected
  // token is not a secret (it is fixed and documented), so the early return is safe.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** Parse a `Cookie:` header into name -> value. First occurrence wins. */
export function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

export function createApp(options: AppOptions) {
  const { store, configPath, graphRoot, stateDir } = options
  const tz = options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const now = options.now ?? Date.now
  const source: RunSourceKind = options.source ?? store.source ?? 'service'
  const label = options.label ?? null
  const token = options.token ?? null
  // Mutable only because a caller that binds port 0 learns the real port after
  // `Bun.serve` returns; it must then call `setListeningPort`. Until it does, the
  // Host/Origin checks FAIL CLOSED (403): an unknown port must never mean
  // "any host is fine", or a forgotten call is a permanent DNS-rebinding hole.
  let port = options.port
  /**
   * The session cookie's name, fixed at the first authenticated use.
   *
   * Cookies are not port-scoped, so a shared name would let a second dashboard on
   * the same host overwrite the first one's cookie and log it out. A known port
   * identifies the instance (and a plugin reload onto the same port correctly
   * reuses the name, because the old server is gone); an instance that never
   * learns its port gets a per-instance random suffix instead, so two of them
   * still cannot collide.
   *
   * Resolved lazily because a `port: 0` caller learns the real port after binding,
   * and memoised so the exchange and the validation can never disagree: only a
   * request that passed the Host allowlist (which requires a known port) can
   * reach this, so the memo is always the port name in practice.
   */
  const cookieSuffixFallback = `i${crypto.randomBytes(8).toString('hex')}`
  let cookieNameValue: string | null = null
  function sessionCookieName(): string {
    cookieNameValue ??= sessionCookieNameFor(port > 0 ? port : cookieSuffixFallback)
    return cookieNameValue
  }
  const distDirRaw = options.distDir ?? null
  const csp = token === null ? SERVICE_CSP : PLUGIN_CSP
  // Canonical form: on macOS /var is a symlink to /private/var, so a lexical
  // containment check against the un-resolved path would reject every asset.
  let distDir: string | null = null
  if (distDirRaw !== null) {
    try {
      distDir = fs.realpathSync(distDirRaw)
    } catch {
      distDir = distDirRaw
    }
  }

  /** Attach the app's static security headers (plus this deployment's CSP). */
  function secured(response: Response, extra: Record<string, string> = {}): Response {
    return withHeaders(response, { 'Content-Security-Policy': csp, ...extra })
  }

  // ---- endpoint handlers -------------------------------------------------

  function meta(): Meta {
    return {
      ...(configPath === undefined ? {} : { configPath }),
      graphRoot,
      ...(stateDir === undefined ? {} : { stateDir }),
      nodeCount: store.graph().nodes.length,
      runCount: store.runs().runs.length,
      serverTime: new Date(now()).toISOString(),
      tz,
      source,
      ...(label === null ? {} : { label }),
    }
  }

  function graphResponse(): GraphResponse {
    const snapshot = store.graph()
    return {
      nodes: snapshot.publicNodes,
      edges: snapshot.edges,
      openHandoffs: snapshot.openHandoffs,
      warnings: [...snapshot.warnings, ...store.runs().warnings, ...store.healthWarnings()],
      generation: snapshot.generation,
    }
  }

  function nodeDetail(id: string): NodeDetail | null {
    const node = store.graph().nodeById.get(id)
    if (node === undefined) return null
    return {
      id: node.id,
      description: node.description,
      type: node.type,
      created: node.created,
      updated: node.updated,
      superseded: node.superseded,
      supersededBy: node.supersededBy,
      openHandoff: node.openHandoff,
      degree: node.degree,
      attachmentCount: node.attachmentCount,
      mapRank: node.mapRank,
      visitCount: node.visitCount,
      body: node.body,
      frontmatter: node.frontmatter,
      attachments: node.attachments.map((attachment) => ({ ...attachment })),
      neighbours: node.neighbours.map((neighbour) => ({ ...neighbour })),
      recentAccess: node.recentAccess.map((event) => ({ ...event })),
      // Read per request, not from the snapshot: provenance appends never
      // trigger a graph rescan, and the file is bounded and guarded (SEC-003).
      provenance: readProvenance(SafeRoot.open(graphRoot, options.graphTrust ?? null), node.id),
    }
  }

  function attachmentOf(id: string, name: string): Attachment | undefined {
    const node = store.graph().nodeById.get(id)
    return node?.attachments.find((attachment) => attachment.name === name)
  }

  /**
   * Raw attachment text. The name must already be in the node's attachment
   * listing (which excludes dotfiles, directories and symlinks), be a single
   * segment, and resolve inside graph.root through `SafeRoot` — a symlink
   * escape, a symlink alias of a forbidden file, or an oversized file is refused.
   */
  function attachmentResponse(id: string, rawName: string): Response {
    if (!isValidNodeId(id)) return badRequest('invalid node id')
    const name = decodeSegment(rawName)
    // A traversal or separator is a malformed request (400); a well-formed name
    // that is not an attachment — a dotfile, a directory, `accessed.log` — is a
    // miss (404), because it can never be served.
    if (name === null || !isSinglePathSegment(name)) return badRequest('invalid attachment name')
    if (!isValidAttachmentName(name)) return notFound()
    // Only files the last snapshot listed as attachments are servable, so a file
    // created after the snapshot (or a permanent decoy) is not reachable here.
    if (attachmentOf(id, name) === undefined) return notFound()

    // Anchored open: if the graph root was moved aside and replaced by a symlink,
    // this refuses rather than serving the outside tree's bytes (#1).
    const root = SafeRoot.open(graphRoot, options.graphTrust ?? null)
    if (root === null) return notFound()
    const read = root.readBytes(path.posix.join(id, name), MAX_ATTACHMENT_BYTES)
    if (!read.ok || read.bytes === undefined) return notFound()

    const slice = read.bytes
    const size = read.size ?? slice.byteLength
    const sniff = slice.subarray(0, Math.min(slice.byteLength, BINARY_SNIFF_BYTES))
    if (sniff.includes(0)) {
      // Binary attachment: metadata only (edge case "Binary files show metadata only").
      return json(
        { error: 'binary attachment', name, size, mtime: new Date(read.mtimeMs ?? 0).toISOString() },
        415,
      )
    }
    const truncated = size > MAX_ATTACHMENT_BYTES
    return new Response(slice.toString('utf8'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-File-Size': String(size),
        ...(truncated ? { 'X-Truncated': '1' } : {}),
      },
    })
  }

  /**
   * Day-bucket zone. The server's local zone is the contract's `tz`; an
   * explicit `?tz=` overrides it so the bucketing rule is directly testable
   * (AC-020 states the Shanghai case). An unknown zone falls back to the server's.
   */
  function zoneFor(url: URL): string {
    const requested = url.searchParams.get('tz')
    if (requested === null || requested.trim() === '') return tz
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: requested })
      return requested
    } catch {
      return tz
    }
  }

  function usageResponse(url: URL): Response {
    const range = defaultRange(now())
    const fromParam = parseInstant(url.searchParams.get('from'))
    const toParam = parseInstant(url.searchParams.get('to'))
    const from = fromParam ?? range.from
    const to = toParam ?? range.to
    if (to <= from) return badRequest('to must be after from')
    const zone = zoneFor(url)

    // Reject an unchartable window instead of aggregating one range and charting
    // a truncated part of it (#14).
    const bucketCount = countDayBuckets(from, to, zone)
    if (bucketCount > MAX_DAY_BUCKETS) {
      return json(
        {
          error: `range spans ${bucketCount} days; the maximum is ${MAX_DAY_BUCKETS} — narrow from/to`,
          buckets: bucketCount,
          maxBuckets: MAX_DAY_BUCKETS,
        },
        400,
      )
    }

    const snapshot = store.runs()
    if (store.runsUnavailable()) {
      const summary = buildUsageSummary({
        runs: [],
        from,
        to,
        tz: zone,
        warnings: snapshot.warnings,
        unavailable: true,
      })
      return json(summary)
    }
    return json(
      buildUsageSummary({
        runs: snapshot.runs,
        from,
        to,
        tz: zone,
        warnings: snapshot.warnings,
      }),
    )
  }

  const SORT_KEYS = new Set(['createdAt', 'totalTokens', 'latencyMs'])

  function runsResponse(url: URL): Response {
    const params = url.searchParams
    const offsetRaw = Number.parseInt(params.get('offset') ?? '0', 10)
    const limitRaw = Number.parseInt(params.get('limit') ?? String(DEFAULT_RUN_LIMIT), 10)
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_RUN_LIMIT) : DEFAULT_RUN_LIMIT
    const sortRaw = params.get('sort') ?? 'createdAt'
    const sort = SORT_KEYS.has(sortRaw) ? (sortRaw as 'createdAt' | 'totalTokens' | 'latencyMs') : 'createdAt'
    const dirRaw = params.get('dir') ?? 'desc'
    const dir = dirRaw === 'asc' ? 'asc' : 'desc'

    if (store.runsUnavailable()) {
      const page: RunsPage = { total: 0, offset, limit, runs: [], unavailable: true }
      return json(page)
    }

    const range = defaultRange(now())
    const from = parseInstant(params.get('from')) ?? range.from
    const to = parseInstant(params.get('to')) ?? range.to
    if (to <= from) return badRequest('to must be after from')

    const inWindow = store
      .runs()
      .runs.filter((run) => {
        const created = Date.parse(run.createdAt)
        return !Number.isNaN(created) && created >= from && created < to
      })

    const valueOf = (run: RunSummary): number | null => {
      if (sort === 'createdAt') {
        const ms = Date.parse(run.createdAt)
        return Number.isNaN(ms) ? null : ms
      }
      if (sort === 'latencyMs') return run.latencyMs
      return run.usage?.totalTokens ?? null
    }

    const sign = dir === 'desc' ? -1 : 1
    const sorted = [...inWindow].sort((a, b) => {
      const va = valueOf(a)
      const vb = valueOf(b)
      // Nulls always sort last, regardless of direction (REQ-009).
      if (va === null && vb === null) return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
      if (va === null) return 1
      if (vb === null) return -1
      if (va !== vb) return (va - vb) * sign
      return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
    })

    const page: RunsPage = {
      total: sorted.length,
      offset,
      limit,
      runs: sorted.slice(offset, offset + limit).map((run) => ({ ...run })),
    }
    return json(page)
  }

  function searchResponse(url: URL): Response {
    const raw = url.searchParams.get('q') ?? ''
    const needle = raw.trim().toLowerCase()
    const response: SearchResponse = { q: raw, ids: [] }
    if (needle === '') return json(response)
    response.ids = store
      .graph()
      .nodes.filter((node) => node.searchText.includes(needle))
      .map((node) => node.id)
    return json(response)
  }

  // ---- SSE ---------------------------------------------------------------

  /**
   * Disable Bun's per-request idle timer for a streaming response.
   *
   * `idleTimeout` is a socket-level deadline, and Bun does NOT extend it when a
   * handler enqueues chunks — a quiet SSE stream is torn down at that deadline
   * however often the heartbeat fires. `server.timeout(request, 0)` opts this
   * one request out, which is the only mechanism that actually keeps a long-lived
   * stream open (REQ-007 / AC-019). The heartbeat remains the liveness signal the
   * client sees.
   */
  function disableIdleTimeoutFor(request: Request): void {
    const timeout = options.server?.timeout
    if (timeout === undefined) return
    try {
      timeout(request, 0)
    } catch {
      // A server without timeout support still serves; the heartbeat covers it.
    }
  }

  function sseResponse(): Response {
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let closed = false

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        const write = (chunk: string): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            cleanup()
          }
        }
        const cleanup = (): void => {
          if (closed) return
          closed = true
          if (heartbeat !== null) clearInterval(heartbeat)
          heartbeat = null
          unsubscribe?.()
          unsubscribe = null
          try {
            controller.close()
          } catch {
            // already closed by the client
          }
        }

        const send = (event: SseEvent): void => {
          write(`data: ${JSON.stringify(event)}\n\n`)
        }

        // A reconnect (or first connect) gets a fresh invalidation hint: the
        // client refetches everything on every open (REQ-007).
        write(': connected\n\n')
        send({ kind: 'graph' })
        unsubscribe = store.subscribe(send)

        heartbeat = setInterval(() => {
          // Comment line keeps the stream under Bun's idleTimeout (5 s < 10 s).
          write(': hb\n\n')
        }, store.heartbeatMs)
        ;(heartbeat as unknown as { unref?: () => void }).unref?.()
      },
      // Bun calls `cancel` when the client disconnects.
      cancel() {
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
        heartbeat = null
        unsubscribe?.()
        unsubscribe = null
      },
    })

    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  }

  // ---- static ------------------------------------------------------------

  /**
   * The file a static path would serve, or null when it serves nothing.
   *
   * Decoding, containment, the SPA fallback and the final realpath all live here
   * so that AUTH and SERVING can never disagree: a path that would deliver the
   * shell must be classified as the shell. (They disagreed once: `/index%2ehtml`
   * was decoded by the static server but compared raw by the auth check, so an
   * anonymous caller got the app shell with 200.)
   */
  function resolveStaticFile(pathname: string): { file: string; isShell: boolean } | null {
    if (distDir === null || !fs.existsSync(path.join(distDir, 'index.html'))) return null
    const relative = pathname === '/' ? '/index.html' : pathname
    const decoded = decodeSegment(relative)
    if (decoded === null) return null
    const candidate = path.normalize(path.join(distDir, decoded))
    if (!candidate.startsWith(distDir)) return null

    let file = candidate
    let isShell = path.basename(candidate) === 'index.html'
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // SPA fallback: unknown non-/api paths serve the shell.
      if (path.extname(decoded) !== '') return null
      file = path.join(distDir, 'index.html')
      isShell = true
    }
    let resolved: string
    try {
      resolved = fs.realpathSync(file)
    } catch {
      return null
    }
    if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) return null
    // The resolve step is the last word: a path whose decoded form names another
    // file (a symlink out of dist, a `..` that normalised away) is not the shell.
    return { file: resolved, isShell: resolved === fs.realpathSync(path.join(distDir, 'index.html')) }
  }

  function staticResponse(pathname: string, method: string): Response {
    if (distDir === null || !fs.existsSync(path.join(distDir, 'index.html'))) {
      return text('UI not built: run bun run build:web\n', 503)
    }
    const target = resolveStaticFile(pathname)
    if (target === null) return notFound()
    const resolved = target.file

    if (method === 'HEAD') {
      const info = fs.statSync(resolved)
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': String(info.size),
        },
      })
    }
    const body = fs.readFileSync(resolved)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Cache-Control': target.isShell ? 'no-store' : 'public, max-age=300',
      },
    })
  }

  /**
   * True when `pathname` would deliver the app shell.
   *
   * Classified by RESOLVING the path exactly as the static server does, never by
   * comparing the raw string: `/index%2ehtml`, `/%69ndex.html`, `/index.html/`
   * and an extensionless SPA path all resolve to the shell, and all of them must
   * be gated.
   */
  function servesShell(pathname: string): boolean {
    const target = resolveStaticFile(pathname)
    return target !== null && target.isShell
  }

  /**
   * The page an unauthenticated plugin-mode browser gets instead of the shell.
   *
   * It is deliberately static text: no script, no token echo, no hint about
   * where the token lives (the plugin printed it). The URL it asks for is the
   * one `/mexplore ui` handed the user.
   */
  function unauthorizedPage(): Response {
    return new Response(
      [
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>mexplore — not authorised</title>',
        '<style>body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#181818}',
        'h1{font-size:1.15rem;margin:0 0 .6rem}code{background:#f2f2f2;padding:.1em .35em;border-radius:3px}',
        'p{color:#444}</style></head><body>',
        '<h1>Not authorised</h1>',
        '<p>This page needs the link that <code>/mexplore ui</code> printed, which carries a one-time token.</p>',
        '<p>Run <code>/mexplore ui</code> again to get a fresh link.</p>',
        '</body></html>',
        '',
      ].join('\n'),
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
    )
  }

  // ---- router ------------------------------------------------------------

  /**
   * Host allowlist (SEC-001).
   *
   * Binding to `127.0.0.1` stops a remote machine reaching us, but NOT a
   * DNS-rebinding page: a browser resolves `attacker.example` to 127.0.0.1 and
   * then treats our responses as same-origin. The only defence that costs a real
   * request nothing is to refuse a `Host` that names anything but our own
   * loopback address and port.
   *
   * FAIL CLOSED. A request with no `Host` is refused (an HTTP/1.0 client cannot
   * be served safely, since it has no name to check), and so is every request
   * while the port is still unknown — the caller must report the bound port with
   * `setListeningPort`. The old "no port means allow everything" default was a
   * permanent hole for any caller that forgot.
   */
  function hostAllowed(header: string | null): boolean {
    if (port === 0) return false
    if (header === null || header.trim() === '') return false
    const host = header.trim().toLowerCase()
    return (
      host === `127.0.0.1:${port}` ||
      host === `localhost:${port}` ||
      host === `[::1]:${port}`
    )
  }

  /** The `Origin` of a same-origin request, or null when there is none. */
  function originProblem(request: Request): string | null {
    const crossSite = request.headers.get('sec-fetch-site')
    if (crossSite !== null && crossSite.trim().toLowerCase() === 'cross-site') return 'cross-site request refused'
    const origin = request.headers.get('origin')
    if (origin === null || origin.trim() === '') return null
    if (origin.trim().toLowerCase() === 'null') return 'cross-site request refused'
    // An unknown port cannot be matched, so the request is refused rather than
    // exempted (see `hostAllowed`).
    if (port === 0) return 'cross-site request refused'
    let parsed: URL
    try {
      parsed = new URL(origin.trim())
    } catch {
      return 'cross-site request refused'
    }
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cross-site request refused'
    // `URL.host` omits the port for :80/:443; our ports are never those.
    return allowed.has(parsed.host.toLowerCase()) ? null : 'cross-site request refused'
  }

  /**
   * Plugin-mode capability check. `?t=<token>` on any path is an exchange: it
   * sets the HttpOnly, SameSite=Strict cookie and redirects to the same path
   * without the query, so the token disappears from the URL bar, history and any
   * `Referer` the page might emit. Every `/api/*` request then needs the cookie.
   */
  function tokenExchange(url: URL): Response | null {
    if (token === null) return null
    const presented = url.searchParams.get('t')
    if (presented === null) return null
    const target = new URL(url)
    target.searchParams.delete('t')
    if (!tokensMatch(token, presented)) {
      return secured(text('invalid token\n', 401))
    }
    // Collapse leading slashes: a path like `//evil.example/x` would otherwise
    // become a protocol-relative Location and redirect to another host.
    const location = `${target.pathname.replace(/^\/{2,}/, '/')}${target.search}`
    const secure = url.protocol === 'https:' ? '; Secure' : ''
    return secured(
      new Response(null, {
        status: 302,
        headers: {
          Location: location,
          // The NAME is per-server (see `sessionCookieName`): a second dashboard
          // on the same host must not overwrite this one's cookie. `SameSite=Strict`
          // plus a non-`__Host-` name keeps it a loopback-only, HTTP-safe cookie.
          'Set-Cookie': `${sessionCookieName()}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure}`,
        },
      }),
    )
  }

  /** Does this request carry this server's session cookie (plugin mode only)? */
  function hasSession(request: Request): boolean {
    if (token === null) return true
    return tokensMatch(token, cookieValue(request.headers.get('cookie'), sessionCookieName()))
  }

  async function handle(request: Request): Promise<Response> {
    const method = request.method.toUpperCase()
    const url = new URL(request.url)
    const pathname = url.pathname

    if (!hostAllowed(request.headers.get('host'))) {
      return secured(json({ error: 'host not allowed' }, 403))
    }

    // The exchange runs before anything else so `/?t=…` works on the shell too.
    const exchanged = tokenExchange(url)
    if (exchanged !== null) return exchanged

    const isApi = pathname.startsWith('/api/')
    if (isApi) {
      const problem = originProblem(request)
      if (problem !== null) return secured(json({ error: problem }, 403))
      // SEC-002: only GET/HEAD exist. HEAD is served as GET (Bun strips the body).
      if (method !== 'GET' && method !== 'HEAD') {
        return secured(json({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' }))
      }
      if (!hasSession(request)) return secured(json({ error: 'unauthorized' }, 401))
      return secured(handleApi(request, url, pathname, method))
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return secured(json({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' }))
    }
    // Static assets are cacheable, public bytes (the same JS for every user):
    // requiring the cookie for them would only break the module graph.
    // `index.html` is NOT: it is the app shell that then calls `/api/*`, so an
    // unauthenticated caller gets a 401 page instead of the UI.
    if (token !== null && !hasSession(request) && servesShell(pathname)) {
      return secured(unauthorizedPage())
    }
    return secured(staticResponse(pathname, method))
  }

  function handleApi(request: Request, url: URL, pathname: string, method: string): Response {
    const segments = pathname.split('/').filter((segment) => segment !== '')
    // segments[0] === 'api'
    const head = segments[1]

    if (segments.length === 2) {
      switch (head) {
        case 'meta':
          return json(meta())
        case 'graph':
          return json(graphResponse())
        case 'usage':
          return usageResponse(url)
        case 'runs':
          return runsResponse(url)
        case 'search':
          return searchResponse(url)
        case 'events':
          // HEAD must not open a stream: there is no body to deliver and the
          // subscriber would linger until the client gave up.
          if (method === 'HEAD') return new Response(null, { status: 200, headers: SSE_HEADERS })
          disableIdleTimeoutFor(request)
          return sseResponse()
        default:
          return notFound()
      }
    }

    if (head === 'node' && segments.length >= 3) {
      const rawId = segments[2] as string
      const id = decodeSegment(rawId)
      if (id === null || !isValidNodeId(id)) return badRequest('invalid node id')
      if (segments.length === 3) {
        const detail = nodeDetail(id)
        return detail === null ? notFound() : json(detail)
      }
      if (segments.length === 5 && segments[3] === 'file') {
        return attachmentResponse(id, segments[4] as string)
      }
      return notFound()
    }

    return notFound()
  }

  return {
    handle,
    meta,
    graphResponse,
    usageResponse,
    runsResponse,
    searchResponse,
    nodeDetail,
    /**
     * Tell the Host/Origin allowlist which port actually got bound (item 4).
     * `Bun.serve({ port: 0 })` picks one, so the caller must report it — until it
     * does, every request is refused rather than every host allowed.
     */
    setListeningPort(next: number): void {
      port = next
    },
    /** This server's session cookie name (tests and diagnostics). */
    sessionCookieName(): string {
      return sessionCookieName()
    },
  }
}

export type App = ReturnType<typeof createApp>

export type { Usage, UsageStatus }
