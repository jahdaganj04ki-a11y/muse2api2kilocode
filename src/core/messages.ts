import { normalizeTools, renderToolPrompt, type OpenAITool } from "./tools"

export interface ToolCallMessagePart {
  id?: string
  type?: string
  function?: { name?: string; arguments?: unknown }
  name?: string
  arguments?: unknown
}

export interface ChatMessage {
  role?: string
  content?: unknown
  name?: string
  tool_calls?: ToolCallMessagePart[]
  tool_call_id?: string
  [key: string]: unknown
}

export interface TransformOptions {
  /** Maximum characters kept from a tool result before it is truncated. */
  maxToolResultChars?: number
  /** Skip the tool instructions, e.g. when tool_choice is "none". */
  withoutTools?: boolean
}

const DEFAULT_TOOL_RESULT_CHARS = 8000

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const removed = text.length - max
  return `${text.slice(0, max)}\n… [${removed} characters truncated]`
}

function contentToText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part)
        continue
      }
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>
        if (typeof record.text === "string") parts.push(record.text)
        else if (record.type === "tool_result" && typeof record.content === "string") parts.push(record.content)
      }
    }
    return parts.join("\n")
  }
  if (typeof content === "object") {
    const record = content as Record<string, unknown>
    if (typeof record.text === "string") return record.text
  }
  return String(content)
}

function renderToolCall(call: ToolCallMessagePart): string {
  const fn = call.function ?? call
  const name = typeof fn.name === "string" ? fn.name : ""
  if (!name) return ""
  let args = fn.arguments
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      args = { text: args }
    }
  }
  return `<tool_use>\n${JSON.stringify({ name, arguments: args ?? {} })}\n</tool_use>`
}

/**
 * Rewrite an OpenAI chat history for muse2api:
 * - assistant messages that only carry `tool_calls` become the text protocol the model learned
 * - `tool` results are wrapped so the model can tell which call they answer
 * - the tool instructions are appended as a final system block
 */
export function transformMessages(
  messages: ChatMessage[],
  tools: OpenAITool[] | undefined,
  options: TransformOptions = {},
): ChatMessage[] {
  const maxResult = options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS
  const out: ChatMessage[] = []

  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "user"
    const text = contentToText(message.content)

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const calls = message.tool_calls.map(renderToolCall).filter(Boolean)
      const body = [text.trim(), ...calls].filter(Boolean).join("\n\n")
      out.push({ role: "assistant", content: body || "(tool call)" })
      continue
    }

    if (role === "tool") {
      const label = typeof message.name === "string" && message.name ? message.name : "tool"
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      const body = truncate(text, maxResult)
      out.push({
        role: "tool",
        name: label,
        content: `<tool_result name="${label}"${id ? ` id="${id}"` : ""}>\n${body}\n</tool_result>`,
      })
      continue
    }

    out.push({ ...message, role })
  }

  const specs = normalizeTools(tools)
  if (!options.withoutTools && specs.length > 0) {
    out.push({ role: "system", content: renderToolPrompt(specs) })
  }
  return out
}

/** Build the upstream request body: transformed history, no native tool fields. */
export function buildUpstreamBody(body: Record<string, unknown>, options: TransformOptions = {}): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []
  const tools = body.tools as OpenAITool[] | undefined
  const toolChoice = body.tool_choice
  const withoutTools = toolChoice === "none" || !Array.isArray(tools) || tools.length === 0

  const next: Record<string, unknown> = { ...body }
  delete next.tools
  delete next.tool_choice
  delete next.parallel_tool_calls
  delete next.tool_choice_enabled
  next.messages = transformMessages(messages, tools, { ...options, withoutTools })
  return next
}
