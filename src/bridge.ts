#!/usr/bin/env node
import process from "node:process";
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type PartialMessage,
  type TextBasedChannel,
  type ThreadChannel,
} from "discord.js";
import { normalizeDiscordAttachments } from "./attachments.js";
import { loadConfig } from "./config.js";
import { sendPayloadsQueued, StreamingDiscordResponse } from "./discord-output.js";
import { DiscordKnowledgebase } from "./knowledgebase.js";
import { PiSessionPool, buildForumRouteKey, buildTextChannelRouteKey, type SessionRouteMetadata } from "./pi-session-pool.js";
import { DiscordSendQueue } from "./rate-limit.js";
import { redactSecrets } from "./redaction.js";
import { renderDiscordMessages, renderErrorMessage, renderToolStatusMessage, type RenderedDiscordPayload } from "./renderer.js";
import type { DiscordBridgeConfig, ForumChannelConfig, KnowledgebaseChannelConfig, SingleSessionChannelConfig } from "./types.js";

const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

interface Metrics {
  prompts: number;
  errors: number;
  kbUpdates: number;
  startedAt: Date;
}

type SendableChannel = TextBasedChannel & { send: (payload: string | RenderedDiscordPayload) => Promise<Message> };

function log(level: "info" | "warn" | "error", message: string, meta: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

class ThreadQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private running = false;

  get pendingCount(): number {
    return this.pending;
  }

  get isRunning(): boolean {
    return this.running;
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const run = this.tail.then(async () => {
      this.running = true;
      this.pending -= 1;
      try {
        await task();
      } finally {
        this.running = false;
      }
    }, async () => {
      this.running = true;
      this.pending -= 1;
      try {
        await task();
      } finally {
        this.running = false;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function getForumChannels(config: DiscordBridgeConfig): Map<string, ForumChannelConfig> {
  const channels = new Map<string, ForumChannelConfig>();
  for (const channel of config.channels) if (channel.mode === "forum") channels.set(channel.channelId, channel);
  return channels;
}

function getSingleSessionChannels(config: DiscordBridgeConfig): Map<string, SingleSessionChannelConfig> {
  const channels = new Map<string, SingleSessionChannelConfig>();
  for (const channel of config.channels) if (channel.mode === "single-session") channels.set(channel.channelId, channel);
  return channels;
}

function getKnowledgebaseChannels(config: DiscordBridgeConfig): Map<string, KnowledgebaseChannelConfig> {
  const channels = new Map<string, KnowledgebaseChannelConfig>();
  for (const channel of config.channels) if (channel.mode === "knowledgebase") channels.set(channel.channelId, channel);
  return channels;
}

function memberHasAllowedRole(member: ChatInputCommandInteraction["member"], config: DiscordBridgeConfig): boolean {
  if (config.allowedRoleIds.length === 0) return true;
  const roles = member?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return config.allowedRoleIds.some((roleId) => roles.includes(roleId));
  return config.allowedRoleIds.some((roleId) => roles.cache.has(roleId));
}

function hasAllowedRole(message: Message, config: DiscordBridgeConfig): boolean {
  if (config.allowedRoleIds.length === 0) return true;
  if (!message.member) return false;
  return config.allowedRoleIds.some((roleId) => message.member?.roles.cache.has(roleId));
}

function isAllowedUser(message: Message, config: DiscordBridgeConfig): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(message.author.id);
}

function isAllowedInteraction(interaction: ChatInputCommandInteraction, config: DiscordBridgeConfig): boolean {
  if (config.guildId && interaction.guildId !== config.guildId) return false;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(interaction.user.id)) return false;
  return memberHasAllowedRole(interaction.member, config);
}

function normalizePrompt(message: Message, config: DiscordBridgeConfig, clientId?: string): string | undefined {
  let content = message.content.trim();
  if (!content && message.attachments.size === 0) return undefined;
  if (config.requireMention) {
    if (!clientId || !message.mentions.users.has(clientId)) return undefined;
    content = content.replace(new RegExp(`<@!?${clientId}>`, "g"), "").trim();
  }
  if (config.prefix) {
    if (!content.startsWith(config.prefix)) return config.requireMention ? content || undefined : undefined;
    content = content.slice(config.prefix.length).trim();
  }
  return content;
}

function getThreadChannel(message: Message): ThreadChannel | undefined {
  if (!message.channel.isThread()) return undefined;
  if (message.channel.type !== ChannelType.PublicThread && message.channel.type !== ChannelType.PrivateThread) return undefined;
  return message.channel;
}

function getInteractionThread(interaction: ChatInputCommandInteraction): ThreadChannel | undefined {
  const channel = interaction.channel;
  if (!channel?.isThread()) return undefined;
  if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) return undefined;
  return channel;
}

function canSend(channel: Message["channel"]): channel is SendableChannel {
  return "send" in channel && typeof channel.send === "function";
}

function interactionSendableChannel(interaction: ChatInputCommandInteraction): SendableChannel | undefined {
  const channel = interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") return undefined;
  return channel as SendableChannel;
}

function makeSessionName(forum: ForumChannelConfig, thread: ThreadChannel): string {
  return `${forum.sessionNamePrefix ?? "forum-"}${thread.name}`.slice(0, 100);
}

function makeRouteMetadata(message: Message, forum: ForumChannelConfig, thread: ThreadChannel): SessionRouteMetadata {
  const guildId = message.guild?.id ?? "unknown";
  const forumId = thread.parentId ?? forum.channelId;
  return {
    routeKey: buildForumRouteKey({ guildId, forumId, threadId: thread.id }),
    kind: "forum-thread",
    guildId,
    forumId,
    threadId: thread.id,
    threadName: thread.name,
    sessionName: makeSessionName(forum, thread),
  };
}

function makeTextRouteMetadata(message: Message, channelConfig: SingleSessionChannelConfig): SessionRouteMetadata {
  const guildId = message.guild?.id ?? "unknown";
  const channelName = "name" in message.channel && typeof message.channel.name === "string" ? message.channel.name : message.channelId;
  return {
    routeKey: buildTextChannelRouteKey({ guildId, channelId: message.channelId }),
    kind: "text-channel",
    guildId,
    channelId: message.channelId,
    channelName,
    sessionName: channelConfig.sessionName ?? `channel-${channelName}`,
  };
}

function makeInteractionRouteMetadata(interaction: ChatInputCommandInteraction, forum: ForumChannelConfig, thread: ThreadChannel): SessionRouteMetadata {
  const guildId = interaction.guildId ?? "unknown";
  const forumId = thread.parentId ?? forum.channelId;
  return {
    routeKey: buildForumRouteKey({ guildId, forumId, threadId: thread.id }),
    kind: "forum-thread",
    guildId,
    forumId,
    threadId: thread.id,
    threadName: thread.name,
    sessionName: makeSessionName(forum, thread),
  };
}

function makeTextInteractionRouteMetadata(interaction: ChatInputCommandInteraction, channelConfig: SingleSessionChannelConfig): SessionRouteMetadata {
  const guildId = interaction.guildId ?? "unknown";
  const channel = interaction.channel;
  const channelName = channel && "name" in channel && typeof channel.name === "string" ? channel.name : interaction.channelId;
  return {
    routeKey: buildTextChannelRouteKey({ guildId, channelId: interaction.channelId }),
    kind: "text-channel",
    guildId,
    channelId: interaction.channelId,
    channelName,
    sessionName: channelConfig.sessionName ?? `channel-${channelName}`,
  };
}

function discordMessageUrl(message: Message): string {
  return `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`;
}

function initialContext(message: Message, metadata: SessionRouteMetadata): string {
  const lines = [
    metadata.kind === "forum-thread" ? "Discord-Arbeitsforum-Kontext:" : "Discord-Textchannel-Kontext:",
    `- Guild: ${message.guild?.name ?? message.guildId ?? "unknown"} (${message.guildId ?? "unknown"})`,
  ];
  if (metadata.kind === "forum-thread") {
    lines.push(`- Forum: ${metadata.forumId ?? "unknown"}`, `- Thread: ${metadata.threadName ?? metadata.threadId} (${metadata.threadId ?? "unknown"})`);
  } else {
    lines.push(`- Channel: ${metadata.channelName ?? metadata.channelId} (${metadata.channelId ?? "unknown"})`);
  }
  lines.push(`- Autor: ${message.author.tag} (${message.author.id})`, `- Link: ${discordMessageUrl(message)}`);
  return lines.join("\n");
}

function buildPrompt(
  message: Message,
  metadata: SessionRouteMetadata,
  content: string,
  includeInitialContext: boolean,
  knowledgebaseContext?: string,
  attachmentSection?: string,
): string {
  const routeLabel = metadata.kind === "forum-thread"
    ? `Thread ${metadata.threadName ?? metadata.threadId}`
    : `Channel ${metadata.channelName ?? metadata.channelId}`;
  return [
    includeInitialContext ? initialContext(message, metadata) : undefined,
    knowledgebaseContext,
    `Discord-Nachricht von ${message.author.tag} im ${routeLabel}:`,
    content.trim() || "_(kein Nachrichtentext)_",
    attachmentSection,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

async function indexKnowledgebaseMessage(message: Message, knowledgebase: DiscordKnowledgebase, knowledgebaseChannels: Map<string, KnowledgebaseChannelConfig>): Promise<boolean> {
  const thread = getThreadChannel(message);
  if (!thread || !knowledgebase.isKnowledgebaseThread(thread, knowledgebaseChannels)) return false;
  await knowledgebase.upsertThread(thread);
  return true;
}

async function resolveFullMessage(message: Message | PartialMessage): Promise<Message | undefined> {
  if (!message.partial) return message as Message;
  return message.fetch().catch(() => undefined);
}

type SubscribableSession = {
  subscribe: (listener: (event: unknown) => void) => () => void;
};

function extractToolOutput(event: unknown, maxChars: number, redactionPatterns?: string[]): string | undefined {
  const typed = event as { output?: unknown; result?: unknown };
  const raw = typeof typed.output === "string" ? typed.output : typeof typed.result === "string" ? typed.result : typed.result ? JSON.stringify(typed.result) : undefined;
  return raw ? redactSecrets(raw.slice(0, maxChars), redactionPatterns) : undefined;
}

function bindSessionDiscordEvents(input: {
  routeKey: string;
  session: SubscribableSession;
  channel: SendableChannel;
  config: DiscordBridgeConfig;
  sendQueue: DiscordSendQueue;
  streamers: Map<string, StreamingDiscordResponse>;
  subscriptions: Map<string, () => void>;
}) {
  const { routeKey, session, channel, config, sendQueue, streamers, subscriptions } = input;
  if (subscriptions.has(routeKey)) return;
  const unsubscribe = session.subscribe((event: unknown) => {
    const typed = event as { type?: string; message?: { role?: string }; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; name?: string; error?: unknown };
    if (typed.type === "message_update" && typed.message?.role === "assistant" && typed.assistantMessageEvent?.type === "text_delta") {
      if (!config.discord.streamUpdates) return;
      let streamer = streamers.get(routeKey);
      if (!streamer) {
        streamer = new StreamingDiscordResponse(channel, sendQueue, config.discord);
        streamers.set(routeKey, streamer);
      }
      streamer.append(redactSecrets(typed.assistantMessageEvent.delta ?? "", config.redactionPatterns));
      return;
    }
    if (typed.type === "message_end" && typed.message?.role === "assistant") {
      void streamers.get(routeKey)?.finish();
      return;
    }
    if (!config.discord.postToolEvents) return;
    if (typed.type === "tool_execution_start") {
      void sendPayloadsQueued(sendQueue, channel, renderToolStatusMessage({
        toolName: typed.toolName ?? typed.name ?? "tool",
        status: "running",
        summary: "Tool wird ausgeführt…",
      }, config.discord)).catch(() => undefined);
      return;
    }
    if (typed.type === "tool_execution_end") {
      void sendPayloadsQueued(sendQueue, channel, renderToolStatusMessage({
        toolName: typed.toolName ?? typed.name ?? "tool",
        status: typed.error ? "error" : "success",
        summary: typed.error ? redactSecrets(String(typed.error), config.redactionPatterns) : "Tool abgeschlossen.",
        output: extractToolOutput(event, config.discord.maxToolOutputChars ?? 4000, config.redactionPatterns),
      }, config.discord)).catch(() => undefined);
    }
  });
  subscriptions.set(routeKey, unsubscribe);
}

function slashCommands() {
  return [
    new SlashCommandBuilder().setName("pi").setDescription("pi Discord Bridge Administration")
      .addSubcommand((cmd) => cmd.setName("status").setDescription("Bridge-Status anzeigen"))
      .addSubcommand((cmd) => cmd.setName("reset").setDescription("Neue pi-Session für diesen Thread erzeugen"))
      .addSubcommand((cmd) => cmd.setName("compact").setDescription("Aktuelle Thread-Session kompaktieren"))
      .addSubcommand((cmd) => cmd.setName("abort").setDescription("Laufende Bearbeitung in diesem Thread abbrechen"))
      .addSubcommand((cmd) => cmd.setName("help").setDescription("Erlaubte Admin-Kommandos anzeigen"))
      .toJSON(),
  ];
}

function commandHelp(): string {
  return [
    "Verfügbare Kommandos:",
    "- `/pi status` – Sessions, Queues und Laufstatus anzeigen",
    "- `/pi reset` – neue Session für diesen Thread erzeugen",
    "- `/pi compact` – lokale pi-Compaction für diesen Thread starten",
    "- `/pi abort` – laufende Bearbeitung abbrechen",
    "",
    "Modell, Provider, Thinking-Level und API-Keys können über Discord nicht gelesen oder geändert werden.",
  ].join("\n");
}

async function handleAdminCommand(input: {
  interaction: ChatInputCommandInteraction;
  config: DiscordBridgeConfig;
  forumChannels: Map<string, ForumChannelConfig>;
  singleSessionChannels: Map<string, SingleSessionChannelConfig>;
  pool: PiSessionPool;
  queues: Map<string, ThreadQueue>;
  semaphore: Semaphore;
  sendQueue: DiscordSendQueue;
  metrics: Metrics;
  streamers: Map<string, StreamingDiscordResponse>;
  subscriptions: Map<string, () => void>;
}) {
  const { interaction, config, forumChannels, singleSessionChannels, pool, queues, semaphore, sendQueue, metrics, streamers, subscriptions } = input;
  if (!isAllowedInteraction(interaction, config)) {
    await interaction.reply({ content: "Keine Berechtigung für pi-Admin-Kommandos.", ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "help") {
    await interaction.reply({ content: commandHelp(), ephemeral: true });
    return;
  }

  if (subcommand === "status") {
    const status = pool.getStatus().slice(0, 10).map((entry) => {
      const queue = queues.get(entry.routeKey);
      const id = entry.kind === "forum-thread" ? `thread=${entry.threadId ?? "-"}` : `channel=${entry.channelId ?? "-"}`;
      return `• ${entry.kind} ${entry.label} (${id}): active=${entry.active}, running=${queue?.isRunning ?? false}, queue=${queue?.pendingCount ?? 0}, pending=${entry.pendingMessages}, session=${entry.sessionId?.slice(0, 8) ?? "-"}`;
    });
    const uptimeSec = Math.round((Date.now() - metrics.startedAt.getTime()) / 1000);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("pi Bridge Status")
        .setDescription(status.length ? status.join("\n") : "Keine aktiven Sessions.")
        .addFields(
          { name: "Queues", value: `Discord-send=${sendQueue.pendingCount}, Agent-running=${semaphore.activeCount}, Agent-waiting=${semaphore.waitingCount}` },
          { name: "Metriken", value: `Prompts=${metrics.prompts}, KB-Updates=${metrics.kbUpdates}, Fehler=${metrics.errors}, Uptime=${uptimeSec}s` },
        )
        .setColor(0x5865f2)],
      ephemeral: true,
    });
    return;
  }

  const thread = getInteractionThread(interaction);
  const forum = thread?.parentId ? forumChannels.get(thread.parentId) : undefined;
  const textConfig = interaction.channelId ? singleSessionChannels.get(interaction.channelId) : undefined;
  const metadata = thread && forum
    ? makeInteractionRouteMetadata(interaction, forum, thread)
    : textConfig
      ? makeTextInteractionRouteMetadata(interaction, textConfig)
      : undefined;
  if (!metadata) {
    await interaction.reply({ content: "Dieses Kommando muss in einem konfigurierten Arbeits-Thread oder Single-Session-Textchannel ausgeführt werden.", ephemeral: true });
    return;
  }
  if (subcommand === "reset") {
    subscriptions.get(metadata.routeKey)?.();
    subscriptions.delete(metadata.routeKey);
    streamers.get(metadata.routeKey)?.reset();
    streamers.delete(metadata.routeKey);
    pool.reset(metadata.routeKey);
    queues.delete(metadata.routeKey);
    await pool.getOrCreate(metadata);
    log("info", "session reset via discord", { routeKey: metadata.routeKey, userId: interaction.user.id });
    await interaction.reply({ content: "Neue Session für diesen Thread wurde erzeugt.", ephemeral: true });
    return;
  }

  const pooled = await pool.getOrCreate(metadata);
  if (subcommand === "abort") {
    await pooled.session.abort();
    log("info", "session abort via discord", { routeKey: metadata.routeKey, userId: interaction.user.id });
    await interaction.reply({ content: "Laufende Bearbeitung wurde abgebrochen.", ephemeral: true });
    return;
  }

  if (subcommand === "compact") {
    await interaction.deferReply({ ephemeral: true });
    await pooled.session.compact();
    log("info", "session compact via discord", { routeKey: metadata.routeKey, userId: interaction.user.id });
    await interaction.editReply("Session wurde kompaktifiziert.");
  }
}

async function runBridge() {
  const cwd = process.cwd();
  const config = loadConfig({ cwd, projectTrusted: true });
  if (!config) throw new Error("Keine Discord-Bridge-Konfiguration gefunden");
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error(`Env ${config.tokenEnv} fehlt`);

  const forumChannels = getForumChannels(config);
  const singleSessionChannels = getSingleSessionChannels(config);
  const knowledgebaseChannels = getKnowledgebaseChannels(config);
  if (forumChannels.size === 0 && singleSessionChannels.size === 0) throw new Error("Keine forum oder single-session Channels konfiguriert");

  const metrics: Metrics = { prompts: 0, errors: 0, kbUpdates: 0, startedAt: new Date() };
  const knowledgebase = new DiscordKnowledgebase({
    config: config.knowledgebase,
    discord: config.discord,
    redactionPatterns: config.redactionPatterns,
  });
  const subscriptions = new Map<string, () => void>();
  const streamers = new Map<string, StreamingDiscordResponse>();
  const pool = new PiSessionPool({
    cwd: config.cwd ?? cwd,
    idleDisposeMs: config.idleDisposeMs,
    onDispose: (routeKey) => {
      subscriptions.get(routeKey)?.();
      subscriptions.delete(routeKey);
      streamers.get(routeKey)?.reset();
      streamers.delete(routeKey);
    },
  });
  const queues = new Map<string, ThreadQueue>();
  const semaphore = new Semaphore(config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS);
  const sendQueue = new DiscordSendQueue();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on("ready", async () => {
    log("info", "discord bridge daemon ready", { bot: client.user?.tag });
    await client.application?.commands.set(slashCommands()).catch((error: unknown) => {
      metrics.errors += 1;
      log("error", "slash command registration failed", { error: error instanceof Error ? error.message : String(error) });
    });
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "pi") return;
    try {
      await handleAdminCommand({ interaction, config, forumChannels, singleSessionChannels, pool, queues, semaphore, sendQueue, metrics, streamers, subscriptions });
    } catch (error) {
      metrics.errors += 1;
      log("error", "admin command failed", { error: error instanceof Error ? error.message : String(error), userId: interaction.user.id });
      const payload = { content: `Fehler: ${redactSecrets(error instanceof Error ? error.message : String(error), config.redactionPatterns)}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload.content);
      else await interaction.reply(payload);
    }
  });

  client.on("messageCreate", async (message) => {
    if (!message.guild) return;
    if (config.guildId && message.guild.id !== config.guildId) return;

    if (await indexKnowledgebaseMessage(message, knowledgebase, knowledgebaseChannels).then((indexed) => {
      if (indexed) metrics.kbUpdates += 1;
      return indexed;
    }).catch((error: unknown) => {
      metrics.errors += 1;
      log("error", "knowledgebase update failed", { error: error instanceof Error ? error.message : String(error) });
      return true;
    })) return;

    if (message.author.bot) return;
    if (!isAllowedUser(message, config)) return;
    if (!hasAllowedRole(message, config)) return;

    const thread = getThreadChannel(message);
    const forum = thread?.parentId ? forumChannels.get(thread.parentId) : undefined;
    const textConfig = !thread ? singleSessionChannels.get(message.channelId) : undefined;
    if (!forum && !textConfig) return;
    if (!canSend(message.channel)) return;
    const normalized = normalizePrompt(message, config, client.user?.id);
    if (!normalized) return;

    const metadata = thread && forum ? makeRouteMetadata(message, forum, thread) : makeTextRouteMetadata(message, textConfig!);
    const routeChannel = message.channel as SendableChannel;
    const queue = queues.get(metadata.routeKey) ?? new ThreadQueue();
    queues.set(metadata.routeKey, queue);

    await queue.enqueue(async () => {
      await semaphore.run(async () => {
        try {
          metrics.prompts += 1;
          if (config.discord.sendTyping && "sendTyping" in routeChannel) await routeChannel.sendTyping().catch(() => undefined);

          const pooled = await pool.getOrCreate(metadata);
          bindSessionDiscordEvents({
            routeKey: metadata.routeKey,
            session: pooled.session,
            channel: routeChannel,
            config,
            sendQueue,
            streamers,
            subscriptions,
          });
          const includeInitialContext = !pooled.mapping.initialized;
          const attachments = await normalizeDiscordAttachments(message, config.discord, config.redactionPatterns);
          const kbContext = knowledgebase.buildContext(`${metadata.threadName ?? metadata.channelName ?? ""}\n${normalized}\n${attachments.promptSection ?? ""}`, {
            forumIds: [...knowledgebaseChannels.keys()],
            limit: Math.max(1, ...[...knowledgebaseChannels.values()].map((channel) => channel.maxContextThreads ?? 3)),
          });
          const prompt = buildPrompt(message, metadata, normalized, includeInitialContext, kbContext?.markdown, attachments.promptSection);

          await pooled.session.sendUserMessage(prompt, pooled.session.isStreaming ? { deliverAs: "followUp" } : undefined);
          pool.markInitialized(metadata.routeKey);

          const answer = pooled.session.getLastAssistantText();
          if (answer?.trim()) {
            const safeAnswer = redactSecrets(answer, config.redactionPatterns);
            await sendPayloadsQueued(sendQueue, routeChannel, renderDiscordMessages(safeAnswer, config.discord, {
              title: `pi Antwort – ${metadata.threadName ?? metadata.channelName ?? "Discord"}`,
              context: metadata.kind === "forum-thread" ? `Discord Thread ${metadata.threadId}` : `Discord Channel ${metadata.channelId}`,
              preferMarkdownAttachments: true,
              sourceLinks: [discordMessageUrl(message), ...(attachments.sourceLinks ?? []), ...(kbContext?.sourceLinks ?? [])],
            }));
          }
        } catch (error) {
          metrics.errors += 1;
          log("error", "forum thread processing failed", { routeKey: metadata.routeKey, error: error instanceof Error ? error.message : String(error) });
          await sendPayloadsQueued(sendQueue, routeChannel, renderErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error), config.redactionPatterns)));
        }
      });
    });
  });

  client.on("threadUpdate", (_oldThread, newThread) => {
    if (!newThread.parentId || !forumChannels.has(newThread.parentId)) return;
    const routeKey = buildForumRouteKey({ guildId: newThread.guildId, forumId: newThread.parentId, threadId: newThread.id });
    if (newThread.archived) {
      pool.disposeRoute(routeKey);
      log("info", "archived thread session disposed", { routeKey });
    }
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    const message = await resolveFullMessage(newMessage);
    if (!message?.guild) return;
    if (config.guildId && message.guild.id !== config.guildId) return;
    await indexKnowledgebaseMessage(message, knowledgebase, knowledgebaseChannels).then((indexed) => {
      if (indexed) metrics.kbUpdates += 1;
    }).catch((error: unknown) => {
      metrics.errors += 1;
      log("error", "knowledgebase update failed", { error: error instanceof Error ? error.message : String(error) });
    });
  });

  const shutdown = async () => {
    log("info", "discord bridge daemon shutting down");
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    streamers.clear();
    pool.dispose();
    await client.destroy();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await client.login(token);
}

runBridge().catch((error: unknown) => {
  log("error", "bridge startup failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
