/** OpenAI tool/function declarations as sent by Kilo Code. */
export interface OpenAITool {
  type?: string
  name?: string
  description?: string
  parameters?: unknown
  function?: {
    name?: string
    description?: string
    parameters?: unknown
  }
}

export interface ToolSpec {
  name: string
  description: string
  parameters: unknown
}

/** A tool call the model produced, normalised to the OpenAI shape. */
export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

const TAG_PATTERN = "tool[_\\s]?use|tool[_\\s]?call|function[_\\s]?calls?"
const START_RE = new RegExp(`<\\s*(?:${TAG_PATTERN})\\s*>`, "i")
const GLOBAL_BLOCK_RE = new RegExp(
  `<\\s*(${TAG_PATTERN})\\s*>([\\s\\S]*?)<\\s*\\/\\s*(?:${TAG_PATTERN})\\s*>`,
  "gi",
)

/** Tag literals used for the streaming hold-back check. */
const TAG_LITERALS = ["<tool_use>", "<tooluse>", "<tool_call>", "<toolcall>", "<function_call>", "<function_calls>"]
const NORMALIZED_TAGS = TAG_LITERALS.map(normalizeTag)
const MAX_TAG_LEN = Math.max(...TAG_LITERALS.map((t) => t.length)) + 4

function normalizeTag(value: string): string {
  return value.replace(/[\s_]/g, "").toLowerCase()
}

/** Flatten the different tool declaration shapes clients use. */
export function normalizeTools(tools: unknown): ToolSpec[] {
  if (!Array.isArray(tools)) return []
  const specs: ToolSpec[] = []
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue
    const tool = raw as OpenAITool
    const fn = tool.function ?? tool
    const name = typeof fn.name === "string" ? fn.name.trim() : ""
    if (!name) continue
    specs.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    })
  }
  return specs
}

/**
 * System-prompt block that teaches the model the text protocol and lists the tools.
 * muse.ai's web chat has no native function calling, so tool calls travel as text.
 */
export function renderToolPrompt(specs: ToolSpec[]): string {
  const listing = specs
    .map((spec) =>
      JSON.stringify({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      }),
    )
    .join(",\n")

  return [
    "# Tool calling",
    "",
    "You act inside an AI coding assistant (Kilo Code) and can operate on the user's workspace by calling tools.",
    "The tools below are the only ones that exist. You call a tool by writing exactly one block in this format:",
    "",
    "<tool_use>",
    '{"name": "tool_name", "arguments": {"argument": "value"}}',
    "</tool_use>",
    "",
    "Rules:",
    '- Call exactly ONE tool per reply, then stop and wait. You receive the outcome as a "[Tool]" message.',
    '- "arguments" must be a single valid JSON object that matches the tool\'s "parameters" schema.',
    '  Use JSON only: double quotes, no comments, no trailing commas, no placeholders like "<path>".',
    "- Never invent a tool name and never call a tool that is not listed below.",
    "- Do not put the block inside a markdown code fence and do not escape it.",
    "- Text you write before the block is shown to the user; keep it short.",
    "- If you cannot or must not call a tool, answer with plain text and no block.",
    "- Absolute paths are required for every file or directory argument.",
    "",
    "Available tools:",
    "<tools>",
    listing,
    "</tools>",
  ].join("\n")
}

function coerceArguments(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      return { value: parsed }
    } catch {
      return { text: value }
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return { value }
}

/** Strip markdown fences and surrounding prose so the JSON payload can be parsed. */
function extractJson(body: string): unknown | undefined {
  let text = body.trim()
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)```$/)
  if (fence?.[1]) text = fence[1].trim()
  if (!text) return undefined
  const candidates: string[] = [text]
  const firstBrace = text.indexOf("{")
  const firstBracket = text.indexOf("[")
  const lastBrace = text.lastIndexOf("}")
  const lastBracket = text.lastIndexOf("]")
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1))
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(text.slice(firstBracket, lastBracket + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

function callFromPayload(payload: unknown, index: number, idPrefix: string): ParsedToolCall | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const fn = (record.function ?? record) as Record<string, unknown>
  const name = typeof fn.name === "string" ? fn.name.trim() : typeof record.tool === "string" ? record.tool.trim() : ""
  if (!name) return undefined
  const args =
    fn.arguments !== undefined
      ? fn.arguments
      : record.arguments !== undefined
        ? record.arguments
        : record.args !== undefined
          ? record.args
          : record.input !== undefined
            ? record.input
            : record.parameters
  return { id: `${idPrefix}_${index}`, name, arguments: coerceArguments(args) }
}

/**
 * Parse tool calls out of a complete assistant reply.
 * Returns the calls plus the reply text with every tool block removed.
 */
export function parseToolCalls(text: string, idPrefix = "call"): { calls: ParsedToolCall[]; text: string } {
  const calls: ParsedToolCall[] = []
  let plain = text
  if (text.includes("<")) {
    plain = text.replace(GLOBAL_BLOCK_RE, (_match, _tag: string, body: string) => {
      const payload = extractJson(body)
      const parsed = payloadToArray(payload)
        .map((item, index) => callFromPayload(item, calls.length + index, idPrefix))
        .filter((call): call is ParsedToolCall => Boolean(call))
      if (parsed.length === 0) return _match // not a tool call -> keep the text as-is
      calls.push(...parsed)
      return ""
    })
  }
  if (calls.length === 0) {
    // Fallback: the whole reply is a bare JSON tool call without tags.
    const trimmed = text.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const payload = extractJson(trimmed)
      const parsed = payloadToArray(payload)
        .map((item, index) => callFromPayload(item, index, idPrefix))
        .filter((call): call is ParsedToolCall => Boolean(call))
      if (parsed.length > 0) return { calls: parsed, text: "" }
    }
  }
  return { calls, text: plain.replace(/\n{3,}/g, "\n\n").trim() }
}

function payloadToArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === "object") return [payload]
  return []
}

/** Length of the trailing buffer section that may still grow into a start tag. */
export function partialTagLength(buffer: string): number {
  const idx = buffer.lastIndexOf("<")
  if (idx < 0) return 0
  const tail = buffer.slice(idx)
  if (tail.length > MAX_TAG_LEN) return 0
  const normalized = normalizeTag(tail)
  if (!normalized) return 0
  for (const tag of NORMALIZED_TAGS) {
    if (tag.startsWith(normalized)) return tail.length
  }
  return 0
}

export type ScannerEvent = { type: "text"; text: string } | { type: "call"; call: ParsedToolCall }

/**
 * Incremental scanner for streamed model output.
 * Emits user-visible text as soon as it is safe and turns completed tool blocks
 * into calls. Incomplete or unparsable blocks degrade to plain text.
 */
export class ToolBlockScanner {
  private buffer = ""
  private block = ""
  private inBlock = false
  private callCount = 0
  private readonly idPrefix: string

  constructor(idPrefix = "call") {
    this.idPrefix = idPrefix
  }

  get sawToolCall(): boolean {
    return this.callCount > 0
  }

  push(delta: string): ScannerEvent[] {
    if (!delta) return []
    this.buffer += delta
    return this.drain(false)
  }

  /** Flush everything that is left when the stream ends. */
  end(): ScannerEvent[] {
    const events = this.drain(true)
    if (this.inBlock) {
      // The model never closed the block: show it as text instead of losing it.
      events.push({ type: "text", text: this.block })
      this.block = ""
      this.inBlock = false
    }
    if (this.buffer) {
      events.push({ type: "text", text: this.buffer })
      this.buffer = ""
    }
    return events
  }

  private drain(final: boolean): ScannerEvent[] {
    const events: ScannerEvent[] = []
    let guard = 0
    while (guard++ < 1000) {
      if (this.inBlock) {
        // All streamed chunks belonging to the open block must be appended
        // before we can look for its closing tag.
        if (this.buffer) {
          this.block += this.buffer
          this.buffer = ""
        }
        const close = findCloseTag(this.block)
        if (close) {
          const raw = this.block.slice(0, close.end)
          const body = this.block.slice(close.bodyStart, close.bodyEnd)
          const remainder = this.block.slice(close.end)
          this.block = ""
          this.inBlock = false
          const payload = extractJson(body)
          const parsed = payloadToArray(payload)
            .map((item, index) => callFromPayload(item, this.callCount + index, this.idPrefix))
            .filter((call): call is ParsedToolCall => Boolean(call))
          if (parsed.length > 0) {
            this.callCount += parsed.length
            for (const call of parsed) events.push({ type: "call", call })
            // Anything after a tool call still belongs to the reply.
            if (remainder) this.buffer = remainder + this.buffer
          } else {
            events.push({ type: "text", text: raw })
            if (remainder) this.buffer = remainder + this.buffer
          }
          continue
        }
        if (this.block.length > 400_000) {
          // Runaway block: give up on parsing and pass the text through.
          events.push({ type: "text", text: this.block })
          this.block = ""
          this.inBlock = false
          continue
        }
        break
      }

      const match = START_RE.exec(this.buffer)
      if (match && match.index !== undefined) {
        if (match.index > 0) {
          events.push({ type: "text", text: this.buffer.slice(0, match.index) })
        }
        this.buffer = this.buffer.slice(match.index + match[0].length)
        this.inBlock = true
        this.block = match[0]
        continue
      }
      const hold = final ? 0 : partialTagLength(this.buffer)
      const emitLength = this.buffer.length - hold
      if (emitLength > 0) {
        events.push({ type: "text", text: this.buffer.slice(0, emitLength) })
        this.buffer = this.buffer.slice(emitLength)
      }
      break
    }
    return events
  }
}

interface CloseTag {
  /** Index just after the closing tag, relative to the block. */
  end: number
  /** Index where the JSON body starts (after the opening tag). */
  bodyStart: number
  /** Index where the JSON body ends (before the closing tag). */
  bodyEnd: number
}

function findCloseTag(block: string): CloseTag | undefined {
  const openMatch = START_RE.exec(block)
  const bodyStart = openMatch ? openMatch.index + openMatch[0].length : 0
  const search = block.slice(bodyStart)
  const close = new RegExp(`<\\s*\\/\\s*(?:${TAG_PATTERN})\\s*>`, "i").exec(search)
  if (!close || close.index === undefined) return undefined
  return {
    end: bodyStart + close.index + close[0].length,
    bodyStart,
    bodyEnd: bodyStart + close.index,
  }
}
