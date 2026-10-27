import * as vscode from "vscode"
import type { GatewaySettings } from "../core/gateway"

export interface KiloSettings {
  providerId: string
  displayName: string
  scope: "global" | "workspace"
  contextWindow: number
  maxOutputTokens: number
  declareToolCalls: boolean
  declareImages: boolean
  includeAliases: boolean
  includeNonChatModels: boolean
  setAsActiveModel: boolean
  writeKeyToAuthStore: boolean
}

export interface ShimSettings {
  enabled: boolean
  port: number
  autoPort: boolean
  maxToolResultChars: number
  timeoutSeconds: number
}

export interface ExtensionSettings {
  gateway: GatewaySettings
  shim: ShimSettings
  kilo: KiloSettings
  pythonPath: string
  useUv: boolean
  autoStart: boolean
}

const SECTION = "muse2api"

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION)
}

function read<T>(key: string, fallback: T): T {
  const value = config().get<T>(key)
  return value === undefined || value === null ? fallback : value
}

export function readSettings(): ExtensionSettings {
  const envRaw = read<Record<string, unknown>>("env", {}) ?? {}
  const extraEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(envRaw)) {
    if (value === undefined || value === null) continue
    extraEnv[key] = String(value)
  }

  return {
    gateway: {
      driver: read<"browser" | "mock" | "http">("driver", "browser"),
      host: read<string>("host", "127.0.0.1"),
      port: read<number>("port", 18610),
      autoPort: read<boolean>("autoPort", true),
      logLevel: read<string>("logLevel", "INFO"),
      dataDir: read<string>("dataDir", ""),
      apiKey: read<string>("apiKey", ""),
      adminKey: read<string>("adminKey", ""),
      chromiumPath: read<string>("chromiumPath", ""),
      headless: read<boolean>("headless", true),
      accountConcurrency: read<number>("accountConcurrency", 4),
      poolStrategy: read<string>("poolStrategy", "affinity"),
      streamHeartbeat: read<number>("streamHeartbeat", 0),
      extraEnv,
    },
    shim: {
      enabled: read<boolean>("shim.enabled", true),
      port: read<number>("shim.port", 18611),
      autoPort: read<boolean>("shim.autoPort", true),
      maxToolResultChars: read<number>("shim.maxToolResultChars", 8000),
      timeoutSeconds: read<number>("shim.timeoutSeconds", 600),
    },
    kilo: {
      providerId: sanitizeProviderId(read<string>("kilocode.providerId", "muse2api")),
      displayName: read<string>("kilocode.displayName", "muse.ai (muse2api)"),
      scope: read<"global" | "workspace">("kilocode.scope", "global"),
      contextWindow: read<number>("kilocode.contextWindow", 128000),
      maxOutputTokens: read<number>("kilocode.maxOutputTokens", 8192),
      declareToolCalls: read<boolean>("kilocode.declareToolCalls", true),
      declareImages: read<boolean>("kilocode.declareImages", true),
      includeAliases: read<boolean>("kilocode.includeAliases", false),
      includeNonChatModels: read<boolean>("kilocode.includeNonChatModels", false),
      setAsActiveModel: read<boolean>("kilocode.setAsActiveModel", false),
      writeKeyToAuthStore: read<boolean>("kilocode.writeKeyToAuthStore", true),
    },
    pythonPath: read<string>("pythonPath", ""),
    useUv: read<boolean>("useUv", true),
    autoStart: read<boolean>("autoStart", false),
  }
}

/** Kilo Code provider ids: lowercase letters, numbers, hyphen, underscore. */
export function sanitizeProviderId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "muse2api"
}

export async function updateSetting(key: string, value: unknown, global = true): Promise<void> {
  await config().update(
    key,
    value,
    global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
  )
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) handler()
  })
}
