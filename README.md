# pi-discord-bridge

Discord-Bridge für pi.dev als pi-Extension und als Standalone-Bridge-Daemon.

Aktueller Stand: **Phasen 1–9 implementiert**. Verbleibende Folgearbeiten stehen in [`TODO.md`](./TODO.md).

- Extension-Modus: Single-Session-Textchannels im laufenden pi-Prozess.
- Bridge-Daemon: Discord-Arbeitsforen und normale Textchannels als eigene Routen/Sessions.
- Optionales Knowledgebase-Forum mit lokalem Markdown-Index, Attachment-Indexierung und Keyword/BM25-artigem Retrieval.
- Discord-gerechtes Rendering mit Chunks, Embeds und Markdown-Attachments.
- Optionales, gedrosseltes Streaming nach Discord und optionale Tool-Event-Cards.
- Discord-Anhänge als Prompt-Kontext: kleine Text-/Markdown-/Code-Dateien werden eingebettet, Bilder als Links/Metadaten weitergereicht.
- Admin-Kommandos, Rate-Limit-Queue, Idle-Dispose/Resume und Secret-Redaction.

## Installation

```bash
npm install
npm run typecheck
```

## Konfiguration

Die Bridge liest die globale Config aus:

```text
~/.pi/agent/discord-bridge.json
```

Optional wird zusätzlich projektlokal gelesen, wenn das Projekt trusted ist:

```text
.pi/discord-bridge.json
```

Beispiel siehe `examples/config.example.json`.

Minimal für den Extension-Modus:

```json
{
  "tokenEnv": "DISCORD_BOT_TOKEN",
  "guildId": "123456789012345678",
  "prefix": "!pi",
  "channels": [
    {
      "channelId": "123456789012345678",
      "mode": "single-session"
    }
  ]
}
```

Umfangreicheres Beispiel für Daemon, Forum, Knowledgebase, Attachments und Streaming:

```json
{
  "tokenEnv": "DISCORD_BOT_TOKEN",
  "guildId": "123456789012345678",
  "cwd": "/path/to/project",
  "allowedUserIds": ["111111111111111111"],
  "allowedRoleIds": [],
  "requireMention": false,
  "prefix": "!pi",
  "maxConcurrentSessions": 3,
  "idleDisposeMs": 1800000,
  "channels": [
    {
      "channelId": "111111111111111111",
      "mode": "single-session",
      "sessionName": "discord-main"
    },
    {
      "channelId": "222222222222222222",
      "mode": "forum",
      "sessionNamePrefix": "forum-"
    },
    {
      "channelId": "333333333333333333",
      "mode": "knowledgebase",
      "indexName": "discord-kb",
      "maxContextThreads": 5
    }
  ],
  "knowledgebase": {
    "downloadAttachments": true,
    "maxAttachmentBytes": 262144,
    "enableVectorSearch": false,
    "maxStoredThreadChars": 500000
  },
  "discord": {
    "sendTyping": true,
    "streamUpdates": false,
    "streamUpdateIntervalMs": 5000,
    "postToolEvents": false,
    "maxToolOutputChars": 4000,
    "maxMessageChars": 1900,
    "maxCodeCharsInline": 900,
    "largeCodeAsAttachment": true,
    "downloadAttachments": true,
    "maxAttachmentBytes": 262144,
    "allowedAttachmentMimeTypes": [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/xml",
      "text/xml",
      "text/yaml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "text/javascript",
      "text/css",
      "text/html",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif"
    ]
  },
  "redactionPatterns": []
}
```

Token setzen:

```bash
export DISCORD_BOT_TOKEN="..."
```

## Discord Bot Intents

Im Discord Developer Portal aktivieren:

- Guilds
- Guild Messages
- Message Content
- Guild Members, falls `allowedRoleIds` genutzt wird

Der Bot braucht Schreibrechte in den konfigurierten Channels/Threads. Für Slash Commands muss er im Server Anwendungen/Commands registrieren dürfen.

## Nutzung: Extension-Modus

Der Extension-Modus eignet sich für einen laufenden pi-Prozess und `single-session` Channels.

```bash
pi -e ./src/extension.ts
```

Oder als pi-Package installieren/auto-discovern. Das Package deklariert:

```json
{
  "pi": {
    "extensions": ["./src/extension.ts"]
  }
}
```

Ablauf:

1. pi startet die Extension bei `session_start`.
2. Die Extension verbindet sich mit Discord.
3. Nachrichten in konfigurierten `single-session` Channels werden nach Prefix/Mention/User-/Rollenprüfung als pi-Prompt gesendet.
4. Text-/Code-Attachments werden bei erlaubtem Typ und passender Größe in den Prompt eingebettet; Bilder werden als Links/Metadaten ergänzt.
5. Optional werden Streaming-Updates und Tool-Event-Cards gepostet.
6. Die finale Assistant-Antwort wird vollständig nach Discord gerendert.

Hinweis: Wenn `prefix` gesetzt ist, müssen auch Nachrichten mit Attachments den Prefix enthalten. Attachment-only Nachrichten funktionieren ohne Prefix-Config oder mit gültiger Mention-Konfiguration.

## Nutzung: Bridge-Daemon für Textchannels und Foren

Der Daemon ist der bevorzugte Modus für mehrere parallele Discord-Routen: normale Textchannels (`single-session`) und Arbeitsforen (`forum`).

```bash
npm run bridge
```

Ablauf:

- Jeder konfigurierte `single-session` Textchannel bekommt eine eigene pi-Session mit Route-Key `discord:guild:<guildId>:channel:<channelId>`.
- Jeder Thread eines konfigurierten `forum` Channels bekommt eine eigene pi-Session mit Route-Key `discord:guild:<guildId>:forum:<forumId>:thread:<threadId>`.
- Mapping wird persistent gespeichert unter:

```text
~/.pi/agent/discord-bridge-sessions.json
```

- Pro Route werden Nachrichten sequentiell verarbeitet.
- Mehrere Routen laufen parallel bis `maxConcurrentSessions`.
- Der Thread-Titel bzw. `sessionName` aus der Channel-Config wird als pi-Session-Name verwendet.
- Inaktive Sessions werden nach `idleDisposeMs` disposed, das Mapping bleibt erhalten und wird bei neuer Aktivität aus der Session-Datei wieder geöffnet.
- Archivierte Threads werden nicht gelöscht; aktive Sessions werden disposed und bei neuer Aktivität/Unarchive wieder geöffnet.
- Attachments aus Arbeits-Routen werden wie im Extension-Modus in den Prompt aufgenommen.

## Knowledgebase-Forum

Channels mit `mode: "knowledgebase"` werden nicht als Arbeits-Threads benutzt. Stattdessen werden Threads gelesen, normalisiert und lokal gespeichert:

```text
~/.pi/agent/discord-bridge-kb/
├── index.json
├── threads/<threadId>.md
└── vectors/
```

Bei Prompts in Arbeitschannels/-threads sucht die Bridge relevante KB-Threads und injiziert kurze Auszüge plus Quellenlinks in den Prompt.

Aktuell umgesetzt:

- KB-Thread-Nachrichten werden normalisiert und indexiert.
- Erlaubte Text-/Markdown-/Code-Attachments aus KB-Threads werden heruntergeladen und in das Thread-Markdown integriert.
- Nicht unterstützte oder zu große Anhänge werden verlinkt.
- Suchtreffer enthalten Thread-ID, Pfad, Quellenlink und Score.
- Volltext kann kontrolliert per `loadDocument(threadId)` nachgeladen werden.
- Vektorsuche ist providerunabhängig vorbereitet; ohne konkrete Embedding-Integration bleibt Keyword/BM25-Fallback aktiv.

## Attachment-Verarbeitung

Gemeinsame Logik in `src/attachments.ts`:

- Discord-Attachment-Metadaten werden erfasst: Name, URL, Größe, Content-Type.
- Kleine Text-/Markdown-/Code-Dateien werden heruntergeladen und im Prompt unter `Discord-Anhänge` eingebettet.
- Downloads haben Timeout und Größenlimit.
- Nicht erlaubte, zu große oder fehlerhafte Anhänge werden nicht heruntergeladen, sondern im Prompt als ignoriert/verlinkt markiert.
- Bilder (`png`, `jpeg`, `webp`, `gif`) werden derzeit als Discord-Link/Metadaten weitergereicht, nicht multimodal als Bilddaten.
- Heruntergeladene Textinhalte werden vor Verwendung mit den Redaction-Regeln maskiert.

Wichtige Config-Werte:

- `discord.downloadAttachments` – Downloads für Arbeits-Prompts aktivieren/deaktivieren, Default `true`.
- `discord.maxAttachmentBytes` – maximale Downloadgröße für Arbeits-Prompts, Default `262144`.
- `discord.allowedAttachmentMimeTypes` – erlaubte MIME-Typen.
- `knowledgebase.downloadAttachments` – Downloads für KB-Indexierung aktivieren/deaktivieren.
- `knowledgebase.maxAttachmentBytes` – maximale Downloadgröße für KB-Indexierung.

## Rendering, Streaming und Tool-Events

Antworten werden Discord-konform gerendert:

- Text wird in Chunks bis `maxMessageChars` gesplittet.
- Kurze Codeblöcke werden als Embeds/Cards gesendet.
- Lange Codeblöcke und sehr lange Antworten werden als `.md` Attachment ausgelagert.
- Fehler werden als Embed gepostet.
- Bei `discord.streamUpdates: true` werden Assistant-Deltas gedrosselt in eine Discord-Statusnachricht geschrieben.
- `discord.streamUpdateIntervalMs` steuert das Mindestintervall der Edits, Default `5000`.
- Bei `discord.postToolEvents: true` werden Tool-Start/-Ende als kompakte Cards gepostet.
- `discord.maxToolOutputChars` begrenzt Tool-Ausgaben, große Logs werden über den Renderer gekürzt/ausgelagert.

## Admin-Kommandos im Daemon

Der Daemon registriert `/pi` Slash Commands:

- `/pi status` – Sessions, Queues und Metriken anzeigen
- `/pi reset` – neue Session für aktuelle Route erzeugen
- `/pi compact` – aktuelle Route-Session kompaktieren
- `/pi abort` – laufende Bearbeitung abbrechen
- `/pi help` – Hilfe anzeigen

Modell, Provider, Thinking-Level und API-Keys können über Discord weder gelesen noch geändert werden.

## Sicherheit

- Bot-Token wird nur über Env-Var gelesen (`tokenEnv`).
- Guild-, Channel-, User- und Rollenfilter sind vorhanden.
- Optional Prefix- und/oder Mention-Pflicht.
- Projektlokale Config wird nur bei trusted project gelesen.
- Redaction für bekannte Secret-Muster und optionale eigene Regexe (`redactionPatterns`).
- Attachment-Downloads sind typ- und größengeprüft.
- Discord-Kommandos können keine Modell-/Provider-/Thinking-/API-Key-Konfiguration ändern.

## Aktuelle Einschränkungen

- Bildanhänge werden noch nicht multimodal an pi übergeben, sondern als Link/Metadaten.
- Vektorsuche ist nur als providerunabhängiger Stub vorbereitet; ohne lokale Embedding-Integration bleibt Keyword/BM25-Fallback aktiv.
- Tests und CI sind noch ausbaufähig.

## Entwicklung

```bash
npm run typecheck
npm run bridge
```

Phasen automatisiert ausführen:

```bash
START_PHASE=7 END_PHASE=7 scripts/run-phases.sh
```

`scripts/run-phases.sh` startet pi standardmäßig mit `--verbose`. Mit `PI_VERBOSE=0` lässt sich das deaktivieren.
