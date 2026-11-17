// `bun run setup` (scripts/dev-install.ts) installs a checkout without the
// same-repo `#release/oss-initial::path:` git dependencies, which bun cannot resolve.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { devManifest } from '../scripts/dev-install'

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8'))

describe('dev install manifest', () => {
  test('drops exactly the same-repo git dependencies and keeps everything else', () => {
    const { manifest, siblings } = devManifest(pkg)
    expect(siblings.sort()).toEqual(['dsh_plugin', 'mexplore_ui'])
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toEqual(pkg.devDependencies)
    expect(manifest.name).toBe(pkg.name)
    // package.json itself is untouched.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['dsh-mexplore', 'mexplore-ui'])
  })

  test('keeps any other runtime dependency', () => {
    const { manifest, siblings } = devManifest({
      dependencies: {
        'dsh-mexplore': 'git+https://github.com/mexplor/Mexplore-oss.git#release/oss-initial::path:dsh_plugin',
        'other': '1.2.3',
        'elsewhere': 'git+ssh://git@github.com/someone/else.git#main::path:pkg',
      },
    })
    expect(siblings).toEqual(['dsh_plugin'])
    expect(manifest.dependencies).toEqual({
      other: '1.2.3',
      elsewhere: 'git+ssh://git@github.com/someone/else.git#main::path:pkg',
    })
  })

  test('runtime dependencies use only the planned public HTTPS repository and matching subdirectories', () => {
    expect(pkg.dependencies).toEqual({
      'dsh-mexplore': 'git+https://github.com/mexplor/Mexplore-oss.git#release/oss-initial::path:dsh_plugin',
      'mexplore-ui': 'git+https://github.com/mexplor/Mexplore-oss.git#release/oss-initial::path:mexplore_ui',
    })
  })

  test('keeps a different repository even when it names the same package directory', () => {
    const spec = 'git+https://github.com/example/unrelated.git#main::path:dsh_plugin'
    const { manifest, siblings } = devManifest({ dependencies: { 'dsh-mexplore': spec } })
    expect(siblings).toEqual([])
    expect(manifest.dependencies).toEqual({ 'dsh-mexplore': spec })
  })

  test('recognizes a named release branch without changing the original manifest', () => {
    const spec = 'git+https://github.com/mexplor/Mexplore-oss.git#release/0.3::path:mexplore_ui'
    const input = { dependencies: { 'mexplore-ui': spec } }
    expect(devManifest(input)).toEqual({ manifest: {}, siblings: ['mexplore_ui'] })
    expect(input.dependencies['mexplore-ui']).toBe(spec)
  })

  test('every in-repo fallback the script relies on exists in this checkout', () => {
    for (const dir of devManifest(pkg).siblings) {
      expect(() => readFileSync(path.resolve(import.meta.dir, '..', '..', dir, 'package.json'))).not.toThrow()
    }
  })
})
