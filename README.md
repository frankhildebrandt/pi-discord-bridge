# pi-discord-bridge

Discord-Bridge für pi.dev als pi-Extension und als Standalone-Bridge-Daemon.

Aktueller Stand: **Phasen 1–6 implementiert, Phase 7–9 offen**.

- Extension-Modus: Single-Session-Textchannels.
- Bridge-Daemon: Discord-Arbeitsforen, ein Thread = eine pi-Session.
- Optionales Knowledgebase-Forum mit lokalem Markdown-Index und Keyword-Retrieval.
- Discord-gerechtes Rendering mit Chunks, Embeds und Markdown-Attachments.
- Discord-Anhänge als Prompt-Kontext: kleine Text-/Markdown-/Code-Dateien werden eingebettet, Bilder als Links/Metadaten weitergereicht.
- Admin-Kommandos, Rate-Limit-Queue und Secret-Redaction.

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

Beispiel für Forum-Bridge plus Knowledgebase und Attachment-Verarbeitung:

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
  "channels": [
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
  "discord": {
    "sendTyping": true,
    "streamUpdates": false,
    "maxMessageChars": 1900,
    "maxCodeCharsInline": 900,
    "largeCodeAsAttachment": true,
    "downloadAttachments": true,
    "maxAttachmentBytes": 262144,
    "allowedAttachmentMimeTypes": [
      "text/plain",
      "text/markdown",
      "application/json",
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
5. Die finale Assistant-Antwort wird nach Discord gerendert.

Hinweis: Wenn `prefix` gesetzt ist, müssen auch Nachrichten mit Attachments den Prefix enthalten. Attachment-only Nachrichten funktionieren ohne Prefix-Config oder mit gültiger Mention-Konfiguration.

## Nutzung: Bridge-Daemon für Foren

Der Daemon ist der bevorzugte Modus für Discord-Foren mit mehreren parallelen Threads.

```bash
npm run bridge
```

Ablauf:

- Jeder Thread eines konfigurierten `forum` Channels bekommt eine eigene pi-Session.
- Mapping wird persistent gespeichert unter:

```text
~/.pi/agent/discord-bridge-sessions.json
```

- Pro Thread werden Nachrichten sequentiell verarbeitet.
- Mehrere Threads laufen parallel bis `maxConcurrentSessions`.
- Der Thread-Titel wird als pi-Session-Name verwendet.
- Attachments aus Arbeits-Threads werden wie im Extension-Modus in den Prompt aufgenommen.

## Knowledgebase-Forum

Channels mit `mode: "knowledgebase"` werden nicht als Arbeits-Threads benutzt. Stattdessen werden Threads gelesen, normalisiert und lokal gespeichert:

```text
~/.pi/agent/discord-bridge-kb/
├── index.json
└── threads/<threadId>.md
```

Bei Prompts in Arbeitschannels/-threads sucht die Bridge relevante KB-Threads per Keyword-Scoring und injiziert kurze Auszüge plus Quellenlinks in den Prompt.

Aktuell werden KB-Thread-Nachrichten und Attachment-Links erfasst; KB-Attachments werden noch nicht inhaltlich heruntergeladen und indexiert.

## Attachment-Verarbeitung

Gemeinsame Logik in `src/attachments.ts`:

- Discord-Attachment-Metadaten werden erfasst: Name, URL, Größe, Content-Type.
- Kleine Text-/Markdown-/Code-Dateien werden heruntergeladen und im Prompt unter `Discord-Anhänge` eingebettet.
- Downloads haben Timeout und Größenlimit.
- Nicht erlaubte, zu große oder fehlerhafte Anhänge werden nicht heruntergeladen, sondern im Prompt als ignoriert/verlinkt markiert.
- Bilder (`png`, `jpeg`, `webp`, `gif`) werden derzeit als Discord-Link/Metadaten weitergereicht, nicht multimodal als Bilddaten.
- Heruntergeladene Textinhalte werden vor Verwendung mit den Redaction-Regeln maskiert.

Wichtige Config-Werte:

- `discord.downloadAttachments` – Downloads aktivieren/deaktivieren, Default `true`.
- `discord.maxAttachmentBytes` – maximale Downloadgröße, Default `262144`.
- `discord.allowedAttachmentMimeTypes` – erlaubte MIME-Typen.

## Rendering

Antworten werden Discord-konform gerendert:

- Text wird in Chunks bis `maxMessageChars` gesplittet.
- Kurze Codeblöcke werden als Embeds/Cards gesendet.
- Lange Codeblöcke und sehr lange Antworten werden als `.md` Attachment ausgelagert.
- Fehler werden als Embed gepostet.
- Tool-Status-Renderer ist vorhanden; Event-Posting für Tool-Events ist noch nicht vollständig verdrahtet.

## Admin-Kommandos im Daemon

Der Daemon registriert `/pi` Slash Commands:

- `/pi status` – Sessions, Queues und Metriken anzeigen
- `/pi reset` – neue Session für aktuellen Arbeits-Thread erzeugen
- `/pi compact` – aktuelle Thread-Session kompaktieren
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

## Aktuelle Einschränkungen

Nicht alle Punkte aus `DESIGN.md` sind vollständig umgesetzt:

- Bildanhänge werden noch nicht multimodal an pi übergeben, sondern als Link/Metadaten.
- Streaming nach Discord ist nur gepuffert vorbereitet; produktiv wird final nach `message_end`/Session-Antwort gepostet.
- Tool-Execution-Events werden noch nicht automatisch nach Discord gepostet.
- Knowledgebase nutzt Keyword-Scoring, keine Embeddings/Vektorindexe.
- Knowledgebase lädt Anhänge nicht inhaltlich herunter, sondern verlinkt sie.
- Archivierungs-/Idle-Dispose-Verhalten für Forum-Threads ist rudimentär.
- Klassische Textchannels im Daemon sind nicht als eigene Multi-Session-Routen umgesetzt; dafür gibt es den Extension-Modus.

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
