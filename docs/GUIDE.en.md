# Guide – Using muse.ai in Kilo Code

This guide belongs to the **muse.ai for Kilo Code (muse2api)** extension.
It covers setup, daily use, the configuration files and troubleshooting.

---

## 1. The three processes

```
Kilo Code (VS Code)
   │  POST /v1/chat/completions  (OpenAI format, incl. tools)
   ▼
Tool-call shim ── 127.0.0.1:18611 ── (this extension, Node.js)
   │  translated request without native tools
   ▼
muse2api gateway ── 127.0.0.1:18610 ── (Python/FastAPI, bundled)
   │  browser driver (Chromium + CDP)
   ▼
muse.ai web app
```

All three run on your machine. By default the gateway binds to `127.0.0.1`
only — it is not reachable from the network. The same applies to the shim.

---

## 2. First-time setup

### 2.1 Check the requirements

```bash
python3 --version      # >= 3.10
code --version         # >= 1.85
```

**Kilo Code** must be installed in VS Code
(`code --list-extensions | grep -i kilo`).

Optional: `uv --version` — when present, installation takes seconds.

### 2.2 Install the VSIX

```
Extensions → ⋯ → Install from VSIX… → muse2api-kilocode-0.1.0.vsix
Developer: Reload Window
```

### 2.3 Setup assistant

On first start a notification appears:

- **“Set it up now”** — creates the venv, installs muse2api and starts the gateway.
- **“Try the demo driver (mock)”** — the same with `MUSE2API_DRIVER=mock`.
  Ideal for testing Kilo Code → shim → gateway without a muse.ai account.
  The model replies with `[mock:muse-chat] You said: …`.
- **“Later”** — you can always run `muse.ai: Set up the Python environment`
  and `muse.ai: Start gateway`.

The venv lives at:

| Platform | Path |
|---|---|
| Linux | `~/.config/Code/User/globalStorage/muse-ai-tools.muse2api-kilocode/venv` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/.../venv` |
| Windows | `%APPDATA%\Code\User\globalStorage\...\venv` |

The data folder (accounts, keys, media, browser profile) is next to it in
`data/`. Use `muse2api.dataDir` to move it, e.g. into your home directory.

---

## 3. Importing muse.ai cookies

The browser driver needs a valid muse.ai session. Required:

- `hatch_sess`
- `hatch_native_auth_device`

Optional but recommended: `hatch_gw`, `hatch_vml` and all `__Host-` cookies.

### Option A: cookie-import extension (recommended)

1. `muse.ai: Open dashboard in browser` (the admin key is copied automatically).
2. In the dashboard go to **Accounts** → **Tải extension** (download extension) —
   served from `/admin/extension.zip`.
3. Unzip, open `chrome://extensions`, enable Developer mode → **Load unpacked**.
4. Sign in to muse.ai, open the extension popup, enter the gateway URL
   (`http://127.0.0.1:18610`) and the admin key, then import.

### Option B: paste manually

1. DevTools (F12) → **Network** → any `muse.ai` request → **Headers** → copy the
   `cookie` request header.
2. `muse.ai: Import muse.ai cookies (paste)` → paste → optionally enter a label.

Supported formats:

```
hatch_sess=abc; hatch_native_auth_device=xyz
```

```
acc1 | hatch_sess=abc; hatch_native_auth_device=xyz
acc2 | {"hatch_sess":"def","hatch_native_auth_device":"uvw"}
```

```json
[{"name":"hatch_sess","value":"abc","expirationDate":1900000000}, …]
```

Multiple accounts = one line per account; muse2api then spreads the load over
its account pool (`muse2api.poolStrategy`).

> Cookies are credentials. They are stored only locally in `data/accounts.json`
> and are never sent to anyone except muse.ai itself.

---

## 4. Registering in Kilo Code

`muse.ai: Register models in Kilo Code` → **Global** or **This workspace only**.

### Global (recommended)

The extension searches in the same order as Kilo Code itself:

1. `$KILO_CONFIG`
2. `$XDG_CONFIG_HOME/kilo/` or `~/.config/kilo/`
   – `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, `config.json`
3. `~/.kilo/`, `~/.kilocode/`, `~/.opencode/`
4. `$KILO_CONFIG_DIR/`

If nothing exists, `~/.config/kilo/kilo.jsonc` is created.

### Workspace

`<project>/.kilo/kilo.jsonc` (or an existing project config). Useful when you
only want muse.ai in one repository. Note: project config overrides global
settings — `model` and `provider` are merged.

### What gets written

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "provider": {
    "muse2api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "muse.ai (muse2api)",
      "options": { "baseURL": "http://127.0.0.1:18611/v1" },
      "models": {
        "muse-chat": {
          "name": "muse.ai Chat (muse-chat)",
          "tool_call": true,
          "temperature": false,
          "reasoning": false,
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  }
}
```

Plus `~/.local/share/kilo/auth.json` (mode 0600):

```json
{ "muse2api": { "type": "api", "key": "m2a-…" } }
```

This is exactly what Kilo Code's *Custom provider* dialog writes. Existing
providers, comments and other settings are preserved (`jsonc-parser`).

### Older Kilo Code releases (< 7)

There a profile is written to VS Code settings under
`kilocode.providerProfiles` (`apiProvider: "openai"`, `openAiBaseUrl`, …).
The extension detects the installed version automatically.

**Reload the window** after registering. The models then appear in the model
picker. `muse.ai: Set model as the active Kilo Code model` sets the top-level
`model` in kilo.jsonc.

---

## 5. Daily use

- **Status bar** bottom left: click to open the action menu.
  `$(pass-filled) muse.ai` = running, `$(circle-slash)` = stopped, `$(error)` = error.
- **Sidebar** (muse.ai icon): status, URLs, driver, version, Kilo Code,
  models, accounts and quick actions.
- **Images/videos**: `muse.ai: Generate image (muse-image)` opens the result in
  your browser. Videos create an async task (`/v1/videos`) whose status is
  written to the log. Both need the browser driver and an active account.
- **Accounts**: `muse.ai: Manage accounts` shows state, quota and cookie expiry.
  “Renew session” calls `/admin/accounts/{id}/renew`.
- **Auto start**: `muse2api.autoStart: true` starts the gateway with VS Code.

---

## 6. Tool calls / agent modes

Kilo Code expects OpenAI function calling from a model. muse.ai does not offer
it. The shim bridges the gap:

**Request** (Kilo Code → shim):

```json
{"model":"muse-chat","messages":[…],
 "tools":[{"type":"function","function":{"name":"read_file", …}}],
 "stream":true}
```

**Forwarded** (shim → gateway): `tools` removed, replaced by a system message:

```
# Tool calling
You act inside an AI coding assistant (Kilo Code) …
<tool_use>
{"name": "tool_name", "arguments": {"argument": "value"}}
</tool_use>
…
<tools>{"name":"read_file", …}</tools>
```

**Response** (model → shim → Kilo Code):

```
I'll read the file.
<tool_use>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</tool_use>
```

becomes SSE chunks with `delta.tool_calls` and `finish_reason: "tool_calls"`.
The tool result comes back in the next request as a `<tool_result>` message.

### Tips

- **`muse2api.kilocode.declareToolCalls`** defaults to `true` so Kilo Code sends
  tools to the shim in agent modes. If you disable the shim, set it to `false` —
  otherwise Kilo Code will try tool calls against the bare gateway.
- `muse2api.shim.maxToolResultChars` (default 8000) limits large file contents.
- For odd tool calls check the log (`muse.ai: Show gateway log`) — the shim logs
  count and duration.
- The shim is pure passthrough: if you disable it, **register again** so the base
  URL points at port 18610 instead of 18611.

---

## 7. Configuration reference (excerpt)

| Key | Default | Purpose |
|---|---|---|
| `muse2api.driver` | `browser` | `browser` \| `mock` \| `http` |
| `muse2api.host` / `.port` | `127.0.0.1` / `18610` | Gateway address |
| `muse2api.autoPort` | `true` | pick the next free port |
| `muse2api.shim.enabled` / `.port` | `true` / `18611` | Tool shim |
| `muse2api.shim.timeoutSeconds` | `600` | Request timeout |
| `muse2api.accountConcurrency` | `4` | parallel tabs per account |
| `muse2api.poolStrategy` | `affinity` | account scheduling |
| `muse2api.streamHeartbeat` | `0` | SSE keepalive (seconds) |
| `muse2api.chromiumPath` | `""` | path to Chrome/Chromium |
| `muse2api.headless` | `true` | invisible browser |
| `muse2api.kilocode.includeAliases` | `false` | `gpt-4o`, `dall-e-3`, … |
| `muse2api.kilocode.includeNonChatModels` | `false` | image/video in picker |
| `muse2api.kilocode.setAsActiveModel` | `false` | set `model` automatically |
| `muse2api.kilocode.writeKeyToAuthStore` | `true` | write `auth.json` |
| `muse2api.env` | `{}` | e.g. `{"CHAT_TIMEOUT":"600"}` |

`muse2api.env` accepts keys with or without the `MUSE2API_` prefix.

---

## 8. Troubleshooting

### Gateway does not start

Open `muse.ai: Show gateway log`. Typical causes:

- Python < 3.10 → set `muse2api.pythonPath` to a valid interpreter.
- No `pip` in the venv → `python3 -m ensurepip --upgrade` or install `uv`.
- Port in use → change `muse2api.port` (or let `autoPort` handle it).
- Behind a proxy → `muse2api.env`: `{"BROWSER_PROXY":"http://…"}`.

### Kilo Code: “Invalid API Key” / 401

Run `muse.ai: Register models in Kilo Code` again. The key is generated/read on
each gateway start and written to `auth.json`. Check it with
`muse.ai: Copy credentials → API key`.

### Kilo Code: “Connection refused” / 502

The gateway is not running. `muse.ai: Start gateway`. Otherwise the shim reports
`gateway_unreachable` with a clear hint.

### “no account available” / `readyz: ready=false`

Cookies are missing or expired. `muse.ai: Manage accounts` → check state,
renew the session or re-import cookies.

### Chromium problems

- Linux: install `chromium` or `google-chrome`; set `muse2api.chromiumPath` if needed.
- Containers/WSL: keep `muse2api.headless: true` (default) and configure extra
  flags via `muse2api.env` (see upstream docs).
- Images/videos need a running VM — muse2api confirms the wake automatically.

### Models missing after registering

1. `Developer: Reload Window`
2. `muse.ai: Open Kilo Code configuration` — is the `provider.muse2api` block there?
3. Kilo Code → Settings → Providers: does “muse.ai (muse2api)” appear?
4. `muse.ai: Show status` lists the paths actually used.

### Reset everything

`muse.ai: Remove registration from Kilo Code`, then `muse.ai: Stop gateway`,
delete the data folder via `muse.ai: Open data folder` (removes accounts & keys),
then set it up again.

---

## 9. Security & privacy

- Gateway and shim bind to `127.0.0.1` only.
- The API key is kept in VS Code SecretStorage and Kilo Code's `auth.json`
  (file mode 0600).
- Cookies are stored unencrypted in `data/accounts.json` — protect your user
  account and do not put `dataDir` in a synced/git directory.
- The extension sends no telemetry. The gateway logs requests locally in
  `data/requests.db` (retention `MUSE2API_REQUEST_LOG_RETENTION_DAYS`, default 14).
- **Legal:** this project is for learning and research. Automated use of muse.ai
  may violate its terms of service. Check before using it. No warranty.

---

## 10. Handy debug commands

```bash
# Gateway endpoints directly
curl http://127.0.0.1:18610/healthz
curl http://127.0.0.1:18610/readyz
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18610/v1/models
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18610/admin/accounts

# Shim
curl http://127.0.0.1:18611/shim/healthz

# Chat (non-streaming)
curl http://127.0.0.1:18611/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-chat","messages":[{"role":"user","content":"Hello"}]}'
```

More details: [muse2api README](../vendor/muse2api/README.md) and the
[upstream ARCHITECTURE.md](https://github.com/www222fff/muse2api/blob/main/docs/ARCHITECTURE.md).
