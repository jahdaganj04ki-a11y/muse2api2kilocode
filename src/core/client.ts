import { errorMessage } from "./logger"
import type { GatewayModel } from "./kiloConfig"

export interface GatewayStatus {
  ok: boolean
  httpStatus?: number
  /** Value of the `ready` field of /readyz (false while no account is usable). */
  ready?: boolean
  driver?: string
  accounts?: number
  available?: number
  detail?: string
  raw?: Record<string, unknown>
}

export interface AccountInfo {
  id: string
  label?: string
  enabled?: boolean
  state?: string
  cookies?: string[]
  missing_cookies?: string[]
  expires_at?: number
  quota?: Record<string, unknown>
  [key: string]: unknown
}

/** Thin HTTP client for the muse2api admin/model endpoints. */
export class GatewayClient {
  constructor(
    private baseUrl: string,
    private key: string | undefined,
    private timeoutMs = 15_000,
  ) {}

  get baseUrlValue(): string {
    return this.baseUrl
  }

  withKey(key: string | undefined): GatewayClient {
    return new GatewayClient(this.baseUrl, key, this.timeoutMs)
  }

  withBaseUrl(baseUrl: string): GatewayClient {
    return new GatewayClient(baseUrl, this.key, this.timeoutMs)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json", ...extra }
    if (this.key) headers.authorization = `Bearer ${this.key}`
    return headers
  }

  private url(pathname: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${pathname}`
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.body ? Math.max(this.timeoutMs, 120_000) : this.timeoutMs)
    try {
      const response = await fetch(this.url(pathname), {
        ...init,
        headers: this.headers((init.headers as Record<string, string>) ?? {}),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${pathname}: ${text.slice(0, 400)}`)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Liveness probe without authentication. */
  async health(): Promise<GatewayStatus> {
    try {
      const response = await fetch(this.url("/healthz"), { signal: AbortSignal.timeout(3000) })
      const text = await response.text()
      if (!response.ok) return { ok: false, httpStatus: response.status, detail: text.slice(0, 200) }
      return { ok: true, httpStatus: response.status, raw: safeJson(text) }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  /** Readiness: driver state and how many accounts can serve requests.
   *  muse2api answers `{ready, driver: {...}, accounts: {total, available, ...}}`
   *  with HTTP 200 even when `ready` is false (e.g. browser driver with no account). */
  async ready(): Promise<GatewayStatus> {
    try {
      const response = await fetch(this.url("/readyz"), { signal: AbortSignal.timeout(4000) })
      const text = await response.text()
      const raw = safeJson(text)
      const driverInfo = asRecord(raw?.driver)
      const pool = asRecord(raw?.accounts)
      const ready = typeof raw?.ready === "boolean" ? raw.ready : response.ok
      return {
        ok: response.ok,
        ready,
        httpStatus: response.status,
        driver: typeof driverInfo?.driver === "string" ? driverInfo.driver : undefined,
        accounts: numberFrom(pool?.total) ?? numberFrom(raw?.accounts),
        available: numberFrom(pool?.available) ?? numberFrom(raw?.available),
        detail: ready ? undefined : text.slice(0, 300),
        raw,
      }
    } catch (error) {
      return { ok: false, detail: errorMessage(error) }
    }
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/admin/status")
  }

  async models(): Promise<GatewayModel[]> {
    const payload = await this.request<{ data?: GatewayModel[] }>("/v1/models")
    return Array.isArray(payload.data) ? payload.data : []
  }

  async accounts(): Promise<AccountInfo[]> {
    const payload = await this.request<{ data?: AccountInfo[] }>("/admin/accounts")
    return Array.isArray(payload.data) ? payload.data : []
  }

  async createKey(name: string, note = ""): Promise<{ id?: string; apiKey?: string }> {
    const payload = await this.request<{ key?: { id?: string }; api_key?: string }>("/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, note }),
    })
    return { id: payload.key?.id, apiKey: payload.api_key }
  }

  async listKeys(): Promise<Array<{ id?: string; name?: string; revoked?: boolean; prefix?: string }>> {
    const payload = await this.request<{ data?: Array<Record<string, unknown>> }>("/admin/keys")
    return (payload.data ?? []) as Array<{ id?: string; name?: string; revoked?: boolean; prefix?: string }>
  }

  /** Bulk cookie import; one bad entry does not abort the batch. */
  async importAccounts(accounts: Array<{ label?: string; cookies: unknown }>) {
    return this.request<{ data?: Array<Record<string, unknown>> }>("/admin/accounts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts }),
    })
  }

  async renewAccount(id: string) {
    return this.request<Record<string, unknown>>(`/admin/accounts/${encodeURIComponent(id)}/renew`, { method: "POST" })
  }

  async resetAccount(id: string) {
    return this.request<Record<string, unknown>>(`/admin/accounts/${encodeURIComponent(id)}/reset`, { method: "POST" })
  }

  async deleteAccount(id: string) {
    return this.request<Record<string, unknown>>(`/admin/accounts/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  async quota(id: string, refresh = false) {
    return this.request<Record<string, unknown>>(
      `/admin/accounts/${encodeURIComponent(id)}/quota${refresh ? "?refresh=1" : ""}`,
    )
  }

  /** One non-streaming chat round trip, used by the connection test. */
  async testChat(model: string, prompt: string): Promise<{ text: string; usage?: Record<string, unknown> }> {
    const payload = await this.request<{
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>
      usage?: Record<string, unknown>
      error?: { message?: string }
    }>("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (payload.error?.message) throw new Error(payload.error.message)
    const content = payload.choices?.[0]?.message?.content
    return { text: typeof content === "string" ? content : JSON.stringify(content ?? ""), usage: payload.usage }
  }

  async generateImage(prompt: string, model = "muse-image"): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, response_format: "url" }),
    })
  }

  async createVideoTask(prompt: string, model = "muse-video"): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/videos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, duration: 5, size: "16:9" }),
    })
  }

  async task(id: string, kind: "videos" | "images/generations"): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/v1/${kind}/${encodeURIComponent(id)}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
