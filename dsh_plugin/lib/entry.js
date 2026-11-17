/**
 * Package-root entry (`dsh-mexplore`).
 *
 * DSH loads a package's browser half (`./client`, the Memory graph panel) only
 * for a row named by the bare package name; a subpath row such as
 * `dsh-mexplore/ui` is skipped (dsh-client-modules
 * `locatePkgJson` → `exactPackageSpecifier`). The panel's Host row therefore
 * has to use the bare name, which existing deployments already use for the
 * core plugin with a `graphRoot`. This entry tells the two apart by config:
 *
 *   config.panel === true  → the panel's read-only data routes (bundle/ui.js)
 *   anything else          → the core plugin, exactly as before (index.js)
 *
 * Everything index.js exports is re-exported unchanged.
 *
 * @module dsh-mexplore
 */

import * as core from './index.js'
import * as ui from './bundle/ui.js'

export * from './index.js'

export function apply(ctx, config = {}) {
  if (config !== null && typeof config === 'object' && config.panel === true) {
    const { panel: _panel, ...rest } = config
    // The core row's static inject is ['tools']; the panel needs the web
    // server and the connection gate, which ctx.inject waits for.
    return ctx.inject(ui.inject, (scoped) => ui.apply(scoped, rest))
  }
  return core.apply(ctx, config)
}
