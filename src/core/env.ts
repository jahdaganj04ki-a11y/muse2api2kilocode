import * as fs from "fs/promises"
import * as path from "path"
import { findInterpreter, findUv, venvPythonPath, type Interpreter, type Runner } from "./python"

export interface EnvironmentOptions {
  /** Where the venv lives (extension global storage). */
  storageDir: string
  /** Vendored muse2api sources shipped inside the VSIX. */
  vendorDir: string
  configuredPython?: string
  /** Prefer `uv` when it is on PATH. */
  useUv?: boolean
  run: Runner
  report?(stage: string, detail?: string): void
  log?(line: string): void
}

export interface EnvironmentInfo {
  python: string
  interpreter: Interpreter
  tool: "uv" | "venv"
  version: string
  venvDir: string
  reinstalled: boolean
}

interface InstallMarker {
  version?: string
  revision?: string
  tool?: string
  python?: string
  at?: string
}

async function readJson(file: string): Promise<InstallMarker | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as InstallMarker
  } catch {
    return undefined
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

export async function vendoredVersion(vendorDir: string): Promise<{ version: string; revision: string }> {
  const pyproject = (await readText(path.join(vendorDir, "pyproject.toml"))) ?? ""
  const version = pyproject.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown"
  const revision = ((await readText(path.join(vendorDir, "UPSTREAM_REVISION.txt"))) ?? "").trim()
  return { version, revision }
}

/** Verify that the venv can import muse2api and report its version. */
export async function probeInstall(python: string, run: Runner): Promise<string | undefined> {
  try {
    const result = await run(python, ["-c", "import muse2api;print(muse2api.__version__)"])
    if (result.code !== 0) return undefined
    return result.stdout.trim().split(/\r?\n/).pop()?.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Create the venv and install the vendored muse2api into it.
 * Skips work when the marker file and the import check agree with the vendored version.
 */
export async function ensureEnvironment(options: EnvironmentOptions): Promise<EnvironmentInfo> {
  const { storageDir, vendorDir, run, report, log } = options
  const venvDir = path.join(storageDir, "venv")
  const markerFile = path.join(storageDir, "install.json")
  const vendored = await vendoredVersion(vendorDir)

  await fs.mkdir(storageDir, { recursive: true })
  const interpreter = await findInterpreter(run, options.configuredPython)
  if (!interpreter) {
    throw new Error(
      "No Python >= 3.10 found. Install Python 3.10+ or set muse2api.pythonPath.",
    )
  }

  let python = venvPythonPath(venvDir)
  const existing = await probeInstall(python, run)
  const marker = await readJson(markerFile)
  if (
    existing === vendored.version &&
    marker?.version === vendored.version &&
    marker?.revision === vendored.revision
  ) {
    report?.("ready", `muse2api ${existing}`)
    return { python, interpreter, tool: marker?.tool === "uv" ? "uv" : "venv", version: existing, venvDir, reinstalled: false }
  }

  const uv = options.useUv === false ? undefined : await findUv(run)
  const tool = uv ? "uv" : "venv"
  report?.("venv", `${tool} -> ${venvDir}`)

  if (uv) {
    await runOrThrow(run, uv, ["venv", "--python", interpreter.executable, venvDir], log)
    await runOrThrow(run, uv, ["pip", "install", "--python", python, "--quiet", vendorDir], log, 900_000)
  } else {
    await runOrThrow(run, interpreter.command, [...interpreter.args, "-m", "venv", venvDir], log, 300_000)
    await runOrThrow(
      run,
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--quiet", vendorDir],
      log,
      900_000,
    )
  }

  const installed = await probeInstall(python, run)
  if (!installed) {
    throw new Error(`muse2api could not be imported from ${venvDir}. Check the output log for the pip/uv error.`)
  }
  const nextMarker: InstallMarker = {
    version: installed,
    revision: vendored.revision,
    tool,
    python: `${interpreter.command} ${interpreter.args.join(" ")}`.trim(),
    at: new Date().toISOString(),
  }
  await fs.writeFile(markerFile, `${JSON.stringify(nextMarker, null, 2)}\n`, "utf8")
  report?.("ready", `muse2api ${installed}`)
  return { python, interpreter, tool, version: installed, venvDir, reinstalled: true }
}

async function runOrThrow(
  run: Runner,
  command: string,
  args: string[],
  log?: (line: string) => void,
  timeoutMs = 300_000,
): Promise<string> {
  log?.(`$ ${command} ${args.join(" ")}`)
  const result = await withTimeout(run(command, args), timeoutMs, `${command} ${args.join(" ")}`)
  if (result.stdout) log?.(result.stdout.trimEnd())
  if (result.stderr) log?.(result.stderr.trimEnd())
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-6).join("\n")
    throw new Error(`"${command} ${args.join(" ")}" failed (exit ${result.code}).\n${detail}`)
  }
  return result.stdout
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
