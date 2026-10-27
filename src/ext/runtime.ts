import * as path from "path"
import * as vscode from "vscode"
import { GatewayClient, type AccountInfo } from "../core/client"
import { GatewayManager, type GatewayInfo, type GatewayState } from "../core/gateway"
import type { GatewayModel } from "../core/kiloConfig"
import { errorMessage, type Logger } from "../core/logger"
import { ShimServer } from "../core/shim"
import { t } from "./i18n"
import { createRunner } from "./runner"
import { readSettings, type ExtensionSettings } from "./settings"

const SECRET_API_KEY = "muse2api.apiKey"
const SECRET_CLIENT_KEY = "muse2api.clientKey"
const SECRET_CLIENT_KEY_ID = "muse2api.clientKeyId"
const SECRET_BASE_URL = "muse2api.baseUrl"
const STATE_SETUP_DONE = "muse2api.setupDone"

/** Shared runtime: settings, gateway process, shim, cached models/accounts. */
export class Runtime {
  readonly output: vscode.OutputChannel
  readonly logger: Logger
  readonly gateway: GatewayManager
  settings: ExtensionSettings
  models: GatewayModel[] = []
  accounts: AccountInfo[] = []
  shim: ShimServer | undefined
  shimBaseUrl = ""
  requestCount = 0

  private readonly changed = new vscode.EventEmitter<void>()
  readonly onChanged = this.changed.event
  private readonly runner = createRunner()

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel(t("logs.title"))
    const output = this.output
    this.logger = {
      info: (message) => output.appendLine(`[${stamp()}] ${message}`),
      warn: (message) => output.appendLine(`[${stamp()}] WARN ${message}`),
      error: (message, error) =>
        output.appendLine(`[${stamp()}] ERROR ${message}${error ? `: ${errorMessage(error)}` : ""}`),
      debug: (message) => output.appendLine(`[${stamp()}] DEBUG ${message}`),
    }
    this.settings = readSettings()
    this.gateway = new GatewayManager({
      storageDir: this.storageDir,
      vendorDir: this.vendorDir,
      pythonPath: this.settings.pythonPath,
      useUv: this.settings.useUv,
      settings: this.settings.gateway,
      logger: this.logger,
    })
    this.gateway.on("change", () => {
      void this.persistSecrets()
      this.changed.fire()
    })
  }

  get storageDir(): string {
    return this.context.globalStorageUri.fsPath
  }

  /** Vendored muse2api sources inside the installed extension. */
  get vendorDir(): string {
    return path.join(this.context.extensionPath, "vendor", "muse2api")
  }

  get state(): GatewayState {
    return this.gateway.info.state
  }

  get info(): GatewayInfo {
    return this.gateway.info
  }

  /** URL clients should use: the shim when it is on, otherwise the gateway. */
  get clientBaseUrl(): string {
    if (this.settings.shim.enabled && this.shimBaseUrl) return this.shimBaseUrl
    return this.info.baseUrl
  }

  get apiKey(): string | undefined {
    return this.gateway.effectiveKey
  }

  get adminKey(): string | undefined {
    return this.gateway.adminKey
  }

  refreshSettings(): void {
    this.settings = readSettings()
  }

  /** Client for the gateway admin API. */
  adminClient(): GatewayClient | undefined {
    const baseUrl = this.info.baseUrl
    if (!baseUrl) return undefined
    return new GatewayClient(baseUrl, this.adminKey)
  }

  /** Client for /v1/* (through the shim is not needed for direct calls). */
  v1Client(): GatewayClient | undefined {
    const baseUrl = this.info.baseUrl
    if (!baseUrl) return undefined
    return new GatewayClient(baseUrl, this.apiKey)
  }

  async restore(): Promise<void> {
    const secrets = this.context.secrets
    const [apiKey, clientKey, clientKeyId, baseUrl] = await Promise.all([
      secrets.get(SECRET_API_KEY),
      secrets.get(SECRET_CLIENT_KEY),
      secrets.get(SECRET_CLIENT_KEY_ID),
      secrets.get(SECRET_BASE_URL),
    ])
    this.gateway.restoreSecrets({ apiKey, clientKey, clientKeyId, baseUrl })
    // A stored URL from a previous session may be stale. Drop it unless a
    // gateway actually answers, otherwise every stale request wastes a timeout.
    if (baseUrl) {
      try {
        const health = await new GatewayClient(baseUrl, undefined).health()
        if (!health.ok) this.gateway.clearRestoredBaseUrl()
      } catch {
        this.gateway.clearRestoredBaseUrl()
      }
    }
  }

  private async persistSecrets(): Promise<void> {
    const secrets = this.context.secrets
    const info = this.info
    const writes: Array<Promise<void>> = []
    const setOrDelete = (key: string, value: string | undefined): Promise<void> =>
      Promise.resolve(value ? secrets.store(key, value) : secrets.delete(key))
    writes.push(setOrDelete(SECRET_API_KEY, info.apiKey))
    writes.push(setOrDelete(SECRET_CLIENT_KEY, info.clientKey))
    writes.push(setOrDelete(SECRET_CLIENT_KEY_ID, info.clientKeyId))
    writes.push(setOrDelete(SECRET_BASE_URL, info.baseUrl || undefined))
    await Promise.all(writes)
  }

  get setupDone(): boolean {
    return Boolean(this.context.globalState.get<boolean>(STATE_SETUP_DONE))
  }

  async markSetupDone(): Promise<void> {
    await this.context.globalState.update(STATE_SETUP_DONE, true)
  }

  /** Ensure the Python venv exists and muse2api is installed. */
  async setup(options: { silent?: boolean } = {}): Promise<void> {
    const progress = options.silent
      ? undefined
      : await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t("cmd.installing"), cancellable: false },
          async () => this.gateway.setup(this.runner),
        )
    if (!progress) await this.gateway.setup(this.runner)
    await this.markSetupDone()
  }

  async start(options: { silent?: boolean } = {}): Promise<GatewayInfo> {
    const run = async () => {
      const info = await this.gateway.start(this.runner)
      await this.startShim()
      await this.refreshModelsAndAccounts()
      return info
    }
    if (options.silent) return run()
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("cmd.starting"), cancellable: false },
      run,
    )
  }

  async stop(): Promise<void> {
    await this.stopShim()
    await this.gateway.stop()
    this.changed.fire()
  }

  async restart(): Promise<GatewayInfo> {
    await this.stop()
    return this.start()
  }

  private async startShim(): Promise<void> {
    const settings = this.settings.shim
    const target = this.info.baseUrl
    if (!settings.enabled || !target) {
      await this.stopShim()
      return
    }
    try {
      if (!this.shim) {
        this.shim = new ShimServer({
          host: this.settings.gateway.host,
          port: settings.port,
          autoPort: settings.autoPort,
          target,
          apiKey: () => this.gateway.effectiveKey,
          maxToolResultChars: settings.maxToolResultChars,
          timeoutSeconds: settings.timeoutSeconds,
          logger: this.logger,
          onRequest: (request) => {
            this.requestCount++
            this.logger.debug?.(
              `shim ${request.path} -> ${request.status} in ${request.ms}ms (tool calls: ${request.toolCalls})`,
            )
          },
        })
      } else {
        this.shim.setTarget(target)
      }
      this.shimBaseUrl = await this.shim.start()
      this.logger.info(t("shim.on", { url: this.shimBaseUrl }))
    } catch (error) {
      this.shimBaseUrl = ""
      this.logger.error(t("shim.error", { message: errorMessage(error) }))
      vscode.window.showWarningMessage(t("shim.error", { message: errorMessage(error) }))
    }
    this.changed.fire()
  }

  private async stopShim(): Promise<void> {
    if (this.shim) {
      await this.shim.stop()
      this.shim = undefined
    }
    this.shimBaseUrl = ""
  }

  async refreshModelsAndAccounts(): Promise<void> {
    const client = this.adminClient()
    if (!client) {
      this.models = []
      this.accounts = []
      return
    }
    try {
      this.models = await client.withKey(this.apiKey).models()
    } catch (error) {
      this.logger.warn(`Could not read /v1/models: ${errorMessage(error)}`)
    }
    try {
      this.accounts = await client.accounts()
    } catch (error) {
      this.logger.debug?.(`Could not read /admin/accounts: ${errorMessage(error)}`)
    }
    this.changed.fire()
  }

  /** Chat models only, used for pickers. */
  get chatModels(): GatewayModel[] {
    const chat = this.models.filter((model) => model.kind !== "image" && model.kind !== "video")
    return chat.length > 0 ? chat : this.models
  }

  dispose(): void {
    void this.stopShim()
    void this.gateway.stop()
    this.output.dispose()
    this.changed.dispose()
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}
