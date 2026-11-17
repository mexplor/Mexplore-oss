// The OpenCode plugin's entry point into this package: `mexplore-ui/plugin`.
//
// The plugin runs inside the OpenCode server process and mounts this read-only
// UI on a loopback port for the lifetime of the plugin. That deployment differs
// from the `--config` service mode in exactly four ways, all handled here:
//
//   1. **No config file.** The caller supplies `graphRoot` and `usageDir`, both
//      already created. No `memory_service` checkout is involved.
//   2. **No SQLite.** History is the plugin's own monthly usage JSONL, read by
//      `JsonlRunSource`. That is why this module imports nothing from
//      `bun:sqlite` at module scope: the service task reader is loaded lazily by
//      `Store` only when it actually defaults to the service source, so importing
//      `./plugin` under a runtime without `bun:sqlite` still works.
//   3. **A capability token.** Every start mints a random token; the returned
//      URL carries it once and the browser trades it for an HttpOnly cookie.
//      A loopback port is not by itself a permission to read the user's memory:
//      any process or page on the machine can otherwise fetch it.
//   4. **A chosen port.** Default 43191; on `EADDRINUSE`, fall back to port 0 and
//      let the OS choose. It NEVER adopts an existing listener — that would serve
//      whatever the other process is serving under this link.
//
// Importing this module has no side effects: nothing is created, bound or
// scheduled until `startPluginUi` is called.

import crypto from 'node:crypto'

import { assetsPresentAt, boot, defaultDistDir, isPortInUse } from './server/boot.ts'
import { pinTrustedRoot, type TrustedRoot } from './server/fs-safe.ts'
import { JsonlRunSource } from './server/usage/jsonl-source.ts'

/** Default loopback port. Chosen next to the service's 43190 and away from it. */
export const DEFAULT_PLUGIN_PORT = 43191

export interface PluginUiOptions {
  /** Absolute; created by the caller beforehand. */
  graphRoot: string
  /** Absolute; the directory the monthly `usage-YYYY-MM.jsonl` files live in. */
  usageDir: string
  /** Default 43191; on EADDRINUSE fall back to 0 (OS-chosen). */
  port?: number
  /** Shown as the source label, default `opencode plugin`. */
  label?: string
  /** Override the built UI's directory (tests). Defaults to `<package>/dist`. */
  distDir?: string
  /** Injectable clock (month rollover in tests). */
  now?: () => number
}

export interface PluginUiHandle {
  /** `http://127.0.0.1:<port>/?t=<capability token>`. */
  url: string
  port: number
  graphRoot: string
  /** `await server.stop(true)` + `store.close()`; idempotent. */
  stop(): Promise<void>
}

/**
 * True when the built UI ships next to this package.
 *
 * The plugin preflights this so a missing build is an actionable error
 * ("reinstall, or build mexplore_ui") rather than a 503 page in the browser.
 */
export function uiAssetsPresent(): boolean {
  return assetsPresentAt(defaultDistDir())
}

/** `http://127.0.0.1:<port>/?t=<token>` — the one address the user is given. */
export function pluginUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`
}

/**
 * Start the UI for one graph.
 *
 * Two servers are attempted at most: the requested port, then port 0. A failure
 * other than `EADDRINUSE` (a permission error, a broken dist) is thrown as-is —
 * retrying would only hide it.
 */
export async function startPluginUi(options: PluginUiOptions): Promise<PluginUiHandle> {
  const requestedGraphRoot = options.graphRoot
  const usageDir = options.usageDir
  const label = options.label ?? 'opencode plugin'
  const token = crypto.randomBytes(32).toString('base64url')

  // Pinning the graph root is what stops the memory the user is looking at from
  // being swapped for another directory mid-session; the usage dir is pinned on
  // the same principle (a symlinked log directory is refused instead of read).
  const graphTrust: TrustedRoot | null = pinTrustedRoot(requestedGraphRoot)
  const usageTrust = pinTrustedRoot(usageDir)
  // The canonical form is what the usage records carry in `graphRoot` (the
  // plugin writes the realpath), so filtering by it is what makes the rows
  // match. A root we cannot pin falls back to the path as given.
  const graphRoot = graphTrust?.canonical ?? requestedGraphRoot
  const runs = new JsonlRunSource({
    usageDir,
    graphRoot,
    trust: usageTrust,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const requested = options.port ?? DEFAULT_PLUGIN_PORT
  const base = {
    graphRoot,
    graphTrust,
    usageDir,
    runs,
    source: 'plugin' as const,
    label,
    token,
    ...(options.distDir === undefined ? {} : { distDir: options.distDir }),
    ...(options.now === undefined ? {} : { now: options.now }),
    // The plugin's dashboard is refreshed by its own appends, which the 2 s poll
    // catches; a faster graph reconcile buys nothing (the graph is written by the
    // same process) and costs battery.
    reconcileMs: 30_000,
  }

  let started: Awaited<ReturnType<typeof boot>>
  try {
    started = await boot({ ...base, port: requested })
  } catch (error) {
    if (!isPortInUse(error)) throw error
    // Never adopt the foreign listener: bind an OS-chosen port instead.
    started = await boot({ ...base, port: 0 })
  }

  return {
    url: pluginUrl(started.port, token),
    port: started.port,
    graphRoot: started.graphRoot,
    stop: () => started.stop(),
  }
}

export type { RunSourceKind } from './shared/types.ts'
