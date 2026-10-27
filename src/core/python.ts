import * as path from "path"

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Injected process runner so interpreter discovery can be unit tested. */
export type Runner = (command: string, args: string[], cwd?: string) => Promise<RunResult>

export interface Interpreter {
  command: string
  args: string[]
  /** Absolute path from sys.executable (used by `uv venv --python`). */
  executable: string
  version: string
  /** "3.11" style major.minor, used in messages. */
  shortVersion: string
}

export const MIN_PYTHON = { major: 3, minor: 10 }

/** Interpreter candidates, best first. `py` launchers only make sense on Windows. */
export function interpreterCandidates(configured?: string): Array<{ command: string; args: string[]; label: string }> {
  const candidates: Array<{ command: string; args: string[]; label: string }> = []
  if (configured && configured.trim()) {
    const value = configured.trim()
    const parts = value.split(/\s+/)
    candidates.push({ command: parts[0]!, args: parts.slice(1), label: value })
  }
  candidates.push({ command: "python3", args: [], label: "python3" })
  candidates.push({ command: "python", args: [], label: "python" })
  if (process.platform === "win32") {
    for (const minor of [13, 12, 11, 10]) {
      candidates.push({ command: "py", args: [`-3.${minor}`], label: `py -3.${minor}` })
    }
    candidates.push({ command: "py", args: ["-3"], label: "py -3" })
  } else {
    for (const name of ["python3.13", "python3.12", "python3.11", "python3.10"]) {
      candidates.push({ command: name, args: [], label: name })
    }
    const extras = [
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      path.join(process.env.HOME ?? "", ".pyenv", "shims", "python3"),
    ]
    for (const file of extras) {
      if (file) candidates.push({ command: file, args: [], label: file })
    }
  }
  return candidates
}

const VERSION_SNIPPET = [
  "import sys",
  "print('%d.%d.%d' % sys.version_info[:3])",
  "print(sys.executable)",
].join(";")

export function parseVersion(stdout: string): { major: number; minor: number; patch: number } | undefined {
  const match = stdout.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return undefined
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
  }
}

export function versionSatisfies(version: string, min = MIN_PYTHON): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  if (parsed.major !== min.major) return parsed.major > min.major
  return parsed.minor >= min.minor
}

/** First candidate that exists and is new enough (muse2api needs Python >= 3.10). */
export async function findInterpreter(run: Runner, configured?: string): Promise<Interpreter | undefined> {
  for (const candidate of interpreterCandidates(configured)) {
    let result: RunResult
    try {
      result = await run(candidate.command, [...candidate.args, "-c", VERSION_SNIPPET])
    } catch {
      continue
    }
    if (result.code !== 0) continue
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const version = lines[0] ?? ""
    if (!versionSatisfies(version)) continue
    const parsed = parseVersion(version)!
    return {
      command: candidate.command,
      args: candidate.args,
      executable: lines.at(-1) || candidate.command,
      version,
      shortVersion: `${parsed.major}.${parsed.minor}`,
    }
  }
  return undefined
}

/** `uv` speeds the install up a lot when it is present. */
export async function findUv(run: Runner): Promise<string | undefined> {
  try {
    const result = await run("uv", ["--version"])
    if (result.code === 0 && result.stdout.includes("uv")) return "uv"
  } catch {
    /* not installed */
  }
  return undefined
}

/** Relative path of the venv interpreter. */
export function venvPythonPath(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python")
}
