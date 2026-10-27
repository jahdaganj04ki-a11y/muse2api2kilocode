/** Server-sent-events helpers shared by the shim and the gateway probes. */

export interface SseEvent {
  /** Concatenated `data:` payload of the event. */
  data: string
  event?: string
  id?: string
  /** True for `: comment` heartbeats (muse2api sends ": keepalive"). */
  comment?: boolean
}

/**
 * Incremental SSE parser. Feed it raw chunks; it emits complete events.
 * Handles CRLF, multi-line data fields and comment lines.
 */
export class SseParser {
  private buffer = ""
  private data: string[] = []
  private event: string | undefined
  private id: string | undefined

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let newline: number
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const rawLine = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
      const event = this.handleLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /** Flush a trailing line that was not terminated by a newline. */
  end(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer) {
      const line = this.buffer
      this.buffer = ""
      const event = this.handleLine(line)
      if (event) events.push(event)
    }
    const flushed = this.flush()
    if (flushed) events.push(flushed)
    return events
  }

  private handleLine(line: string): SseEvent | undefined {
    if (line === "") return this.flush()
    if (line.startsWith(":")) {
      return { data: "", comment: true }
    }
    const colon = line.indexOf(":")
    let field = line
    let value = ""
    if (colon >= 0) {
      field = line.slice(0, colon)
      value = line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
    }
    switch (field) {
      case "data":
        this.data.push(value)
        break
      case "event":
        this.event = value
        break
      case "id":
        this.id = value
        break
      default:
        break
    }
    return undefined
  }

  private flush(): SseEvent | undefined {
    if (this.data.length === 0 && !this.event && !this.id) return undefined
    const event: SseEvent = { data: this.data.join("\n"), event: this.event, id: this.id }
    this.data = []
    this.event = undefined
    this.id = undefined
    return event
  }
}

export function sseFrame(data: string): string {
  return `data: ${data}\n\n`
}

export function sseJson(payload: unknown): string {
  return sseFrame(JSON.stringify(payload))
}

export const SSE_DONE = "data: [DONE]\n\n"
