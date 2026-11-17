// Server half of the memory-graph panel, bundled into lib/ui-server.js.
//
// It reuses mexplore_ui's read-only Store and createApp unchanged and exposes
// one factory to the Host row in lib/bundle/ui.js, which owns HTTP, the
// connection check and lifetime.
//
// Usage history: there is no A2A task database or run directory inside DSH
// (the memory agent runs in the DSH process), so the Store gets a run source
// that always reports usage as unavailable. /api/usage and /api/runs then
// answer `unavailable: true`. The default service run source is never built;
// its bun:sqlite reader is only kept out of the bundle, see tasks-stub.ts.

import { createApp } from '../../mexplore_ui/src/server/app.ts'
import { pinTrustedRoot } from '../../mexplore_ui/src/server/fs-safe.ts'
import { Store } from '../../mexplore_ui/src/server/store.ts'
import type { RunSource, RunSourceResult } from '../../mexplore_ui/src/server/usage/source.ts'

export const CONFIG_LABEL = 'DSH plugin row memory-graph-ui'

/**
 * A run source with nothing to read. `kind: 'service'` keeps `Meta.source` what
 * the panel always reported. No warnings: the graph response repeats run
 * warnings, and an always-on warning would show on every read.
 */
export function unavailableRunSource(): RunSource {
  return {
    kind: 'service',
    refresh: (): RunSourceResult => ({ runs: [], orphanRunDirs: [], warnings: [], unavailable: true, signature: 'unavailable' }),
    moved: () => false,
    watchPath: () => null,
  }
}

export interface MemoryGraphUiOptions {
  /** Absolute graph root. Read only; a missing directory is reported, never created. */
  graphRoot: string
  /** Watch the graph for live updates (default true). False rebuilds on each /api/graph read instead. */
  watch?: boolean
  /**
   * The DSH web server's listening port. createApp only serves requests whose
   * Host is `127.0.0.1:<port>`; the Host row writes that Host on every request
   * it forwards (see lib/bundle/ui.js). Must be a positive integer.
   */
  port: number
}

export interface MemoryGraphUi {
  readonly graphRoot: string
  /** True when the graph root existed when this instance was created. */
  readonly rootExisted: boolean
  readonly subscriberCount: number
  readonly port: number
  /** Report a new listening port (the web server was restarted on another one). */
  setPort(port: number): void
  handle(request: Request): Promise<Response>
  close(): void
}

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`memory-graph-ui: invalid listening port ${port}`)
  return port
}

export function createMemoryGraphUi(options: MemoryGraphUiOptions): MemoryGraphUi {
  const graphRoot = options.graphRoot
  const watch = options.watch !== false
  let port = checkPort(options.port)
  const graphTrust = pinTrustedRoot(graphRoot)
  const store = new Store({ graphRoot, runs: unavailableRunSource(), graphTrust, stateTrust: null })
  if (watch) store.start()
  const app = createApp({ store, configPath: CONFIG_LABEL, graphRoot, graphTrust, port })

  return {
    graphRoot,
    rootExisted: graphTrust !== null,
    get subscriberCount() {
      return store.subscriberCount
    },
    get port() {
      return port
    },
    setPort(next: number) {
      port = checkPort(next)
      app.setListeningPort(port)
    },
    handle(request: Request): Promise<Response> {
      if (!watch && new URL(request.url).pathname === '/api/graph') store.rebuildNow()
      return app.handle(request)
    },
    close() {
      store.close()
    },
  }
}
