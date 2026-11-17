// CLI and installer tests (REQ-001, REQ-011, REQ-012, AC-013, AC-014, AC-021).
//
// The installer is exercised with a temp HOME and `--no-load`, so no launchctl
// command is ever issued against the real user session and no file outside the
// temp HOME is touched.

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { install, layoutFor, parseCliArgs, uninstall } from '../scripts/agent.ts'
import { parseArgs, parsePort, startServer } from '../src/server/cli.ts'
import { configNameOf, loadUiConfig } from '../src/server/config.ts'
import { labelFor, renderPlist } from '../src/server/plist.ts'
import {
  cleanupTemps,
  newNode,
  tempDir,
  treeSignature,
  writeConfig,
} from './helpers.ts'

afterAll(() => cleanupTemps())

function fixturePackage(): { graphRoot: string; stateDir: string; configPath: string } {
  const base = tempDir()
  const graphRoot = path.join(base, 'graph')
  newNode(graphRoot, 'cli fixture node')
  const stateDir = path.join(base, 'state')
  fs.mkdirSync(stateDir, { recursive: true })
  const configPath = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
  return { graphRoot, stateDir, configPath }
}

// ---- arg parsing ---------------------------------------------------------

describe('CLI argument parsing', () => {
  test('--config and --port in both spellings', () => {
    expect(parseArgs(['--config', '/a/b.json'])).toMatchObject({ config: '/a/b.json', port: 43190, errors: [] })
    expect(parseArgs(['--config=/a/b.json', '--port', '5000'])).toMatchObject({ config: '/a/b.json', port: 5000 })
    expect(parseArgs(['--config=/a/b.json', '--port=5001'])).toMatchObject({ config: '/a/b.json', port: 5001 })
  })

  test('the default port is 43190 (REQ-011, AC-013)', () => {
    expect(parseArgs(['--config', '/a/b.json']).port).toBe(43190)
  })

  test('bad ports and unknown flags are errors', () => {
    expect(parseArgs(['--config', '/a', '--port', 'abc']).errors.length).toBe(1)
    expect(parseArgs(['--config', '/a', '--port', '0']).errors.length).toBe(1)
    expect(parseArgs(['--config', '/a', '--port', '70000']).errors.length).toBe(1)
    expect(parseArgs(['--config', '/a', '--nope']).errors.length).toBe(1)
    expect(parseArgs(['--config']).errors.length).toBe(1)
  })
})

describe('config loading (REQ-001, CON-002)', () => {
  test('configName is the basename without its extension', () => {
    expect(configNameOf('/x/y/test_1.json')).toBe('test_1')
    expect(configNameOf('/x/y/ab263-swap.json')).toBe('ab263-swap')
    expect(configNameOf('plain')).toBe('plain')
  })

  test('a missing config fails with a clear message', async () => {
    await expect(loadUiConfig('/definitely/not/here.json')).rejects.toThrow(/config file not found/)
  })

  test('invalid JSON fails clearly', async () => {
    const file = path.join(tempDir(), 'bad.json')
    fs.writeFileSync(file, '{not json', 'utf8')
    await expect(loadUiConfig(file)).rejects.toThrow(/not valid JSON/)
  })

  test('an unknown config key is rejected by parseConfigShape', async () => {
    const { graphRoot, stateDir } = fixturePackage()
    const file = path.join(tempDir(), 'unknown.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        stateDir,
        graph: { id: 'x', handle: 'x', root: graphRoot },
        runtime: { adapter: 'dsh', executable: '/bin/true', profile: 'p', plugin: '/bin/true' },
        port_ui: 1234,
      }),
      'utf8',
    )
    await expect(loadUiConfig(file)).rejects.toThrow(/config\.port_ui is not allowed/)
  })

  test('a missing graph.root or stateDir fails at startup', async () => {
    const base = tempDir()
    const file = path.join(base, 'gone.json')
    writeConfig(file, path.join(base, 'no-graph'), path.join(base, 'no-state'))
    await expect(loadUiConfig(file)).rejects.toThrow(/graph\.root does not exist/)
  })

  test('loading a config writes nothing (no mkdir, no chmod)', async () => {
    const base = tempDir()
    const graphRoot = path.join(base, 'graph')
    newNode(graphRoot, 'ro config node')
    const stateDir = path.join(base, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    const file = writeConfig(path.join(base, 'test_1.json'), graphRoot, stateDir)
    const before = fs.statSync(stateDir).mode
    await loadUiConfig(file)
    expect(fs.statSync(stateDir).mode).toBe(before)
    expect(fs.readdirSync(stateDir)).toEqual([])
  })
})

// ---- server start / port conflicts --------------------------------------

describe('AC-013 / AC-014: port selection and conflicts', () => {
  test('an explicit port is honoured and the server answers', async () => {
    const { graphRoot, stateDir, configPath } = fixturePackage()
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
    const port = probe.port as number
    await probe.stop(true)

    const started = await startServer({ configPath, port })
    try {
      expect(started.port).toBe(port)
      expect(started.graphRoot).toBe(fs.realpathSync(graphRoot))
      const response = await fetch(`http://127.0.0.1:${port}/api/meta`)
      expect(response.status).toBe(200)
      const meta = (await response.json()) as { graphRoot: string; stateDir: string }
      expect(meta.graphRoot).toBe(fs.realpathSync(graphRoot))
      expect(meta.stateDir).toBe(fs.realpathSync(stateDir))
    } finally {
      await started.stop()
    }
  })

  test('AC-014: a taken port fails with EADDRINUSE and binds nothing else', async () => {
    const { configPath } = fixturePackage()
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('blocker') })
    const port = blocker.port as number
    try {
      await expect(startServer({ configPath, port })).rejects.toThrow()
    } finally {
      await blocker.stop(true)
    }
  })

  test('the CLI exits 1 with `port <n> in use` on a taken port', async () => {
    const { configPath } = fixturePackage()
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('blocker') })
    const port = blocker.port as number
    try {
      const proc = Bun.spawn([process.execPath, 'src/server/cli.ts', '--config', configPath, '--port', String(port)], {
        cwd: path.resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      expect(exitCode).toBe(1)
      expect(stderr).toContain(`port ${port} in use`)
    } finally {
      await blocker.stop(true)
    }
  })

  test('the CLI exits non-zero for a missing --config', async () => {
    const proc = Bun.spawn([process.execPath, 'src/server/cli.ts'], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).not.toBe(0)
    expect(await new Response(proc.stderr).text()).toContain('--config is required')
  })

  test('the CLI prints the startup line and serves /api/meta', async () => {
    const { configPath, graphRoot } = fixturePackage()
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    const port = probe.port as number
    await probe.stop(true)

    const proc = Bun.spawn([process.execPath, 'src/server/cli.ts', '--config', configPath, '--port', String(port)], {
      cwd: path.resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ''
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !output.includes('graph=')) {
        const chunk = await reader.read()
        if (chunk.done) break
        output += decoder.decode(chunk.value)
      }
      reader.releaseLock()
      expect(output).toContain(`mexplore-ui (read-only) → http://127.0.0.1:${port}  graph=`)
      expect(output).toContain(fs.realpathSync(graphRoot))

      const response = await fetch(`http://127.0.0.1:${port}/api/meta`)
      expect(response.status).toBe(200)
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  }, 20_000)
})

// ---- plist renderer ------------------------------------------------------

describe('plist renderer (REQ-012, golden)', () => {
  const input = {
    configName: 'test_1',
    bunPath: '/Users/someone/.bun/bin/bun',
    cliPath: '/Users/someone/Projects/memory_graph/mexplore_ui/src/server/cli.ts',
    configPath: '/Users/someone/.config/memory-agent/test_1.json',
    port: 43190,
    workingDirectory: '/Users/someone/Projects/memory_graph/mexplore_ui',
    logPath: '/Users/someone/.local/state/mexplore-ui/test_1/ui.log',
    home: '/Users/someone',
    pathEnv: '/Users/someone/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  }

  test('renders exactly the golden plist', () => {
    const golden = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'ai.mexplore.mexplore-ui.test_1.plist'), 'utf8')
    expect(renderPlist(input)).toBe(golden)
  })

  test('carries the required launchd keys', () => {
    const xml = renderPlist(input)
    expect(xml).toContain('<key>Label</key>\n  <string>ai.mexplore.mexplore-ui.test_1</string>')
    expect(xml).toContain('<key>WorkingDirectory</key>\n  <string>/Users/someone/Projects/memory_graph/mexplore_ui</string>')
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(xml).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>Crashed</key>\n    <true/>\n  </dict>')
    expect(xml).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>')
    expect(xml).toContain('<key>NO_PROXY</key>\n    <string>127.0.0.1,localhost</string>')
    expect(xml).toContain('<string>--config</string>')
    expect(xml).toContain('<string>--port</string>\n    <string>43190</string>')
    // Both streams go to the same log file.
    expect(xml.match(/ui\.log<\/string>/g)?.length).toBe(2)
  })

  test('the label carries the config name', () => {
    expect(labelFor('test_1')).toBe('ai.mexplore.mexplore-ui.test_1')
    expect(renderPlist({ ...input, configName: 'ab263-swap' })).toContain('ai.mexplore.mexplore-ui.ab263-swap')
  })

  test('XML special characters are escaped', () => {
    const xml = renderPlist({ ...input, pathEnv: '/a&b:/c<d>' })
    expect(xml).toContain('/a&amp;b:/c&lt;d&gt;')
    expect(xml).not.toContain('/a&b')
  })
})

// ---- installer -----------------------------------------------------------

describe('AC-021: installer against a temp HOME', () => {
  function distFixture(): string {
    const dist = path.join(tempDir('mexplore-dist-'), 'dist')
    fs.mkdirSync(dist, { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>', 'utf8')
    return dist
  }

  test('creates the log directory and writes the plist without loading', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const distDir = distFixture()
    const calls: string[][] = []

    const result = await install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/Users/someone/.bun/bin/bun',
      load: false,
      distDir,
      runCommand: (command) => {
        calls.push(command)
        return { status: 0, stdout: '', stderr: '' }
      },
      stdout: () => {},
    })

    expect(result.ok).toBe(true)
    expect(calls).toEqual([]) // --no-load issues no launchctl command
    const layout = layoutFor('test_1', home)
    expect(layout.logDir).toBe(path.join(home, '.local', 'state', 'mexplore-ui', 'test_1'))
    expect(fs.statSync(layout.logDir).isDirectory()).toBe(true)
    expect(fs.existsSync(layout.plistPath)).toBe(true)
    expect(fs.readFileSync(layout.plistPath, 'utf8')).toContain(`<string>${path.resolve(configPath)}</string>`)
  })

  test('refuses to write a plist when dist/ is missing', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const messages: string[] = []
    const result = await install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: false,
      distDir: path.join(home, 'no-dist'),
      stderr: (line) => messages.push(line),
      stdout: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.plistPath).toBeNull()
    expect(fs.existsSync(layoutFor('test_1', home).plistPath)).toBe(false)
    expect(messages.join('\n')).toContain('bun run build:web')
  })

  test('a bad config is refused before anything is written', async () => {
    const home = tempDir('mexplore-home-')
    const distDir = distFixture()
    const result = await install({
      configPath: path.join(home, 'missing.json'),
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: false,
      distDir,
      stderr: () => {},
      stdout: () => {},
    })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false)
  })

  test('bootstrap is called with gui/<uid>, the plist path, and the log dir already present', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const layout = layoutFor('test_1', home)
    const calls: string[][] = []
    // AC-021: launchd does not create StandardOutPath parents, so the job would
    // crash-loop under KeepAlive if the log directory were missing at bootstrap.
    // Assert the state INSIDE the bootstrap mock, not merely after install.
    let logDirAtBootstrap = false
    let plistAtBootstrap = false
    const result = await install({
      configPath,
      port: 43191,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: true,
      distDir: distFixture(),
      runCommand: (command) => {
        calls.push(command)
        if (command[1] === 'bootstrap') {
          logDirAtBootstrap = fs.existsSync(layout.logDir) && fs.statSync(layout.logDir).isDirectory()
          plistAtBootstrap = fs.existsSync(layout.plistPath)
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      stdout: () => {},
      stderr: () => {},
    })
    expect(result.ok).toBe(true)
    expect(logDirAtBootstrap).toBe(true)
    expect(plistAtBootstrap).toBe(true)
    const uid = process.getuid?.() ?? 501
    const bootstrap = calls.find((command) => command[1] === 'bootstrap')
    expect(bootstrap).toEqual(['launchctl', 'bootstrap', `gui/${uid}`, layout.plistPath])
    // Bootout precedes bootstrap, so a stale instance cannot hold the port.
    const bootoutIndex = calls.findIndex((command) => command[1] === 'bootout')
    const bootstrapIndex = calls.findIndex((command) => command[1] === 'bootstrap')
    expect(bootoutIndex).toBeGreaterThanOrEqual(0)
    expect(bootoutIndex).toBeLessThan(bootstrapIndex)
  })

  test('a failed bootstrap reports failure', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const result = await install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: true,
      distDir: distFixture(),
      runCommand: (command) =>
        command[1] === 'bootstrap'
          ? { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
          : { status: 0, stdout: '', stderr: '' },
      stdout: () => {},
      stderr: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  test('uninstall removes only its own plist and keeps the logs', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    await install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: false,
      distDir: distFixture(),
      stdout: () => {},
    })
    const layout = layoutFor('test_1', home)
    fs.writeFileSync(layout.logPath, 'startup line\n', 'utf8')
    // A sibling agent plist must survive.
    const sibling = path.join(home, 'Library', 'LaunchAgents', 'ai.mexplore.memory-agent.test_1.plist')
    fs.writeFileSync(sibling, 'agent plist', 'utf8')

    const calls: string[][] = []
    const result = uninstall({
      configPath,
      home,
      runCommand: (command) => {
        calls.push(command)
        return { status: 3, stdout: '', stderr: 'No such process' }
      },
      stdout: () => {},
    })

    expect(result.ok).toBe(true)
    const uid = process.getuid?.() ?? 501
    expect(calls[0]).toEqual(['launchctl', 'bootout', `gui/${uid}/ai.mexplore.mexplore-ui.test_1`])
    expect(fs.existsSync(layout.plistPath)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
    expect(fs.existsSync(layout.logPath)).toBe(true)
  })

  test('uninstalling when nothing is installed is not an error', () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const result = uninstall({
      configPath,
      home,
      runCommand: () => ({ status: 3, stdout: '', stderr: 'No such process' }),
      stdout: () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  test('the installer CLI parses install/uninstall with --no-load', () => {
    expect(parseCliArgs(['install', '--config', '/a/test_1.json', '--port', '43191', '--no-load'])).toMatchObject({
      action: 'install',
      config: '/a/test_1.json',
      port: 43191,
      noLoad: true,
    })
    expect(parseCliArgs(['uninstall', '--config=/a/test_1.json'])).toMatchObject({ action: 'uninstall', noLoad: false })
    expect(parseCliArgs([]).errors.length).toBe(1)
    expect(parseCliArgs(['install']).config).toBeNull()
  })

  test('the installer CLI runs end to end with --no-load and a temp HOME', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const distDir = distFixture()
    // Point HOME at the temp dir; --no-load keeps launchctl out of it.
    const proc = Bun.spawn(
      [process.execPath, 'scripts/agent.ts', 'install', '--config', configPath, '--no-load', '--dist', distDir],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    const layout = layoutFor('test_1', home)
    expect(stdout).toContain(`installed ${layout.plistPath}`)
    expect(fs.existsSync(layout.plistPath)).toBe(true)
    expect(fs.existsSync(layout.logDir)).toBe(true)

    // And uninstall removes exactly that plist, keeping the log directory.
    const off = Bun.spawn([process.execPath, 'scripts/agent.ts', 'uninstall', '--config', configPath, '--no-load'], {
      cwd: path.resolve(import.meta.dir, '..'),
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await off.exited).toBe(0)
    expect(fs.existsSync(layout.plistPath)).toBe(false)
    expect(fs.existsSync(layout.logDir)).toBe(true)
  })

  test('the installer CLI refuses without a dist and writes no plist', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const proc = Bun.spawn(
      [
        process.execPath,
        'scripts/agent.ts',
        'install',
        '--config',
        configPath,
        '--no-load',
        '--dist',
        path.join(home, 'no-dist'),
      ],
      {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode).toBe(1)
    expect(stderr).toContain('bun run build:web')
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'ai.mexplore.mexplore-ui.test_1.plist'))).toBe(false)
  })
})

// ---- #2: the installer cannot write through a symlink or into protected trees

describe('#2: installer output-path safety', () => {
  function distFixture2(): string {
    const dist = path.join(tempDir('mexplore-dist-'), 'dist')
    fs.mkdirSync(dist, { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>', 'utf8')
    return dist
  }

  async function runInstall(home: string, configPath: string, extra: Partial<Parameters<typeof install>[0]> = {}) {
    return install({
      configPath,
      port: 43190,
      home,
      pathEnv: '/usr/bin:/bin',
      bunPath: '/bun',
      load: false,
      distDir: distFixture2(),
      stdout: () => {},
      stderr: () => {},
      ...extra,
    })
  }

  test('a symlinked plist path is refused and its target is untouched', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const layout = layoutFor('test_1', home)
    fs.mkdirSync(path.dirname(layout.plistPath), { recursive: true })
    // The attack: the UI plist path points at the memory-agent plist.
    const victim = path.join(path.dirname(layout.plistPath), 'ai.mexplore.memory-agent.test_1.plist')
    fs.writeFileSync(victim, 'AGENT-PLIST-CONTENT', 'utf8')
    fs.symlinkSync(victim, layout.plistPath)

    const messages: string[] = []
    const result = await runInstall(home, configPath, { stderr: (line) => messages.push(line) })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(messages.join('\n')).toContain('symlink')
    // The link is still a link and the agent plist is byte-identical.
    expect(fs.lstatSync(layout.plistPath).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(victim, 'utf8')).toBe('AGENT-PLIST-CONTENT')
  })

  test('a plist path resolving into graph.root is refused', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot } = fixturePackage()
    const layout = layoutFor('test_1', home)
    // Redirect LaunchAgents into the graph root.
    fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
    fs.symlinkSync(graphRoot, path.join(home, 'Library', 'LaunchAgents'))
    const before = treeSignature(graphRoot)

    const result = await runInstall(home, configPath)
    expect(result.ok).toBe(false)
    expect(treeSignature(graphRoot)).toBe(before)
    expect(fs.existsSync(path.join(graphRoot, `${layout.label}.plist`))).toBe(false)
  })

  test('a plist path resolving into stateDir is refused', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath, stateDir } = fixturePackage()
    fs.mkdirSync(path.join(home, 'Library'), { recursive: true })
    fs.symlinkSync(stateDir, path.join(home, 'Library', 'LaunchAgents'))
    const before = treeSignature(stateDir)

    const result = await runInstall(home, configPath)
    expect(result.ok).toBe(false)
    expect(treeSignature(stateDir)).toBe(before)
  })

  test('a symlinked log directory is refused', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath, graphRoot } = fixturePackage()
    const layout = layoutFor('test_1', home)
    fs.mkdirSync(path.dirname(layout.logDir), { recursive: true })
    fs.symlinkSync(graphRoot, layout.logDir)
    const before = treeSignature(graphRoot)

    const result = await runInstall(home, configPath)
    expect(result.ok).toBe(false)
    expect(treeSignature(graphRoot)).toBe(before)
  })

  test('the plist is written atomically: no temp file survives, content complete', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const result = await runInstall(home, configPath)
    expect(result.ok).toBe(true)
    const layout = layoutFor('test_1', home)
    const dirEntries = fs.readdirSync(path.dirname(layout.plistPath))
    // Exactly the plist: the temp file was renamed away.
    expect(dirEntries).toEqual([`${layout.label}.plist`])
    const content = fs.readFileSync(layout.plistPath, 'utf8')
    expect(content.startsWith('<?xml version="1.0"')).toBe(true)
    expect(content.trim().endsWith('</plist>')).toBe(true)
    expect(fs.lstatSync(layout.plistPath).isSymbolicLink()).toBe(false)
  })

  test('re-installing over an existing real plist replaces it in place', async () => {
    const home = tempDir('mexplore-home-')
    const { configPath } = fixturePackage()
    const layout = layoutFor('test_1', home)
    expect((await runInstall(home, configPath)).ok).toBe(true)
    const first = fs.readFileSync(layout.plistPath, 'utf8')
    // Each run needs its OWN dist fixture: `distFixture2()` uses a temp dir.
    expect((await runInstall(home, configPath, { port: 43191 })).ok).toBe(true)
    const second = fs.readFileSync(layout.plistPath, 'utf8')
    expect(first).not.toBe(second)
    expect(second).toContain('<string>43191</string>')
    expect(fs.readdirSync(path.dirname(layout.plistPath))).toEqual([`${layout.label}.plist`])
  })
})

// ---- #13: strict port parsing in the CLI and the installer ---------------

describe('#13: strict whole-string port parsing', () => {
  test('parsePort accepts only decimal digits within range', () => {
    expect(parsePort('43190')).toEqual({ port: 43190 })
    expect(parsePort('1')).toEqual({ port: 1 })
    expect(parsePort('65535')).toEqual({ port: 65535 })
    expect(parsePort(' 43190 ')).toEqual({ port: 43190 })

    for (const bad of ['43198junk', '43198.5', '0', '-1', '65536', '1e3', 'abc', '', ' ', '0x10', '+80', '80,']) {
      expect('error' in parsePort(bad)).toBe(true)
    }
  })

  test('the CLI rejects a port string with trailing junk', () => {
    const args = parseArgs(['--config', '/a/b.json', '--port', '43198junk'])
    expect(args.errors.length).toBe(1)
    expect(args.errors[0]).toContain('decimal digits')
    // The default is NOT silently kept: a bad port must fail, not bind 43190.
    expect(args.port).toBe(43190)
  })

  test('the CLI rejects a fractional port', () => {
    expect(parseArgs(['--config', '/a/b.json', '--port', '43198.5']).errors.length).toBe(1)
  })

  test('the installer CLI rejects a port string with trailing junk', () => {
    const args = parseCliArgs(['install', '--config', '/a/test_1.json', '--port', '43198junk'])
    expect(args.errors.length).toBe(1)
    expect(args.errors[0]).toContain('decimal digits')
  })

  test('a bad port makes both CLIs exit 2 before touching anything', async () => {
    const { configPath } = fixturePackage()
    const home = tempDir('mexplore-home-')
    for (const argv of [
      ['src/server/cli.ts', '--config', configPath, '--port', '43198junk'],
      ['scripts/agent.ts', 'install', '--config', configPath, '--port', '43198junk', '--no-load'],
    ]) {
      const proc = Bun.spawn([process.execPath, ...argv], {
        cwd: path.resolve(import.meta.dir, '..'),
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(2)
      const stderr = await new Response(proc.stderr).text()
      expect(stderr).toContain('decimal digits')
    }
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false)
  })
})
