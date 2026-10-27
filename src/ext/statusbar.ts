import * as vscode from "vscode"
import { t } from "./i18n"
import type { Runtime } from "./runtime"

/** Status bar item that mirrors the gateway state and opens the action menu. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private disposable: vscode.Disposable | undefined

  constructor(private readonly runtime: Runtime) {
    this.item = vscode.window.createStatusBarItem("muse2api.gateway", vscode.StatusBarAlignment.Left, -100)
    this.item.name = "muse.ai"
    this.item.command = "muse2api.statusMenu"
    this.render()
    this.disposable = runtime.onChanged(() => this.render())
  }

  show(): void {
    this.item.show()
  }

  private render(): void {
    const info = this.runtime.info
    const state = t(`state.${info.state}`)
    switch (info.state) {
      case "running":
      case "attached":
        this.item.text = `$(pass-filled) muse.ai`
        this.item.backgroundColor = undefined
        break
      case "starting":
      case "installing":
        this.item.text = `$(sync~spin) muse.ai`
        this.item.backgroundColor = undefined
        break
      case "error":
        this.item.text = `$(error) muse.ai`
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
        break
      default:
        this.item.text = `$(circle-slash) muse.ai`
        this.item.backgroundColor = undefined
    }
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**muse.ai / muse2api** — ${state}`,
        info.baseUrl ? `- Gateway: \`${info.baseUrl}\`` : undefined,
        this.runtime.shimBaseUrl ? `- Shim: \`${this.runtime.shimBaseUrl}\`` : undefined,
        `- Driver: \`${info.driver}\``,
        info.version ? `- muse2api ${info.version}` : undefined,
        info.error ? `- Fehler: ${info.error}` : undefined,
        "",
        t("status.tooltip", { state, driver: info.driver, url: info.baseUrl || "-" }),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    this.item.show()
  }

  dispose(): void {
    this.disposable?.dispose()
    this.item.dispose()
  }
}
