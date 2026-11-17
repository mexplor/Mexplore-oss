/**
 * `/mexplore ui`: run the bundled usage dashboard inside the OpenCode server
 * (Lane B, item 5).
 *
 * The dashboard lives in the separate `mexplore-ui` package, whose `./plugin`
 * export starts a loopback HTTP server. This module is the plugin's side of that
 * contract, and it owns the awkward parts:
 *
 *   - **the module is resolved dynamically**, because a plugin's dependencies are
 *     not guaranteed to be on the same graph: the installed package
 *     (`mexplore-ui/plugin`) first, then the sibling checkout (`../mexplore_ui`).
 *     Both are only probed when the user actually runs the command;
 *   - **a Bun guard**, because the UI server is `Bun.serve` and the plugin may be
 *     loaded by a Node build of OpenCode;
 *   - **a process-wide singleton**, keyed by graph root, in
 *     `globalThis[Symbol.for('mexplore.ui')]`, with a reference count per plugin
 *     instance: a plugin reload must not open a second listener, and the last
 *     instance to release is the one that stops it. Concurrent starts are
 *     coalesced onto one promise;
 *   - **an asset preflight**, so a package without a built `dist/` fails with a
 *     sentence a person can act on rather than an empty page.
 *
 * Security is the UI lane's: the URL carries a capability token, and the server
 * is loopback-only. This side only ever prints the URL it was given.
 *
 * @module mexplore/plugin/ui
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPinnedDirectory } from './usage-log'

/** The `./plugin` contract `mexplore_ui` exports (Shared contract). */
export interface PluginUiOptions {
  graphRoot: string
  usageDir: string
  port?: number
  label?: string
}

export interface PluginUiHandle {
  url: string
  port: number
  graphRoot: string
  stop: () => Promise<void>
}

export interface PluginUiModule {
  startPluginUi: (options: PluginUiOptions) => Promise<PluginUiHandle>
  uiAssetsPresent: () => boolean
}

/**
 * A module override for tests. A module namespace object is frozen, so a test
 * cannot patch the export; it calls {@link setUiModuleForTests} instead.
 */
let loaderOverride: PluginUiModule | undefined

/** Install a fake UI module (tests only). Pass `undefined` to restore. */
export function setUiModuleForTests(module: PluginUiModule | undefined): void {
  loaderOverride = module
}

/** The default port the UI prefers; the UI lane falls back to an OS port. */
export const DEFAULT_UI_PORT = 43191

/** The global singleton's key, so a plugin reload shares one listener. */
const REGISTRY_KEY = Symbol.for('mexplore.ui')

/**
 * One running dashboard, shared by every plugin instance in this process.
 *
 * **Ownership is per INSTANCE, not per call** (Lane B review #3). A user who runs
 * `/mexplore ui` three times has one dashboard and one owner; a second instance
 * (another project in the same server) that starts it becomes a second owner.
 * The server stops when the last OWNER releases — never merely when some
 * instance's first reference goes away — and `/mexplore ui stop` deliberately
 * overrides that, because it is an explicit "stop it" from a person.
 */
interface RegistryEntry {
  handle?: PluginUiHandle
  starting?: Promise<PluginUiHandle>
  /** Owner tokens holding this dashboard. A Set, so re-starting is idempotent. */
  owners: Set<string>
}

/**
 * Is `entry` still THE registry entry for this graph root?
 *
 * Deleting by `graphRoot` alone erases a SUCCESSOR (review round 3, major 2): A
 * disposes, B has already created a fresh entry, then A's cleanup deletes B's
 * entry and B's listener becomes unreachable. Every mutation of the map goes
 * through this identity test instead.
 */
function isCurrent(entries: Registry, graphRoot: string, entry: RegistryEntry): boolean {
  return entries.get(graphRoot) === entry
}

/**
 * Owners that called `startUi` and then DISPOSED while the start was still
 * pending (review #2-3). A late listener must be stopped, never registered.
 */
const disposedOwners = new Set<string>()

type Registry = Map<string, RegistryEntry>

/**
 * Load the UI module, installed package first, sibling checkout second.
 *
 * Errors are COLLECTED, not just swallowed: the user's message has to say which
 * two specifiers were tried and why each failed, or "cannot find module" is a
 * dead end.
 */
export async function loadUiModule(): Promise<
  { module: PluginUiModule; source: string } | { error: string }
> {
  if (loaderOverride !== undefined) return { module: loaderOverride, source: 'fake' }
  const attempts: string[] = []
  const installed = 'mexplore-ui/plugin'
  try {
    const loaded = (await import(installed)) as PluginUiModule & { default?: PluginUiModule }
    return { module: pick(loaded), source: installed }
  } catch (error) {
    attempts.push(`${installed}: ${message(error)}`)
  }
  // The contributor route, and ONLY that (review #2-8): the sibling checkout is
  // allowed only when this file is genuinely inside a source checkout. An
  // installed plugin must never silently load neighbouring code — a broken
  // pinned dependency has to be reported, not papered over by whatever happens
  // to sit next to it.
  if (await isSourceCheckout()) {
    const sibling = new URL('../../../mexplore_ui/src/plugin.ts', import.meta.url).href
    try {
      const loaded = (await import(sibling)) as PluginUiModule & { default?: PluginUiModule }
      return { module: pick(loaded), source: 'mexplore_ui' }
    } catch (error) {
      attempts.push(`../mexplore_ui: ${message(error)}`)
    }
  } else {
    attempts.push('the sibling checkout is not used from an installed plugin')
  }
  return { error: attempts.join('; ') }
}

/**
 * Are we running from the repository checkout rather than an installed package?
 *
 * Both conditions must hold (review #2-8):
 *
 *   - this file is NOT under a `node_modules` path (an installed plugin always
 *     is; a clone is not), and
 *   - three levels up is a repository root: `.git` exists AND `mexplore_ui/`
 *     carries a `package.json` named `mexplore-ui`.
 *
 * The name check is what makes this identification rather than a guess: a random
 * directory named `mexplore_ui` does not qualify.
 */
export async function isSourceCheckout(): Promise<boolean> {
  const here = fileURLToPath(import.meta.url)
  if (here.split(path.sep).includes('node_modules')) return false
  const root = path.resolve(path.dirname(here), '..', '..', '..')
  const [git, manifest] = await Promise.all([
    fsp.stat(path.join(root, '.git')).then(() => true, () => false),
    fsp.readFile(path.join(root, 'mexplore_ui', 'package.json'), 'utf8').then(
      (raw) => (JSON.parse(raw) as { name?: unknown }).name === 'mexplore-ui',
      () => false,
    ),
  ])
  return git && manifest
}

function pick(loaded: PluginUiModule & { default?: PluginUiModule }): PluginUiModule {
  // A default export is accepted too: the contract fixes the NAMES, not whether
  // they are named or default exports.
  const candidate = loaded.default ?? loaded
  if (typeof candidate?.startPluginUi !== 'function' || typeof candidate.uiAssetsPresent !== 'function') {
    throw new Error('the module does not export startPluginUi and uiAssetsPresent')
  }
  return candidate
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The process-wide registry, created on first use. */
function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>
  holder[REGISTRY_KEY] ??= new Map<string, RegistryEntry>()
  return holder[REGISTRY_KEY] as Registry
}

export interface StartUiInput {
  graphRoot: string
  usageDir: string
  port?: number
  label?: string
}

export interface StartUiResult {
  url: string
  port: number
}

/**
 * Start (or join) the dashboard for this graph, as `owner` (a plugin instance).
 *
 * Idempotent per owner: calling it again from the same instance returns the same
 * dashboard and adds no reference. A DIFFERENT owner joins as a co-owner, so the
 * server outlives either one's disposal but stops when both are gone.
 *
 * `mkdir -p` runs first, because the UI opens both directories and a missing one
 * would be an unhelpful ENOENT deep inside the server.
 */
export async function startUi(input: StartUiInput & { owner?: string }): Promise<StartUiResult> {
  const owner = input.owner ?? DEFAULT_OWNER
  // REGISTERED AT ADMISSION (review #2-3). The work below awaits directory
  // creation and a dynamic import; `dispose` can land in that window, and a
  // registration that happened only afterwards would resurrect a listener whose
  // owner is already gone. Claiming the slot first means dispose always sees it.
  const entries = registry()
  const entry = entries.get(input.graphRoot) ?? { owners: new Set<string>() }
  entries.set(input.graphRoot, entry)
  entry.owners.add(owner)
  // A fresh start clears any earlier disposal marker for THIS owner: only a
  // disposal that lands AFTER this admission may cancel this start.
  disposedOwners.delete(owner)

  // ONE rollback scope for the WHOLE preflight (review round 3, major 3). Every
  // await below used to sit outside it, so a failed directory/module/asset check
  // left this owner in `owners` for ever: a later sibling would start a server
  // that could never be stopped, because the dead owner still held the entry.
  // Cancellation is PER OWNER (`disposedOwners`), not per entry (review round 3,
  // major 2): a co-owner's disposal must not cancel a start somebody else still
  // wants, and a `/mexplore ui stop` cancels every owner at once.
  const cancelled = (): boolean => disposedOwners.has(owner) || !isCurrent(entries, input.graphRoot, entry)
  try {
    // The graph root is created 0700 only when WE create it: an existing
    // directory is the user's (Lane B review #4), and a shared one must not lose
    // its mode merely because the dashboard was opened. The usage dir keeps its
    // own policy.
    await ensureDir(input.graphRoot, { mode: 0o700, onlyIfCreated: true })
    // The usage directory is OURS, and the reader refuses a symlinked one: refuse
    // it here too, before anything is mutated through the link (review #2-2).
    await ensureDir(input.usageDir, {
      mode: 0o700,
      onlyIfCreated: false,
      refuseSymlink: true,
      ...(__uiDirTestHook.beforePin === undefined ? {} : { hook: () => __uiDirTestHook.beforePin?.(input.usageDir) }),
    })

    const loaded = await loadUiModule()
    if ('error' in loaded) {
      throw new Error(
        `the bundled memory UI is not installed (${loaded.error}). Reinstall the plugin, or run \`opencode plugin update\`.`,
      )
    }
    if (!loaded.module.uiAssetsPresent()) {
      throw new Error(
        `the bundled memory UI has no built assets in ${loaded.source}. Reinstall the plugin, or run \`opencode plugin update\`.`,
      )
    }

    if (entry.handle !== undefined) return { url: entry.handle.url, port: entry.handle.port }
    // Cancelled while we were in preflight: nothing is listening, so refuse
    // rather than starting a listener nobody can reach (review round 3, major 2).
    if (cancelled()) throw unloaded('starting')
    // Coalesce concurrent starts onto one promise: two `/mexplore ui` at once must
    // not race two listeners onto one port.
    entry.starting ??= loaded.module.startPluginUi({
      graphRoot: input.graphRoot,
      usageDir: input.usageDir,
      port: input.port ?? DEFAULT_UI_PORT,
      ...(input.label === undefined ? {} : { label: input.label }),
    })
    const handle = await entry.starting
    // The listener is shared by every owner of this entry, so a LEAVING owner
    // must not stop it (review round 3, major 2): only a handle nobody can
    // reach — its entry replaced by a successor, or no owners left at all — is
    // stopped here.
    if (!isCurrent(entries, input.graphRoot, entry) || entry.owners.size === 0) {
      delete entry.starting
      if (isCurrent(entries, input.graphRoot, entry)) entries.delete(input.graphRoot)
      await handle.stop().catch(() => undefined)
      throw unloaded('starting')
    }
    // Publish for the owners that remain, then refuse only THIS one if it left
    // while the listener was being created.
    entry.handle = handle
    if (disposedOwners.has(owner)) {
      disposedOwners.delete(owner)
      throw unloaded('starting')
    }
    return { url: handle.url, port: handle.port }
  } catch (error) {
    // Roll back only the ownership THIS call newly admitted: another instance's
    // owner, or a running handle, is untouched. This runs for PREFLIGHT failures
    // too (review round 3, major 3) — a failed directory or asset check used to
    // leave a phantom owner that kept the server unstoppable for everyone else.
    entry.owners.delete(owner)
    delete entry.starting
    // Delete by IDENTITY: a successor entry (a different object) must survive.
    if (entry.owners.size === 0 && isCurrent(entries, input.graphRoot, entry)) entries.delete(input.graphRoot)
    throw error
  }
}

function unloaded(phase: 'starting'): string {
  return `mexplore: the plugin unloaded while the usage UI was ${phase}`
}

/** The owner token used when a caller does not name one (tests, one-off use). */
export const DEFAULT_OWNER = 'plugin'

/**
 * Release `owner`'s hold on the dashboard; the LAST owner stops it.
 *
 * `stop()` is awaited, so a caller that is reloading can be sure the port is
 * free before a new instance tries to bind it. An owner that holds nothing here
 * is a no-op — it can never decrement another instance's ownership.
 */
export async function releaseUi(graphRoot: string, owner: string = DEFAULT_OWNER): Promise<boolean> {
  const entries = registry()
  const entry = entries.get(graphRoot)
  if (entry === undefined) {
    // A start may be PENDING for this owner (review #2-3): remember the disposal
    // so the late listener is stopped when it arrives.
    disposedOwners.add(owner)
    return false
  }
  // Returns whether a RUNNING server was stopped. A release that only drops an
  // owner (another one remains, or a start is still pending) reports `false`:
  // nothing was listening to stop. The disposal is still recorded, so a pending
  // start stops its own listener when it arrives (review #2-3).
  if (!entry.owners.delete(owner)) return false
  // A pending start by THIS owner must not publish a late listener (review
  // round 3, major 2). Other owners are unaffected.
  disposedOwners.add(owner)
  if (entry.owners.size > 0) return false
  // Delete by IDENTITY: a successor entry must survive this (review round 3).
  if (isCurrent(entries, graphRoot, entry)) entries.delete(graphRoot)
  return stopEntry(entry)
}

/**
 * `/mexplore ui stop`: stop it for this graph OUTRIGHT, whoever owns it.
 *
 * The person asked for it to stop; honouring a reference count over that would
 * leave a listener the user cannot see. Every owner in this process is dropped.
 */
export async function stopUi(graphRoot: string): Promise<boolean> {
  const entries = registry()
  const entry = entries.get(graphRoot)
  if (entry === undefined) return false
  // Cancel every pending start FIRST, so one that resumes stops its own late
  // handle instead of listening forever (review round 3, major 2).
  for (const owner of entry.owners) disposedOwners.add(owner)
  if (isCurrent(entries, graphRoot, entry)) entries.delete(graphRoot)
  entry.owners.clear()
  return stopEntry(entry)
}

/** Stop one registry entry's server, if it has one. */
async function stopEntry(entry: RegistryEntry): Promise<boolean> {
  const handle = entry.handle ?? (await entry.starting?.catch(() => undefined))
  delete entry.handle
  delete entry.starting
  if (handle === undefined) return false
  await handle.stop().catch(() => undefined)
  return true
}

/** Is a dashboard running for this graph in this process? */
export function uiRunning(graphRoot: string): boolean {
  return registry().get(graphRoot)?.handle !== undefined
}

/** The running dashboard's URL, when one is up. */
export function uiUrl(graphRoot: string): string | undefined {
  return registry().get(graphRoot)?.handle?.url
}

/**
 * Create `dir` if needed, applying `mode` only to a directory WE create.
 *
 * `onlyIfCreated` is the graph-root rule (review #4): the path may be a directory
 * the user chose and populated, and re-chmodding it — or, worse, the target of a
 * symlink it points at — would silently take away permissions they set. The usage
 * directory is ours alone, so its mode is enforced every time.
 *
 * The mode is applied with `fchmod` on a PINNED directory descriptor (review
 * round 3, major 1): a path-based `chmod` can be pointed at an unrelated file by
 * swapping the directory for a symlink between the `lstat` and the `chmod`.
 */
async function ensureDir(
  dir: string,
  options: { mode: number; onlyIfCreated: boolean; refuseSymlink?: boolean; hook?: () => void | Promise<void> },
): Promise<void> {
  // `lstat`, never `stat` (review #2-2): `stat` follows a link, so a symlinked
  // directory would look ordinary.
  const existing = await fsp.lstat(dir).catch(() => undefined)
  if (existing !== undefined && existing.isSymbolicLink() && options.refuseSymlink === true) {
    throw new Error(`refusing to use the usage directory ${dir}: it is a symlink`)
  }
  const existed = existing !== undefined
  if (!existed) {
    await fsp.mkdir(dir, { recursive: true, mode: options.mode })
  }
  if (existing !== undefined && existing.isSymbolicLink()) return
  if (options.onlyIfCreated && existed) return
  if (options.hook !== undefined) await options.hook()
  // The pin is the check: `O_DIRECTORY|O_NOFOLLOW` plus an ownership test, and
  // the mode goes on THAT inode.
  const pinned = await openPinnedDirectory(dir).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (options.refuseSymlink === true) throw new Error(`${message} (symlink or not a directory)`)
    throw error
  })
  try {
    await pinned.handle.chmod(options.mode).catch(() => undefined)
  } finally {
    await pinned.handle.close().catch(() => undefined)
  }
}

/**
 * Test seam for the directory pin (review round 3, major 1): called AFTER the
 * pre-checks and BEFORE the directory is opened/chmod-ed, so a test can swap the
 * directory for a symlink inside that window.
 */
export const __uiDirTestHook: { beforePin?: (dir: string) => void | Promise<void> } = {}

/** The reply text for a successful start (Lane B, item 5). */
export function uiReply(url: string): string[] {
  return [
    `mexplore usage UI: ${url}`,
    'It is served on loopback by the OpenCode server, and stays up until `/mexplore ui stop`, a plugin reload, or OpenCode exits.',
    'A remote OpenCode server serves it on THAT machine, not on yours.',
    'The link contains an access token for this session of the dashboard; anyone with it can read this graph, so don\'t share it.',
    'Open it in a browser on the machine running the OpenCode server (the terminal UI shows it here because a plugin cannot launch a browser).',
  ]
}

/** The shared Bun guard's wording: the UI server is `Bun.serve`. */
export const BUN_REQUIRED = '/mexplore ui needs the Bun build of OpenCode (it starts a local web server).'

/** `path` re-export keeps this module's imports honest in a bundler. */
void path
