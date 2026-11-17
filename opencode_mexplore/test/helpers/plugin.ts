/**
 * A fake host wired to a real mexplore plugin instance on a temp graph root.
 *
 * Every test gets its own graph directory, so nothing here depends on the
 * repo's own memory or on another test's leftovers.
 *
 * @module mexplore/test/helpers/plugin
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setupMexplore, type MexplorePlugin } from '../../src/index'
import { FakeHost, type FakeHostOptions } from './fake-host'

export interface Fixture {
  host: FakeHost
  plugin: MexplorePlugin
  /** Dispose the plugin and remove the temp graph root. */
  dispose: () => Promise<void>
  root: string
}

export interface FixtureOptions extends FakeHostOptions {
  /** Pass `null` to leave the option out entirely (env/default resolution). */
  graphRoot?: string | null
  timeoutMs?: number
  /** Extra plugin options, merged with the graph root. */
  options?: Record<string, unknown>
  /** Env vars to set for the duration of `setup` only. */
  env?: Record<string, string | undefined>
  /** The fake host's `ownerToken`, also handed to the setup for the sweep test. */
  ownerToken?: string
}

/** Explicit mock-provider configuration for lifecycle tests, never product defaults. */
export const CUSTOM_PROVIDER_SETTINGS = Object.freeze({
  mexploreModel: 'deepseek-v4.1-flash-1017',
  baseURL: 'https://memory.example.com/v1',
})

/** Make a fresh temp graph root. The caller removes it. */
export async function tempRoot(prefix = 'mexplore-plugin-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Run `body` with `env` applied, restoring the previous values afterwards. */
export async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Build a plugin against a fake host on a fresh temp graph root. The plugin is
 * set up inside this call, so env-based resolution sees the test's env.
 */
export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = options.graphRoot === null || options.graphRoot === undefined ? await tempRoot() : options.graphRoot
  // Existing lifecycle/usage tests request a connected custom provider. Give
  // that fixture an explicit public example endpoint/model, not an implicit
  // product default. Pass storage: {} to exercise a fresh key-only install.
  const host = new FakeHost({
    ...options,
    storage: options.storage ?? (options.keyConnected === true ? CUSTOM_PROVIDER_SETTINGS : undefined),
  })
  // A test must never touch the user's REAL state directory (Lane B review #13):
  // usage logging is on by default, so every fixture gets its own temp usage dir
  // unless the caller names one or turns logging off. A test that cares about
  // logging asserts against this dir (or passes its own).
  const usageDir: string =
    typeof options.options?.usageDir === 'string' ? options.options.usageDir : await tempRoot('mexplore-usage-')
  // MERGE, so `options` can override one key (usageDir, usageLog) without losing
  // the graph root — otherwise a test would silently use the real home dir.
  const pluginOptions: Record<string, unknown> = {
    ...(options.graphRoot === null ? {} : { graphRoot: root }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.ownerToken === undefined ? {} : { ownerToken: options.ownerToken }),
    usageDir,
    ...(options.options ?? {}),
  }
  // The host hands options in at setup; `options` is readonly on the real type,
  // so the fake's own object is replaced through its writable field.
  Object.assign(host.ctx, { options: pluginOptions })
  const { plugin, dispose } = await withEnv(options.env ?? {}, () => setupMexplore(host.ctx))
  return {
    host,
    plugin,
    root,
    dispose: async () => {
      await dispose()
      await fsp.rm(root, { recursive: true, force: true })
      // The temp usage dir this fixture created (never the real one).
      if (options.options?.usageDir === undefined) {
        await fsp.rm(usageDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}
