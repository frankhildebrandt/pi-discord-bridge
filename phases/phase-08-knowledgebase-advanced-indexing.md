# Phase 8 – Knowledgebase: Anhänge, Volltext und optionale Vektorsuche

## Ziel

Das Knowledgebase-Forum soll über die aktuelle Keyword-Suche hinausgehen: Anhänge sollen inhaltlich indexiert werden, vollständige Thread-Inhalte sollen bei Bedarf nachladbar sein, und eine optionale Embedding-/Vektorsuche soll vorbereitet oder implementiert werden.

## Wichtige Vorgaben

- Knowledgebase bleibt read-only: keine Agent-Antworten im KB-Forum.
- Anhänge nur nach Allowlist, Größenlimit und Timeout herunterladen.
- Keine harte Abhängigkeit von einem bestimmten Embedding-Provider, falls lokale pi-Konfiguration das nicht hergibt.
- Quellenlinks müssen erhalten bleiben.
- Modellwechsel über Discord bleibt ausgeschlossen.

## Aufgaben

1. KB-Config erweitern:
   - `knowledgebase.downloadAttachments` oder entsprechender Discord-Config-Abschnitt.
   - `knowledgebase.maxAttachmentBytes`.
   - `knowledgebase.enableVectorSearch` optional.
   - `knowledgebase.maxStoredThreadChars` optional.

2. Attachment-Indexierung:
   - Text-/Markdown-/Code-Anhänge aus KB-Threads herunterladen.
   - Inhalte normalisiert in `~/.pi/agent/discord-bridge-kb/threads/<threadId>.md` integrieren.
   - Nicht unterstützte Anhänge als Links mit Metadaten aufnehmen.

3. Volltext-Nachladen:
   - Suchtreffer sollen neben Excerpt auch Pfad/Thread-ID enthalten.
   - Eine Funktion bereitstellen, die vollständige normalisierte KB-Dokumente nachladen kann.
   - Prompt-Kontext weiterhin kurz halten; Volltext nur kontrolliert injizieren.

4. Suche verbessern:
   - Keyword-Scoring robuster machen: Gewichtung Titel/Tags/Startpost/Antworten/Anhänge.
   - Optional BM25-artige Normalisierung.
   - Optional Embedding-/Vektorindex unter `~/.pi/agent/discord-bridge-kb/vectors/`.
   - Wenn Embeddings nicht konfiguriert sind, sauber auf Keyword-Suche zurückfallen.

5. Aktualisierung:
   - Hashes sollen Attachment-Inhalte einbeziehen.
   - Updates bei Message-Edit und neuen Antworten inkrementell abbilden.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- KB-Thread mit `.md`/`.txt` Attachment wird inklusive Attachment-Inhalt indexiert.
- Nicht unterstützte oder zu große Attachments werden nur verlinkt.
- Suchtreffer enthalten nachvollziehbare Quellenlinks.
- Ohne Embedding-Konfiguration funktioniert die Keyword-Suche weiterhin.

## Hinweise für pi

Lies zuerst `src/knowledgebase.ts`, `src/attachments.ts` falls vorhanden, `src/bridge.ts`, `src/types.ts` und `examples/config.example.json`. Vermeide Provider-spezifische harte Kopplung für Embeddings; falls nötig nur Interface/Stub plus Keyword-Fallback implementieren.
