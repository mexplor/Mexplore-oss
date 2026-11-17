/**
 * Contributor install for a repo checkout: `bun run setup` (instead of `bun install`).
 *
 * Why this exists: the runtime `dependencies` are same-repo HTTPS git specs
 * with a subdirectory selector (`git+https://…#release/oss-initial::path:dsh_plugin`). OpenCode's
 * Git installer understands this selector. Bun versions checked during the
 * integration (1.3.10 and 1.4.4) do not, and they resolve every declared
 * dependency, even optional/peer ones. Checkout setup therefore avoids asking
 * Bun to resolve the same-repository Git dependencies.
 *
 * A checkout doesn't need those packages anyway: `src/graph/load.ts` and
 * `src/plugin/ui.ts` fall back to the sibling `../dsh_plugin` and
 * `../mexplore_ui` directories. So this script installs everything EXCEPT the
 * same-repo git dependencies: it runs `bun install` on a copy of package.json
 * without them, in a scratch directory, then moves the result into place.
 * package.json itself is never modified. Extra arguments go to `bun install`.
 *
 * @module mexplore/scripts/dev-install
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** A same-repo dependency that a checkout provides as a sibling directory. */
const SAME_REPO = /^git\+https:\/\/github\.com\/mexplor\/Mexplore-oss\.git#[^:]+::path:([\w-]+)$/

interface Manifest {
  dependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * The manifest bun installs from: `pkg` minus its same-repo git dependencies.
 * Returns the sibling directories those dependencies stand for, so the caller
 * can check that the checkout really has them.
 */
export function devManifest(pkg: Manifest): { manifest: Manifest; siblings: string[] } {
  const kept: Record<string, string> = {}
  const siblings: string[] = []
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    const dir = SAME_REPO.exec(spec)?.[1]
    if (dir === undefined) kept[name] = spec
    else siblings.push(dir)
  }
  const manifest: Manifest = { ...pkg }
  if (Object.keys(kept).length > 0) manifest.dependencies = kept
  else delete manifest.dependencies
  return { manifest, siblings }
}

/** Replace `target` with `fresh`; if that fails, put the old `target` back. */
function swapIn(fresh: string, target: string, parked: string): void {
  const hadOld = existsSync(target)
  if (hadOld) renameSync(target, parked)
  try {
    renameSync(fresh, target)
  } catch (error) {
    if (hadOld) renameSync(parked, target)
    throw error
  }
}

function main(): void {
  const root = path.resolve(import.meta.dir, '..')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest
  const { manifest, siblings } = devManifest(pkg)

  const missing = siblings.filter((dir) => !existsSync(path.join(root, '..', dir, 'package.json')))
  if (missing.length > 0) {
    console.error(`dev-install: this needs a full repo checkout; missing sibling dir(s): ${missing.map((d) => `../${d}`).join(', ')}`)
    process.exit(1)
  }

  // Scratch dir inside the package (gitignored), so the final renames stay on
  // one filesystem. Claimed exclusively: a second concurrent run stops here
  // instead of deleting the first run's install.
  const scratch = path.join(root, '.dev-install')
  try {
    mkdirSync(scratch)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    console.error(`dev-install: ${scratch} already exists: another setup is running, or an earlier one crashed. If none is running, delete it and retry.`)
    process.exit(1)
  }
  try {
    writeFileSync(path.join(scratch, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const lock = path.join(root, 'bun.lock')
    if (existsSync(lock)) cpSync(lock, path.join(scratch, 'bun.lock'))

    const result = Bun.spawnSync(['bun', 'install', ...process.argv.slice(2)], {
      cwd: scratch,
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    if (result.exitCode !== 0) {
      // Not process.exit(): that would skip the scratch cleanup below.
      process.exitCode = result.exitCode ?? 1
      return
    }

    // A mode that installs nothing (e.g. --lockfile-only) leaves the current
    // node_modules alone.
    const fresh = path.join(scratch, 'node_modules')
    if (existsSync(fresh)) swapIn(fresh, path.join(root, 'node_modules'), path.join(scratch, 'node_modules.old'))
    if (existsSync(path.join(scratch, 'bun.lock'))) cpSync(path.join(scratch, 'bun.lock'), lock)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(`dev-install: done. Skipped ${siblings.map((d) => `../${d}`).join(', ') || 'nothing'} (used from this checkout).`)
}

if (import.meta.main) main()
