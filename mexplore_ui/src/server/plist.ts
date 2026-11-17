// Pure launchd plist renderer (REQ-012, AC-021).
//
// Mirrors the working `ai.mexplore.memory-agent.test_1` plist: RunAtLoad, restart
// only when killed by a signal, ThrottleInterval 30, and the same HOME / PATH /
// NO_PROXY environment. Nothing here touches the filesystem, so the renderer is
// unit-tested against a golden file.

export interface PlistInput {
  /** Config file basename without extension, e.g. `test_1`. */
  configName: string
  /** Absolute path of the bun binary (`process.execPath`). */
  bunPath: string
  /** Absolute path of `src/server/cli.ts`. */
  cliPath: string
  /** Absolute path of the memory-agent config JSON. */
  configPath: string
  port: number
  /** Absolute path of the mexplore_ui package directory. */
  workingDirectory: string
  /** Absolute log path, e.g. `<home>/.local/state/mexplore-ui/test_1/ui.log`. */
  logPath: string
  home: string
  /** Value for PATH (the installing shell's PATH). */
  pathEnv: string
}

export const LABEL_PREFIX = 'ai.mexplore.mexplore-ui'
export const DEFAULT_PORT = 43190

export function labelFor(configName: string): string {
  return `${LABEL_PREFIX}.${configName}`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Render the plist XML for one config. Deterministic: same input, same bytes. */
export function renderPlist(input: PlistInput): string {
  const args = [
    input.bunPath,
    input.cliPath,
    '--config',
    input.configPath,
    '--port',
    String(input.port),
  ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(labelFor(input.configName))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(input.workingDirectory)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>HOME</key>',
    `    <string>${xmlEscape(input.home)}</string>`,
    '    <key>PATH</key>',
    `    <string>${xmlEscape(input.pathEnv)}</string>`,
    '    <key>NO_PROXY</key>',
    '    <string>127.0.0.1,localhost</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>Crashed</key>',
    '    <true/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(input.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(input.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}
