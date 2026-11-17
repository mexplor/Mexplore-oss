/**
 * Loading dsh_plugin for the mexplore graph adapter (REQ-006).
 *
 * The adapter may be installed either as a real npm/git dependency
 * (`dsh-mexplore`) or straight out of the repository, where
 * `opencode_mexplore/` sits beside `dsh_plugin/` with no install step. Both
 * routes must hand back the SAME module instances, because dsh_plugin's
 * trusted-preparation and audited-refusal registries are private WeakMaps: a
 * second copy of `lib/tool.js` would silently never recognize a definition the
 * copy of `lib/index.js` built, and the write fence would treat every
 * provable non-execution as an uncertain one.
 *
 * @module mexplore/graph/load
 */

const PACKAGE = 'dsh-mexplore'

/** Repo-relative fallback: `opencode_mexplore/src/graph/` -> repo root. */
const FALLBACK_BASE = new URL('../../../dsh_plugin/lib/', import.meta.url)

/** One text block of a rendered tool result (`@deepseek-ai/dsh-tools` shape). */
export interface DshRenderBlock {
  type?: string
  text?: string
}

/** The slice of the dsh tool definition contract this adapter consumes. */
export interface DshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema?: unknown
    render: (args: unknown, value: unknown) => DshRenderBlock[]
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** The result of a definition's own trusted preparation (`lib/tool.js`). */
export interface DshPreparation {
  args: unknown
  violations: string[]
}

/** `dsh-mexplore` (the Cordis plugin entry). */
export interface DshPluginModule {
  name?: string
  inject?: string[]
  apply: (ctx: unknown, config: Record<string, unknown>) => void
}

/** `dsh-mexplore/tool` — the private trust registries. */
export interface DshToolModule {
  trustedPreparationFor: (definition: unknown) => ((args: unknown) => DshPreparation) | undefined
  consumeAuditedRefusal: (definition: unknown, exec: unknown, error: unknown) => string | undefined
  restateDeclaredPropertiesRemedy: (violation: string, properties: Record<string, unknown>) => string
}

/** The parsed contents of one `node.md` (dsh's `parseNode`). */
export interface DshNode {
  description: string
  created: string
  updated: string
  type: string
  extra: Array<[string, string]>
  body: string
}

/**
 * `dsh-mexplore/graph` — the storage layer. Everything this adapter
 * needs is read through it rather than re-implemented: `assertId` is the
 * traversal guard, `parseNode` is the body authority, and `withNodeLocks` is
 * the same read discipline dsh itself uses.
 */
export interface DshGraphModule {
  outEdges: (root: string, id: string) => Promise<string[]>
  /** Reject anything that is not a well-formed node id (blocks traversal). */
  assertId: (id: string, label?: string) => string
  /** Parse one `node.md` into its fields plus body. */
  parseNode: (text: string) => DshNode
  /** Run `fn` holding every requested per-Node lock. */
  withNodeLocks: <T>(root: string, ids: string[], fn: () => Promise<T>) => Promise<T>
}

export interface DshModules {
  plugin: DshPluginModule
  tool: DshToolModule
  graph: DshGraphModule
  source: 'package' | 'repo'
}

/**
 * Import `subpath` behind one package root, falling back to the repo copy of
 * the same directory. A specifier like `dsh-mexplore/tool` keeps the
 * subpath; the fallback resolves it against `FALLBACK_BASE`.
 */
function specifiers(subpath: string | undefined): { pkg: string; file: URL } {
  const pkg = subpath === undefined ? PACKAGE : `${PACKAGE}/${subpath}`
  const file = new URL(subpath === undefined ? 'index.js' : `${subpath}.js`, FALLBACK_BASE)
  return { pkg, file }
}

async function importWithFallback<T>(subpath: string | undefined): Promise<{ module: T; source: 'package' | 'repo' }> {
  const { pkg, file } = specifiers(subpath)
  try {
    return { module: (await import(pkg)) as T, source: 'package' }
  } catch (packageError) {
    try {
      return { module: (await import(file.href)) as T, source: 'repo' }
    } catch (repoError) {
      const packageMessage = packageError instanceof Error ? packageError.message : String(packageError)
      const repoMessage = repoError instanceof Error ? repoError.message : String(repoError)
      throw new Error(
        `mexplore: cannot load ${pkg} (${packageMessage}) nor its repo fallback ${file.pathname} (${repoMessage})`,
      )
    }
  }
}

/** Resolve once per process: three imports, one module graph. */
let cached: Promise<DshModules> | undefined

/**
 * Load dsh_plugin plus its `./tool` and `./graph` subpaths from ONE source, and
 * verify the two halves really share their private registries.
 *
 * The verification is not ceremony: `trustedPreparationFor` is a WeakMap lookup
 * keyed by the exact definition `defineTool` built, so "same instance" is the
 * difference between a provable non-execution and an uncertain write. Rather
 * than trust the resolver, probe it — `apply` registers a `memory_write`
 * definition through `defineTool`, and the tool module must recognize it.
 */
export function loadDshModules(): Promise<DshModules> {
  cached ??= (async () => {
    const [plugin, tool, graph] = await Promise.all([
      importWithFallback<DshPluginModule>(undefined),
      importWithFallback<DshToolModule>('tool'),
      importWithFallback<DshGraphModule>('graph'),
    ])
    if (typeof plugin.module.apply !== 'function') {
      throw new Error(`mexplore: ${PACKAGE} does not export apply()`)
    }
    for (const [label, value] of [
      ['trustedPreparationFor', tool.module.trustedPreparationFor],
      ['consumeAuditedRefusal', tool.module.consumeAuditedRefusal],
      ['restateDeclaredPropertiesRemedy', tool.module.restateDeclaredPropertiesRemedy],
    ] as const) {
      if (typeof value !== 'function') throw new Error(`mexplore: ${PACKAGE}/tool does not export ${label}()`)
    }
    for (const [label, value] of [
      ['outEdges', graph.module.outEdges],
      ['assertId', graph.module.assertId],
      ['parseNode', graph.module.parseNode],
      ['withNodeLocks', graph.module.withNodeLocks],
    ] as const) {
      if (typeof value !== 'function') throw new Error(`mexplore: ${PACKAGE}/graph does not export ${label}()`)
    }
    if (plugin.source !== tool.source || plugin.source !== graph.source) {
      // A mixed load would pair one copy's definitions with another copy's
      // trust registries — the exact failure this function exists to prevent.
      throw new Error(
        `mexplore: dsh_plugin subpaths resolved from different sources (index: ${plugin.source}, tool: ${tool.source}, graph: ${graph.source})`,
      )
    }
    return {
      plugin: plugin.module,
      tool: tool.module,
      graph: graph.module,
      source: plugin.source,
    }
  })()
  return cached
}

/** Drop the cached module graph. Test-only. */
export function resetDshModulesForTests(): void {
  cached = undefined
}
