# TODO

Aktueller Stand: Die geplanten Phasen 1–9 sind implementiert und `npm run typecheck` ist fehlerfrei.

## Offen / Folgearbeiten

- **Multimodale Bilder:** Discord-Bildanhänge werden aktuell als Links/Metadaten weitergereicht. Direkte Bilddatenübergabe an pi ist noch offen.
- **Echte Vektorsuche:** Knowledgebase-Vektorsuche ist providerunabhängig vorbereitet, aber ohne konkrete Embedding-Integration.
- **Tests:** Unit-/Integrationstests für Renderer, Attachments, Knowledgebase-Scoring, SessionPool-Migration und Daemon-Routing ergänzen.
- **CI:** GitHub Actions für Typecheck/Tests einrichten.
- **Admin-UX:** Slash-Command-Texte und Replies vollständig auf generische „Route“-Sprache vereinheitlichen.
- **Observability:** Healthcheck, ausführlichere Metriken und ggf. Log-Level-Konfiguration ergänzen.
- **Discord Command Scope:** Optional Commands pro Guild registrieren, um Entwicklungsupdates schneller sichtbar zu machen.

## Bewusst ausgeschlossen

- Modellwechsel, Providerwechsel, Thinking-Level-Änderungen oder API-Key-Verwaltung über Discord. Diese Einstellungen bleiben lokal in pi.
