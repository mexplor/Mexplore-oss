/**
 * The TUI part against a REAL server: does `./tui` resolve and load, and does the
 * RPC it calls answer over HTTP?
 *
 * This is the headless half of the TUI story. It proves the two things a fake
 * context cannot: that the host can resolve this package's `./tui` export, and
 * that `POST /api/rpc/mexplore/command` — the route `client.rpc(...)` uses
 * (`protocol/src/groups/rpc.ts:14`) — answers with the shared contract's shape.
 * What it CANNOT prove is how the TUI renders the reply; that needs a live
 * terminal (reported as pending).
 *
 * It deliberately does NOT run a model turn: the reply path under test is the
 * command/RPC one, which needs no provider. Skipped unless `MEXPLORE_IT=1`.
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { startMock, type Mock } from "./mock-provider"
import { startOpencode, type Opencode } from "./harness"

const enabled = process.env.MEXPLORE_IT === "1"
const pluginDir = path.resolve(import.meta.dir, "..", "..")

/** Poll the command list until the plugin's registration lands (or time out). */
async function pollCommands(read: () => Promise<string[]>, deadlineMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const names = await read().catch(() => [] as string[])
    if (names.includes("mexplore-settings") || Date.now() > deadline) return names
    await Bun.sleep(200)
  }
}

/** A load failure the host would log for a part it could not import. */
const LOAD_FAILURES = [/failed to (?:load|import) plugin/i, /\bcannot find module\b/i, /ERR_MODULE_NOT_FOUND/]

describe.skipIf(!enabled)("TUI part: resolves, and its RPC answers", () => {
  let mock: Mock | undefined
  let oc: Opencode | undefined

  afterAll(async () => {
    await oc?.stop()
    await mock?.stop()
  })

  test(
    "the ./tui export resolves the way the host resolves entrypoints",
    async () => {
      mock = startMock(() => ({ text: "ok" }))
      oc = await startOpencode({ pluginDir, mockPort: mock.port })

      // The server part came up: no load error was logged, and the plugin's own
      // command is registered (a failed server part loses both).
      const logs = oc.logs.join("\n")
      for (const pattern of LOAD_FAILURES) expect(logs).not.toMatch(pattern)
      // The server command is registered by the plugin's async activation, so a
      // list taken the instant the port opens can still be empty: poll briefly.
      // (`/api/command` is also location-scoped; the realpath is what matches.)
      const directory = encodeURIComponent(fs.realpathSync(path.join(oc.root, "work")))
      const names = await pollCommands(async () =>
        (await oc!.apiData<Array<{ name: string }>>("GET", `/api/command?directory=${directory}`)).map(
          (command) => command.name,
        ),
      )
      // The SERVER command, which desktop and web use. The TUI's own slash
      // command is a keymap layer and never appears in this list.
      expect(names).toContain("mexplore-settings")

      // The TUI process resolves `./tui` through the package's exports map, which
      // is exactly what the host's `resolve({tui})` does. Loading it here proves
      // the module graph (and its `@opencode/plugin/tui` import) is sound.
      const resolved = await import("mexplore/tui").catch((error: unknown) => error as Error)
      expect(resolved).not.toBeInstanceOf(Error)
      const definition = (resolved as { default: { id: string; setup: unknown } }).default
      expect(definition.id).toBe("mexplore.tui")
      expect(typeof definition.setup).toBe("function")
    },
    90_000,
  )

  test(
    "POST /api/rpc/mexplore/command answers the status text",
    async () => {
      if (oc === undefined) throw new Error("the first test must run first")
      const result = await oc.api("POST", "/api/rpc/mexplore/command", { input: { args: "status" } })
      expect(result.status).toBeLessThan(400)
      const output = (result.body as { output?: { text?: string } }).output
      expect(output?.text).toContain("mexplore memory")
      expect(output?.text).toContain("key:")
      // The RPC is the TUI's transport, so its help names the TUI's command.
      expect(output?.text).toContain("/mexplore model")
      expect(output?.text).not.toContain("/mexplore-settings")
    },
    90_000,
  )

  test(
    "the RPC changes a setting, and /mexplore key still only explains /connect",
    async () => {
      if (oc === undefined) throw new Error("the first test must run first")
      const set = await oc.api("POST", "/api/rpc/mexplore/command", {
        input: { args: "base-url https://proxy.example.com/v1" },
      })
      expect(set.status).toBeLessThan(400)
      expect(JSON.stringify(set.body)).toContain("proxy.example.com")

      // Reflected by status: the RPC reached the same storage the server uses.
      const status = await oc.api("POST", "/api/rpc/mexplore/command", { input: { args: "status" } })
      expect(JSON.stringify(status.body)).toContain("proxy.example.com")

      const key = await oc.api("POST", "/api/rpc/mexplore/command", { input: { args: "key" } })
      const text = (key.body as { output?: { text?: string } }).output?.text ?? ""
      expect(text).toContain("/connect")
      expect(text).not.toContain("sk-")
    },
    90_000,
  )
})
