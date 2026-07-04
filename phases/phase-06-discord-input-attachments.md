# Phase 6 – Discord Input: Attachments, Dateien und Bilder

## Ziel

Discord-Nachrichten sollen nicht nur reinen Text, sondern auch Anhänge an pi weiterreichen. Textdateien sollen als Inhalt in den Prompt übernommen werden, Bilder sollen – soweit pi/Provider multimodale Eingaben unterstützt – sichtbar an die Agent-Session übergeben oder zumindest sauber referenziert werden.

## Wichtige Vorgaben

- Niemals Discord-Attachments ungeprüft lokal ausführen.
- Maximalgrößen und erlaubte MIME-Typen erzwingen.
- Secrets und Binärdaten nicht unkontrolliert in Discord zurückposten.
- Modell-/Provider-/Thinking-Level bleiben ausschließlich lokale Konfiguration.
- Für nicht unterstützte Dateitypen soll der Bot verständlich erklären, was ignoriert wurde.

## Aufgaben

1. Config erweitern:
   - `discord.maxAttachmentBytes` mit sicherem Default.
   - `discord.allowedAttachmentMimeTypes` oder pragmatische Extension-/MIME-Allowlist.
   - optional `discord.downloadAttachments`.

2. Attachment-Erfassung implementieren:
   - Discord `message.attachments` auswerten.
   - Metadaten erfassen: Name, URL, Größe, Content-Type.
   - Kleine Text-/Markdown-/Code-Dateien herunterladen und in den Prompt einbetten.
   - Große Dateien nur zusammenfassen/verlinken.

3. Bild-Unterstützung vorbereiten:
   - Bilder erkennen (`image/png`, `image/jpeg`, `image/webp`, `image/gif`).
   - Wenn die pi-API multimodale User-Messages unterstützt: Bilddaten korrekt übergeben.
   - Falls nicht: Bild als Discord-Link und Metadaten in den Prompt aufnehmen.

4. Sicherheit:
   - Download mit Timeout und Größenlimit.
   - Content-Type und Dateiendung prüfen.
   - Redaction auf heruntergeladene Textinhalte anwenden, bevor sie in Logs/Discord auftauchen.

5. Integration:
   - Extension-Modus und Bridge-Daemon verwenden dieselbe Attachment-Normalisierung.
   - Prompt enthält einen klaren Abschnitt `Discord-Anhänge`.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- Eine Discord-Nachricht mit kleiner `.md`/`.txt`/Code-Datei landet mit Dateiinhalt im pi-Prompt.
- Zu große oder nicht erlaubte Anhänge werden nicht heruntergeladen und im Prompt als ignoriert/verlinkt markiert.
- Bildanhänge werden mindestens als strukturierte Links/Metadaten weitergereicht.
- Fehler beim Download brechen die gesamte Prompt-Verarbeitung nicht ab.

## Hinweise für pi

Lies vor der Implementierung `DESIGN.md`, `README.md`, `src/extension.ts`, `src/bridge.ts`, `src/types.ts`, `src/config.ts` und `src/redaction.ts`. Implementiere eine gemeinsame Hilfsschicht, z.B. `src/attachments.ts`, statt Logik in Extension und Daemon zu duplizieren.
