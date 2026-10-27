/**
 * Kilo Code before 7.x stored provider profiles in VS Code settings
 * (`kilocode.providerProfiles`, Roo/Cline lineage). Current versions read
 * `kilo.jsonc` instead, so this is a compatibility path only.
 */
export interface LegacyProfileOptions {
  profileName: string
  baseURL: string
  apiKey: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  supportsImages: boolean
}

export const LEGACY_SETTINGS_KEY = "kilocode.providerProfiles"

export function buildLegacyApiConfig(options: LegacyProfileOptions): Record<string, unknown> {
  return {
    apiProvider: "openai",
    openAiBaseUrl: options.baseURL,
    openAiApiKey: options.apiKey,
    openAiModelId: options.modelId,
    openAiStreamingEnabled: true,
    openAiLegacyFormat: false,
    openAiR1FormatEnabled: false,
    openAiCustomModelInfo: {
      maxTokens: options.maxOutputTokens,
      contextWindow: options.contextWindow,
      supportsImages: options.supportsImages,
      supportsPromptCache: false,
      inputPrice: 0,
      outputPrice: 0,
    },
    modelTemperature: 0,
  }
}

/**
 * Merge our profile into the existing `providerProfiles` value.
 * `activate` decides whether our profile becomes the current one.
 */
export function mergeLegacyProfiles(
  existing: unknown,
  options: LegacyProfileOptions,
  activate: boolean,
): Record<string, unknown> {
  const current = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {}
  const configs =
    current.apiConfigs && typeof current.apiConfigs === "object" ? { ...(current.apiConfigs as Record<string, unknown>) } : {}
  configs[options.profileName] = buildLegacyApiConfig(options)
  const merged: Record<string, unknown> = { ...current, apiConfigs: configs }
  if (activate || typeof current.currentApiConfigName !== "string" || !current.currentApiConfigName) {
    merged.currentApiConfigName = options.profileName
  }
  return merged
}

/** Remove our profile again, keeping everything else untouched. */
export function removeLegacyProfile(existing: unknown, profileName: string): Record<string, unknown> | undefined {
  if (!existing || typeof existing !== "object") return undefined
  const current = existing as Record<string, unknown>
  const configs =
    current.apiConfigs && typeof current.apiConfigs === "object" ? { ...(current.apiConfigs as Record<string, unknown>) } : {}
  if (!(profileName in configs)) return undefined
  delete configs[profileName]
  const merged: Record<string, unknown> = { ...current, apiConfigs: configs }
  if (current.currentApiConfigName === profileName) {
    const remaining = Object.keys(configs)
    if (remaining.length > 0) merged.currentApiConfigName = remaining[0]
    else delete merged.currentApiConfigName
  }
  return merged
}

/** Kilo Code extension ids we know about (marketplace + open-vsx). */
export const KILO_EXTENSION_IDS = ["kilocode.kilo-code", "Kilo-Org.kilo-code", "kilocode.kilocode"]

export interface KiloInstall {
  id: string
  version: string
  /** 7+ reads kilo.jsonc, older builds use VS Code settings. */
  modern: boolean
  major: number
}

export function describeInstall(id: string, version: string | undefined): KiloInstall {
  const parsed = Number.parseInt(String(version ?? "").split(".")[0] ?? "", 10)
  const known = Number.isFinite(parsed) && parsed > 0
  const major = known ? parsed : 7
  return {
    id,
    version: version ?? "unknown",
    major,
    // An unknown version is treated as a current (7.x) build: kilo.jsonc is
    // the format of every release we know of, and the legacy path is only for
    // versions we can positively identify as pre-7.
    modern: known ? major >= 7 : true,
  }
}
