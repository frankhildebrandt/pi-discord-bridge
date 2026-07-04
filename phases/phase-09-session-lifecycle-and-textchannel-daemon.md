# Phase 9 – Session-Lifecycle und Daemon-Routing für Textchannels

## Ziel

Der Bridge-Daemon soll neben Forum-Threads auch normale Textchannels als eigene Routen unterstützen. Zusätzlich soll der Lifecycle von Forum-Thread-Sessions robuster werden: Idle-Dispose, Reopen/Resume und Archivierungsverhalten.

## Wichtige Vorgaben

- Ein Discord-Route-Key muss eindeutig und stabil sein.
- Keine parallele Bearbeitung innerhalb derselben Route; pro Route eine Queue.
- Mehrere Routen dürfen bis `maxConcurrentSessions` parallel laufen.
- Session-Mapping muss persistent und migrationsfähig bleiben.
- Modell-/Provider-/Thinking-Level bleiben ausschließlich lokale Konfiguration.

## Aufgaben

1. Routing erweitern:
   - `single-session` Channels im Daemon unterstützen.
   - Route-Key für Textchannels definieren, z.B. `discord:guild:<guildId>:channel:<channelId>`.
   - Optional `sessionName` aus Config verwenden.
   - Forum-Thread-Routing unverändert kompatibel halten.

2. SessionPool generalisieren:
   - Metadata nicht nur Thread-, sondern generische Route-Daten erlauben.
   - Persistiertes Mapping abwärtskompatibel lesen.
   - Status-Ausgabe für Channel- und Thread-Routen.

3. Lifecycle:
   - `idleDisposeMs` optional konfigurieren.
   - Inaktive Sessions disposen, Mapping aber behalten.
   - Bei neuer Aktivität Session aus Sessionfile wieder öffnen.
   - Archivierte Threads: Session nicht löschen, nur idle halten/disposen.
   - Bei Thread-Unarchive oder neuer Nachricht wieder öffnen.

4. Queue-/Concurrency-Modell:
   - Gemeinsame RouteQueue für Textchannel und Forum-Thread.
   - Queue-Status in `/pi status` anzeigen.
   - Fehler in einer Route dürfen andere Routen nicht blockieren.

5. Dokumentation:
   - README mit Daemon-Textchannel-Modus aktualisieren.
   - Config-Beispiel ergänzen.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- Daemon kann einen normalen Textchannel mit `mode: "single-session"` bedienen.
- Forum-Thread-Sessions funktionieren weiterhin.
- Idle-disposed Sessions werden bei neuer Aktivität wieder aufgenommen.
- `/pi status` zeigt Channel- und Thread-Routen verständlich an.

## Hinweise für pi

Lies zuerst `src/bridge.ts`, `src/pi-session-pool.ts`, `src/types.ts`, `src/config.ts`, `README.md` und `examples/config.example.json`. Plane die Mapping-Änderungen vorsichtig, damit bestehende `discord-bridge-sessions.json` Dateien nicht kaputtgehen.
