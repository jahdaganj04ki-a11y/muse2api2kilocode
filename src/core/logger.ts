/** Minimal logging contract so core modules stay free of the vscode API. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
  debug?(message: string): void
}

export const nullLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
