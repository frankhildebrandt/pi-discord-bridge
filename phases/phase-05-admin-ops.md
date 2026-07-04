# Phase 5 – Admin & Betrieb

## Ziel

Die Bridge soll sicher und stabil betreibbar werden. Discord-Admin-Kommandos dürfen Sessions und Betrieb steuern, aber niemals Modell oder Thinking-Level ändern.

## Harte Vorgabe

Über Discord darf es keine Möglichkeit geben:

- Modell zu wechseln.
- Provider zu wechseln.
- Thinking-Level zu ändern.
- API Keys oder lokale Modellkonfiguration zu lesen/setzen.

Diese Dinge bleiben ausschließlich lokal am pi-Agent bzw. in lokaler Konfiguration.

## Aufgaben

1. Discord Slash Commands registrieren:
   - `/pi status`
   - `/pi reset`
   - `/pi compact`
   - `/pi abort`
   - optional `/pi help`

2. Permissions:
   - User-Allowlist.
   - Rollen-Allowlist.
   - Guild-/Channel-Scopes.
   - Admin-Kommandos nur für berechtigte Personen.

3. Status:
   - aktive Sessions/Threads anzeigen.
   - Queue-Länge anzeigen.
   - Laufende Bearbeitung anzeigen.
   - Session-Datei oder Session-ID nur wenn unkritisch, keine Secrets.

4. Reset/Compact/Abort:
   - Reset erzeugt neue Session für Channel/Thread.
   - Compact triggert lokale pi-Compaction.
   - Abort bricht laufende Bearbeitung ab.

5. Rate-Limits & Backoff:
   - zentrale Send-Queue für Discord-Ausgaben.
   - Retry bei transienten Discord-Fehlern.
   - keine Message-Edit-Spam-Schleifen.

6. Observability:
   - strukturierte Logs.
   - klare Fehlerausgaben.
   - optional einfache Metriken.

7. Redaction:
   - Secrets in Toolausgaben möglichst maskieren.
   - Config für zusätzliche Redaction-Regeln.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- Admin-Kommandos existieren und respektieren Permissions.
- Kein Discord-Kommando kann Modell/Provider/Thinking-Level ändern.
- Rate-Limit-Queue schützt vor zu schnellem Senden.
- Fehler werden verständlich als Discord-Embed und lokal im Log angezeigt.

## Hinweise für pi

Bitte implementiere diese Phase nach Phase 4. Lies zuerst alle vorherigen Phasendateien und den aktuellen Code. Achte besonders auf die harte Vorgabe, dass Discord keine Modellkonfiguration verändern darf.
