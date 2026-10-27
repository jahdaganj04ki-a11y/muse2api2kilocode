# muse.ai für Kilo Code (muse2api)

**English version: [README.en.md](README.en.md)**

Eine VS-Code-Erweiterung (`.vsix`), die das OpenAI-kompatible Gateway
[www222fff/muse2api](https://github.com/www222fff/muse2api) lokal startet und die
muse.ai-Modelle (`muse-chat`, `muse-image`, `muse-video`) als **OpenAI-kompatiblen
Provider in Kilo Code** registriert.

Die Erweiterung liefert muse2api bereits mit (eingebetteter Quellstand
`618aeb0d`, v0.3.0) – es muss nichts separat geklont werden.

---

## Was sie tut

1. **Python-Umgebung** – legt beim ersten Start ein venv im globalen Extension-Speicher an
   und installiert das mitgelieferte muse2api hinein (`uv`, falls vorhanden, sonst `pip`).
2. **Gateway** – startet `python -m muse2api` auf `127.0.0.1:18610` (nur lokal).
3. **Tool-Call-Shim** – ein lokaler Proxy auf `127.0.0.1:18611`, der Kilo Codes
   `tools` in ein Textprotokoll übersetzt und `<tool_use>`-Antworten des Modells
   zurück in OpenAI-`tool_calls` verwandelt (streamend und nicht-streamend).
   Damit funktionieren auch die Agenten-Modi (Code/Build) von Kilo Code, obwohl
   muse.ai kein natives Function-Calling hat.
4. **Registrierung** – schreibt den Provider-Block in Kilo Codes `kilo.jsonc`
   (global `~/.config/kilo/` oder `.kilo/kilo.jsonc` im Workspace) und den API-Key
   in `auth.json` – exakt wie Kilo Codes eigener Dialog *Custom provider*.
   Ältere Kilo-Code-Versionen (< 7) bekommen stattdessen ein
   `kilocode.providerProfiles`-Profil.

Zusätzlich: Seitenleiste mit Status/Modellen/Konten, Statusleiste, Cookie-Import,
Konto-Verwaltung (Kontingent, Sitzung erneuern), Dashboard-Link, Bild-/Video-Erzeugung,
Verbindungstest und Log.

> **Hinweis:** Die Erweiterung ist eine inoffizielle Integration. Sie nutzt muse.ai
> über dessen Web-Oberfläche (Browser-Treiber). Bitte beachte die
> [Nutzungsbedingungen von muse.ai](https://muse.ai/) – das Upstream-Projekt ist
> ausschließlich für Lern- und Forschungszwecke gedacht. Teile niemals deine Cookies.
> Cookies werden nur lokal im Datenordner der Erweiterung gespeichert.

---

## Voraussetzungen

| | |
|---|---|
| Editor | VS Code ≥ 1.85 (oder kompatible Forks) |
| Erweiterung | **Kilo Code** (`kilocode.kilo-code`) installiert |
| Python | ≥ 3.10 im `PATH` (oder `muse2api.pythonPath` setzen) |
| Für echte Modelle | Ein bei [muse.ai](https://muse.ai/) angemeldetes Konto + Chrome/Chromium |
| Optional | `uv` im `PATH` (beschleunigt die Installation deutlich) |

Zum bloßen Ausprobieren reicht der `mock`-Driver – kein Konto, kein Browser, kein Netz.

---

## Installation

```bash
# VSIX aus dem Repo bauen (oder die fertige .vsix aus dem Releases-Tab nutzen)
npm install
npm run package
code --install-extension muse2api-kilocode-0.1.0.vsix
```

Oder in VS Code: **Extensions → ⋯ → Install from VSIX…**

Anschließend VS Code neu laden (`Developer: Reload Window`).

---

## Schnellstart

Beim ersten Start fragt die Erweiterung, ob sie eingerichtet werden soll:

1. **„Jetzt einrichten“** – installiert Python-Umgebung und startet das Gateway.
   („Mit Demo-Driver testen“ macht dasselbe mit `mock`.)
2. **Cookies importieren** – `muse.ai: muse.ai-Cookies importieren (einfügen)`
   aus der Befehlspalette. Mindestens `hatch_sess` und
   `hatch_native_auth_device` werden benötigt. Am einfachsten über die
   Cookie-Import-Erweiterung aus dem Gateway-Dashboard
   (`/admin/extension.zip`) oder per Kopie des `cookie`-Request-Headers aus den
   Browser-DevTools.
3. **Registrieren** – `muse.ai: Modelle in Kilo Code registrieren`. Es wird
   gefragt: **global** (alle Projekte) oder **nur dieser Workspace**.
4. **Fenster neu laden** – Kilo Code liest die Konfiguration beim Start.
5. **Modell wählen** – in Kilo Code im Modelpicker `muse.ai Chat (muse-chat)`
   auswählen, oder `muse.ai: Modell als aktives Kilo-Code-Modell festlegen`.

Das Gateway muss laufen, solange du die Modelle nutzt
(Symbol in der Statusleiste: `$(pass-filled) muse.ai`).

---

## Befehle (Befehlspalette: „muse.ai“)

| Befehl | Funktion |
|---|---|
| Gateway starten / stoppen / neu starten | Lebenszyklus des Python-Prozesses |
| Python-Umgebung einrichten | venv + muse2api (erneut) installieren |
| Modelle in Kilo Code registrieren | Provider + Key in kilo.jsonc / auth.json schreiben |
| Registrierung entfernen | Provider-Block und Key wieder löschen |
| Driver wechseln | `browser` / `mock` / `http` |
| Cookies importieren / aus Datei | Konten anlegen (auch mehrere Zeilen `label \| cookies`) |
| Konten verwalten | Kontingent, Sitzung erneuern, aktivieren, löschen |
| Verbindung testen | Ein Chat-Request an `muse-chat` |
| Bild erzeugen / Video erzeugen | `muse-image` / `muse-video` direkt nutzen |
| Dashboard öffnen | muse2api-Web-Dashboard |
| Gateway-Protokoll anzeigen | Output-Kanal mit Gateway- und Shim-Log |
| Zugangsdaten kopieren | Base URL, Key, cURL-Beispiel oder kilo.jsonc-Ausschnitt |
| Status anzeigen | Alle relevanten Pfade und Versionen |
| Anleitung öffnen | [GUIDE.de.md](docs/GUIDE.de.md) / [GUIDE.en.md](docs/GUIDE.en.md) |

---

## Wichtige Einstellungen

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `muse2api.driver` | `browser` | `browser` (echt), `mock` (Demo), `http` (noch 501) |
| `muse2api.port` | `18610` | Gateway-Port |
| `muse2api.shim.port` | `18611` | Shim-Port = Base URL für Kilo Code |
| `muse2api.shim.enabled` | `true` | Tool-Call-Emulation; ohne sie nur Ask/Chat-Modus |
| `muse2api.pythonPath` | `""` | Fester Interpreter-Pfad |
| `muse2api.autoStart` | `false` | Gateway beim VS-Code-Start starten |
| `muse2api.kilocode.scope` | `global` | Vorgabe beim Registrieren (es wird trotzdem gefragt) |
| `muse2api.kilocode.providerId` | `muse2api` | Provider-ID in kilo.jsonc |
| `muse2api.kilocode.contextWindow` | `128000` | Kontextfenster, das Kilo Code annimmt |
| `muse2api.kilocode.declareToolCalls` | `true` | `tool_call: true` deklarieren (auf `false`, wenn der Shim aus ist) |
| `muse2api.kilocode.includeAliases` | `false` | Auch `gpt-4o`, `claude-sonnet-4`, … registrieren |
| `muse2api.dataDir` | `""` | Datenordner; leer = Extension-Speicher |
| `muse2api.env` | `{}` | Zusätzliche `MUSE2API_*`-Variablen |

Alle Einstellungen sind in den VS-Code-Einstellungen beschrieben (zweisprachig).

---

## Wie der Tool-Call-Shim arbeitet

Kilo Code sendet OpenAI-`tools` (z. B. `read_file`, `execute_command`) im
`/v1/chat/completions`-Body. Der Shim:

- entfernt `tools`/`tool_choice` aus dem Request und hängt stattdessen eine
  System-Nachricht mit der Tool-Liste und einem JSON-Protokoll an;
- wandelt frühere `assistant.tool_calls` und `tool`-Ergebnisse in
  `<tool_use>`- bzw. `<tool_result>`-Text um;
- parst die Antwort des Modells inkrementell aus dem SSE-Stream und erzeugt
  daraus korrekte OpenAI-`tool_calls`-Deltas (`finish_reason: "tool_calls"`);
- leitet alles andere (`/v1/models`, Bilder, Videos, Admin, Medien) unverändert durch.

**Grenzen:** muse.ai ist ein Chat-Modell, kein speziell trainiertes Coding-Agent-Modell.
Tool-Aufrufe funktionieren „best effort“ – prüfe die Vorschläge, bevor du Änderungen
übernimmst. Der Prompt ist generisch gehalten; sehr große Tool-Schemata werden
gekürzt. Du kannst den Shim jederzeit abschalten
(`muse2api.shim.enabled: false`) – dann landet die direkte Gateway-URL in Kilo Code
und es funktionieren nur Ask-/Chat-Modi.

---

## Build & Entwicklung

```bash
npm install          # Abhängigkeiten
npm run typecheck    # TypeScript prüfen
npm test             # 57 Unit-Tests + Aktivierungs-Smoke-Test des Bundles
npm run compile      # dist/extension.js (esbuild)
npm run smoke        # Bundle mit gestubbter VS-Code-API aktivieren
npm run package      # .vsix via @vscode/vsce
```

Das Python-Gateway wird beim ersten Start der Erweiterung aus
`vendor/muse2api/` in ein venv installiert. Der Stand ist in
`vendor/muse2api/UPSTREAM_REVISION.txt` festgehalten. Zum Aktualisieren den
Ordner `src/muse2api` aus dem Upstream-Repo kopieren und die Revisionsdatei
anpassen – die Erweiterung erkennt die Änderung über `install.json` und
installiert neu.

---

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Kein Python ≥ 3.10 gefunden“ | Python installieren oder `muse2api.pythonPath` setzen; Log prüfen |
| Gateway startet nicht | `muse.ai: Gateway-Protokoll anzeigen`; Port-Konflikt mit `muse2api.port` |
| `502 gateway_unreachable` in Kilo Code | Gateway starten (`muse.ai: Gateway starten`) |
| Modelle erscheinen nicht | Fenster neu laden; `muse.ai: Kilo-Code-Konfiguration öffnen` prüfen |
| `401 invalid or missing API key` | Erneut `Modelle registrieren` (schreibt `auth.json` neu) |
| „no account available“ | Cookies importieren; `muse.ai: Konten verwalten` |
| Bilder/Videos bleiben hängen | Browser-Driver braucht Chromium; `muse2api.chromiumPath` setzen |
| Agenten-Modus ruft keine Tools auf | Shim aktiv? `muse2api.kilocode.declareToolCalls: true` setzen |

Ausführlich: [GUIDE.de.md](docs/GUIDE.de.md).

---

## Danksagung & Lizenz

- [www222fff/muse2api](https://github.com/www222fff/muse2api) – MIT, Copyright (c) www222fff.
  Der vollständige Quelltext liegt unter `vendor/muse2api/` (inkl. `LICENSE`).
- [Kilo Code](https://github.com/Kilo-Org/kilocode) – Apache-2.0. Diese Erweiterung
  ist ein unabhängiger Drittanbieter-Client und nicht mit Kilo Code affiliate.

Die Erweiterung selbst steht unter der [MIT-Lizenz](LICENSE).
