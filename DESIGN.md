# pi Discord Bridge Extension – Entwurf

## Zielbild

`pi-discord-bridge` verbindet pi mit Discord:

- Beim Start meldet sich ein konfigurierter Discord-Bot an.
- Nachrichten aus erlaubten Discord-Channels werden als pi-Prompts angenommen.
- Antworten werden gestreamt oder nach Abschluss sauber in Discord gepostet.
- Soweit möglich werden Inhalte direkt als Chat-Nachrichten oder Discord-Cards/Embeds dargestellt.
- In Foren sollen Attachments bevorzugt als Markdown-Dateien (`.md`) erzeugt und an Threads angehängt werden, statt rohe Text-/Code-Dateien zu produzieren.
- Lange Antworten werden in Discord-konforme Chunks aufgeteilt.
- Codeblöcke werden als kompakte Cards/Embeds zusammengefasst und nur bei Bedarf als Markdown-Attachments ausgelagert.
- Discord-Foren werden unterstützt: Jeder Arbeits-Forum-Thread entspricht einer eigenen pi-Session.
- Ein zweites Forum kann als Knowledgebase überwacht werden; dessen Threads werden indexiert und bei passenden Prompts als zusätzlicher Kontext genutzt.

## Wichtige Architekturentscheidung

Für einen einzelnen Channel kann eine klassische pi-Extension reichen: Sie startet in `session_start` einen Discord-Client, leitet Discord-Nachrichten mit `pi.sendUserMessage()` in die aktuell laufende pi-Session und postet `message_update`/`message_end` zurück.

Für Discord-Foren mit „ein Thread = eine eigene pi-Session“ ist eine reine Extension im selben pi-Prozess nur eingeschränkt geeignet, weil Extension-Eventhandler nicht beliebig parallel mehrere aktive pi-Sessions besitzen. Empfohlen ist daher ein hybrides Design:

1. **Extension-Modus** für einfachen Single-Session-Betrieb.
2. **Bridge/SDK-Modus** als bevorzugter Modus für mehrere Channel/Forum-Threads, bei dem ein Node-Service pro Discord-Thread eine eigene `AgentSession` oder einen eigenen RPC-Prozess verwaltet.

Das Projekt sollte deshalb als pi-Package ausgeliefert werden mit:

- `src/extension.ts`: pi-Extension für Single-Session/embedded use.
- `src/bridge.ts`: eigenständiger Discord-Bridge-Daemon auf Basis des pi SDK.
- gemeinsamer Discord-, Config- und Rendering-Schicht.

## Paketstruktur

```text
pi-discord-bridge/
├── package.json
├── README.md
├── src/
│   ├── extension.ts          # pi Extension entrypoint
│   ├── bridge.ts             # Standalone daemon: Discord <-> mehrere pi AgentSessions
│   ├── config.ts             # Config laden/validieren
│   ├── discord-client.ts     # discord.js Client, Events, Permissions
│   ├── session-router.ts     # Discord Channel/Thread <-> pi Session Mapping
│   ├── pi-session-pool.ts    # SDK/RPC Session Lifecycle
│   ├── knowledgebase.ts      # Discord-Forum indexieren und relevante Inhalte suchen
│   ├── renderer.ts           # Markdown -> Discord Messages/Embeds/Attachments
│   ├── rate-limit.ts         # Queueing, Backoff, Discord Limits
│   └── types.ts
└── examples/
    └── config.example.json
```

## Konfiguration

Globale Config z.B. `~/.pi/agent/discord-bridge.json`, optional projektlokal `.pi/discord-bridge.json` nur bei trusted project.

```json
{
  "tokenEnv": "DISCORD_BOT_TOKEN",
  "clientId": "1234567890",
  "guildId": "1234567890",
  "cwd": "/path/to/project",
  "allowedUserIds": ["111", "222"],
  "channels": [
    {
      "channelId": "333",
      "mode": "single-session",
      "sessionName": "discord-main"
    },
    {
      "channelId": "444",
      "mode": "forum",
      "sessionNamePrefix": "forum-"
    },
    {
      "channelId": "555",
      "mode": "knowledgebase",
      "indexName": "discord-kb",
      "maxContextThreads": 5
    }
  ],
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "thinkingLevel": "medium"
  },
  "discord": {
    "sendTyping": true,
    "streamUpdates": false,
    "maxMessageChars": 1900,
    "maxCodeCharsInline": 900,
    "largeCodeAsAttachment": true
  }
}
```

## Discord Routing

### Normale Textchannels

- Ein Channel kann an eine vorhandene pi-Session gebunden werden.
- Neue Discord-Nachrichten werden ignoriert, wenn sie vom Bot selbst stammen.
- Optional nur Erwähnungen (`@bot`) oder Präfix (`!pi`) akzeptieren.
- Wenn pi gerade arbeitet:
  - `followUp` als Default: Anfrage wird queued.
  - optional `steer`: neue Nachricht greift in die laufende Bearbeitung ein.

### Arbeits-Foren

- `ForumChannel` wird überwacht.
- Jeder `ThreadChannel` erhält einen eigenen Session-Key:
  - `discord:guild:<guildId>:forum:<forumId>:thread:<threadId>`
- Mapping persistent speichern:
  - in `~/.pi/agent/discord-bridge-sessions.json`
  - oder im Session-Namen/Metadata-Entry.
- Beim ersten Post in einem Thread:
  - neue pi-Session erstellen,
  - Session-Name auf Thread-Titel setzen,
  - Initial-Kontext injizieren: Guild, Forum, Thread, Author, Link.
- Bei archivierten Threads Session idle halten oder dispose; bei neuer Aktivität wieder öffnen.

### Knowledgebase-Forum

Ein zusätzlich konfigurierbares Discord-Forum dient als Knowledgebase. Es erzeugt keine eigenen Arbeits-Sessions, sondern wird beobachtet, gelesen, indexiert und bei passenden Prompts als Kontextquelle genutzt.

- Jeder Knowledgebase-Thread ist ein Knowledge-Dokument.
- Thread-Titel, Startpost, Antworten, Anhänge und Links werden erfasst.
- Änderungen im Forum aktualisieren den lokalen Index inkrementell.
- Der Bot reagiert im Knowledgebase-Forum nicht wie ein Agent auf Nachrichten, sondern behandelt Posts als Wissensdaten.
- Für jeden eingehenden Prompt in einem Arbeits-Channel/-Thread sucht die Bridge relevante KB-Threads und injiziert kurze Auszüge plus Discord-Links in den pi-Prompt.
- Optional kann der Agent bei Bedarf explizit vollständige KB-Inhalte nachladen, aber nur lesend.

Persistenz:

```text
~/.pi/agent/discord-bridge-kb/
├── index.json              # Metadaten, Thread IDs, Hashes, Zeitstempel
├── threads/
│   └── <threadId>.md       # normalisierter Thread-Inhalt
└── vectors/                # optionaler Embedding-/Suchindex
```

Retrieval-Strategie:

1. Neuer Prompt kommt aus Discord.
2. Query aus Prompt, Thread-Titel und ggf. Session-Zusammenfassung bilden.
3. Lokalen KB-Index durchsuchen:
   - MVP: Keyword/BM25-artige Suche.
   - später: Embeddings/Vektorindex.
4. Top-N relevante Threads auswählen.
5. Kontext injizieren:
   - Titel
   - kurzer Auszug
   - Relevanzgrund
   - Discord-Link zum Thread/Post
6. pi antwortet mit sichtbarer Quellenangabe, wenn KB-Inhalte verwendet wurden.

## Session-Strategie

### Extension-Modus

Geeignet für genau eine aktive pi-Session:

- Discord-Client in `session_start` starten.
- In `session_shutdown` sauber `client.destroy()`.
- Discord-Input via `pi.sendUserMessage()`.
- Output via Events `message_update`, `message_end`, `tool_execution_*` sammeln und posten.

Limitation: Forum-Threads können nicht sauber parallel als getrennte Sessions in derselben Extension bedient werden.

### SDK/Daemon-Modus – empfohlen

Der Daemon nutzt `createAgentSession()` oder `createAgentSessionRuntime()` pro Discord-Thread/Channel.

- `SessionPool.getOrCreate(routeKey)` erzeugt/lädt eine pi-Session.
- Pro Session eine Queue, damit Nachrichten eines Threads sequentiell verarbeitet werden.
- Mehrere Threads können parallel laufen, begrenzt durch `maxConcurrentSessions`.
- Events jeder AgentSession werden an den passenden Discord-Thread gerendert.

## Antwort-Rendering für Discord

Discord-Limits:

- Message Content: 2000 Zeichen, praktisch 1900 reservieren.
- Embed Description: 4096 Zeichen.
- Max. 10 Embeds pro Message.
- Rate Limits strikt respektieren.

Renderer-Pipeline:

1. Assistant-Markdown in Blöcke parsen:
   - Text
   - fenced code block
   - tables/lists
   - tool summary
2. Zuerst versuchen, alles direkt in Discord abzubilden:
   - normaler Text als Chat-Nachricht
   - strukturierte Abschnitte als Embeds/Cards
   - kurze Codeblöcke als Code-Card mit Syntaxhinweis
   - Tool-Status als kompakte Card
3. Textblöcke in Chunks ≤ `maxMessageChars` splitten.
4. Codeblöcke:
   - kurz: Embed/Card mit Sprache, Preview, Copy-Hinweis.
   - mittel: mehrere Cards.
   - lang: gekürzte Preview + Markdown-Datei als Attachment.
5. Attachments in Foren bevorzugt als `.md` erzeugen:
   - vollständige Antwort: `pi-answer-<timestamp>.md`
   - große Code-/Diff-Auszüge: `pi-code-<timestamp>.md`
   - große Tool-/Log-Auszüge: `pi-log-<timestamp>.md`
   - Inhalt enthält Überschrift, Kontext, fenced code blocks und Quellenlinks.
6. Tool-Ausgaben:
   - kompakte Status-Embeds, z.B. `read`, `edit`, `bash`.
   - große Logs nie vollständig in Discord posten; Markdown-Attachment oder gekürzte Zusammenfassung.
7. Streaming optional:
   - während der Generierung `typing` senden.
   - final posten ist robuster als Message-Edit-Spam.

Beispiel Card für Code:

```text
Embed title: Code: src/foo.ts
Description:
```ts
<gekürzte Vorschau>
```
Footer: gekürzt – vollständiger Inhalt als Markdown-Attachment
```

## Event-Mapping

| pi Event | Discord-Verhalten |
|---|---|
| `agent_start` | Typing starten, optional Status-Message |
| `message_update` | optional Buffer aktualisieren, nicht jeden Delta posten |
| `tool_execution_start` | kompakte Tool-Status-Card optional |
| `tool_execution_end` | Tool-Zusammenfassung oder Fehler-Embed |
| `message_end` Assistant | finale Antwort rendern und senden |
| `agent_end` | Typing/Status abschließen |
| Fehler | Fehler-Embed mit kurzer Ursache |

## Sicherheitsmodell

- Bot-Token nur per Env-Var, nie in Config im Klartext erzwingen.
- Guild-, Channel- und User-Allowlist.
- Optional Rollen-Allowlist.
- Optional Prefix/Mention-Pflicht, um versehentliche Prompts zu vermeiden.
- Projektlokale Config nur lesen, wenn `ctx.isProjectTrusted()` true ist.
- Tool-Ausgaben können Secrets enthalten: Renderer sollte Redaction-Hooks unterstützen.
- Slash-Command `/pi disconnect`, `/pi status`, `/pi session` nur für berechtigte Nutzer.
- Discord darf keine Modellwechsel auslösen. Modellwahl und Thinking-Level bleiben ausschließlich lokale Agent-Konfiguration.
- Renderer soll zuerst Chat/Card-Ausgabe bevorzugen und nur bei Länge/Komplexität auf Markdown-Attachments ausweichen.
- In Forum-Threads sollen Attachments möglichst immer Markdown-Dateien sein, damit Ergebnisse direkt versionierbar/weiterverwendbar bleiben.

## Discord Commands

Später sinnvoll:

- `/pi status` – aktive Session, Modell, Queue, Kosten/Token grob.
- `/pi reset` – neue Session für Channel/Thread.
- `/pi compact` – Session kompaktieren.
- `/pi abort` – laufende Bearbeitung abbrechen.
- `/pi mode followup|steer` – Verhalten bei laufender Session.

## Implementierungsphasen

### Phase 1: MVP Single Channel Extension

- Config laden.
- Discord Bot anmelden.
- Einen Textchannel überwachen.
- Eingaben mit `pi.sendUserMessage()` weiterleiten.
- Assistant-Endantwort nach Discord posten.
- Sauberes Chunking von Text.

### Phase 2: Robuster Renderer

- Markdown-Blockparser.
- Code Cards/Embeds.
- Attachments für große Codeblöcke/Logs.
- Fehler-Embeds und Rate-Limit-Queue.

### Phase 3: SDK Daemon für Multi-Session

- `bridge.ts` mit `SessionPool`.
- Pro Channel/Thread eigene AgentSession.
- Persistentes Mapping Discord Thread -> Sessionfile.
- Reconnect/Resume nach Prozessneustart.

### Phase 4: Arbeits-Forum-Support

- Forum-Channel-Events.
- Thread-Erstellung/Archivierung.
- Thread-Titel als Session-Name.
- Optional Startpost als System-/Kontextinfo.

### Phase 5: Knowledgebase-Forum

- Zweites Forum als reine Wissensquelle überwachen.
- Threads normalisieren und lokal speichern.
- Keyword-Suche als MVP.
- Relevante KB-Auszüge vor Prompts injizieren.
- Quellenlinks in Antworten unterstützen.

### Phase 6: Commands & Admin

- Discord Slash Commands.
- Permission-Modell.
- Session-Steuerung ohne Modellwechsel.
- Observability: Logs, Status, Metriken.

## Minimales Extension-Skelett

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client, GatewayIntentBits, Partials } from "discord.js";

export default function discordBridge(pi: ExtensionAPI) {
  let client: Client | undefined;
  let output = "";

  pi.on("session_start", async (_event, ctx) => {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      ctx.ui.notify("DISCORD_BOT_TOKEN fehlt", "warning");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;
      // TODO: channel/user allowlist + prefix/mention parsing
      pi.sendUserMessage(`Discord ${msg.author.tag}:\n${msg.content}`);
    });

    await client.login(token);
    ctx.ui.notify("Discord bridge connected", "info");
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const delta = event.assistantMessageEvent.type === "text_delta"
      ? event.assistantMessageEvent.delta
      : "";
    output += delta;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    // TODO: render output -> Discord chunks/cards
    output = "";
  });

  pi.on("session_shutdown", async () => {
    await client?.destroy();
    client = undefined;
  });
}
```

## Offene Designfragen

- Soll der Bot nur auf Erwähnung reagieren oder jeden Channel-Post als Prompt interpretieren?
- Sollen Discord-Attachments/Bilder an pi weitergereicht werden?
- Wie aggressiv darf gestreamt/editiert werden, ohne Discord Rate Limits zu treffen?
- Sollen Arbeits-Foren-Threads parallel laufen oder global serialisiert werden?
- Sollen Tool-Ausgaben öffentlich gepostet werden oder nur finale Antworten?
- Wie viele Knowledgebase-Treffer dürfen maximal in einen Prompt injiziert werden?
- Sollen Knowledgebase-Attachments indexiert oder nur verlinkt werden?
- Modellwechsel sind bewusst ausgeschlossen: Das Modell wird ausschließlich lokal im pi-Agent/TUI/Settings geändert, niemals über Discord.
