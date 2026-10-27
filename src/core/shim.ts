import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import type { AddressInfo } from "net"
import { buildUpstreamBody } from "./messages"
import { errorMessage, type Logger } from "./logger"
import { pickPort } from "./ports"
import { SseParser, sseJson, SSE_DONE } from "./sse"
import { ParsedToolCall, ToolBlockScanner } from "./tools"

export interface ShimOptions {
  host: string
  port: number
  autoPort: boolean
  /** Base URL of the muse2api gateway, e.g. http://127.0.0.1:18610 */
  target: string
  /** Bearer key for the gateway; injected when the client sends none. */
  apiKey?: () => string | undefined
  maxToolResultChars?: number
  timeoutSeconds?: number
  logger: Logger
  onRequest?(info: { path: string; status: number; ms: number; toolCalls: number }): void
}

interface ChunkShape {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{ index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }>
  usage?: Record<string, unknown>
  error?: Record<string, unknown>
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
])

/**
 * Local OpenAI-compatible proxy in front of muse2api.
 *
 * muse.ai's chat has no native function calling, so this rewrites Kilo Code's
 * `tools` into a text protocol and turns the model's `<tool_use>` blocks back
 * into OpenAI `tool_calls` — including the streaming variant. Everything else
 * (images, videos, models, admin) is passed through untouched.
 */
export class ShimServer {
  private server: Server | undefined
  private port = 0
  private readonly options: ShimOptions

  constructor(options: ShimOptions) {
    this.options = options
  }

  get baseUrl(): string {
    return this.port ? `http://${this.options.host}:${this.port}` : ""
  }

  get currentPort(): number {
    return this.port
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl
    const port = await pickPort(this.options.host, this.options.port, this.options.autoPort)
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.options.logger.error("shim request failed", error)
        sendError(res, 502, "shim_error", errorMessage(error))
      })
    })
    server.on("error", (error: NodeJS.ErrnoException) => {
      this.options.logger.error("shim server error", error)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, this.options.host, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    this.server = server
    const address = server.address() as AddressInfo | null
    this.port = address?.port ?? port
    this.options.logger.info(`Tool-call shim listening on ${this.baseUrl} -> ${this.options.target}`)
    return this.baseUrl
  }

  /** Point the shim at a (possibly new) gateway URL. */
  setTarget(target: string) {
    this.options.target = target
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
      setTimeout(() => resolve(), 1500)
    })
  }

  private upstreamUrl(pathname: string, search: string): string {
    return `${this.options.target.replace(/\/$/, "")}${pathname}${search ?? ""}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now()
    const pathname = (req.url ?? "/").split("?")[0] ?? "/"
    const search = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : ""

    if (pathname === "/healthz" || pathname === "/shim/healthz") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, shim: true, target: this.options.target }))
      return
    }

    const body = await readBody(req)
    const isChat = req.method === "POST" && pathname === "/v1/chat/completions"
    let upstreamBody = body
    let parsedBody: Record<string, unknown> | undefined

    if (isChat && body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>
      } catch {
        parsedBody = undefined
      }
    }

    const toolsPresent =
      parsedBody !== undefined && Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0 &&
      parsedBody.tool_choice !== "none"

    if (parsedBody && toolsPresent) {
      upstreamBody = Buffer.from(
        JSON.stringify(
          buildUpstreamBody(parsedBody, { maxToolResultChars: this.options.maxToolResultChars }),
        ),
        "utf8",
      )
    }

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue
      if (typeof value === "string") headers[key] = value
      else if (Array.isArray(value)) headers[key] = value.join(", ")
    }
    headers["content-length"] = String(upstreamBody.length)
    if (!headers.authorization && !headers.Authorization) {
      const key = this.options.apiKey?.()
      if (key) headers.authorization = `Bearer ${key}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(30, this.options.timeoutSeconds ?? 600) * 1000,
    )
    req.on("close", () => controller.abort())

    let upstream: Response
    try {
      upstream = await fetch(this.upstreamUrl(pathname, search), {
        method: req.method ?? "GET",
        headers,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : upstreamBody,
        signal: controller.signal,
        duplex: "half",
      })
    } catch (error) {
      clearTimeout(timeout)
      const message = errorMessage(error)
      this.options.logger.error(`Upstream ${pathname} failed: ${message}`)
      this.report(pathname, 502, started, 0)
      sendError(
        res,
        502,
        "gateway_unreachable",
        `muse2api gateway not reachable at ${this.options.target}: ${message}. Start it with "muse.ai: Gateway starten".`,
      )
      return
    }

    const responseHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value
    })

    const wantsStream = String(upstream.headers.get("content-type") ?? "").includes("text/event-stream")
    if (!parsedBody || !toolsPresent || !wantsStream) {
      // Plain passthrough (also for non-streaming chat when no tools were requested).
      if (!parsedBody || !toolsPresent) {
        clearTimeout(timeout)
        await pipeThrough(upstream, res, responseHeaders)
        this.report(pathname, upstream.status, started, 0)
        return
      }
      // Tools were requested but the client asked for a non-streaming reply.
      const text = await upstream.text()
      clearTimeout(timeout)
      const transformed = transformCompletion(text, upstream.status)
      responseHeaders["content-type"] = "application/json"
      res.writeHead(upstream.status, responseHeaders)
      res.end(transformed.body)
      this.report(pathname, upstream.status, started, transformed.toolCalls)
      return
    }

    clearTimeout(timeout)
    await streamChat(upstream, res, responseHeaders, this.options.logger, (calls) => {
      this.report(pathname, upstream.status, started, calls)
    })
  }

  private report(pathname: string, status: number, started: number, toolCalls: number) {
    this.options.onRequest?.({ path: pathname, status, ms: Date.now() - started, toolCalls })
  }
}

async function pipeThrough(upstream: Response, res: ServerResponse, headers: Record<string, string>) {
  res.writeHead(upstream.status, headers)
  if (!upstream.body) {
    res.end()
    return
  }
  const { Readable } = await import("stream")
  const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream)
  nodeStream.on("error", (error) => {
    res.destroy(error instanceof Error ? error : new Error(errorMessage(error)))
  })
  nodeStream.pipe(res)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks)
}

function sendError(res: ServerResponse, status: number, type: string, message: string) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message, type, code: status } }))
}

/** Non-streaming: turn tool blocks in the reply into OpenAI tool_calls. */
export function transformCompletion(rawBody: string, status: number): { body: string; toolCalls: number } {
  if (status >= 400) return { body: rawBody, toolCalls: 0 }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return { body: rawBody, toolCalls: 0 }
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return { body: rawBody, toolCalls: 0 }
  const choice = choices[0] as Record<string, unknown>
  const message = (choice.message ?? {}) as Record<string, unknown>
  const content = typeof message.content === "string" ? message.content : ""
  if (!content) return { body: rawBody, toolCalls: 0 }

  const scanner = new ToolBlockScanner(callIdPrefix(payload.id))
  const events = [...scanner.push(content), ...scanner.end()]
  const calls = events.filter((event) => event.type === "call").map((event) => (event as { call: ParsedToolCall }).call)
  if (calls.length === 0) return { body: rawBody, toolCalls: 0 }

  const text = events
    .filter((event) => event.type === "text")
    .map((event) => (event as { text: string }).text)
    .join("")
    .trim()

  const nextMessage: Record<string, unknown> = { role: "assistant", content: text || null }
  if (message.reasoning_content) nextMessage.reasoning_content = message.reasoning_content
  nextMessage.tool_calls = calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }))
  choice.message = nextMessage
  choice.finish_reason = "tool_calls"
  return { body: JSON.stringify(payload), toolCalls: calls.length }
}

function callIdPrefix(id: unknown): string {
  const base = typeof id === "string" && id ? id.replace(/[^a-zA-Z0-9]/g, "") : "chatcmpl"
  return `call_${base.slice(-12)}`
}

/** Streaming: rewrite SSE chunks, converting tool blocks into tool_call deltas. */
async function streamChat(
  upstream: Response,
  res: ServerResponse,
  headers: Record<string, string>,
  logger: Logger,
  done: (calls: number) => void,
) {
  headers["content-type"] = "text/event-stream; charset=utf-8"
  headers["cache-control"] = "no-cache"
  headers["x-accel-buffering"] = "no"
  res.writeHead(upstream.status, headers)

  if (!upstream.body) {
    res.end()
    done(0)
    return
  }

  const parser = new SseParser()
  const scanner = new ToolBlockScanner("call_shim")
  let callCount = 0
  let started = false
  let meta: { id?: string; created?: number; model?: string } = {}
  let usageChunk: ChunkShape | undefined
  let finished = false

  const envelope = (delta: Record<string, unknown>, finish: string | null): string =>
    sseJson({
      id: meta.id ?? "chatcmpl-shim",
      object: "chat.completion.chunk",
      created: meta.created ?? Math.floor(Date.now() / 1000),
      model: meta.model ?? "muse-chat",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })

  const emitText = (text: string) => {
    if (!text) return
    started = true
    res.write(envelope({ content: text }, null))
  }

  const emitCall = (call: ParsedToolCall, index: number) => {
    const args = JSON.stringify(call.arguments)
    res.write(
      envelope(
        {
          tool_calls: [
            { index, id: call.id, type: "function", function: { name: call.name, arguments: "" } },
          ],
        },
        null,
      ),
    )
    // Argument deltas stay small enough for every client to buffer.
    const step = 512
    for (let offset = 0; offset < args.length; offset += step) {
      res.write(
        envelope({ tool_calls: [{ index, function: { arguments: args.slice(offset, offset + step) } }] }, null),
      )
    }
    callCount++
  }

  const handleEvents = (chunkPayloads: string[]) => {
    for (const payload of chunkPayloads) {
      const trimmed = payload.trim()
      if (!trimmed || trimmed === "[DONE]") continue
      let parsed: ChunkShape
      try {
        parsed = JSON.parse(trimmed) as ChunkShape
      } catch {
        continue
      }
      if (parsed.error) {
        res.write(sseJson(parsed))
        continue
      }
      if (parsed.id) meta = { id: parsed.id, created: parsed.created, model: parsed.model }
      if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
        usageChunk = parsed
        continue
      }
      const choice = parsed.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      const content = typeof delta.content === "string" ? delta.content : ""
      if (content) {
        if (!started && !scanner.sawToolCall) {
          started = true
          res.write(envelope({ role: "assistant", content: "" }, null))
        }
        for (const event of scanner.push(content)) {
          if (event.type === "text") emitText(event.text)
          else emitCall(event.call, callCount)
        }
      }
      if (choice.finish_reason) finished = true
    }
  }

  const decoder = new TextDecoder()
  try {
    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
      const events = parser.push(decoder.decode(chunk, { stream: true }))
      handleEvents(events.map((event) => event.data))
      if (res.writableEnded) break
    }
    const tail = parser.end()
    handleEvents(tail.map((event) => event.data))

    for (const event of scanner.end()) {
      if (event.type === "text") emitText(event.text)
      else emitCall(event.call, callCount)
    }

    if (!started && callCount === 0) res.write(envelope({ role: "assistant", content: "" }, null))
    res.write(envelope({}, callCount > 0 ? "tool_calls" : finished ? "stop" : "stop"))
    if (usageChunk) {
      res.write(
        sseJson({
          id: meta.id ?? "chatcmpl-shim",
          object: "chat.completion.chunk",
          created: meta.created ?? Math.floor(Date.now() / 1000),
          model: meta.model ?? "muse-chat",
          choices: [],
          usage: usageChunk.usage,
        }),
      )
    }
    res.write(SSE_DONE)
  } catch (error) {
    logger.error("shim stream failed", error)
    if (!res.writableEnded) {
      res.write(sseJson({ error: { message: errorMessage(error), type: "shim_error" } }))
      res.write(SSE_DONE)
    }
  } finally {
    if (!res.writableEnded) res.end()
    done(callCount)
  }
}
