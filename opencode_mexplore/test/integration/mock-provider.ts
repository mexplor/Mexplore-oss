/**
 * A tiny OpenAI-compatible mock provider for integration tests.
 *
 * It speaks just enough of `/v1/chat/completions` (streaming SSE) for OpenCode's
 * openai-compatible provider package, and records every request so a test can
 * assert which tools the model was offered.
 *
 * Streaming requirements:
 *  - Every chunk must be a `chat.completion.chunk`.
 *  - The LAST chunk must carry a `finish_reason`, otherwise you get
 *    `provider.invalid-output`.
 *  - Tool calls stream as deltas, then `finish_reason: "tool_calls"`.
 */
export type RecordedRequest = {
  model: string
  toolNames: string[]
  system: string
  messages: unknown[]
  authorization: string | null
  /** The port the request arrived on, so a test can tell two endpoints apart. */
  port: number
}

export type MockHandlerResult =
  | { text: string }
  | { toolCalls: { name: string; args: object }[] }
  | { httpError: number }

export type MockHandler = (
  req: RecordedRequest,
  recorded: RecordedRequest[],
) => MockHandlerResult | Promise<MockHandlerResult>

export type Mock = {
  port: number
  requests: RecordedRequest[]
  stop: () => Promise<void>
}

type ChatMessage = {
  role?: string
  content?: unknown
  tool_calls?: unknown[]
}

/** A host reminder may follow a tool result; the latest assistant call decides. */
export function isToolFollowup(req: Pick<RecordedRequest, "messages">): boolean {
  const messages = req.messages as ChatMessage[]
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
  if (lastAssistant < 0 || !messages[lastAssistant]?.tool_calls?.length) return false
  return messages.slice(lastAssistant + 1).some((message) => message.role === "tool")
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "")
        }
        return ""
      })
      .join("")
  }
  return ""
}

/**
 * One SSE chunk.
 *
 * The LAST chunk of a stream carries a `usage` block, which is what makes the
 * provider report tokens at all: without it the core emits
 * `session.usage.updated` with all zeros, and a caller cannot tell "the provider
 * reported nothing" from "the call was free". The numbers are fixed rather than
 * random so a test can assert them.
 */
function chunkBody(id: string, model: string, delta: unknown, finish: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish === null
      ? {}
      : {
          usage: {
            prompt_tokens: MOCK_USAGE.input + MOCK_USAGE.cacheRead,
            completion_tokens: MOCK_USAGE.output,
            total_tokens: MOCK_USAGE.input + MOCK_USAGE.cacheRead + MOCK_USAGE.output,
            prompt_tokens_details: { cached_tokens: MOCK_USAGE.cacheRead },
            completion_tokens_details: { reasoning_tokens: MOCK_USAGE.reasoning },
          },
        }),
  }
}

/** The token numbers every mock response reports. Fixed, so a test can assert them. */
export const MOCK_USAGE = { input: 120, output: 30, reasoning: 5, cacheRead: 40 } as const

export function startMock(handler: MockHandler): Mock {
  const requests: RecordedRequest[] = []
  let counter = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }

      const body = (await req.json().catch(() => ({}))) as {
        model?: string
        tools?: { function?: { name?: string } }[]
        messages?: ChatMessage[]
      }
      const messages = body.messages ?? []
      const system = messages
        .filter((m) => m?.role === "system")
        .map((m) => textOf(m.content))
        .join("\n")

      const recorded: RecordedRequest = {
        model: body.model ?? "",
        toolNames: (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean),
        system,
        messages,
        authorization: req.headers.get("authorization"),
        port: server.port ?? 0,
      }
      requests.push(recorded)

      const result = await handler(recorded, requests)

      if ("httpError" in result) {
        return new Response(JSON.stringify({ error: { message: "mock error" } }), {
          status: result.httpError,
          headers: { "content-type": "application/json" },
        })
      }

      const id = `chatcmpl-mock-${++counter}`
      const model = recorded.model || "mock-model"
      const encoder = new TextEncoder()

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          }

          if ("toolCalls" in result) {
            send(chunkBody(id, model, { role: "assistant", content: null }, null))
            result.toolCalls.forEach((call, index) => {
              send(
                chunkBody(
                  id,
                  model,
                  {
                    tool_calls: [
                      {
                        index,
                        id: `call_${index + 1}`,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: JSON.stringify(call.args ?? {}),
                        },
                      },
                    ],
                  },
                  null,
                ),
              )
            })
            send(chunkBody(id, model, {}, "tool_calls"))
          } else {
            send(chunkBody(id, model, { role: "assistant", content: result.text }, null))
            send(chunkBody(id, model, {}, "stop"))
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      })
    },
  })

  const port = server.port
  if (port === undefined) throw new Error("mock provider: no port assigned")

  return {
    port,
    requests,
    stop: async () => {
      await server.stop(true)
    },
  }
}
