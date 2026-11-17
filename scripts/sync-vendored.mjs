#!/usr/bin/env node
// Write the generated copies of the host-neutral sources into dsh_plugin, or check them.
//
// The graph engine (mexplore_graph/src) and the history import core (mexplore_import/src) belong to
// no harness. DSH installs dsh_plugin straight from git without a build step, so their code is
// committed into dsh_plugin as generated copies: the source plus one GENERATED line on top, and a
// VENDORED.json with the sha256 of every source file.
//
//   node scripts/sync-vendored.mjs           write the copies and VENDORED.json
//   node scripts/sync-vendored.mjs --check   regenerate in memory and compare byte for byte; exit 1
//                                            on any difference, a missing copy, an extra file in an
//                                            import copy directory, or a source importing anything
//                                            but a node: module or a file of its own source tree
//
// Only node: modules, and nothing newer than Node 22.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The fixed mapping. `exclusive`: the destination directory holds nothing but the copies and
 * VENDORED.json, so an extra file there is an error. The graph engine's copies sit in dsh_plugin/lib
 * beside files of dsh_plugin's own, so only the listed files are compared there.
 */
export const MAPPINGS = [
  {
    source: 'mexplore_graph/src',
    dest: 'dsh_plugin/lib',
    files: ['graph.js', 'index.js', 'tool.js'],
    manifest: 'dsh_plugin/lib/VENDORED.json',
    exclusive: false,
  },
  {
    source: 'mexplore_import/src',
    dest: 'dsh_plugin/lib/import',
    files: null, // every .js file under the source
    manifest: 'dsh_plugin/lib/import/VENDORED.json',
    exclusive: true,
  },
]

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const posix = (p) => p.split(path.sep).join('/')

export const header = (source, rel) => `// GENERATED from ${source}/${rel} — do not edit; run \`node scripts/sync-vendored.mjs\`\n`

function listJs(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listJs(full, base))
    else if (e.isFile() && e.name.endsWith('.js')) out.push(posix(path.relative(base, full)))
  }
  return out.sort()
}

function listAll(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listAll(full, base))
    else out.push(posix(path.relative(base, full)))
  }
  return out.sort()
}

// Static imports and re-exports (`import x from`, `import { a, b as c } from`, `export * from`), bare
// side-effect imports, dynamic import() and require() with a literal specifier.
const SPECIFIERS = [
  /^[ \t]*(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]+?\s+from\s*(['"])(.+?)\1/gm,
  /^[ \t]*import\s*(['"])(.+?)\1/gm,
  /(?<![.\w$])import\(\s*(['"`])(.+?)\1/g,
  /(?<![.\w$])require\(\s*(['"`])(.+?)\1/g,
]

/**
 * Problems with the imports of one source file: only node: modules and files of the same source tree.
 * `rel` is the file's path inside its source tree; `where` names it in the messages.
 */
export function importProblems(text, rel, where = rel) {
  const problems = []
  for (const re of SPECIFIERS) {
    for (const m of text.matchAll(re)) {
      const spec = m[2]
      if (spec.startsWith('node:')) continue
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
        if (!target.startsWith('../') && target !== '..') continue
      }
      problems.push(`${where}: imports "${spec}" (only node: modules and files of its own source tree are allowed)`)
    }
  }
  return problems
}

/** Everything the mapping should put on disk: {path relative to the repo: Buffer}, plus problems. */
export function generate(repo = root) {
  const files = new Map()
  const problems = []
  for (const m of MAPPINGS) {
    const srcDir = path.join(repo, m.source)
    const names = m.files ?? listJs(srcDir)
    const hashes = {}
    for (const rel of names) {
      const src = fs.readFileSync(path.join(srcDir, rel))
      problems.push(...importProblems(src.toString('utf8'), rel, `${m.source}/${rel}`))
      hashes[rel] = sha256(src)
      files.set(`${m.dest}/${rel}`, Buffer.concat([Buffer.from(header(m.source, rel), 'utf8'), src]))
    }
    const manifest = { source: m.source, generatedBy: 'scripts/sync-vendored.mjs', files: hashes }
    files.set(m.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  }
  return { files, problems }
}

/** Differences between what should be on disk and what is: [] when in sync. */
export function check(repo = root) {
  const { files, problems } = generate(repo)
  const out = [...problems]
  for (const [rel, want] of files) {
    const full = path.join(repo, rel)
    if (!fs.existsSync(full)) out.push(`${rel}: missing; run node scripts/sync-vendored.mjs`)
    else if (!fs.readFileSync(full).equals(want)) out.push(`${rel}: differs from its source; run node scripts/sync-vendored.mjs (never edit a GENERATED copy)`)
  }
  for (const m of MAPPINGS.filter((x) => x.exclusive)) {
    for (const rel of listAll(path.join(repo, m.dest))) {
      if (!files.has(`${m.dest}/${rel}`)) out.push(`${m.dest}/${rel}: not generated from ${m.source}; remove it or add its source`)
    }
  }
  return out
}

function write(repo = root) {
  const { files, problems } = generate(repo)
  if (problems.length) return problems
  for (const m of MAPPINGS.filter((x) => x.exclusive)) {
    for (const rel of listAll(path.join(repo, m.dest))) {
      if (!files.has(`${m.dest}/${rel}`)) fs.rmSync(path.join(repo, m.dest, rel))
    }
  }
  for (const [rel, buf] of files) {
    const full = path.join(repo, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    if (!fs.existsSync(full) || !fs.readFileSync(full).equals(buf)) fs.writeFileSync(full, buf)
  }
  return []
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checking = process.argv.includes('--check')
  const problems = checking ? check() : write()
  if (problems.length) {
    for (const p of problems) console.error(p)
    process.exit(1)
  }
  console.log(checking ? 'vendored copies match their sources' : 'vendored copies written')
}
