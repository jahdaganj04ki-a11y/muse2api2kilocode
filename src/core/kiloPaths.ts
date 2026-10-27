import * as os from "os"
import * as path from "path"

/**
 * Where Kilo Code keeps its configuration.
 *
 * Mirrors `packages/kilo-vscode/src/kilo-provider/config-file.ts` of Kilo Code 7.x:
 * the extension and the CLI read the same files, the XDG config dir first.
 */
export interface KiloEnv {
  XDG_CONFIG_HOME?: string
  XDG_DATA_HOME?: string
  KILO_CONFIG?: string
  KILO_CONFIG_DIR?: string
  HOME?: string
}

const CONFIG_SCHEMA = "https://app.kilo.ai/config.json"
const MODERN = ["kilo.jsonc", "kilo.json"]
const LEGACY = ["opencode.jsonc", "opencode.json"]
const GLOBAL_NAMES = [...MODERN, ...LEGACY, "config.json"]
const HOME_DIRS = [".kilo", ".kilocode", ".opencode"]

export { CONFIG_SCHEMA }

export function configRoot(env: KiloEnv = process.env, home = os.homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "kilo")
}

export function dataRoot(env: KiloEnv = process.env, home = os.homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim()
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "kilo")
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    if (local) return path.join(local, "kilo")
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "kilo")
  return path.join(home, ".local", "share", "kilo")
}

/** Kilo Code's credential store (`<data>/auth.json`). */
export function authFile(env: KiloEnv = process.env, home = os.homedir()): string {
  return path.join(dataRoot(env, home), "auth.json")
}

/**
 * Global config candidates in Kilo Code's own precedence order.
 * The last entry is the file that gets created when none exists yet.
 */
export function globalConfigCandidates(env: KiloEnv = process.env, home = os.homedir()): string[] {
  const candidates: string[] = []
  if (env.KILO_CONFIG?.trim()) candidates.push(env.KILO_CONFIG.trim())
  const root = configRoot(env, home)
  for (const name of GLOBAL_NAMES) candidates.push(path.join(root, name))
  for (const dir of HOME_DIRS) {
    for (const name of [...MODERN, ...LEGACY]) candidates.push(path.join(home, dir, name))
  }
  if (env.KILO_CONFIG_DIR?.trim()) {
    for (const name of [...MODERN, ...LEGACY]) candidates.push(path.join(env.KILO_CONFIG_DIR.trim(), name))
  }
  return dedupe(candidates)
}

/** File to write to: the first existing candidate, else the recommended XDG path. */
export function pickGlobalConfigFile(
  exists: (file: string) => boolean,
  env: KiloEnv = process.env,
  home = os.homedir(),
): string {
  const candidates = globalConfigCandidates(env, home)
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return path.join(configRoot(env, home), "kilo.jsonc")
}

/** Workspace config: `<root>/.kilo/kilo.jsonc`, the recommended project location. */
export function workspaceConfigFile(root: string): string {
  return path.join(root, ".kilo", "kilo.jsonc")
}

export function existingWorkspaceConfig(root: string, exists: (file: string) => boolean): string | undefined {
  const dirs = [path.join(root, ".kilo"), root, path.join(root, ".kilocode"), path.join(root, ".opencode")]
  for (const dir of dirs) {
    for (const name of [...MODERN, ...LEGACY]) {
      const file = path.join(dir, name)
      if (exists(file)) return file
    }
  }
  return undefined
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = path.resolve(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Empty config document used when Kilo Code has no config file yet. */
export function emptyConfigContent(): string {
  return `{\n  "$schema": "${CONFIG_SCHEMA}"\n}\n`
}
