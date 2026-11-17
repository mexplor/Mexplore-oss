/**
 * A headless OpenCode harness for integration tests.
 *
 * Every caller gets an isolated temp root: its own XDG dirs, its own
 * `opencode.json`, its own workspace, its own server process. Nothing here reads
 * or writes `~/.config/opencode`, and it never touches a running
 * `opencode service` (we always use `serve --port <free port>`).
 */
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type OpencodeOptions = {
  pluginDir: string
  pluginOptions?: Record<string, unknown>
  mockPort: number
}

export type ApiResult = {
  status: number
  /** Parsed JSON body; `{ data: … }` wrappers are unwrapped by `apiData`. */
  body: any
  text: string
}

export type Opencode = {
  url: string
  auth: string
  api: (method: string, apiPath: string, body?: unknown) => Promise<ApiResult>
  /** Convenience: call the endpoint and return `body.data ?? body`. */
  apiData: <T = any>(method: string, apiPath: string, body?: unknown) => Promise<T>
  /** Create a session on a model and return its id. */
  newSession: (model?: { providerID: string; id: string }) => Promise<string>
  /** Prompt a session and wait for its turn to finish. */
  run: (sessionID: string, text: string) => Promise<void>
  /** Every session message, oldest-first (the host returns newest-first). */
  messages: (sessionID: string) => Promise<any[]>
  /** Every session the server knows about (all pages). */
  sessions: () => Promise<any[]>
  /** Sessions this plugin created and has not removed yet (AC-002/AC-006). */
  childSessions: () => Promise<any[]>
  stop: () => Promise<void>
  logs: string[]
  root: string
}

function defaultBin(): string {
  return process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")
}

/** Strip proxy vars that would hijack the loopback API call. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    env[key] = value
  }
  for (const key of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete env[key]
  }
  // Inherited agent-harness state would make the child server believe it is a
  // subagent of THIS session ("OpenCode session is not bound to a Paseo agent"),
  // and `OPENCODE_CONFIG_CONTENT` would override the config this harness writes.
  for (const key of [
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_SESSION_ID",
    "OPENCODE_TERMINAL",
    "PASEO_HOME",
    "CMUX_HERMES_AGENT_WRAPPER_SHIM",
    "CMUX_AGENT_COMMAND_SHIM_ROOT",
    "CMUX_HERMES_AGENT_WRAPPER_SHIM_ROOT",
    "CMUX_SUPPRESS_SUBAGENT_NOTIFICATIONS",
    "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS",
  ]) {
    delete env[key]
  }
  return { ...env, ...extra, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error("harness: could not reserve a port")
  return port
}

function buildConfig(options: OpencodeOptions, pluginDir: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: "mock/mock-model",
    plugins: [
      {
        package: pluginDir,
        ...(options.pluginOptions ? { options: options.pluginOptions } : {}),
      },
    ],
    providers: {
      mock: {
        name: "Mock",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${options.mockPort}/v1`,
          apiKey: "test",
        },
        models: {
          "mock-model": {
            name: "Mock Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 200000, output: 8192 },
          },
          "memory-model": {
            name: "Independent Memory Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 200000, output: 8192 },
          },
        },
      },
    },
  }
}

export async function startOpencode(options: OpencodeOptions): Promise<Opencode> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mexplore-it-"))
  const cfg = path.join(root, "cfg")
  const work = path.join(root, "work")
  await fsp.mkdir(cfg, { recursive: true })
  await fsp.mkdir(work, { recursive: true })

  const pluginDir = path.resolve(options.pluginDir)
  await fsp.writeFile(
    path.join(cfg, "opencode.json"),
    `${JSON.stringify(buildConfig(options, pluginDir), null, 2)}\n`,
  )

  const port = await freePort()
  // Supply the password through the environment. `opencode serve` only PRINTS
  // "server password …" when it had to generate one (cli/src/server-process.ts:209
  // skips the line when the env provides it), and a fixed one makes the harness
  // independent of that log line's wording.
  const password = `mexplore-it-${Math.random().toString(36).slice(2, 12)}`
  const env = cleanEnv({
    OPENCODE_PASSWORD: password,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    OPENCODE_CONFIG_DIR: cfg,
    HOME: root,
  })

  const logs: string[] = []
  const proc = Bun.spawn([defaultBin(), "serve", "--port", String(port)], {
    cwd: work,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    try {
      proc.kill()
    } catch {
      // already gone
    }
    await proc.exited.catch(() => {})
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  // Drain both streams, remembering every line (and the password, if this build
  // announces one instead of honouring the env).
  let announced: string | undefined
  const scan = (line: string) => {
    logs.push(line)
    const match = /server password (\S+)/.exec(line)
    if (match?.[1] && !announced) announced = match[1]
  }
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true })
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        scan(buffer.slice(0, index).replace(/\r$/, ""))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
      }
    }
    if (buffer) scan(buffer)
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)

  // Wait for the server to be up: either it announced a password, or it logged
  // its listening URL (the normal case when the env supplied the password).
  const deadline = Date.now() + 30_000
  while (!announced && !logs.some((line) => line.includes("server listening"))) {
    if (Date.now() > deadline) {
      const tail = logs.slice(-40).join("\n")
      await stop()
      throw new Error(`harness: the server did not come up within 30s. Logs:\n${tail}`)
    }
    if (proc.exitCode !== null) {
      const tail = logs.slice(-40).join("\n")
      await stop()
      throw new Error(`harness: opencode exited early (${proc.exitCode}). Logs:\n${tail}`)
    }
    await Bun.sleep(50)
  }
  const serverPassword = announced ?? password
  // Give the HTTP listener a moment after the log line, and fail loudly if a
  // request still answers 401 (a wrong password would otherwise read as a 4xx
  // somewhere far away).
  for (let attempt = 0; ; attempt += 1) {
    const probe = await fetch(`http://127.0.0.1:${port}/api/session`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
    }).catch(() => undefined)
    if (probe?.status !== 401) break
    if (attempt > 100) {
      await stop()
      throw new Error("harness: the server rejected the harness password")
    }
    await Bun.sleep(50)
  }

  const url = `http://127.0.0.1:${port}`
  const auth = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`

  const api = async (method: string, apiPath: string, body?: unknown): Promise<ApiResult> => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: auth,
        "content-type": "application/json",
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${url}${apiPath}`, init)
    const text = await res.text()
    let parsed: any = undefined
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    return { status: res.status, body: parsed, text }
  }

  const apiData = async <T = any>(method: string, apiPath: string, body?: unknown): Promise<T> => {
    const result = await api(method, apiPath, body)
    if (result.status >= 400) {
      throw new Error(`${method} ${apiPath} -> ${result.status}: ${result.text}`)
    }
    if (result.body && typeof result.body === "object" && "data" in result.body) {
      return result.body.data as T
    }
    return result.body as T
  }

  const newSession = async (model = { providerID: "mock", id: "mock-model" }): Promise<string> => {
    const session = await apiData<{ id: string }>("POST", "/api/session", { model })
    if (session?.id === undefined) throw new Error("harness: session create returned no id")
    return session.id
  }

  const run = async (sessionID: string, text: string): Promise<void> => {
    await apiData("POST", `/api/session/${sessionID}/prompt`, { text })
    await apiData("POST", `/api/experimental/session/${sessionID}/wait`)
  }

  const messages = async (sessionID: string): Promise<any[]> => {
    const list = await apiData<any[]>("GET", `/api/session/${sessionID}/message`)
    // Newest-first from the host; every assertion here reads in reading order.
    return Array.isArray(list) ? [...list].reverse() : []
  }

  const sessions = async (): Promise<any[]> => {
    const all: any[] = []
    let cursor: string | undefined
    for (;;) {
      const query = cursor === undefined ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`
      const page = await api("GET", `/api/session${query}`)
      if (page.status >= 400) throw new Error(`GET /api/session -> ${page.status}: ${page.text}`)
      const batch = page.body?.data ?? []
      all.push(...batch)
      const next = page.body?.cursor?.next
      if (next === undefined || next === null || batch.length === 0) break
      cursor = next
    }
    return all
  }

  const childSessions = async (): Promise<any[]> =>
    (await sessions()).filter((session) => session?.metadata?.mexploreChild === true)

  return { url, auth, api, apiData, newSession, run, messages, sessions, childSessions, stop, logs, root }
}
