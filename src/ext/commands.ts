import { applyEdits, modify } from "jsonc-parser"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { existsSync } from "fs"
import type { AccountInfo } from "../core/client"
import { errorMessage } from "../core/logger"
import { authFile, pickGlobalConfigFile } from "../core/kiloPaths"
import { splitAccounts } from "./cookies"
import { t } from "./i18n"
import { askScope, detectKiloCode, kiloSnippet, registerInKiloCode, unregisterFromKiloCode } from "./registration"
import type { Runtime } from "./runtime"
import { updateSetting } from "./settings"

export function registerCommands(context: vscode.ExtensionContext, runtime: Runtime, refreshUi: () => void): void {
  const command = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args)
        } catch (error) {
          runtime.logger.error(`${id} failed`, error)
          void vscode.window.showErrorMessage(errorMessage(error))
        } finally {
          refreshUi()
        }
      }),
    )

  command("muse2api.setup", async () => {
    await runtime.setup()
    const info = runtime.info
    void vscode.window.showInformationMessage(
      t("setup.done", { version: info.version ?? "?", tool: info.external ? "attached" : "venv" }),
    )
  })

  command("muse2api.start", async () => {
    const info = await runtime.start()
    if (info.state === "attached") {
      void vscode.window.showInformationMessage(t("cmd.attached", { url: info.baseUrl }))
    } else {
      void vscode.window.showInformationMessage(
        t("cmd.started", { url: runtime.clientBaseUrl || info.baseUrl, driver: info.driver }),
      )
    }
    if (info.driver === "browser" && runtime.accounts.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        t("accounts.none"),
        t("tree.action.cookies"),
        t("tree.action.dashboard"),
      )
      if (pick === t("tree.action.cookies")) await vscode.commands.executeCommand("muse2api.importCookies")
      if (pick === t("tree.action.dashboard")) await vscode.commands.executeCommand("muse2api.openDashboard")
    }
  })

  command("muse2api.stop", async () => {
    if (runtime.state === "stopped") {
      void vscode.window.showInformationMessage(t("cmd.notRunning"))
      return
    }
    await runtime.stop()
    void vscode.window.showInformationMessage(t("cmd.stopped"))
  })

  command("muse2api.restart", async () => {
    const info = await runtime.restart()
    void vscode.window.showInformationMessage(
      t("cmd.started", { url: runtime.clientBaseUrl || info.baseUrl, driver: info.driver }),
    )
  })

  command("muse2api.setDriver", async () => {
    const picks: Array<vscode.QuickPickItem & { value: "browser" | "mock" | "http" }> = [
      { label: "browser", description: t("driver.browser"), value: "browser" },
      { label: "mock", description: t("driver.mock"), value: "mock" },
      { label: "http", description: t("driver.http"), value: "http" },
    ]
    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: t("driver.pick"),
      title: t("driver.pick"),
    })
    if (!pick) return
    await updateSetting("driver", pick.value)
    runtime.refreshSettings()
    const restart = await vscode.window.showInformationMessage(
      t("driver.changed", { driver: pick.value }),
      t("restart.now"),
    )
    if (restart === t("restart.now")) await vscode.commands.executeCommand("muse2api.restart")
  })

  command("muse2api.status", async () => {
    runtime.output.show(true)
    const info = runtime.info
    const kilo = detectKiloCode()
    const lines = [
      `muse2api ${info.version ?? "?"} — ${t(`state.${info.state}`)}`,
      `Gateway:  ${info.baseUrl || "-"}`,
      `Shim:     ${runtime.shimBaseUrl || (runtime.settings.shim.enabled ? "-" : t("shim.off"))}`,
      `Client:   ${runtime.clientBaseUrl || "-"}`,
      `Driver:   ${info.driver}`,
      `Python:   ${info.external ? "external process" : runtime.storageDir}`,
      `Data:     ${runtime.gateway.dataDir}`,
      `Models:   ${runtime.models.length} (${runtime.chatModels.map((model) => model.id).join(", ") || "-"})`,
      `Accounts: ${runtime.accounts.length}`,
      `Kilo Code: ${kilo ? `${kilo.id} ${kilo.version} (${kilo.modern ? "kilo.jsonc" : "providerProfiles"})` : t("register.noKilo")}`,
      `Config:   ${pickGlobalConfigFile(existsSync)}`,
      `Auth:     ${authFile()}`,
    ]
    runtime.output.appendLine("")
    for (const line of lines) runtime.output.appendLine(line)
    runtime.output.appendLine("")
    if (info.error) runtime.output.appendLine(`ERROR: ${info.error}`)
  })

  command("muse2api.register", async () => {
    if (!runtime.info.baseUrl) {
      const start = await vscode.window.showInformationMessage(t("cmd.notRunning"), t("tree.action.start"))
      if (start !== t("tree.action.start")) return
      await runtime.start()
    }
    const scope = await askScope(runtime.settings.kilo)
    if (!scope) return
    await runtime.refreshModelsAndAccounts()
    const result = await registerInKiloCode({
      settings: runtime.settings.kilo,
      scope,
      baseUrl: runtime.clientBaseUrl || runtime.info.baseUrl,
      apiKey: runtime.apiKey,
      models: runtime.models,
      activeModel: runtime.chatModels[0]?.id,
    })
    runtime.output.appendLine(`${result.message} (${result.models.map((model) => model.id).join(", ")})`)
    runtime.output.appendLine(t("register.reload"))
    const pick = await vscode.window.showInformationMessage(result.message, t("register.reloadNow"), t("register.later"))
    if (pick === t("register.reloadNow")) await vscode.commands.executeCommand("workbench.action.reloadWindow")
  })

  command("muse2api.unregister", async () => {
    const touched = await unregisterFromKiloCode(runtime.settings.kilo)
    void vscode.window.showInformationMessage(touched.length > 0 ? t("unregister.ok") : t("unregister.none"))
    if (touched.length > 0) runtime.output.appendLine(touched.map((file) => `- ${file}`).join("\n"))
  })

  command("muse2api.useModel", async () => {
    const kilo = detectKiloCode()
    if (!kilo) {
      void vscode.window.showWarningMessage(t("register.noKilo"))
      return
    }
    const models = runtime.chatModels.length > 0 ? runtime.chatModels : [{ id: "muse-chat" }]
    const pick = await vscode.window.showQuickPick(
      models.map((model) => ({ label: model.id, description: model.alias_of ? `→ ${model.alias_of}` : model.kind })),
      { placeHolder: t("model.pick"), title: t("model.pick") },
    )
    if (!pick) return

    if (kilo.modern) {
      const file = pickGlobalConfigFile(existsSync)
      const content = (await read(file)) ?? ""
      if (!content.includes(`"${runtime.settings.kilo.providerId}"`)) {
        const run = await vscode.window.showWarningMessage(t("unregister.none"), t("tree.action.register"))
        if (run === t("tree.action.register")) await vscode.commands.executeCommand("muse2api.register")
        return
      }
      // Only the top-level "model" selection changes; the provider block stays untouched.
      const patched = applyEdits(
        content,
        modify(content, ["model"], `${runtime.settings.kilo.providerId}/${pick.label}`, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        }),
      )
      await write(file, patched)
      void vscode.window.showInformationMessage(t("model.active", { model: pick.label }))
      return
    }

    const configuration = vscode.workspace.getConfiguration("kilocode")
    const existing = configuration.get<Record<string, unknown>>("providerProfiles") ?? {}
    const configs = (existing.apiConfigs ?? {}) as Record<string, Record<string, unknown>>
    const profile = configs[runtime.settings.kilo.displayName]
    if (!profile) {
      void vscode.window.showWarningMessage(t("unregister.none"))
      return
    }
    profile.openAiModelId = pick.label
    existing.currentApiConfigName = runtime.settings.kilo.displayName
    await configuration.update("providerProfiles", existing, vscode.ConfigurationTarget.Global)
    void vscode.window.showInformationMessage(t("model.active", { model: pick.label }))
  })

  command("muse2api.openDashboard", async () => {
    const baseUrl = runtime.info.baseUrl
    if (!baseUrl) {
      void vscode.window.showWarningMessage(t("cmd.notRunning"))
      return
    }
    if (runtime.adminKey) {
      await vscode.env.clipboard.writeText(runtime.adminKey)
      void vscode.window.showInformationMessage(t("dashboard.adminKey"))
    }
    void vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/dashboard`))
    runtime.output.appendLine(t("dashboard.open", { url: `${baseUrl}/dashboard` }))
  })

  command("muse2api.importCookies", () => importCookiesFlow(runtime, false))
  command("muse2api.importCookiesFromFile", () => importCookiesFlow(runtime, true))

  command("muse2api.accounts", () => accountsFlow(runtime))

  command("muse2api.testChat", async () => {
    const client = runtime.v1Client()
    if (!client) {
      void vscode.window.showWarningMessage(t("cmd.notRunning"))
      return
    }
    const model = runtime.chatModels[0]?.id ?? "muse-chat"
    const started = Date.now()
    const reply = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("test.running", { model }), cancellable: false },
      () => client.testChat(model, "Reply with exactly: muse2api ok"),
    )
    const ms = Date.now() - started
    runtime.output.appendLine(`[test] ${model}: ${reply.text.replace(/\n/g, " ")}`)
    void vscode.window.showInformationMessage(t("test.ok", { chars: reply.text.length, ms }))
  })

  command("muse2api.generateImage", () => generateImageFlow(runtime))
  command("muse2api.generateVideo", () => generateVideoFlow(runtime))

  command("muse2api.showLogs", () => runtime.output.show(true))

  command("muse2api.openKiloConfig", async () => {
    const kilo = detectKiloCode()
    if (kilo && !kilo.modern) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:kilocode.kilo-code")
      return
    }
    const file = pickGlobalConfigFile(existsSync)
    if (!existsSync(file)) await write(file, `{\n  "$schema": "https://app.kilo.ai/config.json"\n}\n`)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    await vscode.window.showTextDocument(document)
  })

  command("muse2api.openDataDir", async () => {
    const dir = runtime.gateway.dataDir
    await fs.mkdir(dir, { recursive: true })
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir))
  })

  command("muse2api.copyAccess", async () => {
    const baseUrl = runtime.clientBaseUrl || runtime.info.baseUrl
    const key = runtime.apiKey
    const items: Array<vscode.QuickPickItem & { action: string }> = [
      { label: t("copy.baseUrl"), description: baseUrl || "-", action: "url" },
      { label: t("copy.apiKey"), description: key ? mask(key) : t("copy.noKey"), action: "key" },
      { label: t("copy.curl"), action: "curl" },
      { label: t("copy.kiloSnippet"), action: "snippet" },
    ]
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t("copy.what"), title: t("copy.what") })
    if (!pick) return
    let value = ""
    switch (pick.action) {
      case "url":
        value = baseUrl ? `${baseUrl}/v1` : ""
        break
      case "key":
        value = key ?? ""
        break
      case "curl":
        value = [
          `curl ${baseUrl || "http://127.0.0.1:18610"}/v1/chat/completions \\`,
          `  -H "Authorization: Bearer ${key ?? "$MUSE2API_KEY"}" -H "Content-Type: application/json" \\`,
          `  -d '{"model":"muse-chat","messages":[{"role":"user","content":"Hello"}],"stream":true}'`,
        ].join("\n")
        break
      default:
        value = kiloSnippet(runtime.settings.kilo, baseUrl || "http://127.0.0.1:18611", runtime.models)
        break
    }
    if (!value) {
      void vscode.window.showWarningMessage(t("copy.noKey"))
      return
    }
    await vscode.env.clipboard.writeText(value)
    void vscode.window.showInformationMessage(t("copy.done", { what: pick.label }))
  })

  command("muse2api.help", async () => {
    const lang = vscode.env.language?.toLowerCase().startsWith("de") ? "de" : "en"
    const file = path.join(context.extensionPath, "docs", `GUIDE.${lang}.md`)
    const fallback = path.join(context.extensionPath, "docs", "GUIDE.de.md")
    const target = existsSync(file) ? file : fallback
    if (!existsSync(target)) {
      void vscode.window.showWarningMessage(`Guide not found: ${target}`)
      return
    }
    await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(target))
  })

  command("muse2api.refresh", async () => {
    runtime.refreshSettings()
    if (runtime.info.baseUrl) await runtime.refreshModelsAndAccounts()
  })

  /** Status bar click: a small menu with the most common actions. */
  command("muse2api.statusMenu", async () => {
    const running = runtime.state === "running" || runtime.state === "attached"
    type Entry = vscode.QuickPickItem & { command?: string }
    const entries: Entry[] = [
      running
        ? { label: `$(debug-stop) ${t("tree.action.stop")}`, command: "muse2api.stop" }
        : { label: `$(play) ${t("tree.action.start")}`, command: "muse2api.start" },
      { label: `$(plug) ${t("tree.action.register")}`, command: "muse2api.register" },
      { label: `$(comment-discussion) ${t("model.pick")}`, command: "muse2api.useModel" },
      { label: `$(beaker) ${t("tree.action.test")}`, command: "muse2api.testChat" },
      { label: `$(key) ${t("tree.action.cookies")}`, command: "muse2api.importCookies" },
      { label: `$(account) ${t("accounts.title")}`, command: "muse2api.accounts" },
      { label: `$(dashboard) ${t("tree.action.dashboard")}`, command: "muse2api.openDashboard" },
      { label: `$(file-media) ${t("tree.action.image")}`, command: "muse2api.generateImage" },
      { label: `$(device-camera-video) ${t("tree.action.video")}`, command: "muse2api.generateVideo" },
      { label: `$(copy) ${t("copy.what")}`, command: "muse2api.copyAccess" },
      { label: `$(settings-gear) ${t("driver.pick")}`, command: "muse2api.setDriver" },
      { label: `$(output) ${t("tree.action.logs")}`, command: "muse2api.showLogs" },
      { label: `$(info) ${t("cmd.status")}`, command: "muse2api.status" },
      { label: `$(question) ${t("tree.action.help")}`, command: "muse2api.help" },
    ]
    const pick = await vscode.window.showQuickPick(entries, {
      placeHolder: `muse.ai — ${t(`state.${runtime.state}`)}`,
    })
    if (pick?.command) await vscode.commands.executeCommand(pick.command)
  })
}

function mask(key: string): string {
  return key.length <= 12 ? "***" : `${key.slice(0, 8)}…${key.slice(-4)}`
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
}

async function importCookiesFlow(runtime: Runtime, fromFile: boolean): Promise<void> {
  const client = runtime.adminClient()
  if (!client) {
    void vscode.window.showWarningMessage(t("cmd.notRunning"))
    return
  }

  let raw = ""
  if (fromFile) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: t("cookies.file"),
      filters: { Cookies: ["json", "txt", "cookie", "cookies"] },
    })
    const file = picked?.[0]
    if (!file) return
    raw = await fs.readFile(file.fsPath, "utf8")
  } else {
    const input = await vscode.window.showInputBox({
      title: t("cookies.title"),
      prompt: t("cookies.prompt"),
      placeHolder: t("cookies.placeholder"),
      ignoreFocusOut: true,
      password: true,
      validateInput: (value) => (value.trim().length > 10 ? null : t("cookies.empty")),
    })
    if (!input) return
    raw = input
  }

  const accounts = splitAccounts(raw)
  if (accounts.length === 0) {
    void vscode.window.showErrorMessage(t("cookies.empty"))
    return
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("cookies.title"), cancellable: false },
    () => client.importAccounts(accounts),
  )
  const entries = Array.isArray(result?.data) ? (result.data as Array<Record<string, unknown>>) : []
  const failed = entries.filter((entry) => entry.ok === false)
  const okEntries = entries.filter((entry) => entry.ok !== false)

  await runtime.refreshModelsAndAccounts()

  if (okEntries.length > 0) {
    const missing = okEntries
      .map((entry) => Array.isArray(entry.missing_cookies) ? (entry.missing_cookies as string[]).join(", ") : "")
      .filter(Boolean)
    void vscode.window.showInformationMessage(
      missing.length > 0
        ? t("cookies.missing", { missing: missing[0]! })
        : t("cookies.ok", { label: String(okEntries.length) }),
    )
  }
  if (failed.length > 0) {
    void vscode.window.showErrorMessage(t("cookies.failed", { message: String(failed[0]!.error ?? "unknown") }))
  }
  runtime.output.appendLine(`[cookies] imported=${okEntries.length} failed=${failed.length}`)
}

async function accountsFlow(runtime: Runtime): Promise<void> {
  const client = runtime.adminClient()
  if (!client) {
    void vscode.window.showWarningMessage(t("cmd.notRunning"))
    return
  }
  await runtime.refreshModelsAndAccounts()
  if (runtime.accounts.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      t("accounts.none"),
      t("tree.action.cookies"),
      t("tree.action.dashboard"),
    )
    if (pick === t("tree.action.cookies")) await vscode.commands.executeCommand("muse2api.importCookies")
    if (pick === t("tree.action.dashboard")) await vscode.commands.executeCommand("muse2api.openDashboard")
    return
  }

  const items = runtime.accounts.map((account) => ({
    label: accountLabel(account),
    description: accountState(account),
    detail: accountDetail(account),
    account,
  }))
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: t("accounts.title"),
    title: t("accounts.title"),
    matchOnDescription: true,
  })
  if (!pick) return

  const actions = [
    t("accounts.quota"),
    t("accounts.renew"),
    t("accounts.reset"),
    pick.account.enabled === false ? t("accounts.enable") : t("accounts.disable"),
    t("accounts.delete"),
  ]
  const action = await vscode.window.showQuickPick(actions, {
    placeHolder: t("accounts.action", { label: pick.label }),
    title: pick.label,
  })
  if (!action) return
  const id = String(pick.account.id)

  if (action === t("accounts.quota")) {
    const quota = await client.quota(id)
    runtime.output.appendLine(`[quota] ${id}: ${JSON.stringify(quota, null, 2)}`)
    runtime.output.show(true)
    return
  }
  if (action === t("accounts.renew")) {
    const result = await client.renewAccount(id)
    runtime.output.appendLine(`[renew] ${id}: ${JSON.stringify(result)}`)
    void vscode.window.showInformationMessage(`${t("accounts.renew")}: ${JSON.stringify(result).slice(0, 200)}`)
    return
  }
  if (action === t("accounts.reset")) {
    await client.resetAccount(id)
    void vscode.window.showInformationMessage(t("accounts.reset"))
    return
  }
  if (action === t("accounts.delete")) {
    const confirm = await vscode.window.showWarningMessage(`${t("accounts.delete")}: ${pick.label}?`, { modal: true }, t("accounts.delete"))
    if (confirm !== t("accounts.delete")) return
    await client.deleteAccount(id)
    void vscode.window.showInformationMessage(t("accounts.deleted", { id }))
    return
  }
  const enabled = action === t("accounts.enable")
  await fetch(`${runtime.info.baseUrl}/admin/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${runtime.adminKey ?? ""}` },
    body: JSON.stringify({ enabled }),
  })
  await runtime.refreshModelsAndAccounts()
}

function accountLabel(account: AccountInfo): string {
  return account.label?.trim() ? account.label : account.id
}

function accountState(account: AccountInfo): string {
  const parts = [String(account.state ?? "?")]
  if (account.enabled === false) parts.push("disabled")
  return parts.join(" · ")
}

function accountDetail(account: AccountInfo): string {
  const parts: string[] = []
  if (typeof account.expires_at === "number" && account.expires_at > 0) {
    parts.push(`cookie: ${new Date(account.expires_at * 1000).toISOString().slice(0, 10)}`)
  }
  const missing = account.missing_cookies
  if (Array.isArray(missing) && missing.length > 0) parts.push(`missing: ${missing.join(", ")}`)
  return parts.join(" · ")
}

async function generateImageFlow(runtime: Runtime): Promise<void> {
  const client = runtime.v1Client()
  if (!client) {
    void vscode.window.showWarningMessage(t("cmd.notRunning"))
    return
  }
  const prompt = await vscode.window.showInputBox({
    title: t("image.prompt"),
    prompt: t("image.prompt"),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "…"),
  })
  if (!prompt) return

  const result = await Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("image.running"), cancellable: false },
    () => client.generateImage(prompt.trim()),
  )).catch((error: unknown) => {
    void vscode.window.showErrorMessage(t("image.failed", { message: errorMessage(error) }))
    return undefined
  })
  if (!result) return

  const url = firstDataUrl(result)
  runtime.output.appendLine(`[image] ${JSON.stringify(result).slice(0, 400)}`)
  if (url) {
    const target = runtime.info.baseUrl ? new URL(url, runtime.info.baseUrl).toString() : url
    void vscode.env.openExternal(vscode.Uri.parse(target))
    void vscode.window.showInformationMessage(t("image.ok"))
  } else {
    void vscode.window.showInformationMessage(t("image.ok"))
  }
}

async function generateVideoFlow(runtime: Runtime): Promise<void> {
  const client = runtime.v1Client()
  if (!client) {
    void vscode.window.showWarningMessage(t("cmd.notRunning"))
    return
  }
  const prompt = await vscode.window.showInputBox({
    title: t("video.prompt"),
    prompt: t("video.prompt"),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? null : "…"),
  })
  if (!prompt) return

  const task = await Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("video.running"), cancellable: false },
      () => client.createVideoTask(prompt.trim()),
    ))
    .catch((error: unknown) => {
      void vscode.window.showErrorMessage(t("video.failed", { message: errorMessage(error) }))
      return undefined
    })
  if (!task) return

  const id = String(task.id ?? "")
  runtime.output.appendLine(`[video] task ${id}: ${JSON.stringify(task).slice(0, 300)}`)
  void vscode.window.showInformationMessage(t("video.ok", { id }))

  const poll = await vscode.window.showInformationMessage(
    `${t("video.ok", { id })} — /v1/videos/${id}`,
    t("accounts.quota"),
  )
  if (poll === t("accounts.quota")) {
    const status = await client.task(id, "videos").catch((error: unknown) => {
      runtime.output.appendLine(`[video] poll failed: ${errorMessage(error)}`)
      return undefined
    })
    runtime.output.appendLine(`[video] ${JSON.stringify(status, null, 2)}`)
    runtime.output.show(true)
  }
}

function firstDataUrl(payload: Record<string, unknown>): string | undefined {
  const data = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : []
  for (const item of data) {
    if (typeof item?.url === "string") return item.url
  }
  if (typeof payload.url === "string") return payload.url
  if (typeof payload.result === "object" && payload.result) {
    const result = payload.result as Record<string, unknown>
    if (typeof result.url === "string") return result.url
  }
  return undefined
}
