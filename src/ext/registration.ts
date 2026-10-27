import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import * as vscode from "vscode"
import {
  authFile,
  existingWorkspaceConfig,
  pickGlobalConfigFile,
  workspaceConfigFile,
} from "../core/kiloPaths"
import {
  buildAuthEntry,
  buildProviderBlock,
  removeAuthEntry,
  removeProviderConfig,
  selectModels,
  writeProviderConfig,
  type GatewayModel,
  type ProviderRegistration,
} from "../core/kiloConfig"
import {
  describeInstall,
  KILO_EXTENSION_IDS,
  LEGACY_SETTINGS_KEY,
  mergeLegacyProfiles,
  removeLegacyProfile,
  type KiloInstall,
} from "../core/kiloLegacy"
import { errorMessage } from "../core/logger"
import type { KiloSettings } from "./settings"
import { t } from "./i18n"

export interface RegistrationResult {
  file: string
  scope: "global" | "workspace" | "settings"
  models: GatewayModel[]
  providerId: string
  kilo: KiloInstall | undefined
  message: string
}

export function detectKiloCode(): KiloInstall | undefined {
  for (const id of KILO_EXTENSION_IDS) {
    const extension = vscode.extensions.getExtension(id)
    if (!extension) continue
    const version = extension.packageJSON?.version as string | undefined
    return describeInstall(id, version)
  }
  return undefined
}

async function readFileOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, content, "utf8")
  if (mode !== undefined) await fs.chmod(tmp, mode)
  await fs.rename(tmp, file)
}

function targetFile(scope: "global" | "workspace"): string {
  if (scope === "workspace") {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (root) return existingWorkspaceConfig(root, existsSync) ?? workspaceConfigFile(root)
  }
  return pickGlobalConfigFile(existsSync)
}

/**
 * Write the muse.ai models into Kilo Code's configuration.
 * Modern versions (7+) get a `provider.<id>` block in kilo.jsonc plus an entry in
 * auth.json; older versions get a profile in `kilocode.providerProfiles`.
 */
export async function registerInKiloCode(input: {
  settings: KiloSettings
  scope: "global" | "workspace"
  baseUrl: string
  apiKey: string | undefined
  models: GatewayModel[]
  activeModel?: string
}): Promise<RegistrationResult> {
  const { settings, scope, baseUrl, apiKey, models } = input
  const kilo = detectKiloCode()
  const registration: ProviderRegistration = {
    providerId: settings.providerId,
    displayName: settings.displayName,
    baseURL: `${baseUrl.replace(/\/$/, "")}/v1`,
    contextWindow: settings.contextWindow,
    maxOutputTokens: settings.maxOutputTokens,
    declareToolCalls: settings.declareToolCalls,
    declareImages: settings.declareImages,
    includeAliases: settings.includeAliases,
    includeNonChatModels: settings.includeNonChatModels,
    activeModel: settings.setAsActiveModel ? input.activeModel ?? "muse-chat" : undefined,
  }
  const selected = selectModels(models, registration)
  const chatModels = selected.filter((model) => model.kind !== "image" && model.kind !== "video")
  const list = chatModels.length > 0 ? chatModels : selected
  if (list.length === 0) throw new Error(t("register.noModels"))

  if (kilo && !kilo.modern) {
    const file = await writeLegacyProfile(settings, baseUrl, apiKey ?? "", list[0]!.id)
    return {
      file,
      scope: "settings",
      models: list,
      providerId: settings.providerId,
      kilo,
      message: t("register.legacy", { version: kilo.version }),
    }
  }

  const file = targetFile(scope)
  const block = buildProviderBlock(list, registration)
  const content = await readFileOrUndefined(file)
  const next = writeProviderConfig(content, block, registration)
  await writeFileAtomic(file, next)

  if (apiKey && settings.writeKeyToAuthStore) {
    try {
      const authPath = authFile()
      const current = await readFileOrUndefined(authPath)
      await writeFileAtomic(authPath, buildAuthEntry(current, settings.providerId, apiKey), 0o600)
    } catch (error) {
      // Without auth.json the key can be added in the Kilo UI instead.
      vscode.window.showWarningMessage(
        `${t("register.wrote", { file })} — auth.json: ${errorMessage(error)}`,
      )
    }
  }

  return {
    file,
    scope,
    models: list,
    providerId: settings.providerId,
    kilo,
    message: t("register.ok", { count: list.length, provider: settings.providerId, file }),
  }
}

async function writeLegacyProfile(
  settings: KiloSettings,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<string> {
  const profileName = settings.displayName
  const configuration = vscode.workspace.getConfiguration("kilocode")
  const existing = configuration.get<unknown>("providerProfiles")
  const merged = mergeLegacyProfiles(
    existing,
    {
      profileName,
      baseURL: `${baseUrl.replace(/\/$/, "")}/v1`,
      apiKey,
      modelId,
      contextWindow: settings.contextWindow,
      maxOutputTokens: settings.maxOutputTokens,
      supportsImages: settings.declareImages,
    },
    settings.setAsActiveModel,
  )
  await configuration.update("providerProfiles", merged, vscode.ConfigurationTarget.Global)
  return `${LEGACY_SETTINGS_KEY} (VS Code settings.json)`
}

/** Undo a registration, in both the modern and the legacy location. */
export async function unregisterFromKiloCode(settings: KiloSettings): Promise<string[]> {
  const touched: string[] = []

  const globalFile = pickGlobalConfigFile(existsSync)
  const candidates = [globalFile]
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (root) {
    const workspaceFile = existingWorkspaceConfig(root, existsSync) ?? workspaceConfigFile(root)
    candidates.push(workspaceFile)
  }

  for (const file of candidates) {
    const content = await readFileOrUndefined(file)
    if (!content || !content.includes(settings.providerId)) continue
    const next = removeProviderConfig(content, settings.providerId)
    if (next !== content) {
      await writeFileAtomic(file, next)
      touched.push(file)
    }
  }

  try {
    const authPath = authFile()
    const content = await readFileOrUndefined(authPath)
    const next = removeAuthEntry(content, settings.providerId)
    if (next !== undefined && next !== content) {
      await writeFileAtomic(authPath, next, 0o600)
      touched.push(authPath)
    }
  } catch {
    /* nothing stored */
  }

  const configuration = vscode.workspace.getConfiguration("kilocode")
  const existing = configuration.get<unknown>("providerProfiles")
  const legacyNext = removeLegacyProfile(existing, settings.displayName)
  if (legacyNext) {
    await configuration.update("providerProfiles", legacyNext, vscode.ConfigurationTarget.Global)
    touched.push(LEGACY_SETTINGS_KEY)
  }

  return touched
}

/** Ask where to register, honouring the configured default. */
export async function askScope(settings: KiloSettings): Promise<"global" | "workspace" | undefined> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length)
  if (!hasWorkspace) return "global"

  const globalItem: vscode.QuickPickItem = {
    label: t("register.scopeGlobal"),
    description: t("register.scopeGlobalDetail"),
    detail: pickGlobalConfigFile(existsSync),
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  const workspaceItem: vscode.QuickPickItem = {
    label: t("register.scopeWorkspace"),
    description: t("register.scopeWorkspaceDetail"),
    detail: workspaceRoot ? path.join(workspaceRoot, ".kilo", "kilo.jsonc") : undefined,
  }
  const pick = await vscode.window.showQuickPick(
    settings.scope === "workspace" ? [workspaceItem, globalItem] : [globalItem, workspaceItem],
    { placeHolder: t("register.scope"), title: t("register.title") },
  )
  if (!pick) return undefined
  return pick === workspaceItem ? "workspace" : "global"
}

/** The config snippet, for "copy to clipboard". */
export function kiloSnippet(settings: KiloSettings, baseUrl: string, models: GatewayModel[]): string {
  const registration: ProviderRegistration = {
    providerId: settings.providerId,
    displayName: settings.displayName,
    baseURL: `${baseUrl.replace(/\/$/, "")}/v1`,
    contextWindow: settings.contextWindow,
    maxOutputTokens: settings.maxOutputTokens,
    declareToolCalls: settings.declareToolCalls,
    declareImages: settings.declareImages,
    includeAliases: settings.includeAliases,
    includeNonChatModels: settings.includeNonChatModels,
  }
  const list = selectModels(models, registration)
  return writeProviderConfig(
    undefined,
    buildProviderBlock(list.length > 0 ? list : models, registration),
    registration,
  )
}
