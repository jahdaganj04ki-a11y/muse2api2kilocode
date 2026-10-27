# muse.ai for Kilo Code (muse2api)

**Deutsche Fassung: [README.md](README.md)**

A VS Code extension (`.vsix`) that runs the OpenAI-compatible
[www222fff/muse2api](https://github.com/www222fff/muse2api) gateway locally and
registers the muse.ai models (`muse-chat`, `muse-image`, `muse-video`) as an
**OpenAI-compatible provider in Kilo Code**.

muse2api is bundled with the extension (pinned revision `618aeb0d`, v0.3.0) —
nothing needs to be cloned separately.

---

## What it does

1. **Python environment** — creates a venv in the extension's global storage on
   first run and installs the bundled muse2api into it (`uv` when available, else `pip`).
2. **Gateway** — starts `python -m muse2api` on `127.0.0.1:18610` (loopback only).
3. **Tool-call shim** — a local proxy on `127.0.0.1:18611` that translates Kilo
   Code's `tools` into a text protocol and turns the model's `<tool_use>` replies
   back into OpenAI `tool_calls` (streaming and non-streaming). This makes Kilo
   Code's agent modes (Code/Build) work even though muse.ai has no native
   function calling.
4. **Registration** — writes the provider block into Kilo Code's `kilo.jsonc`
   (globally `~/.config/kilo/` or workspace `.kilo/kilo.jsonc`) and the API key
   into `auth.json` — exactly like Kilo Code's own *Custom provider* dialog.
   Older Kilo Code releases (< 7) get a `kilocode.providerProfiles` profile instead.

Also included: a sidebar with status/models/accounts, a status bar item, cookie
import, account management (quota, session renewal), dashboard link, image/video
generation, a connection test and an output log.

> **Note:** This is an unofficial integration. It drives muse.ai through its web
> UI (browser driver). Please respect the [muse.ai terms of service](https://muse.ai/) —
> the upstream project is intended for learning and research only. Never share
> your cookies. Cookies are stored only locally in the extension's data folder.

---

## Requirements

| | |
|---|---|
| Editor | VS Code >= 1.85 (or compatible forks) |
| Extension | **Kilo Code** (`kilocode.kilo-code`) installed |
| Python | >= 3.10 on `PATH` (or set `muse2api.pythonPath`) |
| For real models | A signed-in [muse.ai](https://muse.ai/) account + Chrome/Chromium |
| Optional | `uv` on `PATH` (much faster install) |

For a quick try the `mock` driver is enough — no account, no browser, no network.

---

## Installation

```bash
# Build the VSIX from the repo (or download it from the Releases tab)
npm install
npm run package
code --install-extension muse2api-kilocode-0.1.0.vsix
```

Or in VS Code: **Extensions → ⋯ → Install from VSIX…**, then reload the window
(`Developer: Reload Window`).

---

## Quick start

On first start the extension offers to set everything up:

1. **“Set it up now”** — installs the Python environment and starts the gateway.
   (“Try the demo driver” does the same with `mock`.)
2. **Import cookies** — run `muse.ai: Import muse.ai cookies (paste)` from the
   command palette. At least `hatch_sess` and `hatch_native_auth_device` are
   required. Easiest: use the cookie-import extension from the gateway dashboard
   (`/admin/extension.zip`), or copy the `cookie` request header from DevTools.
3. **Register** — `muse.ai: Register models in Kilo Code`. You are asked whether
   to register **globally** (all projects) or **in this workspace only**.
4. **Reload window** — Kilo Code reads its config at startup.
5. **Pick a model** — select `muse.ai Chat (muse-chat)` in Kilo Code's model
   picker, or run `muse.ai: Set model as the active Kilo Code model`.

The gateway must be running while you use the models
(status bar: `$(pass-filled) muse.ai`).

---

## Commands (command palette: “muse.ai”)

| Command | Purpose |
|---|---|
| Start / stop / restart gateway | Lifecycle of the Python process |
| Set up Python environment | (Re-)create the venv and install muse2api |
| Register models in Kilo Code | Write provider + key to kilo.jsonc / auth.json |
| Remove registration | Delete the provider block and key again |
| Switch driver | `browser` / `mock` / `http` |
| Import cookies / from file | Create accounts (also multiple `label \| cookies` lines) |
| Manage accounts | Quota, renew session, enable/disable, delete |
| Test connection | One chat request to `muse-chat` |
| Generate image / video | Use `muse-image` / `muse-video` directly |
| Open dashboard | muse2api web dashboard |
| Show gateway log | Output channel with gateway and shim logs |
| Copy credentials | Base URL, key, cURL example or kilo.jsonc snippet |
| Show status | All relevant paths and versions |
| Open guide | [GUIDE.en.md](docs/GUIDE.en.md) / [GUIDE.de.md](docs/GUIDE.de.md) |

---

## Key settings

| Setting | Default | Meaning |
|---|---|---|
| `muse2api.driver` | `browser` | `browser` (real), `mock` (demo), `http` (still 501) |
| `muse2api.port` | `18610` | Gateway port |
| `muse2api.shim.port` | `18611` | Shim port = base URL for Kilo Code |
| `muse2api.shim.enabled` | `true` | Tool-call emulation; without it only Ask/chat mode |
| `muse2api.pythonPath` | `""` | Fixed interpreter path |
| `muse2api.autoStart` | `false` | Start the gateway with VS Code |
| `muse2api.kilocode.scope` | `global` | Default when registering (you are still asked) |
| `muse2api.kilocode.providerId` | `muse2api` | Provider id in kilo.jsonc |
| `muse2api.kilocode.contextWindow` | `128000` | Context window Kilo Code assumes |
| `muse2api.kilocode.declareToolCalls` | `true` | Declare `tool_call: true` (set `false` when the shim is off) |
| `muse2api.kilocode.includeAliases` | `false` | Also register `gpt-4o`, `claude-sonnet-4`, … |
| `muse2api.dataDir` | `""` | Data folder; empty = extension storage |
| `muse2api.env` | `{}` | Extra `MUSE2API_*` variables |

All settings are documented in the VS Code settings UI (bilingual).

---

## How the tool-call shim works

Kilo Code sends OpenAI `tools` (e.g. `read_file`, `execute_command`) in the
`/v1/chat/completions` body. The shim:

- removes `tools`/`tool_choice` from the request and appends a system message
  containing the tool list and a JSON protocol instead;
- converts earlier `assistant.tool_calls` and `tool` results into `<tool_use>`
  and `<tool_result>` text;
- incrementally parses the model's SSE stream and emits proper OpenAI
  `tool_calls` deltas (`finish_reason: "tool_calls"`);
- passes everything else (`/v1/models`, images, videos, admin, media) through unchanged.

**Limits:** muse.ai is a chat model, not a purpose-trained coding agent. Tool
calls work “best effort” — review suggestions before accepting changes. The
prompt is generic; very large tool schemas are truncated. You can disable the
shim at any time (`muse2api.shim.enabled: false`) — Kilo Code then uses the
direct gateway URL and only Ask/chat modes work.

---

## Build & development

```bash
npm install          # dependencies
npm run typecheck    # TypeScript check
npm test             # 57 unit tests + activation smoke test of the bundle
npm run compile      # dist/extension.js (esbuild)
npm run smoke        # activate the bundle against a stubbed VS Code API
npm run package      # .vsix via @vscode/vsce
```

The Python gateway is installed from `vendor/muse2api/` into a venv on first
start. The pinned revision is recorded in
`vendor/muse2api/UPSTREAM_REVISION.txt`. To update, copy `src/muse2api` from
upstream and adjust that file — the extension detects the change via
`install.json` and reinstalls.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| “No Python >= 3.10 found” | Install Python or set `muse2api.pythonPath`; check the log |
| Gateway does not start | `muse.ai: Show gateway log`; port conflict via `muse2api.port` |
| `502 gateway_unreachable` in Kilo Code | Start the gateway (`muse.ai: Start gateway`) |
| Models do not appear | Reload the window; inspect `muse.ai: Open Kilo Code configuration` |
| `401 invalid or missing API key` | Run `Register models` again (rewrites `auth.json`) |
| “no account available” | Import cookies; `muse.ai: Manage accounts` |
| Images/videos hang | Browser driver needs Chromium; set `muse2api.chromiumPath` |
| Agent mode does not call tools | Is the shim on? Set `muse2api.kilocode.declareToolCalls: true` |

See [GUIDE.en.md](docs/GUIDE.en.md) for details.

---

## Credits & license

- [www222fff/muse2api](https://github.com/www222fff/muse2api) — MIT, Copyright (c) www222fff.
  Full source is bundled under `vendor/muse2api/` (including `LICENSE`).
- [Kilo Code](https://github.com/Kilo-Org/kilocode) — Apache-2.0. This is an
  independent third-party client and is not affiliated with Kilo Code.

The extension itself is [MIT licensed](LICENSE).
