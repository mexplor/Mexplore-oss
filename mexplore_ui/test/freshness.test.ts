// dist/ is committed (the plugin ships it), so it must not be stale.
//
// This rebuilds the UI into a TEMPORARY outDir and diffs the result against the
// committed `dist/`. It never writes to `dist/`.
//
// The comparison of the JS/CSS bundles uses the BUILD's own output, so a
// byte-diff is exact: Vite's content hashing makes the asset names stable for
// identical input, and `index.html` names those hashes. A difference means
// `src/web` (or index.html) changed after the last `bun run build:web` and the
// commit would ship the old UI.
//
// Skipped, with a clear message, when Vite is unavailable (a production install
// that only has the package's `files` set) — a missing devDependency is not a
// failed freshness check.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { cleanupTemps, tempDir } from './helpers.ts'

const PACKAGE_ROOT = path.resolve(import.meta.dir, '..')
const DIST = path.join(PACKAGE_ROOT, 'dist')
const TEMP_OUT = path.join(tempDir('mexplore-dist-'), 'dist')

/**
 * True when Vite's binary is installed.
 *
 * The build itself is run through `bun run build:web` — the SAME command that
 * produces the committed `dist/`, whose `vite` shim runs under node. Invoking
 * `node_modules/vite/bin/vite.js` directly under Bun produces a byte-different
 * bundle (the modulepreload helper is emitted for the other runtime), so a
 * direct invocation would report a spurious staleness on a perfectly fresh
 * `dist/`.
 */
function viteInstalled(): boolean {
  return (
    fs.existsSync(path.join(PACKAGE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')) ||
    fs.existsSync(path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'vite'))
  )
}

/** Every file under `dir`, relative, sorted — the manifest a diff compares. */
function manifest(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out
}

afterAll(cleanupTemps)

describe('committed dist/ is fresh', () => {
  test('a fresh build produces the same files', async () => {
    if (!viteInstalled()) {
      console.warn(
        'freshness: skipping — vite is not installed (run `bun install` in mexplore_ui to enable this check)',
      )
      return
    }

    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'build:web', '--', '--outDir', TEMP_OUT, '--emptyOutDir'],
      cwd: PACKAGE_ROOT,
      // `NODE_ENV=production` is what a plain `bun run build:web` yields when the
      // variable is unset, and it is load-bearing: under `NODE_ENV=test` (which
      // `bun test` exports here) Vite emits the DEVELOPMENT modulepreload helper
      // and the bundle hashes differ, so an inherited `test` would fake a stale
      // dist/.
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error(`vite build failed:\n${result.stdout.toString()}\n${result.stderr.toString()}`)
    }

    expect(fs.existsSync(path.join(TEMP_OUT, 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(DIST, 'index.html'))).toBe(true)

    const built = manifest(TEMP_OUT)
    const committed = manifest(DIST)
    expect(built).toEqual(committed)

    for (const rel of built) {
      const fresh = fs.readFileSync(path.join(TEMP_OUT, rel))
      const old = fs.readFileSync(path.join(DIST, rel))
      if (!fresh.equals(old)) {
        throw new Error(
          `dist/${rel} is stale: a fresh build differs from the committed file. Run \`bun run build:web\` and commit dist/.`,
        )
      }
    }
  }, 180_000)
})
