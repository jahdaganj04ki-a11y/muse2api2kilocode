import * as vscode from "vscode"
import { errorMessage } from "./core/logger"
import { registerCommands } from "./ext/commands"
import { setLanguage, t } from "./ext/i18n"
import { detectKiloCode } from "./ext/registration"
import { Runtime } from "./ext/runtime"
import { onSettingsChange, updateSetting } from "./ext/settings"
import { StatusBar } from "./ext/statusbar"
import { GatewayTreeProvider } from "./ext/tree"

let runtime: Runtime | undefined
let firstRunAsked = false

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setLanguage(vscode.env.language)

  const instance = new Runtime(context)
  runtime = instance
  await instance.restore()

  const tree = new GatewayTreeProvider(instance)
  const statusBar = new StatusBar(instance)
  statusBar.show()

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("muse2api.gateway", tree),
    tree,
    statusBar,
    onSettingsChange(() => {
      instance.refreshSettings()
      tree.refresh()
    }),
    { dispose: () => setLanguage(vscode.env.language) },
  )

  registerCommands(context, instance, () => tree.refresh())

  const kilo = detectKiloCode()
  instance.logger.info(
    `muse.ai extension activated (Kilo Code: ${kilo ? `${kilo.id} ${kilo.version}` : "not installed"})`,
  )

  // Show models/accounts of a gateway that is already running (other window, external start).
  await instance.refreshModelsAndAccounts().catch(() => undefined)

  if (instance.settings.autoStart && instance.state === "stopped") {
    void instance.start({ silent: true }).catch((error) => instance.logger.error("auto start failed", error))
    return
  }

  if (!instance.setupDone && !firstRunAsked) {
    firstRunAsked = true
    void firstRunPrompt(instance)
    return
  }

  if (!kilo && !firstRunAsked) {
    firstRunAsked = true
    const pick = await vscode.window.showWarningMessage(t("register.noKilo"), t("register.installKilo"))
    if (pick === t("register.installKilo")) {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code"),
      )
    }
  }
}

async function firstRunPrompt(instance: Runtime): Promise<void> {
  const setup = t("firstRun.setup")
  const demo = t("firstRun.mock")
  const pick = await vscode.window.showInformationMessage(
    t("firstRun.title"),
    { modal: false, detail: t("firstRun.detail") },
    setup,
    demo,
    t("firstRun.later"),
  )
  try {
    if (pick === demo) {
      await updateSetting("driver", "mock")
      instance.refreshSettings()
      await instance.start()
      await vscode.commands.executeCommand("muse2api.register")
      return
    }
    if (pick === setup) {
      await instance.setup()
      await instance.start()
      await vscode.commands.executeCommand("muse2api.register")
    }
  } catch (error) {
    instance.logger.error("first run setup failed", error)
    void vscode.window.showErrorMessage(t("err.setupFailed", { message: errorMessage(error) }))
  }
}

export async function deactivate(): Promise<void> {
  const instance = runtime
  runtime = undefined
  if (!instance) return
  await instance.stop().catch(() => undefined)
  instance.dispose()
}
