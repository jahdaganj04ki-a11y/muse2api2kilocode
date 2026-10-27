export interface CookieAccount {
  label?: string
  cookies: unknown
}

/**
 * Parse cookies from the formats muse2api accepts:
 * - a raw `Cookie` header string (one account per line, optionally `label | cookies`)
 * - an EditThisCookie JSON array of cookie objects
 * - a cookie dict, a single account object, or a list of account objects
 *
 * Kept free of the vscode API so it can be unit tested.
 */
export function splitAccounts(raw: string): CookieAccount[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        // Either a list of cookie objects (one account) or a list of accounts.
        const looksLikeCookies = parsed.every(
          (item) => item && typeof item === "object" && "name" in (item as Record<string, unknown>),
        )
        if (looksLikeCookies) return [{ cookies: parsed }]
        const accounts: CookieAccount[] = []
        for (const item of parsed) {
          const record = item as Record<string, unknown> | null
          if (record && typeof record === "object" && record.cookies) {
            accounts.push({ label: String(record.label ?? ""), cookies: record.cookies })
          }
        }
        if (accounts.length > 0) return accounts
        return [{ cookies: parsed }]
      }
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>
        if (record.cookies) return [{ label: String(record.label ?? ""), cookies: record.cookies }]
        return [{ cookies: record }]
      }
    } catch {
      /* fall through to the line-based parser */
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  if (lines.length === 0) return []

  return lines.map((line) => {
    const separator = line.indexOf("|")
    if (separator > 0 && separator < line.length - 1) {
      return { label: line.slice(0, separator).trim(), cookies: line.slice(separator + 1).trim() }
    }
    return { cookies: line.replace(/^cookie:\s*/i, "") }
  })
}
