/**
 * End-to-end smoke test: the mock model calls a plugin tool, the tool runs
 * inside OpenCode, and its result comes back in the session history.
 *
 * Skipped unless `MEXPLORE_IT=1`, because it needs a real `opencode` binary.
 */
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { isToolFollowup, startMock, type Mock, type RecordedRequest } from "./mock-provider"
import { startOpencode, type Opencode } from "./harness"

const enabled = process.env.MEXPLORE_IT === "1"
const pluginDir = path.join(import.meta.dir, "fixtures", "probe-plugin")

/**
 * Stateless, because OpenCode sends more than one request per turn: the first is
 * usually the session-title helper, which gets no tools at all. Deciding by
 * request count would answer the real turn with a plain text reply.
 */
function handler(req: RecordedRequest) {
  if (isToolFollowup(req)) return { text: "done" }
  if (!req.toolNames.includes("probe_echo")) return { text: "done" }
  return { toolCalls: [{ name: "probe_echo", args: { text: "hi" } }] }
}

describe.skipIf(!enabled)("integration harness", () => {
  let mock: Mock | undefined
  let oc: Opencode | undefined

  afterAll(async () => {
    await oc?.stop()
    await mock?.stop()
  })

  test("a plugin tool is offered to the model and its result reaches history", async () => {
    mock = startMock(handler)

    oc = await startOpencode({
      pluginDir,
      pluginOptions: {},
      mockPort: mock.port,
    })

    const session = await oc.apiData<{ id: string }>("POST", "/api/session", {
      model: { providerID: "mock", id: "mock-model" },
    })
    expect(session?.id).toBeTruthy()

    await oc.api("POST", `/api/session/${session.id}/prompt`, { text: "go" })
    await oc.api("POST", `/api/experimental/session/${session.id}/wait`)

    const messages = await oc.apiData<unknown[]>("GET", `/api/session/${session.id}/message`)
    const serialized = JSON.stringify(messages)

    // The model was offered the plugin tool.
    const offered = mock.requests.some((r) => r.toolNames.includes("probe_echo"))
    expect(offered).toBe(true)

    // …and the tool actually ran, with its output in history.
    expect(serialized).toContain("echo:hi")
  }, 60_000)
})
