import assert from "node:assert/strict"
import * as http from "node:http"
import { describe, it } from "node:test"
import { buildUpstreamBody, transformMessages } from "../src/core/messages"
import { SseParser } from "../src/core/sse"
import { ShimServer, transformCompletion } from "../src/core/shim"
import { nullLogger } from "../src/core/logger"
import type { ServerResponse } from "http"

interface RequestLog {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

/** A stand-in muse2api that replies exactly as the Python gateway does. */
async function fakeGateway(handler: (req: RequestLog, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void>; requests: RequestLog[] }> {
  const requests: RequestLog[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const log: RequestLog = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      requests.push(log)
      handler(log, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function delta(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "muse-chat",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  }
}

function sseFromDeltas(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text(), headers: Object.fromEntries(response.headers) }
}

const CHAT_BODY = {
  model: "muse-chat",
  messages: [{ role: "user", content: "Read /tmp/a.txt" }],
  stream: true,
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ],
}

describe("messages transformation", () => {
  it("moves tools into a system prompt and keeps the history", () => {
    const next = buildUpstreamBody(CHAT_BODY)
    assert.equal(next.tools, undefined)
    assert.equal(next.tool_choice, undefined)
    const messages = next.messages as Array<{ role: string; content: string }>
    assert.equal(messages[0]!.role, "user")
    assert.equal(messages[0]!.content, "Read /tmp/a.txt")
    assert.equal(messages[1]!.role, "system")
    assert.match(messages[1]!.content, /read_file/)
    assert.match(messages[1]!.content, /<tool_use>/)
  })

  it("serialises assistant tool_calls and wraps tool results", () => {
    const messages = transformMessages(
      [
        { role: "assistant", content: "ok", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"/x"}' } }] },
        { role: "tool", name: "read_file", tool_call_id: "c1", content: "file contents" },
      ],
      CHAT_BODY.tools,
      { maxToolResultChars: 10 },
    )
    assert.match(String(messages[0]!.content), /<tool_use>/)
    assert.match(String(messages[0]!.content), /read_file/)
    assert.match(String(messages[1]!.content), /<tool_result/)
    assert.match(String(messages[1]!.content), /truncated/)
  })

  it("skips the tool prompt for tool_choice none", () => {
    const next = buildUpstreamBody({ ...CHAT_BODY, tool_choice: "none" })
    const messages = next.messages as Array<{ role: string }>
    assert.equal(messages.length, 1)
  })
})

describe("SSE parser", () => {
  it("parses multi-line data, comments and ids", () => {
    const parser = new SseParser()
    const first = parser.push("event: message\r\nid: 7\r\ndata: {\"a\":\r\n")
    assert.equal(first.length, 0)
    const second = parser.push('data: 1}\r\n\r\n: keepalive\n\n')
    assert.equal(second.length, 2)
    // SSE joins consecutive data: lines with a newline; field names are stripped.
    assert.equal(second[0]!.data, '{"a":\n1}')
    assert.equal(second[0]!.id, "7")
    assert.equal(second[1]!.comment, true)
  })

  it("does not emit an empty event from muse2api keepalive comments", () => {
    const parser = new SseParser()
    const events = parser.push(": keepalive\n\ndata: {\"x\":1}\n\n")
    assert.equal(events.length, 2)
    assert.equal(events[0]!.comment, true)
    assert.equal(events[1]!.data, '{"x":1}')
  })
})

describe("transformCompletion", () => {
  it("turns a tagged tool block into OpenAI tool_calls", () => {
    const raw = JSON.stringify({
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "muse-chat",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: 'Sure.\n<tool_use>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</tool_use>',
          },
        },
      ],
    })
    const result = transformCompletion(raw, 200)
    const parsed = JSON.parse(result.body) as {
      choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> } }>
    }
    assert.equal(result.toolCalls, 1)
    assert.equal(parsed.choices[0]!.finish_reason, "tool_calls")
    assert.equal(parsed.choices[0]!.message.content, "Sure.")
    assert.equal(parsed.choices[0]!.message.tool_calls[0]!.function.name, "read_file")
    assert.deepEqual(JSON.parse(parsed.choices[0]!.message.tool_calls[0]!.function.arguments), { path: "/tmp/a.txt" })
  })

  it("passes errors and plain replies through", () => {
    const raw = '{"error":{"message":"no account"}}'
    assert.equal(transformCompletion(raw, 503).body, raw)
    const plain = JSON.stringify({ choices: [{ message: { content: "hello" } }] })
    assert.equal(transformCompletion(plain, 200).body, plain)
  })
})

describe("ShimServer end to end", () => {
  it("rewrites a streamed tool call into OpenAI tool_call deltas", async () => {
    const upstream = await fakeGateway((req, res) => {
      assert.equal(req.url, "/v1/chat/completions")
      const body = JSON.parse(req.body) as { tools?: unknown; messages: Array<{ role: string; content: string }> }
      assert.equal(body.tools, undefined)
      assert.match(body.messages.at(-1)!.content, /<tool_use>/)
      assert.equal(req.headers.authorization, "Bearer injected-key")
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(
        sseFromDeltas([
          delta("I will read it. <tool_us"),
          delta('e>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}'),
          delta("</tool_use>"),
          { ...delta(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]),
      )
    })

    const shim = new ShimServer({
      host: "127.0.0.1",
      port: 0,
      autoPort: true,
      target: `http://127.0.0.1:${upstream.port}`,
      apiKey: () => "injected-key",
      logger: nullLogger,
    })
    const base = await shim.start()
    try {
      const response = await post(new URL(base).port as unknown as number, "/v1/chat/completions", CHAT_BODY)
      assert.equal(response.status, 200)
      assert.match(response.text, /"tool_calls"/)
      assert.match(response.text, /"finish_reason":"tool_calls"/)
      assert.match(response.text, /read_file/)
      assert.ok(response.text.includes("I will read it."))
      assert.ok(!response.text.includes("<tool_use>"))
      const parser = new SseParser()
      const events = parser.push(response.text)
      const payloads = events.map((event) => event.data).filter((data) => data && data !== "[DONE]").map((data) => JSON.parse(data))
      const first = payloads[0] as { choices: Array<{ delta: { role?: string } }> }
      assert.equal(first.choices[0]!.delta.role, "assistant")
      const callChunks = payloads.filter(
        (chunk: { choices?: Array<{ delta?: { tool_calls?: unknown } }> }) => chunk.choices?.[0]?.delta?.tool_calls,
      )
      assert.ok(callChunks.length >= 2, "at least one call chunk and one argument chunk")
    } finally {
      await shim.stop()
      await upstream.close()
    }
  })

  it("keeps plain streams unchanged", async () => {
    const upstream = await fakeGateway((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(sseFromDeltas([delta("Hello "), delta("world"), { ...delta(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]))
    })
    const shim = new ShimServer({
      host: "127.0.0.1",
      port: 0,
      autoPort: true,
      target: `http://127.0.0.1:${upstream.port}`,
      logger: nullLogger,
    })
    const base = await shim.start()
    try {
      const response = await post(new URL(base).port as unknown as number, "/v1/chat/completions", CHAT_BODY)
      assert.match(response.text, /Hello/)
      assert.match(response.text, /world/)
      assert.ok(!response.text.includes("tool_calls"))
      assert.match(response.text, /"finish_reason":"stop"/)
    } finally {
      await shim.stop()
      await upstream.close()
    }
  })

  it("passes non-chat endpoints through untouched", async () => {
    const upstream = await fakeGateway((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "muse-chat" }] }))
        return
      }
      res.writeHead(404)
      res.end("nope")
    })
    const shim = new ShimServer({
      host: "127.0.0.1",
      port: 0,
      autoPort: true,
      target: `http://127.0.0.1:${upstream.port}`,
      logger: nullLogger,
    })
    const base = await shim.start()
    try {
      const port = new URL(base).port
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`)
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()) as { data: Array<{ id: string }> }, { object: "list", data: [{ id: "muse-chat" }] })
    } finally {
      await shim.stop()
      await upstream.close()
    }
  })

  it("rewrites a non-streaming tool call", async () => {
    const upstream = await fakeGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "muse-chat",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: '<tool_use>{"name":"read_file","arguments":{"path":"/x"}}</tool_use>' },
            },
          ],
        }),
      )
    })
    const shim = new ShimServer({
      host: "127.0.0.1",
      port: 0,
      autoPort: true,
      target: `http://127.0.0.1:${upstream.port}`,
      logger: nullLogger,
    })
    const base = await shim.start()
    try {
      const response = await post(new URL(base).port as unknown as number, "/v1/chat/completions", { ...CHAT_BODY, stream: false })
      const parsed = JSON.parse(response.text) as { choices: Array<{ finish_reason: string; message: { tool_calls: unknown[] } }> }
      assert.equal(parsed.choices[0]!.finish_reason, "tool_calls")
      assert.equal(parsed.choices[0]!.message.tool_calls.length, 1)
    } finally {
      await shim.stop()
      await upstream.close()
    }
  })

  it("reports a clear error when the gateway is down", async () => {
    const shim = new ShimServer({
      host: "127.0.0.1",
      port: 0,
      autoPort: true,
      target: "http://127.0.0.1:1",
      logger: nullLogger,
    })
    const base = await shim.start()
    try {
      const response = await post(new URL(base).port as unknown as number, "/v1/chat/completions", { model: "x", messages: [{ role: "user", content: "hi" }] })
      assert.equal(response.status, 502)
      assert.match(response.text, /gateway_unreachable/)
    } finally {
      await shim.stop()
    }
  })
})
