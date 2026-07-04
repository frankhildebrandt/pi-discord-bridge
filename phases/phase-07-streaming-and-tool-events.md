# Phase 7 – Streaming und Tool-Events nach Discord

Status: ✅ implementiert

## Ziel

Antworten sollen optional während der Generierung sichtbar werden, ohne Discord-Rate-Limits zu verletzen. Zusätzlich sollen Tool-Ausführungen (`read`, `bash`, `edit`, usw.) als kompakte Status-Cards gepostet werden können.

## Wichtige Vorgaben

- Kein Message-Edit-Spam: Updates throttlen/debouncen.
- Finale Antwort muss auch bei Streaming sauber und vollständig gerendert werden.
- Tool-Ausgaben können Secrets enthalten: immer Redaction anwenden.
- Große Logs niemals vollständig als Discord-Nachricht posten; Markdown-Attachment oder Zusammenfassung nutzen.
- Modell-/Provider-/Thinking-Level bleiben ausschließlich lokale Konfiguration.

## Aufgaben

1. Config erweitern:
   - `discord.streamUpdates` produktiv nutzbar machen.
   - `discord.streamUpdateIntervalMs` mit konservativem Default.
   - `discord.postToolEvents` optional.
   - `discord.maxToolOutputChars` optional.

2. Streaming im Extension-Modus:
   - Assistant-Deltas puffern.
   - Eine Discord-Status-/Antwortnachricht erstellen und throttled editieren.
   - Bei `message_end` finale Payloads rendern und Status sauber ersetzen/abschließen.
   - Fehlerfälle berücksichtigen: gelöschte Message, fehlende Rechte, Rate-Limit.

3. Streaming im Bridge-Daemon:
   - Prüfen, welche AgentSession-Events verfügbar sind.
   - Falls Events verfügbar sind: pro Thread dieselbe Streaming-Pipeline wie Extension nutzen.
   - Falls nicht: dokumentiert final-only bleiben und Code so strukturieren, dass spätere Event-Anbindung möglich ist.

4. Tool-Events:
   - `tool_execution_start` als gelbe/running Card optional posten.
   - `tool_execution_end` als grüne/rote Summary Card posten.
   - Große Toolausgaben via `renderToolStatusMessage` als `.md` Attachment auslagern.
   - Redaction vor dem Rendern anwenden.

5. Rate-Limits:
   - `DiscordSendQueue` auch für Edits/Tool-Events nutzen oder eine äquivalente Edit-Queue einführen.
   - Retries bei transienten Discord-Fehlern.

## Akzeptanzkriterien

- `npm run typecheck` läuft fehlerfrei.
- Bei `streamUpdates: true` sieht man periodische, gedrosselte Updates in Discord.
- Bei `streamUpdates: false` bleibt das bisherige final-only Verhalten erhalten.
- Tool-Start und Tool-Ende können als Cards gepostet werden, wenn `postToolEvents` aktiviert ist.
- Keine Payload verletzt Discord-Limits.

## Hinweise für pi

Lies vor der Implementierung `src/extension.ts`, `src/bridge.ts`, `src/renderer.ts`, `src/rate-limit.ts` und `src/redaction.ts`. Halte Streaming-Logik möglichst gekapselt, z.B. in `src/discord-output.ts` oder `src/streaming.ts`.
