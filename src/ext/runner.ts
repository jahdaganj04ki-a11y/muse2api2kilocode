import { execFile } from "child_process"
import type { RunnerResult, Runner } from "../core/gateway"

/** Process runner used for interpreter discovery, venv creation and pip/uv installs. */
export function createRunner(timeoutMs = 900_000): Runner {
  return (command: string, args: string[], cwd?: string): Promise<RunnerResult> =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          timeout: timeoutMs,
          env: process.env,
        },
        (error, stdout, stderr) => {
          const code =
            error === null || error === undefined
              ? 0
              : typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === "number"
                ? ((error as unknown as { code: number }).code ?? 1)
                : 1
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
        },
      )
    })
}
