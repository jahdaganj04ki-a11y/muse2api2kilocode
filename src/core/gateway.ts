import { spawn, type ChildProcess } from "child_process"
import { EventEmitter } from "events"
import * as fs from "fs/promises"
import * as path from "path"
import { GatewayClient } from "./client"
import { ensureEnvironment, type EnvironmentInfo } from "./env"
import { errorMessage, type Logger } from "./logger"
import { pickPort, portIsFree } from "./ports"

export type GatewayState = "stopped" | "installing" | "starting" | "running" | "attached" | "error"

export interface GatewaySettings {
  driver: "browser" | "mock" | "http"
  host: string
  port: number
  autoPort: boolean
  logLevel: string
  dataDir: string
  apiKey: string
  adminKey: string
  chromiumPath: string
  headless: boolean
  accountConcurrency: number
  poolStrategy: string
  streamHeartbeat: number
  extraEnv: Record<string, string>
}

export interface GatewayOptions {
  storageDir: string
  vendorDir: string
  pythonPath?: string
  useUv?: boolean
  settings: GatewaySettings
  logger: Logger
}

export interface GatewayInfo {
  state: GatewayState
  baseUrl: string
  port: number
  driver: string
  apiKey?: string
  clientKey?: string
  clientKeyId?: string
  external?: boolean
  version?: string
  error?: string
  accounts?: number
  available?: number
}

export interface RunnerResult {
  code: number | null
  stdout: string
  stderr: string
}

export type Runner = (command: string, args: string[], cwd?: string) => Promise<RunnerResult>

const START_TIMEOUT_MS = 180_000

/** Owns the muse2api child process: install, start, health, stop. */
export class GatewayManager extends EventEmitter {
  private child: ChildProcess | undefined
  private state: GatewayState = "stopped"
  private baseUrl = ""
  private port = 0
  private external = false
  private apiKey: string | undefined
  private clientKey: string | undefined
  private clientKeyId: string | undefined
  private lastError: string | undefined
  private environment: EnvironmentInfo | undefined
  private starting: Promise<GatewayInfo> | undefined
  private accountCount: number | undefined
  private availableCount: number | undefined

  constructor(private readonly options: GatewayOptions) {
    super()
  }

  get info(): GatewayInfo {
    return {
      state: this.state,
      baseUrl: this.baseUrl,
      port: this.port,
      driver: this.options.settings.driver,
      apiKey: this.apiKey,
      clientKey: this.clientKey,
      clientKeyId: this.clientKeyId,
      external: this.external,
      version: this.environment?.version,
      error: this.lastError,
      accounts: this.accountCount,
      available: this.availableCount,
    }
  }

  /** Key used for /v1/* calls: the dedicated client key when we could create one. */
  get effectiveKey(): string | undefined {
    return this.clientKey ?? this.apiKey ?? (this.options.settings.apiKey || undefined)
  }

  get adminKey(): string | undefined {
    return this.options.settings.adminKey || this.apiKey
  }

  client(): GatewayClient | undefined {
    if (!this.baseUrl) return undefined
    return new GatewayClient(this.baseUrl, this.adminKey)
  }

  private setState(state: GatewayState, error?: string) {
    this.state = state
    if (error !== undefined) this.lastError = error
    if (state !== "error") this.lastError = undefined
    this.emit("change", this.info)
  }

  /** Install the Python environment without starting the server. */
  async setup(run: Runner): Promise<EnvironmentInfo> {
    const previous = this.state
    this.setState("installing")
    try {
      const environment = await ensureEnvironment({
        storageDir: this.options.storageDir,
        vendorDir: this.options.vendorDir,
        configuredPython: this.options.pythonPath,
        useUv: this.options.useUv,
        run,
        report: (stage, detail) => this.options.logger.info(`[setup] ${stage}${detail ? `: ${detail}` : ""}`),
        log: (line) => this.options.logger.info(`[setup] ${line}`),
      })
      this.environment = environment
      // Keep "running"/"attached" when setup is invoked while the server is up.
      this.setState(previous === "running" || previous === "attached" ? previous : "stopped")
      return environment
    } catch (error) {
      this.setState(previous === "running" || previous === "attached" ? previous : "error", errorMessage(error))
      throw error
    }
  }

  async start(run: Runner): Promise<GatewayInfo> {
    if (this.starting) return this.starting
    this.starting = this.startInternal(run).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async startInternal(run: Runner): Promise<GatewayInfo> {
    const settings = this.options.settings
    if (this.state === "running" || this.state === "attached") {
      const health = await new GatewayClient(this.baseUrl, this.adminKey).health()
      if (health.ok) return this.info
      this.options.logger.warn("Gateway was marked running but does not answer; restarting.")
    }

    // Somebody else may already run a gateway on the configured port: adopt it.
    const configuredFree = await portIsFree(settings.host, settings.port)
    if (!configuredFree) {
      const probe = new GatewayClient(`http://${settings.host}:${settings.port}`, settings.apiKey || undefined)
      const health = await probe.health()
      if (health.ok) {
        this.external = true
        this.baseUrl = `http://${settings.host}:${settings.port}`
        this.port = settings.port
        this.setState("attached")
        this.options.logger.info(`Attached to an already running gateway at ${this.baseUrl}`)
        await this.afterStart()
        return this.info
      }
    }

    const environment = this.environment ?? (await this.setup(run))
    this.environment = environment

    const port = await pickPort(settings.host, configuredFree ? settings.port : settings.port + 1, settings.autoPort)
    const dataDir = settings.dataDir?.trim() ? path.resolve(settings.dataDir.trim()) : path.join(this.options.storageDir, "data")
    await fs.mkdir(dataDir, { recursive: true })

    const env: Record<string, string> = {
      ...stripUndefined(process.env) as Record<string, string>,
      MUSE2API_HOST: settings.host,
      MUSE2API_PORT: String(port),
      MUSE2API_DRIVER: settings.driver,
      MUSE2API_LOG_LEVEL: settings.logLevel,
      MUSE2API_DATA_DIR: dataDir,
      MUSE2API_POOL_STRATEGY: settings.poolStrategy,
      MUSE2API_ACCOUNT_MAX_CONCURRENCY: String(settings.accountConcurrency),
      MUSE2API_HEADLESS: settings.headless ? "true" : "false",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    }
    if (settings.chromiumPath?.trim()) env.MUSE2API_CHROMIUM_PATH = settings.chromiumPath.trim()
    if (settings.apiKey?.trim()) env.MUSE2API_API_KEY = settings.apiKey.trim()
    if (settings.adminKey?.trim()) env.MUSE2API_ADMIN_KEY = settings.adminKey.trim()
    if (settings.streamHeartbeat > 0) env.MUSE2API_STREAM_HEARTBEAT_INTERVAL = String(settings.streamHeartbeat)
    for (const [key, value] of Object.entries(settings.extraEnv ?? {})) {
      if (!key) continue
      env[key.startsWith("MUSE2API_") ? key : `MUSE2API_${key}`] = String(value)
    }

    this.setState("starting")
    this.options.logger.info(`Starting muse2api ${environment.version} (driver=${settings.driver}) on ${settings.host}:${port}`)

    const child = spawn(environment.python, ["-m", "muse2api"], {
      cwd: dataDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    this.child = child
    this.external = false
    this.baseUrl = `http://${settings.host}:${port}`
    this.port = port

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.forward(chunk, false))
    child.stderr?.on("data", (chunk: string) => this.forward(chunk, true))
    child.once("exit", (code, signal) => {
      this.options.logger.warn(`muse2api exited (code=${code ?? "null"} signal=${signal ?? "none"})`)
      if (this.child === child) {
        this.child = undefined
        if (this.state === "running") this.setState("stopped")
        else if (this.state !== "stopped") this.setState("error", `Gateway exited with code ${code ?? signal}`)
      }
    })
    child.once("error", (error) => {
      this.options.logger.error("Failed to spawn muse2api", error)
      this.setState("error", errorMessage(error))
    })

    await this.waitForHealth(dataDir)
    this.setState("running")
    await this.afterStart()
    return this.info
  }

  private forward(chunk: string, isError: boolean) {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (isError) this.options.logger.warn(`[gateway] ${line}`)
      else this.options.logger.info(`[gateway] ${line}`)
    }
  }

  private async waitForHealth(dataDir: string) {
    const client = new GatewayClient(this.baseUrl, this.options.settings.apiKey || undefined)
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastDetail = ""
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`Gateway exited during startup (code ${this.child.exitCode}). ${lastDetail}`)
      }
      const health = await client.health()
      if (health.ok) {
        const ready = await client.ready()
        this.accountCount = ready.accounts
        this.availableCount = ready.available
        if (ready.ok) {
          // The HTTP API is up. `ready: false` is normal for the browser driver
          // before any account/cookies have been imported.
          if (ready.ready === false) {
            this.options.logger.warn(`Gateway is up but not ready yet: ${ready.detail ?? "no available account"}`)
          }
          return
        }
        lastDetail = ready.detail ?? ""
      } else {
        lastDetail = health.detail ?? ""
      }
      await sleep(600)
    }
    // Not ready (e.g. browser driver without accounts) is not fatal: the API is up.
    const health = await client.health()
    if (!health.ok) {
      throw new Error(`Gateway did not become healthy within ${START_TIMEOUT_MS / 1000}s. ${lastDetail}`)
    }
    this.options.logger.warn(`Gateway is up but not ready: ${lastDetail || "no available account"}`)
    await this.readKeyFile(dataDir)
  }

  private async afterStart() {
    const dataDir = this.options.settings.dataDir?.trim()
      ? path.resolve(this.options.settings.dataDir.trim())
      : path.join(this.options.storageDir, "data")
    if (!this.apiKey) await this.readKeyFile(dataDir)
    await this.ensureClientKey()
    this.emit("change", this.info)
  }

  private async readKeyFile(dataDir: string) {
    if (this.options.settings.apiKey?.trim()) {
      this.apiKey = this.options.settings.apiKey.trim()
      return
    }
    try {
      const key = (await fs.readFile(path.join(dataDir, "api_key"), "utf8")).trim()
      if (key) this.apiKey = key
    } catch {
      this.options.logger.debug?.("No api_key file yet")
    }
  }

  /** Create a labelled, revocable key for Kilo Code instead of reusing the master key. */
  private async ensureClientKey() {
    const client = new GatewayClient(this.baseUrl, this.adminKey)
    try {
      const keys = await client.listKeys()
      const existing = keys.find((key) => key.name === "Kilo Code" && !key.revoked)
      if (existing && this.clientKey) return
      if (existing?.id && !this.clientKeyId) {
        // The plaintext of an existing key is gone; create a fresh one.
        this.clientKeyId = undefined
      }
      const created = await client.createKey("Kilo Code", "Created by the muse.ai VS Code extension")
      if (created.apiKey) {
        this.clientKey = created.apiKey
        this.clientKeyId = created.id
        this.options.logger.info(`Created gateway client key ${created.id ?? ""}`.trim())
      }
    } catch (error) {
      this.options.logger.warn(`Could not create a client key (${errorMessage(error)}); using the master key.`)
    }
  }

  /** Restore key material from a previous session (SecretStorage). */
  restoreSecrets(secrets: { apiKey?: string; clientKey?: string; clientKeyId?: string; baseUrl?: string }) {
    if (secrets.apiKey) this.apiKey = secrets.apiKey
    if (secrets.clientKey) this.clientKey = secrets.clientKey
    if (secrets.clientKeyId) this.clientKeyId = secrets.clientKeyId
    if (secrets.baseUrl && !this.baseUrl) {
      this.baseUrl = secrets.baseUrl
      const port = Number.parseInt(secrets.baseUrl.split(":").pop() ?? "", 10)
      if (Number.isFinite(port)) this.port = port
    }
  }

  async stop(): Promise<void> {
    if (this.external) {
      this.options.logger.info("Detached from the external gateway (it keeps running).")
      this.external = false
      this.setState("stopped")
      return
    }
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) {
      this.setState("stopped")
      return
    }
    await terminate(child)
    this.setState("stopped")
  }

  async restart(run: Runner): Promise<GatewayInfo> {
    await this.stop()
    await sleep(400)
    return this.start(run)
  }

  /** Forget a URL restored from SecretStorage when nothing is listening there. */
  clearRestoredBaseUrl() {
    if (this.child || this.state === "running" || this.state === "attached") return
    this.baseUrl = ""
    this.port = 0
    this.emit("change", this.info)
  }

  /** Refresh driver/account numbers from /readyz. */
  async refresh(): Promise<GatewayInfo> {
    if (!this.baseUrl) return this.info
    const client = new GatewayClient(this.baseUrl, this.adminKey)
    const ready = await client.ready()
    if (ready.ok) {
      this.accountCount = ready.accounts
      this.availableCount = ready.available
      this.emit("ready", ready)
      this.emit("change", this.info)
    } else if (this.state === "running" || this.state === "attached") {
      this.setState("error", ready.detail ?? "Gateway unreachable")
    }
    return this.info
  }

  get dataDir(): string {
    return this.options.settings.dataDir?.trim()
      ? path.resolve(this.options.settings.dataDir.trim())
      : path.join(this.options.storageDir, "data")
  }
}

function stripUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) out[key] = value
  return out
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminate(child: ChildProcess) {
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    setTimeout(() => resolve(), 6000)
  })
  try {
    if (process.platform === "win32") {
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
    } else if (child.pid) {
      // The gateway was spawned detached, so signal the whole group (Chromium included).
      process.kill(-child.pid, "SIGTERM")
    } else {
      child.kill("SIGTERM")
    }
  } catch (error) {
    child.kill("SIGTERM")
    void error
  }
  await exited
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  }
}
