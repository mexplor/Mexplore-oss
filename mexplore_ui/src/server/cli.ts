#!/usr/bin/env bun
// mexplore-ui — read-only localhost explorer + token dashboard for mexplore.
//
//   bun src/server/cli.ts --config <path> [--port <n>]
//
// Binds 127.0.0.1 only (SEC-001), serves GET/HEAD only (SEC-002) and writes
// nothing under graph.root or stateDir (SEC-007).

import { boot, isPortInUse } from './boot.ts'
import { loadUiConfig } from './config.ts'

export const DEFAULT_PORT = 43190
export const MIN_PORT = 1
export const MAX_PORT = 65535

/**
 * Strict decimal port parse (#13). `parseInt` would accept `43198junk` as 43198
 * and `43198.5` as 43198, silently binding a port the caller never asked for.
 * The whole string must be decimal digits, then the range is checked.
 */
export function parsePort(raw: string): { port: number } | { error: string } {
  const text = raw.trim()
  if (text === '') return { error: 'must not be empty' }
  if (!/^[0-9]+$/.test(text)) return { error: `must be a whole number of decimal digits (got ${JSON.stringify(raw)})` }
  const port = Number(text)
  if (!Number.isSafeInteger(port)) return { error: `is out of range (got ${JSON.stringify(raw)})` }
  if (port < MIN_PORT || port > MAX_PORT) return { error: `must be between ${MIN_PORT} and ${MAX_PORT} (got ${port})` }
  return { port }
}

export interface ParsedArgs {
  config: string | null
  port: number
  help: boolean
  errors: string[]
}

/** `--config <path>`, `--config=<path>`, `--port <n>`, `--port=<n>`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { config: null, port: DEFAULT_PORT, help: false, errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)

    if (flag === '--help' || flag === '-h') {
      parsed.help = true
      continue
    }
    if (flag === '--config') {
      const value = inline ?? (argv[++i] as string | undefined)
      if (value === undefined || value === '') parsed.errors.push('--config requires a path')
      else parsed.config = value
      continue
    }
    if (flag === '--port') {
      const value = inline ?? (argv[++i] as string | undefined)
      if (value === undefined) {
        parsed.errors.push('--port requires a number')
      } else {
        const result = parsePort(value)
        if ('error' in result) parsed.errors.push(`--port ${result.error}`)
        else parsed.port = result.port
      }
      continue
    }
    parsed.errors.push(`unknown argument: ${arg}`)
  }
  return parsed
}

export const USAGE = `usage: mexplore-ui --config <path> [--port <n>]

  --config <path>   memory-agent config JSON (required) — its graph.root and
                    stateDir decide what this UI shows
  --port <n>        loopback port to listen on (default ${DEFAULT_PORT})

Read-only. Serves http://127.0.0.1:<port> and never writes to the graph.`

export interface StartedServer {
  port: number
  /** realpath of the graph root this instance serves. */
  graphRoot: string
  stop(): Promise<void>
}

export interface StartOptions {
  configPath: string
  port: number
  /** Defaults to `<mexplore_ui>/dist`. */
  distDir?: string
  /** Quiet the startup banner (tests). */
  quiet?: boolean
  /** Injectable timers, for tests. */
  debounceMs?: number
  reconcileMs?: number
  heartbeatMs?: number
}

export async function startServer(options: StartOptions): Promise<StartedServer> {
  const config = await loadUiConfig(options.configPath)
  const started = await boot({
    graphRoot: config.graphRoot,
    // Identities pinned at config load: a root moved aside and replaced by a
    // symlink is refused, never adopted as the new trust boundary (#1).
    graphTrust: config.graphTrust,
    stateDir: config.stateDir,
    stateTrust: config.stateTrust,
    configPath: config.configPath,
    source: 'service',
    port: options.port,
    ...(options.distDir === undefined ? {} : { distDir: options.distDir }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.reconcileMs === undefined ? {} : { reconcileMs: options.reconcileMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  })
  return { port: started.port, graphRoot: started.graphRoot, stop: started.stop }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.errors.length > 0) {
    for (const message of args.errors) process.stderr.write(`mexplore-ui: ${message}\n`)
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  if (args.config === null) {
    process.stderr.write(`mexplore-ui: --config is required\n${USAGE}\n`)
    return 2
  }

  let started: StartedServer
  try {
    started = await startServer({ configPath: args.config, port: args.port })
  } catch (error) {
    if (isPortInUse(error)) {
      // REQ-011: never silently pick another port.
      process.stderr.write(`port ${args.port} in use\n`)
      return 1
    }
    const message = (error as Error).message ?? String(error)
    process.stderr.write(`mexplore-ui: ${message}\n`)
    return 1
  }

  process.stdout.write(
    `mexplore-ui (read-only) → http://127.0.0.1:${started.port}  graph=${started.graphRoot}\n`,
  )

  const shutdown = async (): Promise<void> => {
    await started.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Keep the process alive until a signal arrives.
  await new Promise<void>(() => {})
  return 0
}

if (import.meta.main) {
  const code = await main()
  if (code !== 0) process.exit(code)
}
