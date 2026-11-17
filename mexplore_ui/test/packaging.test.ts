// A git install (`opencode plugin add git+ssh://…::path:opencode_mexplore`, which
// pulls this package as `mexplore-ui` from the same repo) goes through pacote's
// GitFetcher. When the package.json carries ANY of these scripts, pacote runs a
// nested `npm install` inside the clone first ("git dep preparation"), which
// needs the user's npm, installs devDependencies, and failed outright in the
// real install test (2026-11-06: `NpmInstallFailedError: git dep preparation
// failed`). The built UI ships in dist/, so no install-time step is needed.
// See pacote lib/git.js #prepareDir.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const PREPARE_TRIGGERS = ['build', 'prepare', 'prepack', 'preinstall', 'install', 'postinstall'] as const

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
  workspaces?: unknown
}

describe('git-install packaging', () => {
  test('no script name makes pacote run a nested npm install on git install', () => {
    const present = PREPARE_TRIGGERS.filter((name) => pkg.scripts?.[name] !== undefined)
    expect(present).toEqual([])
    expect(pkg.workspaces).toBeUndefined()
  })
})
