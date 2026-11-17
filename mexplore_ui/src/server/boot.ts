// A shared server bootstrap for both deployments of the UI.
//
// `cli.ts` (service mode) and `plugin.ts` (plugin mode) differ only in where the
// run history and the graph root come from and whether a capability token is
// required; everything after that — Store options, the dist path, the Bun.serve
// call, the idle-timeout bridge, the stop path — is identical, so it lives here
// once.

import fs from 'node:fs'
import path from 'node:path'

import type { RunSourceKind } from '../shared/types.ts'
import { createApp } from './app.ts'
import type { TrustedRoot } from './fs-safe.ts'
import { Store } from './store.ts'
import type { RunSource } from './usage/source.ts'

/** `<package>/dist` — the built UI, whichever module asked. */
export function defaultDistDir(): string {
  // The server sources sit at `<package>/src/server/`, both in this checkout and
  // in the published package (which ships sources and `dist/` side by side).
  return path.resolve(import.meta.dir, '..', '..', 'dist')
}

/** True when the built UI is present next to the package. */
export function assetsPresentAt(dir: string = defaultDistDir()): boolean {
  try {
    return fs.existsSync(path.join(dir, 'index.html'))
  } catch {
    return false
  }
}

export interface BootOptions {
  graphRoot: string
  graphTrust?: TrustedRoot | null
  /** Explicit run source; omit for the default service source. */
  runs?: RunSource
  stateDir?: string
  stateTrust?: TrustedRoot | null
  source?: RunSourceKind
  label?: string
  configPath?: string
  port: number
  distDir?: string
  /** Plugin mode's capability token. */
  token?: string
  tz?: string
  now?: () => number
  debounceMs?: number
  reconcileMs?: number
  heartbeatMs?: number
  taskPollMs?: number
}

export interface BootedServer {
  port: number
  graphRoot: string
  store: Store
  stop(): Promise<void>
}

/**
 * Build the Store + app and listen on 127.0.0.1.
 *
 * The caller owns the port policy: on `EADDRINUSE` this throws, and the plugin
 * start path retries with port 0 (the OS picks one) — it never adopts a foreign
 * listener, because adopting one would hand the user's graph to another process.
 */
export async function boot(options: BootOptions): Promise<BootedServer> {
  const store = new Store({
    graphRoot: options.graphRoot,
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.source === undefined ? {} : { source: options.source }),
    graphTrust: options.graphTrust ?? null,
    stateTrust: options.stateTrust ?? null,
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.reconcileMs === undefined ? {} : { reconcileMs: options.reconcileMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.taskPollMs === undefined ? {} : { taskPollMs: options.taskPollMs }),
  })
  store.start()

  const distDir = options.distDir ?? defaultDistDir()
  // `app` needs the server handle to opt the SSE stream out of the idle timer,
  // but the handle only exists after Bun.serve returns: a mutable holder bridges
  // the cycle without a second construction pass.
  const serverHolder: { current: ReturnType<typeof Bun.serve> | null } = { current: null }
  const app = createApp({
    store,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    graphRoot: options.graphRoot,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    source: options.source ?? store.source,
    ...(options.label === undefined ? {} : { label: options.label }),
    distDir,
    graphTrust: options.graphTrust ?? null,
    ...(options.token === undefined ? {} : { token: options.token }),
    // The Host allowlist needs the port this server listens on. A concrete port
    // is known now; port 0 is not (only `Bun.serve` learns it), so the app starts
    // FAILING CLOSED and `setListeningPort` below opens it. The gap is a single
    // statement, and a forgotten call is a 403 rather than a hole.
    port: options.port,
    ...(options.tz === undefined ? {} : { tz: options.tz }),
    ...(options.now === undefined ? {} : { now: options.now }),
    server: {
      timeout(request: Request, seconds: number) {
        serverHolder.current?.timeout(request, seconds)
      },
    },
  })

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: options.port,
      // `development: false` makes Bun set SO_REUSEPORT, which lets a SECOND
      // process bind the same port and silently share it round-robin — the exact
      // "adopted a foreign listener" failure the plugin's port policy forbids
      // (and it defeats the EADDRINUSE check in `startPluginUi`). `reusePort:
      // false` forces a real exclusive bind, so a taken port throws and the
      // fallback to port 0 is exercised as designed.
      reusePort: false,
      // SSE heartbeats arrive every 5 s, but leave real headroom: an idle
      // stream must never be closed by the transport (REQ-007).
      idleTimeout: 120,
      development: false,
      fetch: (request) => app.handle(request),
      error: () =>
        new Response(JSON.stringify({ error: 'internal error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
    })
    serverHolder.current = server
  } catch (error) {
    store.close()
    throw error
  }

  const port = server.port ?? options.port
  app.setListeningPort(port)

  let stopped: Promise<void> | null = null
  return {
    port,
    graphRoot: options.graphRoot,
    store,
    stop() {
      // Idempotent, and in the contract's order: `await server.stop(true)` then
      // `store.close()`. A second call returns the same promise, so a cleanup
      // path that runs twice cannot double-close the store or the socket.
      stopped ??= (async () => {
        await server.stop(true)
        store.close()
      })()
      return stopped
    },
  }
}

/** True when the error means "another process holds that port". */
export function isPortInUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return true
  return /in use|EADDRINUSE/i.test((error as Error | undefined)?.message ?? '')
}
