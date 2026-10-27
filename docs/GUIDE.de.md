# Anleitung – muse.ai in Kilo Code nutzen

Diese Anleitung gehört zur Erweiterung **muse.ai for Kilo Code (muse2api)**.
Sie erklärt Einrichtung, Alltag, die Konfigurationsdateien und die Fehlersuche.

---

## 1. Überblick über die drei Prozesse

```
Kilo Code (VS Code)
   │  POST /v1/chat/completions  (OpenAI-Format, inkl. tools)
   ▼
Tool-Call-Shim  ── 127.0.0.1:18611 ── (nur diese Erweiterung, Node.js)
   │  übersetzter Request ohne native tools
   ▼
muse2api-Gateway ── 127.0.0.1:18610 ── (Python/FastAPI, mitgeliefert)
   │  Browser-Driver (Chromium + CDP)
   ▼
muse.ai Web-App
```

Alle drei laufen auf deinem Rechner. Das Gateway bindet standardmäßig nur an
`127.0.0.1` – es ist nicht aus dem Netz erreichbar. Der Shim ebenfalls.

---

## 2. Erste Einrichtung

### 2.1 Voraussetzungen prüfen

```bash
python3 --version      # >= 3.10
code --version         # >= 1.85
```

In VS Code muss **Kilo Code** installiert sein
(`code --list-extensions | grep -i kilo`).

Optional: `uv --version` – wenn vorhanden, dauert die Installation nur Sekunden.

### 2.2 VSIX installieren

```
Extensions → ⋯ → Install from VSIX… → muse2api-kilocode-0.1.0.vsix
Developer: Reload Window
```

### 2.3 Setup-Assistent

Beim ersten Start erscheint eine Benachrichtigung:

- **„Jetzt einrichten“** – legt das venv an, installiert muse2api und startet das Gateway.
- **„Mit Demo-Driver testen (mock)“** – identisch, aber mit `MUSE2API_DRIVER=mock`.
  Ideal, um die Kette Kilo Code → Shim → Gateway ohne muse.ai-Konto zu testen.
  Das Modell antwortet dann mit `[mock:muse-chat] You said: …`.
- **„Später“** – du kannst jederzeit `muse.ai: Python-Umgebung einrichten`
  und `muse.ai: Gateway starten` aufrufen.

Das venv liegt unter:

| Plattform | Pfad |
|---|---|
| Linux | `~/.config/Code/User/globalStorage/muse-ai-tools.muse2api-kilocode/venv` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/.../venv` |
| Windows | `%APPDATA%\Code\User\globalStorage\...\venv` |

Der Datenordner (Konten, Keys, Media, Browser-Profil) liegt daneben in `data/`.
Mit `muse2api.dataDir` kannst du ihn z. B. in deinen Home-Ordner legen.

---

## 3. muse.ai-Cookies importieren

Der Browser-Driver braucht eine gültige muse.ai-Sitzung. Mindestens erforderlich:

- `hatch_sess`
- `hatch_native_auth_device`

Optional, aber empfohlen: `hatch_gw`, `hatch_vml` sowie alle `__Host-`-Cookies.

### Variante A: Cookie-Import-Erweiterung (empfohlen)

1. `muse.ai: Dashboard im Browser öffnen` (der Admin-Key wird automatisch kopiert).
2. Im Dashboard **Accounts** → **Tải extension** (Extension herunterladen) –
   die Datei kommt von `/admin/extension.zip`.
3. Entpacken, `chrome://extensions` → Entwicklermodus → **Entpackte Erweiterung laden**.
4. In muse.ai anmelden, Extension-Popup öffnen, Gateway-URL
   (`http://127.0.0.1:18610`) und Admin-Key eintragen, importieren.

### Variante B: manuell einfügen

1. Browser-DevTools (F12) → **Network** → eine beliebige `muse.ai`-Anfrage →
   **Headers** → Request Header `cookie` kopieren.
2. `muse.ai: muse.ai-Cookies importieren (einfügen)` → einfügen → optionalen
   Kontonamen eingeben.

Unterstützte Formate:

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

Mehrere Konten = ein Zeile-pro-Konto-Import; muse2api verteilt die Last dann
über den Account-Pool (`muse2api.poolStrategy`).

> Cookies sind Zugangsdaten. Sie werden nur lokal in `data/accounts.json`
> gespeichert und niemals an Dritte gesendet (nur an muse.ai selbst).

---

## 4. In Kilo Code registrieren

`muse.ai: Modelle in Kilo Code registrieren` → **Global** oder **Nur dieses Projekt**.

### Global (empfohlen)

Die Erweiterung sucht in derselben Reihenfolge wie Kilo Code selbst:

1. `$KILO_CONFIG`
2. `$XDG_CONFIG_HOME/kilo/` bzw. `~/.config/kilo/`
   – `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, `config.json`
3. `~/.kilo/`, `~/.kilocode/`, `~/.opencode/`
4. `$KILO_CONFIG_DIR/`

Wenn nichts existiert, wird `~/.config/kilo/kilo.jsonc` neu angelegt.

### Workspace

`<Projekt>/.kilo/kilo.jsonc` (oder eine bereits vorhandene Projekt-Konfiguration).
Praktisch, wenn du muse.ai nur in einem Repo nutzen willst. Achtung: Projekt-Config
überschreibt globale Einstellungen – `model` und `provider` werden gemergt.

### Was geschrieben wird

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

Zusätzlich in `~/.local/share/kilo/auth.json` (Mode 0600):

```json
{ "muse2api": { "type": "api", "key": "m2a-…" } }
```

Das entspricht genau dem, was Kilo Codes Dialog *Custom provider* schreibt.
Bestehende Provider, Kommentare und andere Einstellungen bleiben erhalten
(JSONC-Editor von `jsonc-parser`).

### Ältere Kilo-Code-Versionen (< 7)

Dort landet ein Profil in den VS-Code-Einstellungen unter
`kilocode.providerProfiles` (`apiProvider: "openai"`, `openAiBaseUrl`, …).
Die Erweiterung erkennt die installierte Version automatisch.

Nach der Registrierung **Fenster neu laden**. Danach erscheinen die Modelle im
Modelpicker. Mit `muse.ai: Modell als aktives Kilo-Code-Modell festlegen` kannst
du das Top-Level-`model` in kilo.jsonc setzen.

---

## 5. Alltag

- **Statusleiste** unten links: Klick öffnet dasAktionsmenü.
  `$(pass-filled) muse.ai` = läuft, `$(circle-slash)` = gestoppt, `$(error)` = Fehler.
- **Seitenleiste** (muse.ai-Symbol): Status, URLs, Treiber, Version, Kilo Code,
  Modelle, Konten und Schnellaktionen.
- **Bilder/Videos**: `muse.ai: Bild erzeugen (muse-image)` öffnet das Ergebnis
  im Browser. Videos erzeugen einen asynchronen Task (`/v1/videos`), dessen Status
  im Log landet. Beides braucht den Browser-Driver und ein aktives Konto.
- **Konten**: `muse.ai: Konten verwalten` zeigt Status, Kontingent und Ablaufdatum.
  „Sitzung erneuern“ ruft `/admin/accounts/{id}/renew` auf.
- **Auto-Start**: `muse2api.autoStart: true` startet das Gateway direkt beim
  VS-Code-Start.

---

## 6. Tool-Calls / Agenten-Modi

Kilo Code erwartet von einem Modell OpenAI-Function-Calling. muse.ai bietet das
nicht. Der Shim überbrückt das:

**Request** (Kilo Code → Shim):

```json
{"model":"muse-chat","messages":[…],
 "tools":[{"type":"function","function":{"name":"read_file", …}}],
 "stream":true}
```

**Weitergeleitet** (Shim → Gateway): `tools` entfernt, stattdessen eine
System-Nachricht:

```
# Tool calling
You act inside an AI coding assistant (Kilo Code) …
<tool_use>
{"name": "tool_name", "arguments": {"argument": "value"}}
</tool_use>
…
<tools>{"name":"read_file", …}</tools>
```

**Antwort** (Modell → Shim → Kilo Code):

```
Ich lese die Datei.
<tool_use>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</tool_use>
```

wird zu SSE-Chunks mit `delta.tool_calls` und `finish_reason: "tool_calls"`.
Das Tool-Ergebnis kommt im nächsten Request als `<tool_result>`-Nachricht zurück.

### Tipps

- **`muse2api.kilocode.declareToolCalls`** ist standardmäßig `true`, damit Kilo
  Code in Agenten-Modi Tools an den Shim sendet. Wenn du den Shim abschaltest,
  setze es auf `false` – sonst versucht Kilo Code Tool-Calls gegen das nackte
  Gateway.
- `muse2api.shim.maxToolResultChars` (Standard 8000) begrenzt große Dateiinhalte.
- Bei seltsamen Tool-Aufrufen: Log prüfen (`muse.ai: Gateway-Protokoll anzeigen`)
  – der Shim protokolliert Anzahl und Dauer.
- Der Shim ist reiner Durchsatz: wenn du ihn abschaltest, musst du **neu
  registrieren**, damit die Base URL auf Port 18610 statt 18611 zeigt.

---

## 7. Konfigurationsreferenz (Auszug)

| Schlüssel | Standard | Zweck |
|---|---|---|
| `muse2api.driver` | `browser` | `browser` \| `mock` \| `http` |
| `muse2api.host` / `.port` | `127.0.0.1` / `18610` | Gateway-Adresse |
| `muse2api.autoPort` | `true` | nächsten freien Port wählen |
| `muse2api.shim.enabled` / `.port` | `true` / `18611` | Tool-Shim |
| `muse2api.shim.timeoutSeconds` | `600` | Request-Timeout |
| `muse2api.accountConcurrency` | `4` | parallele Tabs pro Konto |
| `muse2api.poolStrategy` | `affinity` | Konto-Scheduling |
| `muse2api.streamHeartbeat` | `0` | SSE-Keepalive (Sekunden) |
| `muse2api.chromiumPath` | `""` | Pfad zu Chrome/Chromium |
| `muse2api.headless` | `true` | unsichtbarer Browser |
| `muse2api.kilocode.includeAliases` | `false` | `gpt-4o`, `dall-e-3`, … |
| `muse2api.kilocode.includeNonChatModels` | `false` | Bild/Video im Modelpicker |
| `muse2api.kilocode.setAsActiveModel` | `false` | `model` automatisch setzen |
| `muse2api.kilocode.writeKeyToAuthStore` | `true` | `auth.json` schreiben |
| `muse2api.env` | `{}` | z. B. `{"CHAT_TIMEOUT":"600"}` |

`muse2api.env` akzeptiert Keys mit und ohne `MUSE2API_`-Prefix.

---

## 8. Fehlersuche

### Gateway startet nicht

`muse.ai: Gateway-Protokoll anzeigen` öffnen. Typische Ursachen:

- Python < 3.10 → `muse2api.pythonPath` auf einen gültigen Interpreter setzen.
- Kein `pip` im venv → `python3 -m ensurepip --upgrade` oder `uv` installieren.
- Port belegt → `muse2api.port` ändern (oder `autoPort` wirkt lassen).
- Hinter einem Proxy → `muse2api.env`: `{"BROWSER_PROXY":"http://…"}`.

### Kilo Code: „Invalid API Key“ / 401

`muse.ai: Modelle in Kilo Code registrieren` erneut ausführen. Der Key wird bei
jedem Start des Gateways erzeugt/gelesen und in `auth.json` geschrieben. Prüfe
mit `muse.ai: Zugangsdaten kopieren → API-Key`.

### Kilo Code: „Connection refused“ / 502

Gateway läuft nicht. `muse.ai: Gateway starten`. Der Shim meldet sonst
`gateway_unreachable` mit einem klaren Hinweis.

### „no account available“ / `readyz: ready=false`

Cookies fehlen oder sind abgelaufen. `muse.ai: Konten verwalten` → Status prüfen,
ggf. „Sitzung erneuern“ oder Cookies neu importieren.

### Chromium-Probleme

- Linux: `chromium` oder `google-chrome` installieren; ggf.
  `muse2api.chromiumPath` setzen.
- In Containers/WSL: `muse2api.headless: true` (Standard) und
  `--no-sandbox`-Optionen über `muse2api.env` (siehe Upstream-Doku).
- Bilder/Videos brauchen ein laufendes VM – muse2api bestätigt den Wake-Vorgang
  automatisch.

### Modelle fehlen nach Registrierung

1. `Developer: Reload Window`
2. `muse.ai: Kilo-Code-Konfiguration öffnen` – steht der `provider.muse2api`-Block?
3. Kilo Code → Settings → Providers: taucht „muse.ai (muse2api)“ auf?
4. `muse.ai: Status anzeigen` listet die tatsächlich verwendeten Pfade.

### Alles zurücksetzen

`muse.ai: Registrierung aus Kilo Code entfernen`, dann `muse.ai: Gateway stoppen`,
Datenordner über `muse.ai: Datenordner öffnen` löschen (löscht Konten & Keys),
anschließend neu einrichten.

---

## 9. Sicherheit & Datenschutz

- Gateway und Shim binden nur an `127.0.0.1`.
- Der API-Key wird im VS-Code-SecretStorage und in Kilo Codes `auth.json`
  (Dateirechte 0600) abgelegt.
- Cookies liegen unverschlüsselt in `data/accounts.json` – schütze deinen
  Benutzeraccount und lege `dataDir` nicht in ein synchronisiertes/git-Verzeichnis.
- Die Erweiterung sendet keine Telemetrie. Das Gateway loggt Requests lokal in
  `data/requests.db` (Aufbewahrung: `MUSE2API_REQUEST_LOG_RETENTION_DAYS`, Standard 14).
- **Rechtliches:** Dieses Projekt dient Lern- und Forschungszwecken. Die
  automatisierte Nutzung von muse.ai kann gegen dessen Nutzungsbedingungen
  verstoßen. Prüfe dies vor dem Einsatz. Keine Gewährleistung.

---

## 10. Nützliche Befehle zum Debuggen

```bash
# Gateway-Endpunkte direkt ansprechen
curl http://127.0.0.1:18610/healthz
curl http://127.0.0.1:18610/readyz
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18610/v1/models
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:18610/admin/accounts

# Shim
curl http://127.0.0.1:18611/shim/healthz

# Chat (non-streaming)
curl http://127.0.0.1:18611/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-chat","messages":[{"role":"user","content":"Hallo"}]}'
```

Weitere Details: [muse2api README](../vendor/muse2api/README.md) und
[ARCHITECTURE.md des Upstreams](https://github.com/www222fff/muse2api/blob/main/docs/ARCHITECTURE.md).
