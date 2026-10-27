/**
 * Activation smoke test for the built bundle.
 *
 * Stubs the `vscode` module, loads dist/extension.js, activates it and calls a
 * few harmless commands. This catches two classes of bugs that a unit test
 * cannot see: unresolved dynamic requires inside the bundle (jsonc-parser's UMD
 * wrapper used to break here) and wrong VS Code API usage during activation.
 *
 * Run with: npm run smoke
 */
const Module = require("node:module")
const path = require("node:path")
const os = require("node:os")
const fs = require("node:fs")
const { EventEmitter } = require("node:events")

class Disposable {
  constructor(fn) {
    this.fn = fn
  }
  dispose() {
    this.fn?.()
  }
}

class VscodeEventEmitter extends EventEmitter {
  constructor() {
    super()
    this.event = (listener) => {
      this.on("change", listener)
      return new Disposable(() => this.off("change", listener))
    }
  }
  fire(value) {
    this.emit("change", value)
  }
  dispose() {
    this.removeAllListeners()
  }
}

class TreeItem {
  constructor(label, state) {
    this.label = label
    this.collapsibleState = state
  }
}
class ThemeIcon {
  constructor(id) {
    this.id = id
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id
  }
}
class MarkdownString {
  constructor(value) {
    this.value = value
  }
}

const Uri = {
  file: (filePath) => ({ fsPath: filePath, scheme: "file", toString: () => `file://${filePath}` }),
  parse: (value) => ({ toString: () => value, fsPath: value }),
}

const outputLines = []
const commands = new Map()
const settings = new Map()

const vscode = {
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => outputLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: () => new Disposable(),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => ({}),
    withProgress: async (_options, task) => task(),
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => (settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback),
      update: async (key, value) => settings.set(`${section}.${key}`, value),
    }),
    workspaceFolders: [{ uri: Uri.file(path.join(os.tmpdir(), "workspace")), name: "workspace" }],
    onDidChangeConfiguration: () => new Disposable(),
    openTextDocument: async (uri) => uri,
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler)
      return new Disposable(() => commands.delete(id))
    },
    executeCommand: async (id, ...args) => commands.get(id)?.(...args),
  },
  extensions: {
    getExtension: (id) => (id === "kilocode.kilo-code" ? { packageJSON: { version: "7.8.18" } } : undefined),
  },
  env: {
    language: "de",
    clipboard: { writeText: async () => {} },
    openExternal: async () => true,
  },
  EventEmitter: VscodeEventEmitter,
  Disposable,
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Uri,
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode
  return originalLoad.call(this, request, parent, isMain)
}

const root = path.resolve(__dirname, "..")
const bundle = path.join(root, "dist", "extension.js")
if (!fs.existsSync(bundle)) {
  console.error("dist/extension.js is missing — run `npm run compile` first.")
  process.exit(1)
}

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "muse2api-smoke-"))
const context = {
  extensionPath: root,
  globalStorageUri: Uri.file(storage),
  subscriptions: [],
  secrets: {
    data: new Map(),
    async get(key) {
      return this.data.get(key)
    },
    async store(key, value) {
      this.data.set(key, value)
    },
    async delete(key) {
      this.data.delete(key)
    },
  },
  globalState: {
    data: new Map(),
    get(key) {
      return this.data.get(key)
    },
    async update(key, value) {
      this.data.set(key, value)
    },
  },
}

const EXPECTED_COMMANDS = [
  "muse2api.setup",
  "muse2api.start",
  "muse2api.stop",
  "muse2api.restart",
  "muse2api.status",
  "muse2api.register",
  "muse2api.unregister",
  "muse2api.useModel",
  "muse2api.openDashboard",
  "muse2api.importCookies",
  "muse2api.importCookiesFromFile",
  "muse2api.accounts",
  "muse2api.testChat",
  "muse2api.showLogs",
  "muse2api.openKiloConfig",
  "muse2api.openDataDir",
  "muse2api.copyAccess",
  "muse2api.help",
  "muse2api.refresh",
  "muse2api.setDriver",
  "muse2api.generateImage",
  "muse2api.generateVideo",
  "muse2api.statusMenu",
]

async function main() {
  const extension = require(bundle)
  if (typeof extension.activate !== "function" || typeof extension.deactivate !== "function") {
    throw new Error("extension must export activate() and deactivate()")
  }
  await extension.activate(context)

  const missing = EXPECTED_COMMANDS.filter((id) => !commands.has(id))
  if (missing.length > 0) throw new Error(`commands not registered: ${missing.join(", ")}`)

  await commands.get("muse2api.status")()
  await commands.get("muse2api.refresh")()
  await commands.get("muse2api.showLogs")()
  await extension.deactivate(context)

  fs.rmSync(storage, { recursive: true, force: true })
  console.log(`Smoke test OK — activated, ${EXPECTED_COMMANDS.length} commands registered, deactivated.`)
  console.log(outputLines.slice(0, 4).join("\n"))
}

main().catch((error) => {
  console.error("Smoke test FAILED:", error)
  process.exit(1)
})
