# Implementierungsphasen

## Phase 1 – MVP: Single-Session Discord Extension

Ziel: Ein pi-Prozess verbindet sich beim Session-Start mit Discord, hört auf erlaubte Textchannels und sendet finale Antworten zurück.

Umfang:

- Package-Scaffold mit `discord.js`.
- Config laden aus:
  - `~/.pi/agent/discord-bridge.json`
  - optional `<cwd>/.pi/discord-bridge.json`, nur wenn Projekt trusted ist.
- Discord Bot Login in `session_start`.
- Sauberes Shutdown in `session_shutdown`.
- Channel/User-Allowlist.
- Optional Prefix- oder Mention-Filter.
- Discord-Nachrichten als `pi.sendUserMessage()` an lokale aktive pi-Session.
- Assistant-Finalantwort via Renderer als Discord-Nachrichten/Embeds posten.
- Keine Modelländerungen über Discord.

## Phase 2 – Renderer: Chat/Card zuerst, Markdown-Fallback

Ziel: Antworten Discord-gerecht aufbereiten.

Umfang:

- Markdown grob in Text- und Codeblöcke parsen.
- Text als Chat-Chunks posten.
- Kurze Codeblöcke als Embeds/Cards.
- Lange Inhalte als `.md` Attachment.
- Forum-Threads bevorzugt mit Markdown-Dateien für große Inhalte.
- Tool-/Fehler-Zusammenfassungen als Cards.

## Phase 3 – Arbeits-Forum: Thread = Session

Ziel: Forum-Threads als eigene pi-Sessions verwalten.

Umfang:

- Standalone SDK/Daemon-Modus einführen.
- SessionPool: Discord Thread -> pi AgentSession.
- Persistentes Mapping Thread-ID -> Sessionfile.
- Thread-Titel als Session-Name.
- Reconnect/Resume nach Neustart.
- Pro Thread sequentielle Queue, mehrere Threads optional parallel.

## Phase 4 – Knowledgebase-Forum

Ziel: Zweites Forum als lesende Wissensquelle.

Umfang:

- Knowledgebase-Forum beobachten.
- Threads als normalisierte Markdown-Dokumente speichern.
- Lokaler Index mit Metadaten/Hashes.
- MVP-Retrieval via Keyword-Scoring.
- Relevante KB-Auszüge vor Discord-Prompts injizieren.
- Quellenlinks in Antworten ermöglichen.

## Phase 5 – Admin & Betrieb

Ziel: Sicherer Dauerbetrieb.

Umfang:

- Discord Slash Commands ohne Modellwechsel:
  - `/pi status`
  - `/pi reset`
  - `/pi compact`
  - `/pi abort`
- Rollen-/User-Permissions.
- Rate-Limit-Queue und Backoff.
- Observability/Logs.
- Redaction-Hooks für Secrets.

## Phase 6 – Discord Input: Attachments, Dateien und Bilder

Ziel: Discord-Anhänge strukturiert und sicher an pi weiterreichen.

Umfang:

- Attachment-Config mit Größenlimits und MIME-Allowlist.
- Kleine Text-/Markdown-/Code-Dateien herunterladen und in Prompts einbetten.
- Große/nicht unterstützte Anhänge nur verlinken.
- Bildanhänge mindestens als strukturierte Metadaten/Links, optional multimodal.
- Gemeinsame Attachment-Schicht für Extension und Daemon.

## Phase 7 – Streaming und Tool-Events nach Discord

Ziel: Optionale laufende Antwort-Updates und Tool-Status-Cards ohne Rate-Limit-Spam.

Umfang:

- Gedrosseltes Streaming/Editieren von Antwortnachrichten.
- Finales Rendering bleibt zuverlässig.
- Tool-Start/-Ende als kompakte Embeds.
- Redaction für Tool-Ausgaben.
- Queue/Backoff auch für Edits und Tool-Events.

## Phase 8 – Knowledgebase: Anhänge, Volltext und optionale Vektorsuche

Ziel: Knowledgebase-Forum tiefer indexieren und Suche verbessern.

Umfang:

- KB-Thread-Anhänge nach Allowlist herunterladen/indexieren.
- Volltext-Dokumente kontrolliert nachladbar machen.
- Keyword-Scoring verbessern.
- Optionale Embedding-/Vektorsuche mit Fallback auf Keyword-Suche vorbereiten.

## Phase 9 – Session-Lifecycle und Daemon-Routing für Textchannels

Ziel: Der Daemon unterstützt normale Textchannels und robusteren Session-Lifecycle.

Umfang:

- `single-session` Textchannels im Daemon als eigene Routen.
- Generischer SessionPool für Channel- und Thread-Routen.
- Idle-Dispose und Resume aus Sessionfile.
- Archivierte Threads nicht löschen, sondern bei Aktivität wieder aufnehmen.
- `/pi status` für alle Routentypen.
