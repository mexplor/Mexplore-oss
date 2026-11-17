#!/usr/bin/env node
/**
 * Build the memory-graph panel from mexplore_ui (which this script never
 * modifies) into two committed files:
 *
 *   lib/ui-server.js  ESM for the Host (Node), from ui-src/server-entry.ts:
 *                     mexplore_ui's Store + createApp with a run source that
 *                     reports usage unavailable; the bun:sqlite task reader
 *                     (usage/tasks.ts, matched by resolved path) is replaced by
 *                     ui-src/tasks-stub.ts so Bun never reaches the bundle.
 *   client.js         classic script for the DSH Web client: ui-src/client-shell.js
 *                     wrapping a CommonJS bundle of ui-src/panel.tsx whose React
 *                     imports resolve through the module loader's `require`.
 *
 * Build-time text patches to mexplore_ui sources (in memory only; each must
 * match exactly once or the build fails):
 *   - i18n.ts must not set <html lang> on the host page;
 *   - ForceGraph.tsx reads the `--sans` font from the panel root, not <html>.
 * styles.css is scoped under `.mxg-root` and its @keyframes renamed `mxg-*`.
 *
 * Usage: npm run build:ui   (esbuild and postcss are pinned devDependencies)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import postcss from 'postcss'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const uiDir = path.resolve(pkgDir, '..', 'mexplore_ui')
const srcDir = path.join(pkgDir, 'ui-src')
const nodePaths = [path.join(pkgDir, 'node_modules')]

export const ROOT_CLASS = 'mxg-root'
const ROOT = `.${ROOT_CLASS}`

// ---------------------------------------------------------------- CSS scoping

/** Scope one selector under the panel root. Page-level selectors become the root itself. */
function scopeSelector(selector) {
  const s = selector.trim()
  if (s === ':root' || s === 'html' || s === 'body' || s === '#root') return ROOT
  const page = /^(?::root|html|body)(?=[\s>+~.:[#]|$)\s*/.exec(s)
  if (page) {
    const rest = s.slice(page[0].length)
    return rest === '' ? ROOT : `${ROOT} ${rest}`
  }
  return `${ROOT} ${s}`
}

export function scopeCss(css) {
  const keyframes = new Set()
  const root = postcss.parse(css)
  root.walkAtRules(/keyframes$/i, (rule) => {
    keyframes.add(rule.params.trim())
    rule.params = `mxg-${rule.params.trim()}`
  })
  root.walkRules((rule) => {
    const parent = rule.parent
    if (parent && parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return
    rule.selectors = [...new Set(rule.selectors.map(scopeSelector))]
  })
  if (keyframes.size > 0) {
    const names = new RegExp(`(^|[\\s,])(${[...keyframes].map((k) => k.replace(/[-]/g, '\\-')).join('|')})(?=$|[\\s,;])`, 'g')
    root.walkDecls(/^(-webkit-)?animation(-name)?$/i, (decl) => {
      decl.value = decl.value.replace(names, (_m, lead, name) => `${lead}mxg-${name}`)
    })
  }
  const out = root.toString()
  // Fail loudly if anything would still reach the host page.
  const leaks = []
  postcss.parse(out).walkRules((rule) => {
    const parent = rule.parent
    if (parent && parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return
    for (const sel of rule.selectors) if (!sel.startsWith(ROOT)) leaks.push(sel)
  })
  if (leaks.length > 0) throw new Error(`unscoped selectors: ${leaks.slice(0, 5).join(', ')}`)
  return { css: out, keyframes: [...keyframes] }
}

// ---------------------------------------------------------------- source patches

const PATCHES = [
  {
    file: path.join(uiDir, 'src/web/i18n.ts'),
    find: "if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'",
    replace: 'void l // DSH panel: the host page owns <html lang>',
    count: 1,
  },
  {
    file: path.join(uiDir, 'src/web/graph/ForceGraph.tsx'),
    find: 'getComputedStyle(document.documentElement)',
    replace: `getComputedStyle(document.querySelector('${ROOT}') ?? document.documentElement)`,
    count: 1,
  },
]

function patchPlugin() {
  return {
    name: 'mxg-patches',
    setup(build) {
      for (const patch of PATCHES) {
        const filter = new RegExp(`${path.basename(patch.file).replace('.', '\\.')}$`)
        build.onLoad({ filter }, (args) => {
          if (path.resolve(args.path) !== patch.file) return undefined
          const text = fs.readFileSync(args.path, 'utf8')
          const found = text.split(patch.find).length - 1
          if (found !== patch.count) {
            throw new Error(`${path.relative(uiDir, patch.file)}: expected ${patch.count} match(es) of a build patch, found ${found}`)
          }
          return { contents: text.split(patch.find).join(patch.replace), loader: path.extname(args.path).slice(1) }
        })
      }
    },
  }
}

const TASKS_FILE = path.join(uiDir, 'src/server/usage/tasks.ts')

/**
 * Swap mexplore_ui's bun:sqlite task reader for the stub, matched by the file
 * an import resolves to rather than by its text (#293: `../usage/tasks` became
 * `./tasks.ts` and a text filter silently stopped matching). The panel never
 * calls it (server-entry.ts passes its own run source); the swap only keeps
 * `bun:sqlite` out of the bundle. buildUi fails if the file is never swapped,
 * so a rename in mexplore_ui cannot turn this into a silent no-op.
 */
export function tasksStubPlugin(stats = { swapped: 0 }) {
  return {
    name: 'mxg-tasks-stub',
    setup(build) {
      build.onResolve({ filter: /tasks(\.ts)?$/ }, (args) => {
        if (args.kind === 'entry-point' || !args.resolveDir) return undefined
        const target = path.resolve(args.resolveDir, args.path)
        if (target !== TASKS_FILE && `${target}.ts` !== TASKS_FILE) return undefined
        stats.swapped += 1
        return { path: path.join(srcDir, 'tasks-stub.ts') }
      })
    },
  }
}

function cssPlugin(scoped) {
  return {
    name: 'mxg-css',
    setup(build) {
      build.onResolve({ filter: /^mxg:scoped-css$/ }, () => ({ path: 'scoped-css', namespace: 'mxg' }))
      build.onLoad({ filter: /.*/, namespace: 'mxg' }, () => ({ contents: scoped, loader: 'text' }))
    },
  }
}

/** The module table offers react and react/jsx-runtime; nothing else may stay external. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

/**
 * Fail the build when the Node bundle could touch Bun: any `bun:` module
 * specifier anywhere in the text, or the `Bun` global anywhere in the code.
 * Comments are left out of the second check (esbuild keeps some of
 * mexplore_ui's doc comments, and they mention `Bun.serve`); strings are not.
 */
export async function assertNoBun(text, label) {
  const show = (t, i) => JSON.stringify(t.slice(Math.max(0, i - 40), i + 40))
  const spec = /\bbun:/.exec(text)
  if (spec) throw new Error(`${label} still references a bun: module (${show(text, spec.index)})`)
  const code = (await esbuild.transform(text, { loader: 'js', format: 'esm', minifyWhitespace: true, legalComments: 'none' })).code
  const global = /\bBun\b/.exec(code)
  if (global) throw new Error(`${label} still references the Bun global (${show(code, global.index)})`)
}

export async function buildUi({ write = true } = {}) {
  const banner = '// GENERATED by dsh_plugin/scripts/build-ui.mjs from ../mexplore_ui (unmodified) and ui-src/. Do not edit.'

  const stubStats = { swapped: 0 }
  const server = await esbuild.build({
    entryPoints: [path.join(srcDir, 'server-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    nodePaths,
    legalComments: 'inline',
    banner: { js: banner },
    plugins: [tasksStubPlugin(stubStats)],
    logLevel: 'warning',
  })
  const serverText = server.outputFiles[0].text
  if (stubStats.swapped === 0) {
    throw new Error(`${path.relative(uiDir, TASKS_FILE)} was never imported; update tasksStubPlugin in scripts/build-ui.mjs`)
  }
  await assertNoBun(serverText, 'lib/ui-server.js')

  const rawCss = fs.readFileSync(path.join(uiDir, 'src/web/styles.css'), 'utf8')
  const { css } = scopeCss(rawCss)

  const client = await esbuild.build({
    entryPoints: [path.join(srcDir, 'panel.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2020',
    jsx: 'automatic',
    external: CLIENT_EXTERNALS,
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    legalComments: 'inline',
    write: false,
    nodePaths,
    plugins: [patchPlugin(), cssPlugin(css)],
    logLevel: 'warning',
  })
  const bundleText = client.outputFiles[0].text
  const requested = [...bundleText.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1])
  const unexpected = requested.filter((name) => !CLIENT_EXTERNALS.includes(name))
  if (unexpected.length > 0) throw new Error(`client bundle requires modules the DSH module table lacks: ${unexpected.join(', ')}`)

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const shell = fs.readFileSync(path.join(srcDir, 'client-shell.js'), 'utf8')
  const parts = shell.split('/*__MXG_BUNDLE__*/')
  if (parts.length !== 2) throw new Error('client-shell.js must contain the bundle marker exactly once')
  const clientText = `${banner}\n${parts[0].split('__MXG_BUILD_TAG__').join(pkg.version)}${bundleText}${parts[1]}`

  if (write) {
    fs.writeFileSync(path.join(pkgDir, 'lib/ui-server.js'), serverText)
    fs.writeFileSync(path.join(pkgDir, 'client.js'), clientText)
  }
  return { serverText, clientText, css }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { serverText, clientText } = await buildUi()
  process.stdout.write(`lib/ui-server.js ${serverText.length} bytes, client.js ${clientText.length} bytes (esbuild ${esbuild.version})\n`)
}
