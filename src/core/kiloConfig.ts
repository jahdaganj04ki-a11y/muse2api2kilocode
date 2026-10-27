import { applyEdits, modify, type ModificationOptions } from "jsonc-parser"
import { CONFIG_SCHEMA, emptyConfigContent } from "./kiloPaths"

export type ModelKind = "chat" | "image" | "video"

/** A model as reported by `GET /v1/models` of muse2api. */
export interface GatewayModel {
  id: string
  kind?: ModelKind
  alias_of?: string
  owned_by?: string
}

export interface ProviderRegistration {
  providerId: string
  displayName: string
  baseURL: string
  contextWindow: number
  maxOutputTokens: number
  declareToolCalls: boolean
  declareImages: boolean
  includeAliases: boolean
  includeNonChatModels: boolean
  /** Model that becomes the active one, e.g. "muse-chat". Empty keeps the user's choice. */
  activeModel?: string
}

const EDIT_OPTIONS: ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true },
  isArrayInsertion: false,
}

function modelLabel(id: string, kind: ModelKind): string {
  switch (kind) {
    case "image":
      return `muse.ai Image (${id})`
    case "video":
      return `muse.ai Video (${id})`
    default:
      return `muse.ai Chat (${id})`
  }
}

/** Models that make sense inside Kilo Code's model picker. */
export function selectModels(models: GatewayModel[], registration: ProviderRegistration): GatewayModel[] {
  const known = new Set(models.map((model) => model.id))
  return models.filter((model) => {
    const kind: ModelKind = model.kind === "image" || model.kind === "video" ? model.kind : "chat"
    const isAlias = Boolean(model.alias_of) || (kind === "chat" && !model.id.startsWith("muse-"))
    if (isAlias && !registration.includeAliases) return false
    if (kind !== "chat" && !registration.includeNonChatModels) return false
    if (model.alias_of && !known.has(model.alias_of)) return false
    return true
  })
}

/** The `provider.<id>` block, exactly what Kilo Code's own "Custom provider" dialog writes. */
export function buildProviderBlock(models: GatewayModel[], registration: ProviderRegistration): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  for (const model of models) {
    const kind: ModelKind = model.kind === "image" || model.kind === "video" ? model.kind : "chat"
    entries[model.id] = {
      name: modelLabel(model.id, kind),
      tool_call: kind === "chat" ? registration.declareToolCalls : false,
      temperature: false,
      reasoning: false,
      attachment: kind === "chat" ? registration.declareImages : false,
      modalities:
        kind === "chat"
          ? {
              input: registration.declareImages ? ["text", "image"] : ["text"],
              output: ["text"],
            }
          : { input: ["text"], output: ["text"] },
      limit: { context: registration.contextWindow, output: registration.maxOutputTokens },
      cost: { input: 0, output: 0 },
    }
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    name: registration.displayName,
    options: { baseURL: registration.baseURL },
    models: entries,
  }
}

/** Insert or update the provider block in a JSONC document, keeping comments intact. */
export function writeProviderConfig(
  content: string | undefined,
  block: Record<string, unknown>,
  registration: ProviderRegistration,
): string {
  let document = content && content.trim() ? content : emptyConfigContent()
  document = ensureSchema(document)

  let edits = modify(document, ["provider", registration.providerId], block, EDIT_OPTIONS)
  document = applyEdits(document, edits)

  if (registration.activeModel) {
    edits = modify(document, ["model"], `${registration.providerId}/${registration.activeModel}`, EDIT_OPTIONS)
    document = applyEdits(document, edits)
  }
  return document
}

/** Remove the provider block again (used by "unregister"). */
export function removeProviderConfig(content: string, providerId: string): string {
  if (!content.trim()) return content
  let edits = modify(content, ["provider", providerId], undefined, EDIT_OPTIONS)
  let document = applyEdits(content, edits)
  edits = modify(document, ["model"], undefined, EDIT_OPTIONS)
  const candidate = applyEdits(document, edits)
  // Only drop the model selection when it pointed at our provider.
  const modelPrefix = `${providerId}/`
  if (document.includes(`"${modelPrefix}`)) return candidate
  return document
}

function ensureSchema(document: string): string {
  if (document.includes(`"${CONFIG_SCHEMA}"`) || document.includes('"$schema"')) return document
  const edits = modify(document, ["$schema"], CONFIG_SCHEMA, EDIT_OPTIONS)
  return applyEdits(document, edits)
}

/** Read the credential store entry Kilo Code expects for a connected provider. */
export function buildAuthEntry(content: string | undefined, providerId: string, apiKey: string): string {
  let store: Record<string, unknown> = {}
  if (content && content.trim()) {
    try {
      const parsed = JSON.parse(content) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed as Record<string, unknown>
    } catch {
      // A broken auth.json must not stop the registration; keep the parsed part empty.
      store = {}
    }
  }
  store[providerId] = { type: "api", key: apiKey }
  return `${JSON.stringify(store, null, 2)}\n`
}

/** Drop our entry from the credential store. */
export function removeAuthEntry(content: string | undefined, providerId: string): string | undefined {
  if (!content || !content.trim()) return content
  let store: Record<string, unknown>
  try {
    store = JSON.parse(content) as Record<string, unknown>
  } catch {
    return content
  }
  if (!store || typeof store !== "object") return content
  if (!(providerId in store)) return content
  delete store[providerId]
  return `${JSON.stringify(store, null, 2)}\n`
}
