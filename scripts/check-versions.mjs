#!/usr/bin/env node
// Mexplore version check: the packages that ship together must share a major
// version. While a package is on 0.x, semver treats the minor as the breaking
// part, so the shared line is `0.<minor>` until 1.0; patch versions are free.
//
//   node scripts/check-versions.mjs            check (exit 1 on drift)
//   node scripts/check-versions.mjs --tag v0.3.1   also check a release tag
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['dsh_plugin', 'opencode_mexplore', 'mexplore_ui']
// semver.org grammar: no leading zeros, dot-separated non-empty pre-release
// identifiers, optional +build metadata.
const NUM = '0|[1-9]\\d*'
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

function line(version, where) {
  const m = SEMVER.exec(version)
  if (!m) {
    console.error(`${where}: "${version}" is not a semver version`)
    process.exit(1)
  }
  return m[1] === '0' ? `0.${m[2]}` : m[1]
}

const rows = PACKAGES.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  return { dir, name: pkg.name, version: pkg.version, line: line(pkg.version, `${dir}/package.json`) }
})

const tagArg = process.argv.indexOf('--tag')
if (tagArg !== -1) {
  const tag = process.argv[tagArg + 1] ?? ''
  const version = tag.replace(/^v/, '')
  rows.push({ dir: 'tag', name: tag, version, line: line(version, `tag ${tag}`) })
}

for (const r of rows) console.log(`${r.dir.padEnd(18)} ${String(r.name).padEnd(14)} ${r.version.padEnd(12)} line ${r.line}`)

const lines = new Set(rows.map((r) => r.line))
if (lines.size > 1) {
  console.error(`\nversion drift: these must share one ${[...lines][0].startsWith('0.') ? 'major.minor (0.x)' : 'major'} version: ${[...lines].join(', ')}`)
  process.exit(1)
}
console.log(`\nok: all on line ${[...lines][0]}`)
