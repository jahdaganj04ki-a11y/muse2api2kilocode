import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeTools, parseToolCalls, partialTagLength, renderToolPrompt, ToolBlockScanner } from "../src/core/tools"

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
]

describe("normalizeTools", () => {
  it("flattens OpenAI function declarations", () => {
    const specs = normalizeTools(TOOLS)
    assert.equal(specs.length, 1)
    assert.equal(specs[0]!.name, "read_file")
  })

  it("ignores malformed entries", () => {
    assert.deepEqual(normalizeTools([null, 5, { type: "function" }]), [])
  })
})

describe("renderToolPrompt", () => {
  it("mentions the protocol and the tool", () => {
    const prompt = renderToolPrompt(normalizeTools(TOOLS))
    assert.match(prompt, /<tool_use>/)
    assert.match(prompt, /read_file/)
    assert.match(prompt, /"parameters"/)
  })
})

describe("parseToolCalls", () => {
  it("extracts a single tagged call and strips it from the text", () => {
    const reply = 'Ich lese die Datei.\n<tool_use>\n{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}\n</tool_use>'
    const result = parseToolCalls(reply)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]!.name, "read_file")
    assert.deepEqual(result.calls[0]!.arguments, { path: "/tmp/a.txt" })
    assert.match(result.text, /Ich lese die Datei\./)
    assert.ok(!result.text.includes("tool_use"))
  })

  it("accepts alternate tag spellings and fenced JSON", () => {
    const reply = [
      "<TOOL CALL>",
      "```json",
      '{"name": "write_file", "arguments": {"path": "/tmp/a.txt", "content": "hi"}}',
      "```",
      "</TOOL CALL>",
    ].join("\n")
    const result = parseToolCalls(reply)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]!.name, "write_file")
    assert.equal(result.calls[0]!.arguments.content, "hi")
  })

  it("parses multiple calls and array payloads", () => {
    const reply = [
      '<tool_use>[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"y":2}}]</tool_use>',
      '<tool_use>{"name":"c","arguments":{}}</tool_use>',
    ].join("\n")
    const result = parseToolCalls(reply)
    assert.deepEqual(
      result.calls.map((call) => call.name),
      ["a", "b", "c"],
    )
    assert.deepEqual(result.calls[1]!.arguments, { y: 2 })
    assert.equal(result.text, "")
  })

  it("keeps plain text and unparsable blocks untouched", () => {
    assert.deepEqual(parseToolCalls("Just a normal answer.").calls, [])
    const malformed = "<tool_use>not json</tool_use>"
    const result = parseToolCalls(malformed)
    assert.equal(result.calls.length, 0)
    assert.match(result.text, /not json/)
  })

  it("accepts a bare JSON tool call without tags", () => {
    const result = parseToolCalls('{"name":"read_file","arguments":{"path":"/x"}}')
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]!.arguments.path, "/x")
  })

  it("handles stringified arguments", () => {
    const result = parseToolCalls('<tool_use>{"name":"a","arguments":"{\\"k\\":42}"}</tool_use>')
    assert.deepEqual(result.calls[0]!.arguments, { k: 42 })
  })
})

describe("partialTagLength", () => {
  it("holds back a trailing partial start tag", () => {
    assert.equal(partialTagLength("hello <tool_us"), "<tool_us".length)
    assert.equal(partialTagLength("hello <"), 1)
  })

  it("does not hold back ordinary text", () => {
    assert.equal(partialTagLength("hello world"), 0)
    assert.equal(partialTagLength("a < b and c > d"), 0)
  })
})

describe("ToolBlockScanner", () => {
  const block = '<tool_use>\n{"name":"read_file","arguments":{"path":"/tmp/a"}}\n</tool_use>'

  it("emits plain text without a tool block", () => {
    const scanner = new ToolBlockScanner()
    const events = [...scanner.push("hello "), ...scanner.push("world"), ...scanner.end()]
    const text = events
      .map((event) => (event.type === "text" ? event.text : "CALL"))
      .join("")
    assert.equal(text, "hello world")
    assert.equal(scanner.sawToolCall, false)
  })

  it("emits a call when a block arrives in many chunks", () => {
    const scanner = new ToolBlockScanner("call_test")
    const events = []
    for (const char of `Antwort: ${block} Danach`) {
      events.push(...scanner.push(char))
    }
    events.push(...scanner.end())
    const calls = events.filter((event) => event.type === "call")
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join("")
    assert.equal(calls.length, 1)
    assert.equal((calls[0] as { call: { name: string } }).call.name, "read_file")
    assert.match(text, /Antwort:/)
    assert.match(text, /Danach/)
    assert.equal(scanner.sawToolCall, true)
  })

  it("does not lose an incomplete block at end of stream", () => {
    const scanner = new ToolBlockScanner()
    const events = [...scanner.push("start "), ...scanner.push("<tool_use>{oops"), ...scanner.end()]
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join("")
    assert.match(text, /start/)
    assert.match(text, /oops/)
  })

  it("handles a tag split exactly at the boundary", () => {
    const scanner = new ToolBlockScanner()
    const events = [...scanner.push("x<tool"), ...scanner.push("_use>" + block.slice("<tool_use>".length)), ...scanner.end()]
    assert.equal(events.filter((event) => event.type === "call").length, 1)
  })
})
