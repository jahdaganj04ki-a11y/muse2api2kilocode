import * as vscode from "vscode"
import type { GatewayModel } from "../core/kiloConfig"
import { t } from "./i18n"
import { detectKiloCode } from "./registration"
import type { Runtime } from "./runtime"

type NodeKind =
  | "status"
  | "url"
  | "shim"
  | "driver"
  | "version"
  | "python"
  | "kilo"
  | "modelsHeader"
  | "model"
  | "accountsHeader"
  | "account"
  | "actionsHeader"
  | "action"

interface Node {
  kind: NodeKind
  id: string
  label: string
  description?: string
  tooltip?: string
  icon?: string
  command?: string
  contextValue?: string
  children?: Node[]
}

class Item extends vscode.TreeItem {
  constructor(readonly node: Node) {
    super(node.label, node.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
    this.description = node.description
    this.tooltip = node.tooltip ?? (node.description ? `${node.label}: ${node.description}` : node.label)
    this.contextValue = node.contextValue
    if (node.icon) this.iconPath = new vscode.ThemeIcon(node.icon)
    if (node.command) {
      this.command = { command: node.command, title: node.label }
    }
  }
}

export class GatewayTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly runtime: Runtime) {
    runtime.onChanged(() => this.refresh())
  }

  refresh(): void {
    this.emitter.fire(undefined)
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return new Item(element)
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element) return element.children ?? []

    const info = this.runtime.info
    const settings = this.runtime.settings
    const stateLabel = t(`state.${info.state}`)
    const stateIcon =
      info.state === "running" || info.state === "attached"
        ? "pass-filled"
        : info.state === "error"
          ? "error"
          : info.state === "stopped"
            ? "circle-slash"
            : "sync~spin"

    const kilo = detectKiloCode()
    const nodes: Node[] = [
      {
        kind: "status",
        id: "status",
        label: t("tree.status", { state: stateLabel }),
        icon: stateIcon,
        contextValue: "muse2api.status",
        command: "muse2api.status",
        tooltip: info.error ?? undefined,
      },
      {
        kind: "url",
        id: "url",
        label: t("tree.url", { url: info.baseUrl || "-" }),
        icon: "server",
        contextValue: "muse2api.url",
        command: "muse2api.openDashboard",
      },
      {
        kind: "shim",
        id: "shim",
        label: t("tree.shim", {
          url: settings.shim.enabled ? this.runtime.shimBaseUrl || t("state.stopped") : t("shim.off"),
        }),
        icon: settings.shim.enabled ? "plug" : "debug-disconnect",
        contextValue: "muse2api.shim",
        command: "muse2api.copyAccess",
        tooltip: t("shim.on", { url: this.runtime.shimBaseUrl || "-" }),
      },
      {
        kind: "driver",
        id: "driver",
        label: t("tree.driver", { driver: info.driver }),
        icon: "settings-gear",
        contextValue: "muse2api.driver",
        command: "muse2api.setDriver",
      },
      {
        kind: "version",
        id: "version",
        label: t("tree.version", { version: info.version ?? "?" }),
        icon: "package",
        contextValue: "muse2api.version",
        command: "muse2api.setup",
        tooltip: `${this.runtime.vendorDir}`,
      },
      {
        kind: "kilo",
        id: "kilo",
        label: t("tree.kilo", {
          info: kilo ? `${kilo.version} ${kilo.modern ? "(kilo.jsonc)" : "(settings)"}` : t("register.noKilo"),
        }),
        icon: kilo ? "check" : "warning",
        contextValue: "muse2api.action.register",
        command: "muse2api.register",
      },
    ]

    nodes.push({
      kind: "modelsHeader",
      id: "modelsHeader",
      label: t("tree.models", { count: this.runtime.models.length }),
      icon: "symbol-class",
      contextValue: "muse2api.models",
      children: modelNodes(this.runtime.models),
    })

    nodes.push({
      kind: "accountsHeader",
      id: "accountsHeader",
      label: t("tree.accounts", { count: this.runtime.accounts.length }),
      icon: "organization",
      contextValue: "muse2api.accounts",
      command: this.runtime.accounts.length > 0 ? "muse2api.accounts" : "muse2api.importCookies",
      children: accountNodes(this.runtime),
    })

    nodes.push({
      kind: "actionsHeader",
      id: "actionsHeader",
      label: t("tree.actions"),
      icon: "run-all",
      children: actionNodes(info.state === "running" || info.state === "attached"),
    })

    return nodes
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

function modelNodes(models: GatewayModel[]): Node[] {
  return models.map((model) => ({
    kind: "model" as NodeKind,
    id: `model-${model.id}`,
    label: model.id,
    description: model.alias_of ? `→ ${model.alias_of}` : model.kind ?? "chat",
    icon: model.kind === "image" ? "file-media" : model.kind === "video" ? "device-camera-video" : "comment-discussion",
    contextValue: model.kind === "image" || model.kind === "video" ? "muse2api.model.media" : "muse2api.model.chat",
    command:
      model.kind === "image"
        ? "muse2api.generateImage"
        : model.kind === "video"
          ? "muse2api.generateVideo"
          : "muse2api.useModel",
  }))
}

function accountNodes(runtime: Runtime): Node[] {
  return runtime.accounts.map((account) => ({
    kind: "account" as NodeKind,
    id: `account-${account.id}`,
    label: account.label?.trim() ? String(account.label) : String(account.id),
    description: `${String(account.state ?? "?")}${account.enabled === false ? " · disabled" : ""}`,
    icon: account.enabled === false ? "circle-slash" : "account",
    contextValue: "muse2api.account",
    command: "muse2api.accounts",
  }))
}

function actionNodes(running: boolean): Node[] {
  const nodes: Node[] = running
    ? [
        {
          kind: "action",
          id: "action-stop",
          label: t("tree.action.stop"),
          icon: "debug-stop",
          contextValue: "muse2api.action",
          command: "muse2api.stop",
        },
      ]
    : [
        {
          kind: "action",
          id: "action-start",
          label: t("tree.action.start"),
          icon: "play",
          contextValue: "muse2api.action",
          command: "muse2api.start",
        },
      ]

  nodes.push(
    {
      kind: "action",
      id: "action-register",
      label: t("tree.action.register"),
      icon: "plug",
      contextValue: "muse2api.action.register",
      command: "muse2api.register",
    },
    {
      kind: "action",
      id: "action-cookies",
      label: t("tree.action.cookies"),
      icon: "key",
      contextValue: "muse2api.action",
      command: "muse2api.importCookies",
    },
    {
      kind: "action",
      id: "action-test",
      label: t("tree.action.test"),
      icon: "beaker",
      contextValue: "muse2api.action.test",
      command: "muse2api.testChat",
    },
    {
      kind: "action",
      id: "action-dashboard",
      label: t("tree.action.dashboard"),
      icon: "dashboard",
      contextValue: "muse2api.action",
      command: "muse2api.openDashboard",
    },
    {
      kind: "action",
      id: "action-image",
      label: t("tree.action.image"),
      icon: "file-media",
      contextValue: "muse2api.action",
      command: "muse2api.generateImage",
    },
    {
      kind: "action",
      id: "action-video",
      label: t("tree.action.video"),
      icon: "device-camera-video",
      contextValue: "muse2api.action",
      command: "muse2api.generateVideo",
    },
    {
      kind: "action",
      id: "action-logs",
      label: t("tree.action.logs"),
      icon: "output",
      contextValue: "muse2api.action",
      command: "muse2api.showLogs",
    },
    {
      kind: "action",
      id: "action-help",
      label: t("tree.action.help"),
      icon: "question",
      contextValue: "muse2api.action",
      command: "muse2api.help",
    },
  )
  return nodes
}
