# Phase 3 – Arbeits-Forum: Thread = pi-Session

## Ziel

Discord-Arbeitsforen sollen unterstützt werden. Jeder Thread in einem konfigurierten Arbeits-Forum repräsentiert eine eigene pi-Session.

## Architekturvorgabe

Für mehrere parallele Forum-Threads soll ein Standalone-Bridge/SDK-Modus eingeführt werden. Die bestehende Extension bleibt für Single-Session-Betrieb erhalten.

## Wichtige Vorgaben

- Jeder Arbeits-Forum-Thread bekommt eine eigene pi-Session.
- Keine Modellsteuerung über Discord.
- Modell und Thinking-Level kommen ausschließlich aus lokaler pi-Konfiguration/SDK-Initialisierung.
- Pro Thread sequentielle Verarbeitung.
- Mehrere Threads dürfen optional parallel laufen, aber begrenzt.
- Session-Mapping muss Prozessneustarts überleben.

## Aufgaben

1. Daemon-Einstieg anlegen:
   - `src/bridge.ts`
   - nutzt Discord-Client und pi SDK.
   - CLI startbar über npm script, z.B. `npm run bridge`.

2. SessionPool implementieren:
   - Datei z.B. `src/pi-session-pool.ts`.
   - Mapping: `discord:guild:<guildId>:forum:<forumId>:thread:<threadId>`.
   - `getOrCreate(routeKey)` erzeugt/lädt passende AgentSession.
   - Persistenz z.B. `~/.pi/agent/discord-bridge-sessions.json`.

3. Forum-Routing implementieren:
   - `mode: "forum"` Channels überwachen.
   - Nachrichten in ThreadChannels verarbeiten.
   - Thread-Titel als Session-Name setzen.
   - Initial-Kontext injizieren: Guild, Forum, Thread, Author, Discord-Link.

4. Queue pro Thread:
   - Nachrichten eines Threads nacheinander verarbeiten.
   - Während laufender Bearbeitung neue Nachrichten als Follow-up queueen.

5. Output:
   - Renderer aus Phase 2 verwenden.
   - Antworten in denselben Thread posten.
   - Große Inhalte als Markdown-Attachment.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- `npm run bridge` oder äquivalenter Startpunkt existiert.
- Ein neuer Forum-Thread erzeugt bzw. öffnet eine eigene pi-Session.
- Nachrichten in unterschiedlichen Threads vermischen keine Session-Historie.
- Mapping bleibt nach Neustart erhalten.

## Hinweise für pi

Bitte implementiere diese Phase auf Basis des bestehenden MVP. Lies zuerst `DESIGN.md`, `PHASES.md`, `phases/phase-02-renderer.md` und den aktuellen `src/` Stand. Verwende das pi SDK für Multi-Session-Betrieb.
