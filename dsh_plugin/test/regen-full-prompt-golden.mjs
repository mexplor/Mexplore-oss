// Regenerate dsh_plugin/test/fixtures/full-prompt.golden.txt — the RENDERED
// `full` prompt on an empty graph, with the clock, the calendar strip, the
// handoff banner and the index left as slots so the file is deterministic.
//
// Run from dsh_plugin/:  node test/regen-full-prompt-golden.mjs
//
// The golden's whole job is to fail when the DEFAULT output changes, so only
// regenerate it when a change to the full prompt is intended.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { apply } = await import(pathToFileURL(path.join(here, '../lib/index.js')).href)

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memgraph-golden-'))
let section = ''
const variables = new Map()
apply(
  {
    tools: { register: () => () => {} },
    inject: (_names, callback) =>
      callback({
        systemPrompt: {
          section: (value) => { section = value.text; return () => {} },
          variable: (key, provider) => { variables.set(key, provider); return () => {} },
        },
      }),
  },
  { graphRoot: root },
)

const KEEP = ['memory_calendar', 'memory_today', 'memory_handoffs', 'memory_index']
const rendered = section.replace(/\{\{(\w+)\}\}/g, (match, key) => {
  if (KEEP.includes(key)) return match
  const provider = variables.get(key)
  if (provider === undefined) return ''
  return typeof provider === 'function' ? provider({}) : String(provider)
})

await fsp.writeFile(path.join(here, 'fixtures/full-prompt.golden.txt'), rendered, 'utf8')
await fsp.rm(root, { recursive: true, force: true })
console.log(`wrote fixtures/full-prompt.golden.txt (${rendered.length} chars)`)
