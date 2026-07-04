# Implementierungsphasen

Status: **Phasen 1–9 sind implementiert**. Dieses Dokument beschreibt den erreichten Umfang und die verbleibenden Follow-up-TODOs.

## Phase 1 – MVP: Single-Session Discord Extension ✅

Ziel: Ein pi-Prozess verbindet sich beim Session-Start mit Discord, hört auf erlaubte Textchannels und sendet finale Antworten zurück.

Umgesetzt:

- Package-Scaffold mit `discord.js`.
- Config laden aus:
  - `~/.pi/agent/discord-bridge.json`
  - optional `<cwd>/.pi/discord-bridge.json`, nur wenn Projekt trusted ist.
- Discord Bot Login in `session_start`.
- Sauberes Shutdown in `session_shutdown`.
- Channel/User-Allowlist und Rollen-Allowlist.
- Optional Prefix- oder Mention-Filter.
- Discord-Nachrichten als `pi.sendUserMessage()` an lokale aktive pi-Session.
- Assistant-Finalantwort via Renderer als Discord-Nachrichten/Embeds posten.
- Keine Modelländerungen über Discord.

## Phase 2 – Renderer: Chat/Card zuerst, Markdown-Fallback ✅

Ziel: Antworten Discord-gerecht aufbereiten.

Umgesetzt:

- Markdown-Blockparser für Text, Codeblöcke, Tabellen, Listen, Überschriften.
- Text als Discord-konforme Chat-Chunks.
- Kurze Codeblöcke als Embeds/Cards.
- Lange Inhalte als `.md` Attachment.
- Forum-Threads bevorzugt mit Markdown-Dateien für große Inhalte.
- Tool-/Fehler-Zusammenfassungen als Cards.

## Phase 3 – Arbeits-Forum: Thread = Session ✅

Ziel: Forum-Threads als eigene pi-Sessions verwalten.

Umgesetzt:

- Standalone SDK/Daemon-Modus.
- SessionPool: Discord Thread -> pi AgentSession.
- Persistentes Mapping Route -> Sessionfile.
- Thread-Titel als Session-Name.
- Reconnect/Resume nach Neustart.
- Pro Route sequentielle Queue, mehrere Routen parallel.

## Phase 4 – Knowledgebase-Forum ✅

Ziel: Zweites Forum als lesende Wissensquelle.

Umgesetzt:

- Knowledgebase-Forum beobachten.
- Threads als normalisierte Markdown-Dokumente speichern.
- Lokaler Index mit Metadaten/Hashes.
- Retrieval via Keyword/BM25-artigem Scoring.
- Relevante KB-Auszüge vor Discord-Prompts injizieren.
- Quellenlinks in Antworten ermöglichen.

## Phase 5 – Admin & Betrieb ✅

Ziel: Sicherer Dauerbetrieb.

Umgesetzt:

- Discord Slash Commands ohne Modellwechsel:
  - `/pi status`
  - `/pi reset`
  - `/pi compact`
  - `/pi abort`
  - `/pi help`
- Rollen-/User-Permissions.
- Rate-Limit-Queue und Backoff.
- Observability/strukturierte Logs und einfache Metriken.
- Redaction-Hooks für Secrets.

## Phase 6 – Discord Input: Attachments, Dateien und Bilder ✅

Ziel: Discord-Anhänge strukturiert und sicher an pi weiterreichen.

Umgesetzt:

- Attachment-Config mit Größenlimits und MIME-Allowlist.
- Kleine Text-/Markdown-/Code-Dateien herunterladen und in Prompts einbetten.
- Große/nicht unterstützte Anhänge nur verlinken.
- Bildanhänge als strukturierte Metadaten/Links.
- Gemeinsame Attachment-Schicht für Extension, Daemon und Knowledgebase.

## Phase 7 – Streaming und Tool-Events nach Discord ✅

Ziel: Optionale laufende Antwort-Updates und Tool-Status-Cards ohne Rate-Limit-Spam.

Umgesetzt:

- Gedrosseltes Streaming/Editieren von Antwortnachrichten.
- Finales Rendering bleibt zuverlässig.
- Tool-Start/-Ende als kompakte Embeds.
- Redaction für Streaming- und Tool-Ausgaben.
- Queue/Backoff auch für Edits und Tool-Events.

## Phase 8 – Knowledgebase: Anhänge, Volltext und optionale Vektorsuche ✅

Ziel: Knowledgebase-Forum tiefer indexieren und Suche verbessern.

Umgesetzt:

- KB-Thread-Anhänge nach Allowlist herunterladen/indexieren.
- Volltext-Dokumente kontrolliert nachladbar (`loadDocument`).
- Keyword-Scoring verbessert und BM25-artig gewichtet.
- Optionale providerunabhängige Vektorsuche als Stub/Struktur mit Fallback auf Keyword-Suche.

## Phase 9 – Session-Lifecycle und Daemon-Routing für Textchannels ✅

Ziel: Der Daemon unterstützt normale Textchannels und robusteren Session-Lifecycle.

Umgesetzt:

- `single-session` Textchannels im Daemon als eigene Routen.
- Generischer SessionPool für Channel- und Thread-Routen.
- Mapping-Version 2 mit Migration alter Forum-Mappings.
- Idle-Dispose und Resume aus Sessionfile.
- Archivierte Threads nicht löschen, sondern bei Aktivität wieder aufnehmen.
- `/pi status` für alle Routentypen.

## Verbleibende TODOs / mögliche Folgephasen

- Multimodale Bildübergabe an pi implementieren, falls die verwendete pi/Provider-API Bilddaten in User-Messages unterstützt.
- Vektorsuche mit konkretem Embedding-Provider oder lokaler Embedding-Integration anbinden.
- Tests ergänzen, besonders für Renderer, Attachment-Normalisierung, Knowledgebase-Scoring und Session-Mapping-Migration.
- CI einrichten (`npm run typecheck`, ggf. Tests und Linting).
- Slash-Command-Texte weiter verallgemeinern, damit keine Thread-Formulierungen in Textchannel-Routen erscheinen.
- Optional: Discord-Commands gezielt pro Guild statt global registrieren, um Updates schneller auszurollen.
- Optional: bessere Observability/Metriken und Healthcheck für den Daemon.
