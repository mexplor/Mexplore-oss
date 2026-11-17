#!/usr/bin/env bun
// LaunchAgent installer for the read-only mexplore UI (REQ-012, AC-021).
//
//   bun scripts/agent.ts install   --config <path> [--port 43190] [--no-load]
//   bun scripts/agent.ts uninstall --config <path>
//
// Installs a sibling job next to `ai.mexplore.memory-agent.<configName>`: both start
// at login, restart independently, and neither can take the other down.
//
// HOME is always taken from the environment so tests can point it at a temp dir;
// nothing here is ever run against the real launchd domain by the test suite.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parsePort } from '../src/server/cli.ts'
import { configNameOf, loadUiConfig } from '../src/server/config.ts'
import { DEFAULT_PORT, labelFor, renderPlist } from '../src/server/plist.ts'

export { DEFAULT_PORT, labelFor }

export const PACKAGE_DIR = path.resolve(import.meta.dir, '..')
export const CLI_PATH = path.join(PACKAGE_DIR, 'src', 'server', 'cli.ts')

export interface InstallLayout {
  home: string
  label: string
  plistPath: string
  logDir: string
  logPath: string
  distDir: string
}

export function layoutFor(configName: string, home = os.homedir()): InstallLayout {
  const label = labelFor(configName)
  const logDir = path.join(home, '.local', 'state', 'mexplore-ui', configName)
  return {
    home,
    label,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    logDir,
    logPath: path.join(logDir, 'ui.log'),
    distDir: path.join(PACKAGE_DIR, 'dist'),
  }
}

export interface InstallOptions {
  configPath: string
  port: number
  home: string
  pathEnv: string
  bunPath: string
  /** Skip `launchctl bootstrap` (tests, dry runs). */
  force?: boolean
  load?: boolean
  /** Overridable for tests. */
  runCommand?: (command: string[]) => { status: number; stdout: string; stderr: string }
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  /** Overridable for tests. */
  distDir?: string
}

export interface InstallResult {
  ok: boolean
  exitCode: number
  plistPath: string | null
  message: string
}

function defaultRunCommand(command: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })
  return {
    status: result.exitCode ?? 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** True when `candidate` is `root` or below it (both normalised absolute). */
function pathWithin(root: string, candidate: string): boolean {
  const normalRoot = path.resolve(root)
  const normalCandidate = path.resolve(candidate)
  return normalCandidate === normalRoot || normalCandidate.startsWith(normalRoot + path.sep)
}

/**
 * Resolve `target` through its deepest EXISTING ancestor, so a symlinked parent
 * directory is caught even when the leaf does not exist yet. Returns null when
 * the resolved location cannot be determined.
 */
function resolveThroughExisting(target: string): string | null {
  const absolute = path.resolve(target)
  let probe = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      return path.join(real, ...tail.reverse())
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return absolute
      tail.push(path.basename(probe))
      probe = parent
    }
  }
}

/**
 * Reasons an OUTPUT path is unsafe to write to: it is a symlink, or it resolves
 * INSIDE a protected tree (the graph root or the state dir), or it resolves out
 * of the temp HOME the caller gave us.
 */
function outputPathProblem(
  target: string,
  label: string,
  protectedRoots: readonly string[],
  home: string,
  kind: 'file' | 'dir' = 'file',
): string | null {
  // Naming an existing symlink as the destination is how a plist overwrite
  // becomes an arbitrary-file overwrite; refuse it outright.
  try {
    const info = fs.lstatSync(target)
    if (info.isSymbolicLink()) return `${label} is a symlink: ${target} — refusing to write through it`
    // An existing directory is fine for a directory target (re-install), and is
    // an error for a file target (we would be writing over a container).
    if (info.isDirectory() !== (kind === 'dir')) {
      return `${label} is a ${info.isDirectory() ? 'directory' : 'file'}: ${target}`
    }
  } catch {
    // absent is the normal case: we are about to create it
  }

  const resolved = resolveThroughExisting(target)
  if (resolved === null) return `${label} cannot be resolved: ${target}`
  for (const root of protectedRoots) {
    // Compare canonical forms on both sides: macOS /var -> /private/var would
    // otherwise make every temp-dir comparison look like an escape.
    const canonicalRoot = resolveThroughExisting(root) ?? root
    if (pathWithin(canonicalRoot, resolved)) {
      return `${label} resolves inside a protected tree (${canonicalRoot}): ${target} -> ${resolved}`
    }
  }
  const canonicalHome = resolveThroughExisting(home) ?? home
  if (!pathWithin(canonicalHome, resolved)) {
    return `${label} resolves outside the installing HOME (${canonicalHome}): ${target} -> ${resolved}`
  }
  return null
}

/**
 * Refuse an EXISTING destination that is not a plain, singly-linked regular file.
 *
 * A hard link is not a symlink, so it passes every path check: `ui.log` can share
 * an inode with `graph.root/<id>/node.md` while its own realpath looks perfectly
 * safe. `nlink !== 1` means the inode is reachable from somewhere else, which is
 * exactly the case that would let launchd write into protected data (#2).
 */
function existingFileProblem(target: string, label: string): string | null {
  let info: fs.Stats
  try {
    info = fs.lstatSync(target)
  } catch {
    return null // absent: nothing to overwrite
  }
  if (info.isSymbolicLink()) return `${label} is a symlink: ${target} — refusing to write through it`
  if (!info.isFile()) return `${label} is not a regular file: ${target}`
  if (info.nlink !== 1) {
    return `${label} is hard-linked (nlink=${info.nlink}) to another file: ${target} — refusing to write into a shared inode`
  }
  return null
}

/**
 * Write `content` to `target` atomically: a temp file in the same directory plus
 * a rename. A pre-existing symlink at `target` is REPLACED, never followed, so
 * installation cannot overwrite the file it points at (#2).
 */
function writeFileAtomic(target: string, content: string): void {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`)
  // wx: fail rather than reuse an existing entry (including a planted symlink).
  const handle = fs.openSync(temp, 'wx', 0o644)
  try {
    fs.writeFileSync(handle, content, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.unlinkSync(temp)
    } catch {
      // ignore
    }
    throw error
  }
}

/** Create `dir` only if every existing ancestor is a real (non-symlink) dir. */
function ensureRealDir(dir: string): void {
  const missing: string[] = []
  let probe = path.resolve(dir)
  for (;;) {
    try {
      const info = fs.lstatSync(probe)
      if (info.isSymbolicLink()) throw new Error(`refusing to write through symlinked directory: ${probe}`)
      if (!info.isDirectory()) throw new Error(`not a directory: ${probe}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(probe)
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  for (const dirPath of missing.reverse()) fs.mkdirSync(dirPath)
}

/**
 * Install the LaunchAgent.
 *
 * Refuses to write a plist when `dist/` is missing (REQ-012): the job serves the
 * prebuilt assets, so starting without them would only crash-loop.
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const run = options.runCommand ?? defaultRunCommand
  const out = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
  const err = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))

  // Validating the config here also gives us the canonical roots, which the
  // output-path checks below depend on. Fail fast before anything is written.
  let graphRoot: string
  let stateDir: string
  try {
    const config = await loadUiConfig(options.configPath)
    graphRoot = config.graphRoot
    stateDir = config.stateDir
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    err(`mexplore-ui: ${message}`)
    return { ok: false, exitCode: 1, plistPath: null, message }
  }

  const absoluteConfig = path.resolve(options.configPath)
  const configName = configNameOf(absoluteConfig)
  const layout = layoutFor(configName, options.home)
  const distDir = options.distDir ?? layout.distDir

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    const message = `UI not built: ${distDir}/index.html is missing. Run \`bun run build:web\` first.`
    err(`mexplore-ui: ${message}`)
    return { ok: false, exitCode: 1, plistPath: null, message }
  }

  // Validate log destinations BEFORE any write or bootstrap: a hard link or a
  // non-regular file here would route launchd output into protected data (#2).
  for (const [target, label] of [
    [layout.logPath, 'log file'],
    [layout.plistPath, 'plist path'],
  ] as const) {
    const problem = existingFileProblem(target, label)
    if (problem !== null) {
      err(`mexplore-ui: ${problem}`)
      return { ok: false, exitCode: 1, plistPath: null, message: problem }
    }
  }

    // Neither output may be a symlink, nor resolve into the graph or the agent's
  // state dir (SEC-007), nor escape the HOME we were told to install into.
  const protectedRoots = [graphRoot, stateDir]
  const hoisted = path.resolve(options.home)
  for (const [target, label, kind] of [
    [layout.plistPath, 'plist path', 'file'],
    [layout.logPath, 'log file', 'file'],
    [layout.logDir, 'log directory', 'dir'],
  ] as const) {
    const problem = outputPathProblem(target, label, protectedRoots, hoisted, kind)
    if (problem !== null) {
      err(`mexplore-ui: ${problem}`)
      return { ok: false, exitCode: 1, plistPath: null, message: problem }
    }
  }

  const plist = renderPlist({
    configName,
    bunPath: options.bunPath,
    cliPath: CLI_PATH,
    configPath: absoluteConfig,
    port: options.port,
    workingDirectory: PACKAGE_DIR,
    logPath: layout.logPath,
    home: options.home,
    pathEnv: options.pathEnv,
  })

  try {
    // launchd never creates StandardOutPath parents; under KeepAlive a missing
    // log directory would crash-loop the job.
    ensureRealDir(layout.logDir)
    writeFileAtomic(layout.plistPath, plist)
  } catch (error) {
    const message = `cannot install plist: ${(error as Error).message}`
    err(`mexplore-ui: ${message}`)
    return { ok: false, exitCode: 1, plistPath: null, message }
  }

  if (options.load !== false) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501
    // Boot out a previous instance first: bootstrap fails with "service already
    // loaded" otherwise, which would leave an old port in place.
    run(['launchctl', 'bootout', `gui/${uid}/${layout.label}`])
    const result = run(['launchctl', 'bootstrap', `gui/${uid}`, layout.plistPath])
    if (result.status !== 0) {
      err(`mexplore-ui: launchctl bootstrap failed: ${result.stderr.trim() || `exit ${result.status}`}`)
      return {
        ok: false,
        exitCode: 1,
        plistPath: layout.plistPath,
        message: 'launchctl bootstrap failed',
      }
    }
  }

  out(`installed ${layout.plistPath} (port ${options.port}, graph ${graphRoot})`)
  return { ok: true, exitCode: 0, plistPath: layout.plistPath, message: 'installed' }
}

export interface UninstallOptions {
  configPath: string
  home: string
  runCommand?: (command: string[]) => { status: number; stdout: string; stderr: string }
  stdout?: (line: string) => void
  stderr?: (line: string) => void
  load?: boolean
  /**
   * Canonical graph root / state dir. Removal is refused if the LaunchAgents
   * directory resolves into either tree (SEC-007, #3).
   */
  protectedRoots?: readonly string[]
}

export interface UninstallResult {
  ok: boolean
  exitCode: number
  plistPath: string | null
  message: string
}

/**
 * Verify the removal path end to end (#3).
 *
 * `lstat` on the leaf is not enough: `~/Library/LaunchAgents` itself can be a
 * symlink into a Node directory, in which case unlinking the leaf would delete a
 * graph attachment. Every directory between the canonical HOME and the leaf must
 * be a real directory, must not resolve into the graph or state tree, and the
 * leaf must be a regular file named exactly our label's plist.
 */
function removalPathProblem(
  layout: InstallLayout,
  protectedRoots: readonly string[],
  home: string,
): string | null {
  const canonicalHome = resolveThroughExisting(home) ?? home
  const plist = path.resolve(layout.plistPath)
  const relative = path.relative(path.resolve(home), plist)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return `plist path escapes the installing HOME: ${layout.plistPath}`
  }
  // The leaf's name is fixed by our label, never taken from the filesystem.
  if (path.basename(plist) !== `${layout.label}.plist`) {
    return `refusing to remove a file that is not this job's plist: ${plist}`
  }

  // Every intermediate directory must be real and must stay out of protected data.
  const parts = relative.split(path.sep).slice(0, -1)
  let current = path.resolve(home)
  for (const part of parts) {
    current = path.join(current, part)
    let info: fs.Stats
    try {
      info = fs.lstatSync(current)
    } catch {
      return null // missing ancestor: nothing to remove
    }
    if (info.isSymbolicLink()) {
      return `refusing to remove through symlinked directory: ${current}`
    }
    if (!info.isDirectory()) return `refusing to remove through non-directory: ${current}`
    const resolved = resolveThroughExisting(current) ?? current
    for (const root of protectedRoots) {
      if (pathWithin(resolveThroughExisting(root) ?? root, resolved)) {
        return `refusing to remove through a directory inside a protected tree: ${current}`
      }
    }
    if (!pathWithin(canonicalHome, resolved)) {
      return `refusing to remove through a directory outside HOME: ${current}`
    }
  }

  // The leaf, if present, must be a plain file. A hard link is a shared inode and
  // an unlink would not corrupt it, but it also means the path is not ours, so be
  // strict and refuse it.
  let leaf: fs.Stats | null = null
  try {
    leaf = fs.lstatSync(plist)
  } catch {
    leaf = null
  }
  if (leaf === null) return null
  if (leaf.isSymbolicLink()) return `refusing to remove a symlinked plist: ${plist}`
  if (!leaf.isFile()) return `refusing to remove a non-regular plist: ${plist}`
  return null
}

/**
 * Boot the job out and remove ONLY its own plist. Logs are kept: they are the
 * only record of why a job failed, and they live outside graph.root/stateDir.
 */
export function uninstall(options: UninstallOptions): UninstallResult {
  const run = options.runCommand ?? defaultRunCommand
  const out = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))

  const configName = configNameOf(path.resolve(options.configPath))
  const layout = layoutFor(configName, options.home)

  // Validate the removal path BEFORE launchctl or any unlink: a redirected
  // LaunchAgents directory must not turn this into a delete inside the graph, and
  // a refused removal must not have touched the running job either (#3).
  const protectedRoots = options.protectedRoots ?? []
  const problem = removalPathProblem(layout, protectedRoots, options.home)
  if (problem !== null) {
    options.stderr?.(`mexplore-ui: ${problem}`)
    return { ok: false, exitCode: 1, plistPath: null, message: problem }
  }

  if (options.load !== false) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501
    // A job that is not loaded is not an error: bootout reports
    // "No such process" and we continue to the plist removal.
    run(['launchctl', 'bootout', `gui/${uid}/${layout.label}`])
  }

  let removed = false
  try {
    let info: fs.Stats | null = null
    try {
      info = fs.lstatSync(layout.plistPath)
    } catch {
      info = null
    }
    if (info !== null) {
      if (info.isDirectory()) throw new Error(`plist path is a directory: ${layout.plistPath}`)
      fs.unlinkSync(layout.plistPath)
      removed = true
    }
  } catch (error) {
    const message = `cannot remove plist: ${(error as Error).message}`
    options.stderr?.(`mexplore-ui: ${message}`)
    return { ok: false, exitCode: 1, plistPath: layout.plistPath, message }
  }

  out(
    removed
      ? `uninstalled ${layout.plistPath} (logs kept in ${layout.logDir})`
      : `no plist at ${layout.plistPath} (logs kept in ${layout.logDir})`,
  )
  return { ok: true, exitCode: 0, plistPath: removed ? layout.plistPath : null, message: removed ? 'uninstalled' : 'absent' }
}

interface CliArgs {
  action: 'install' | 'uninstall' | null
  config: string | null
  port: number
  noLoad: boolean
  /** Test/dev override for the built-asset directory. */
  dist: string | null
  errors: string[]
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const parsed: CliArgs = { action: null, config: null, port: DEFAULT_PORT, noLoad: false, dist: null, errors: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    if (flag === 'install' || flag === 'uninstall') {
      if (parsed.action !== null) parsed.errors.push(`only one action allowed (got ${parsed.action} and ${flag})`)
      parsed.action = flag
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
    if (flag === '--no-load') {
      parsed.noLoad = true
      continue
    }
    if (flag === '--dist') {
      const value = inline ?? (argv[++i] as string | undefined)
      if (value === undefined || value === '') parsed.errors.push('--dist requires a path')
      else parsed.dist = value
      continue
    }
    if (flag === '--help' || flag === '-h') {
      parsed.errors.push('__help__')
      continue
    }
    parsed.errors.push(`unknown argument: ${arg}`)
  }
  if (parsed.action === null && !parsed.errors.includes('__help__')) parsed.errors.push('an action is required')
  return parsed
}

const USAGE = `usage: bun scripts/agent.ts <install|uninstall> --config <path> [--port ${DEFAULT_PORT}] [--no-load] [--dist <dir>]

  install     render the LaunchAgent plist and bootstrap it (requires dist/)
  uninstall   boot the job out and remove only its own plist
  --no-load   write/remove the plist without calling launchctl (tests)
  --dist      serve built assets from <dir> instead of <package>/dist`

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseCliArgs(argv)
  if (args.errors.includes('__help__')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.errors.length > 0) {
    for (const message of args.errors) process.stderr.write(`mexplore-ui: ${message}\n`)
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  if (args.action === null) {
    process.stderr.write(`mexplore-ui: an action is required\n${USAGE}\n`)
    return 2
  }
  if (args.config === null) {
    process.stderr.write(`mexplore-ui: --config is required\n${USAGE}\n`)
    return 2
  }

  const home = process.env['HOME'] ?? os.homedir()
  const pathEnv = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

  if (args.action === 'install') {
    const result = await install({
      configPath: args.config,
      port: args.port,
      home,
      pathEnv,
      bunPath: process.execPath,
      load: !args.noLoad,
      ...(args.dist === null ? {} : { distDir: path.resolve(args.dist) }),
    })
    return result.exitCode
  }
  // Best-effort canonical roots: when the config cannot be read (the usual
  // reason someone uninstalls), an empty list still enforces the HOME-containment
  // and no-symlink rules — only the protected-tree comparison is skipped.
  let protectedRoots: string[] = []
  try {
    const config = await loadUiConfig(args.config)
    protectedRoots = [config.graphRoot, config.stateDir]
  } catch {
    protectedRoots = []
  }
  const result = uninstall({
    configPath: args.config,
    home,
    load: !args.noLoad,
    protectedRoots,
  })
  return result.exitCode
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
