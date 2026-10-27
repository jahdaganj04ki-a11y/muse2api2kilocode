# Changelog

## 0.1.0 (2026-10-27)

Initial release.

- Bundles muse2api v0.3.0 (upstream revision `618aeb0d`) as a vendored Python
  source tree; creates a venv and installs it on first run (`uv` or `pip`).
- Starts/stops the gateway as a child process, adopts an already running gateway,
  auto-selects a free port, and stores the API key in VS Code SecretStorage.
- Registers the muse.ai models in Kilo Code 7+ via `kilo.jsonc` + `auth.json`
  (global or workspace scope), with a legacy `kilocode.providerProfiles` path for
  pre-7 releases. JSONC comments and unrelated providers are preserved.
- Local tool-call shim: translates OpenAI `tools` into a text protocol, converts
  `<tool_use>` replies back into `tool_calls` for streaming and non-streaming
  responses, and passes all other endpoints through unchanged.
- Sidebar, status bar, cookie import (raw header / EditThisCookie JSON / bulk
  `label | cookies`), account management, connection test, image/video commands,
  dashboard, log output and config/credential copy helpers.
- Bilingual UI (German/English) via `package.nls*.json` and runtime strings.
- `npm run smoke` activates the bundled extension against a stubbed VS Code API,
  which caught a broken dynamic `require` from jsonc-parser’s UMD build.
- 57 unit tests covering the tool protocol, SSE parsing, shim, config writing,
  Kilo Code paths, Python discovery and cookie parsing.
