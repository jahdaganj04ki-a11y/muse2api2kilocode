import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parse as parseJsonc } from "jsonc-parser"
import {
  buildProviderBlock,
  removeProviderConfig,
  selectModels,
  writeProviderConfig,
  buildAuthEntry,
  removeAuthEntry,
  type GatewayModel,
  type ProviderRegistration,
} from "../src/core/kiloConfig"
import {
  authFile,
  configRoot,
  dataRoot,
  emptyConfigContent,
  globalConfigCandidates,
  pickGlobalConfigFile,
  workspaceConfigFile,
} from "../src/core/kiloPaths"
import { describeInstall, mergeLegacyProfiles, removeLegacyProfile } from "../src/core/kiloLegacy"

const MODELS: GatewayModel[] = [
  { id: "muse-chat", kind: "chat" },
  { id: "muse-image", kind: "image" },
  { id: "muse-video", kind: "video" },
  { id: "gpt-4o", kind: "chat", alias_of: "muse-chat" },
  { id: "dall-e-3", kind: "image", alias_of: "muse-image" },
]

const REG: ProviderRegistration = {
  providerId: "muse2api",
  displayName: "muse.ai (muse2api)",
  baseURL: "http://127.0.0.1:18611/v1",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  declareToolCalls: false,
  declareImages: true,
  includeAliases: false,
  includeNonChatModels: false,
}

describe("kiloConfig", () => {
  it("selects only chat models by default", () => {
    const selected = selectModels(MODELS, REG)
    assert.deepEqual(
      selected.map((model) => model.id),
      ["muse-chat"],
    )
  })

  it("registers aliases and non-chat models when requested", () => {
    const selected = selectModels(MODELS, {
      ...REG,
      includeAliases: true,
      includeNonChatModels: true,
    })
    assert.deepEqual(
      selected.map((model) => model.id),
      ["muse-chat", "muse-image", "muse-video", "gpt-4o", "dall-e-3"],
    )
  })

  it("builds a Kilo Code compatible provider block", () => {
    const block = buildProviderBlock(selectModels(MODELS, REG), REG) as {
      npm: string
      options: { baseURL: string }
      models: Record<string, { tool_call: boolean; limit: { context: number } }>
    }
    assert.equal(block.npm, "@ai-sdk/openai-compatible")
    assert.equal(block.options.baseURL, "http://127.0.0.1:18611/v1")
    assert.equal(block.models["muse-chat"]!.tool_call, false)
    assert.equal(block.models["muse-chat"]!.limit.context, 128000)
  })

  it("creates a valid empty config", () => {
    const content = writeProviderConfig(undefined, buildProviderBlock(selectModels(MODELS, REG), REG), REG)
    const parsed = parseJsonc(content) as Record<string, unknown>
    assert.equal(parsed.$schema, "https://app.kilo.ai/config.json")
    const provider = (parsed.provider as Record<string, unknown>).muse2api as Record<string, unknown>
    assert.equal(provider.name, REG.displayName)
    assert.ok((provider.models as Record<string, unknown>)["muse-chat"])
  })

  it("preserves comments and unrelated providers in JSONC", () => {
    const existing = [
      "{",
      '  "$schema": "https://app.kilo.ai/config.json",',
      "  // my other provider",
      '  "provider": { "openai": { "options": { "apiKey": "sk-x" } } },',
      '  "theme": "dark"',
      "}",
    ].join("\n")
    const content = writeProviderConfig(existing, buildProviderBlock(selectModels(MODELS, REG), REG), REG)
    assert.match(content, /my other provider/)
    assert.match(content, /"theme": "dark"/)
    const parsed = parseJsonc(content) as Record<string, unknown>
    const providers = parsed.provider as Record<string, unknown>
    assert.ok(providers.openai)
    assert.ok(providers.muse2api)
  })

  it("sets the active model only when requested", () => {
    const content = writeProviderConfig(undefined, buildProviderBlock(selectModels(MODELS, REG), REG), {
      ...REG,
      activeModel: "muse-chat",
    })
    assert.equal((parseJsonc(content) as { model: string }).model, "muse2api/muse-chat")
    const without = writeProviderConfig(undefined, buildProviderBlock(selectModels(MODELS, REG), REG), REG)
    assert.equal((parseJsonc(without) as { model?: string }).model, undefined)
  })

  it("removes the provider but keeps other config values", () => {
    const content = writeProviderConfig(undefined, buildProviderBlock(selectModels(MODELS, REG), REG), {
      ...REG,
      activeModel: "muse-chat",
    })
    const next = removeProviderConfig(content, "muse2api")
    const parsed = parseJsonc(next) as Record<string, unknown>
    assert.equal((parsed.provider as Record<string, unknown>)["muse2api"] ?? null, null)
    assert.equal(parsed.model, undefined)
    assert.equal(parsed.$schema, "https://app.kilo.ai/config.json")
  })

  it("does not drop an unrelated active model", () => {
    const content = [
      "{",
      '  "$schema": "https://app.kilo.ai/config.json",',
      '  "model": "openai/gpt-4o",',
      '  "provider": { "muse2api": { "options": { "baseURL": "x" } } }',
      "}",
    ].join("\n")
    const next = removeProviderConfig(content, "muse2api")
    const parsed = parseJsonc(next) as Record<string, unknown>
    assert.equal(parsed.model, "openai/gpt-4o")
  })
})

describe("auth store", () => {
  it("adds and removes only our entry", () => {
    const initial = '{"openai":{"type":"api","key":"sk-123"}}'
    const written = buildAuthEntry(initial, "muse2api", "m2a-secret")
    const parsed = JSON.parse(written) as Record<string, { key: string }>
    assert.equal(parsed["openai"]!.key, "sk-123")
    assert.equal(parsed["muse2api"]!.key, "m2a-secret")
    const removed = removeAuthEntry(written, "muse2api")!
    assert.equal(JSON.parse(removed).openai.key, "sk-123")
    assert.equal(JSON.parse(removed).muse2api, undefined)
  })

  it("starts from scratch on invalid JSON", () => {
    const written = JSON.parse(buildAuthEntry("not json", "muse2api", "k")) as Record<string, unknown>
    assert.deepEqual(written, { muse2api: { type: "api", key: "k" } })
  })
})

describe("kiloPaths", () => {
  const home = "/home/tester"
  const env = { XDG_CONFIG_HOME: "/home/tester/.config", XDG_DATA_HOME: "/home/tester/.local/share" }

  it("resolves XDG config and data roots", () => {
    assert.equal(configRoot(env, home), "/home/tester/.config/kilo")
    assert.equal(dataRoot(env, home), "/home/tester/.local/share/kilo")
    assert.equal(authFile(env, home), "/home/tester/.local/share/kilo/auth.json")
  })

  it("puts kilo.jsonc first (after KILO_CONFIG)", () => {
    assert.match(globalConfigCandidates({}, home)[0]!, /\.config\/kilo\/kilo\.jsonc$/)
  })

  it("honours KILO_CONFIG and prefers the first existing file", () => {
    const list = globalConfigCandidates({ KILO_CONFIG: "/tmp/custom.json" }, home)
    assert.equal(list[0], "/tmp/custom.json")
    const existing = new Set(["/home/tester/.config/kilo/kilo.json"])
    assert.equal(
      pickGlobalConfigFile((file) => existing.has(file), {}, home),
      "/home/tester/.config/kilo/kilo.json",
    )
  })

  it("uses the recommended file when nothing exists", () => {
    assert.equal(
      pickGlobalConfigFile(() => false, {}, home),
      "/home/tester/.config/kilo/kilo.jsonc",
    )
    assert.equal(workspaceConfigFile("/work"), "/work/.kilo/kilo.jsonc")
    assert.match(emptyConfigContent(), /\$schema/)
  })
})

describe("legacy profiles", () => {
  it("detects modern and legacy versions", () => {
    assert.equal(describeInstall("kilocode.kilo-code", "7.8.18").modern, true)
    assert.equal(describeInstall("kilocode.kilo-code", "4.110.0").modern, false)
    assert.equal(describeInstall("kilocode.kilo-code", undefined).modern, true)
  })

  it("merges a profile and activates it", () => {
    const existing = {
      currentApiConfigName: "default",
      apiConfigs: { default: { apiProvider: "openrouter" } },
    }
    const merged = mergeLegacyProfiles(
      existing,
      {
        profileName: "muse.ai",
        baseURL: "http://127.0.0.1:18611/v1",
        apiKey: "k",
        modelId: "muse-chat",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsImages: true,
      },
      true,
    ) as { currentApiConfigName: string; apiConfigs: Record<string, Record<string, unknown>> }
    assert.equal(merged.currentApiConfigName, "muse.ai")
    assert.equal(merged.apiConfigs["default"]!.apiProvider, "openrouter")
    assert.equal(merged.apiConfigs["muse.ai"]!.openAiModelId, "muse-chat")
    assert.equal(merged.apiConfigs["muse.ai"]!.apiProvider, "openai")
  })

  it("removes our profile and picks another current config", () => {
    const next = removeLegacyProfile(
      {
        currentApiConfigName: "muse.ai",
        apiConfigs: { "muse.ai": {}, default: {} },
      },
      "muse.ai",
    ) as { currentApiConfigName: string; apiConfigs: Record<string, unknown> }
    assert.equal(next.currentApiConfigName, "default")
    assert.equal(next.apiConfigs["muse.ai"], undefined)
  })
})
