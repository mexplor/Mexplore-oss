// Read-only config loading (CON-002).
//
// The shape validation below is INLINED from memory_service's `config.ts`. That
// package is a sibling checkout, not a dependency: importing it pulled an
// out-of-package file into the published bundle (and through it the whole
// service contracts module), which is why this file owns its own copy.
//
// What is copied is the part `loadUiConfig` needs: `ConfigError` and the
// validation that decides the two values this UI serves — `graph.root` and
// `stateDir` — plus the strictness that makes a typo a startup error rather than
// a silent default (unknown top-level keys, a non-loopback `host`, a
// non-authority `maxAuthority`). The deep `runtime.*` / `limits.*` validation is
// deliberately NOT copied: the UI never reads those values, and the service
// still validates them in its own process before it starts.
//
// `loadConfig` from memory_service is FORBIDDEN here for a second, stronger
// reason: after validating it runs mkdir + chmod 0700 on stateDir and the lock
// root, which would break the UI's read-only guarantee before the server starts.
// We read the JSON ourselves and add realpath / stat checks for `graph.root` and
// `stateDir`.

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { pinTrustedRoot, type TrustedRoot } from './fs-safe.ts'

/** Same message and fields as memory_service's `ConfigError`. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n- ${problems.join('\n- ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** The subset of the service config this process acts on. */
export interface ConfigShape {
  graph: { id: string; handle: string; root: string }
  stateDir: string
}

const TOP_KEYS = new Set(['host', 'port', 'stateDir', 'lockRoot', 'graph', 'maxAuthority', 'defaults', 'runtime', 'limits'])
const GRAPH_KEYS = new Set(['id', 'handle', 'root'])
const DEFAULTS_KEYS = new Set(['requestedAuthority'])

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, prefix: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${prefix}${key} is not allowed`)
}

function nonEmptyString(value: unknown, name: string, problems: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(`${name} must be a non-empty string`)
    return ''
  }
  return value
}

function isAuthority(value: unknown): value is 'read' | 'manage' {
  return value === 'read' || value === 'manage'
}

/**
 * Pure shape validation — no filesystem access, no side effects.
 * Throws `ConfigError` with every problem found.
 */
export function parseConfigShape(raw: unknown): ConfigShape {
  const problems: string[] = []
  if (!plain(raw)) throw new ConfigError(['configuration must be a JSON object'])
  problems.push(...rejectUnknown(raw, TOP_KEYS, 'config.'))

  const host = raw['host'] ?? '127.0.0.1'
  if (host !== '127.0.0.1') problems.push("host must be '127.0.0.1' (loopback only)")

  const port = raw['port'] ?? 43120
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push('port must be an integer between 0 and 65535')
  }

  const stateDir = nonEmptyString(raw['stateDir'], 'stateDir', problems)

  if (!plain(raw['graph'])) problems.push('graph must be an object with id, handle and root')
  const graphRaw = plain(raw['graph']) ? raw['graph'] : {}
  problems.push(...rejectUnknown(graphRaw, GRAPH_KEYS, 'graph.'))
  const graphId = nonEmptyString(graphRaw['id'], 'graph.id', problems)
  const graphHandle = nonEmptyString(graphRaw['handle'], 'graph.handle', problems)
  const graphRoot = nonEmptyString(graphRaw['root'], 'graph.root', problems)
  if (graphRoot && !path.isAbsolute(graphRoot)) problems.push('graph.root must be an absolute path')

  const maxAuthority = raw['maxAuthority'] ?? 'read'
  if (!isAuthority(maxAuthority)) problems.push("maxAuthority must be 'read' or 'manage'")
  if (raw['defaults'] !== undefined) {
    if (!plain(raw['defaults'])) {
      problems.push('defaults must be an object when present')
    } else {
      problems.push(...rejectUnknown(raw['defaults'], DEFAULTS_KEYS, 'defaults.'))
      const requested = raw['defaults']['requestedAuthority'] ?? 'read'
      if (!isAuthority(requested)) problems.push("defaults.requestedAuthority must be 'read' or 'manage'")
      else if (isAuthority(maxAuthority) && requested === 'manage' && maxAuthority === 'read') {
        problems.push('defaults.requestedAuthority cannot exceed maxAuthority')
      }
    }
  }

  // Presence only: the service owns the deep validation of these blocks.
  for (const key of ['runtime', 'limits']) {
    if (raw[key] !== undefined && !plain(raw[key])) problems.push(`${key} must be an object`)
  }
  if (raw['lockRoot'] !== undefined) {
    if (typeof raw['lockRoot'] !== 'string' || raw['lockRoot'].trim().length === 0) {
      problems.push('lockRoot must be a non-empty string when present')
    } else if (!path.isAbsolute(raw['lockRoot'])) {
      problems.push('lockRoot must be an absolute path')
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return { graph: { id: graphId, handle: graphHandle, root: graphRoot }, stateDir }
}

export interface UiConfig {
  /** Absolute path of the config file that was passed on the command line. */
  configPath: string
  /** Config file basename without its extension — the launchd label suffix (test_1). */
  configName: string
  /** realpath of graph.root, resolved once at startup. */
  graphRoot: string
  /** realpath of stateDir, resolved once at startup. */
  stateDir: string
  /**
   * The configured paths with their canonical identity pinned (path + dev/ino).
   * Every later access re-checks these instead of re-resolving the configured
   * path, so a root moved aside and replaced by a symlink is refused rather than
   * adopted as a new trust boundary (SEC-003, pass-3 #1).
   */
  graphTrust: TrustedRoot
  stateTrust: TrustedRoot
}

/** `test_1.json` -> `test_1`. */
export function configNameOf(configPath: string): string {
  const base = path.basename(configPath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

async function requireDir(target: string, label: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(target)
  } catch {
    throw new ConfigError([`${label} does not exist: ${target}`])
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new ConfigError([`${label} is not a directory: ${resolved}`])
  return resolved
}

/**
 * Load the single graph this UI serves. Never writes anything.
 * Throws ConfigError with a readable message for any startup problem (REQ-001).
 */
export async function loadUiConfig(configPath: string): Promise<UiConfig> {
  const absolute = path.resolve(configPath)

  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new ConfigError([
      code === 'ENOENT' ? `config file not found: ${absolute}` : `cannot read config file: ${absolute}`,
    ])
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError([`config file is not valid JSON: ${absolute} (${(error as Error).message})`])
  }

  // Pure shape validation only — no filesystem side effects.
  const config = parseConfigShape(raw)

  const graphRoot = await requireDir(config.graph.root, 'graph.root')
  const stateDir = await requireDir(config.stateDir, 'stateDir')

  // Pin identity now, while the paths are known good.
  const graphTrust = pinTrustedRoot(config.graph.root)
  const stateTrust = pinTrustedRoot(config.stateDir)
  if (graphTrust === null) throw new ConfigError([`graph.root cannot be pinned: ${config.graph.root}`])
  if (stateTrust === null) throw new ConfigError([`stateDir cannot be pinned: ${config.stateDir}`])

  return {
    configPath: absolute,
    configName: configNameOf(absolute),
    graphRoot,
    stateDir,
    graphTrust,
    stateTrust,
  }
}
