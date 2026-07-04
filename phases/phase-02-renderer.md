# Phase 2 – Renderer: Chat/Card zuerst, Markdown-Fallback

## Ziel

Der Discord-Renderer soll Antworten möglichst direkt als Chat-Nachrichten oder Discord-Cards/Embeds abbilden. Nur wenn Inhalte zu lang oder zu komplex sind, werden Markdown-Dateien als Attachments erzeugt.

## Wichtige Vorgaben

- Primär Chat/Card-Ausgabe.
- Fallback: Markdown-Attachments (`.md`).
- In Forum-Threads sollen Attachments bevorzugt Markdown-Dateien sein.
- Keine Modellsteuerung über Discord einbauen.
- Discord-Limits beachten:
  - Message Content praktisch max. 1900 Zeichen.
  - Embed Description max. 4096 Zeichen.
  - max. 10 Embeds pro Discord-Message.
- Rate-Limits vorbereiten, aber noch keine vollständige Queue nötig.

## Aufgaben

1. `src/renderer.ts` robuster machen:
   - Markdown in Blöcke parsen: Text, fenced code, Tabellen, Listen, Überschriften.
   - Text in saubere Chunks splitten.
   - Kurze Codeblöcke als Embed/Card.
   - Lange Codeblöcke als Preview-Embed + `.md` Attachment.
   - Lange Textantworten optional als `pi-answer-<timestamp>.md` anhängen.

2. Attachment-Erzeugung standardisieren:
   - `pi-answer-<timestamp>.md`
   - `pi-code-<timestamp>.md`
   - `pi-log-<timestamp>.md`
   - Markdown mit Titel, Kontext, fenced code blocks und Quellenlinks.

3. Tool-/Fehler-Ausgabe verbessern:
   - Fehler als rote Embed-Card.
   - Toolstatus als kompakte Card vorbereiten.
   - Große Toolausgaben niemals komplett in Discord posten.

4. Tests oder zumindest kleine isolierte Test-Hilfen für Renderer ergänzen.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- Eine lange Textantwort wird in mehrere Discord-Nachrichten oder ein Markdown-Attachment gesplittet.
- Ein kurzer Codeblock wird als Embed dargestellt.
- Ein langer Codeblock erzeugt Preview + `.md` Attachment.
- Renderer erzeugt keine Payloads über Discord-Limits.

## Hinweise für pi

Bitte implementiere diese Phase vollständig im Repository. Lies zuerst den aktuellen Stand (`DESIGN.md`, `PHASES.md`, `src/renderer.ts`, `src/extension.ts`). Ändere nur, was für Phase 2 nötig ist.
