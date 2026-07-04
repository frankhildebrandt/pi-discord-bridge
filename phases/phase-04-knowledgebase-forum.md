# Phase 4 – Knowledgebase-Forum

Status: ✅ implementiert

## Ziel

Ein zweites Discord-Forum dient als Knowledgebase. Dieses Forum erzeugt keine Arbeits-Sessions, sondern wird gelesen, normalisiert, lokal gespeichert, indexiert und bei passenden Prompts als Kontext genutzt.

## Wichtige Vorgaben

- `mode: "knowledgebase"` Channels sind reine Wissensquellen.
- Der Bot soll im Knowledgebase-Forum nicht wie ein Agent antworten.
- Knowledgebase-Inhalte werden nur lesend verwendet.
- Für Prompts in Arbeits-Channels/-Threads sollen relevante KB-Auszüge injiziert werden.
- Wenn KB-Inhalte verwendet werden, soll die Antwort Quellenlinks enthalten.
- Keine Modellsteuerung über Discord.

## Aufgaben

1. Knowledgebase-Modul anlegen:
   - `src/knowledgebase.ts`.
   - Verwaltet lokale Persistenz unter `~/.pi/agent/discord-bridge-kb/`.

2. Thread-Normalisierung:
   - Jeder KB-Thread wird als Markdown-Dokument gespeichert.
   - Enthalten:
     - Thread-Titel
     - Thread-ID
     - Discord-Link
     - Startpost
     - Antworten mit Autor/Zeit
     - Attachment-Links
   - Pfad: `threads/<threadId>.md`.

3. Index:
   - `index.json` mit Thread-ID, Titel, Hash, UpdatedAt, Tags, Auszug.
   - Inkrementelles Update bei neuen/geänderten Posts.
   - MVP: Keyword-/BM25-artige Suche ohne externe Datenbank.

4. Retrieval:
   - Query aus Prompt + Thread-Titel + ggf. Session-Kontext bilden.
   - Top-N Treffer, konfigurierbar via `maxContextThreads`.
   - Kurze Ausschnitte plus Links erzeugen.

5. Prompt-Injektion:
   - Vor Übergabe an pi relevanten KB-Kontext in den Prompt einbauen.
   - Klar markieren als `Discord Knowledgebase Kontext`.
   - Quellenlinks mitgeben.

6. Integration mit Phase 3:
   - Arbeits-Forum und Single-Session-Routing können KB-Retrieval nutzen.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- KB-Forum-Threads werden als `.md` Dateien gespeichert.
- `index.json` wird gepflegt.
- Ein Prompt kann relevante KB-Auszüge erhalten.
- Bot antwortet im KB-Forum nicht automatisch als Agent.

## Hinweise für pi

Bitte implementiere diese Phase nach Phase 3. Lies zuerst `DESIGN.md`, `PHASES.md`, `phases/phase-03-working-forum-sessions.md` und den aktuellen Code. Halte die Knowledgebase lokal und ohne externen Dienst im MVP.
