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
  type ThreadChannel,
} from "discord.js";
import { normalizeDiscordAttachments } from "./attachments.js";
import { loadConfig } from "./config.js";
import { DiscordKnowledgebase } from "./knowledgebase.js";
import { PiSessionPool, buildForumRouteKey, type SessionRouteMetadata } from "./pi-session-pool.js";
import { DiscordSendQueue } from "./rate-limit.js";
import { redactSecrets } from "./redaction.js";
import { renderDiscordMessages, renderErrorMessage, type RenderedDiscordPayload } from "./renderer.js";
import type { DiscordBridgeConfig, ForumChannelConfig, KnowledgebaseChannelConfig } from "./types.js";

const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

interface Metrics {
  prompts: number;
  errors: number;
  kbUpdates: number;
  startedAt: Date;
}

type SendableChannel = ThreadChannel & { send: (payload: string | RenderedDiscordPayload) => Promise<Message> };

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

function makeSessionName(forum: ForumChannelConfig, thread: ThreadChannel): string {
  return `${forum.sessionNamePrefix ?? "forum-"}${thread.name}`.slice(0, 100);
}

function makeRouteMetadata(message: Message, forum: ForumChannelConfig, thread: ThreadChannel): SessionRouteMetadata {
  const guildId = message.guild?.id ?? "unknown";
  const forumId = thread.parentId ?? forum.channelId;
  return {
    routeKey: buildForumRouteKey({ guildId, forumId, threadId: thread.id }),
    guildId,
    forumId,
    threadId: thread.id,
    threadName: thread.name,
    sessionName: makeSessionName(forum, thread),
  };
}

function makeInteractionRouteMetadata(interaction: ChatInputCommandInteraction, forum: ForumChannelConfig, thread: ThreadChannel): SessionRouteMetadata {
  const guildId = interaction.guildId ?? "unknown";
  const forumId = thread.parentId ?? forum.channelId;
  return {
    routeKey: buildForumRouteKey({ guildId, forumId, threadId: thread.id }),
    guildId,
    forumId,
    threadId: thread.id,
    threadName: thread.name,
    sessionName: makeSessionName(forum, thread),
  };
}

function discordMessageUrl(message: Message): string {
  return `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`;
}

function initialContext(message: Message, thread: ThreadChannel, forum: ForumChannelConfig): string {
  return [
    "Discord-Arbeitsforum-Kontext:",
    `- Guild: ${message.guild?.name ?? message.guildId ?? "unknown"} (${message.guildId ?? "unknown"})`,
    `- Forum: ${thread.parent?.name ?? forum.channelId} (${forum.channelId})`,
    `- Thread: ${thread.name} (${thread.id})`,
    `- Autor: ${message.author.tag} (${message.author.id})`,
    `- Link: ${discordMessageUrl(message)}`,
  ].join("\n");
}

function buildPrompt(
  message: Message,
  thread: ThreadChannel,
  forum: ForumChannelConfig,
  content: string,
  includeInitialContext: boolean,
  knowledgebaseContext?: string,
  attachmentSection?: string,
): string {
  return [
    includeInitialContext ? initialContext(message, thread, forum) : undefined,
    knowledgebaseContext,
    `Discord-Nachricht von ${message.author.tag} im Thread ${thread.name}:`,
    content.trim() || "_(kein Nachrichtentext)_",
    attachmentSection,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

async function sendPayloads(sendQueue: DiscordSendQueue, channel: SendableChannel, payloads: RenderedDiscordPayload[]) {
  for (const payload of payloads) await sendQueue.enqueue(() => channel.send(payload));
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
  pool: PiSessionPool;
  queues: Map<string, ThreadQueue>;
  semaphore: Semaphore;
  sendQueue: DiscordSendQueue;
  metrics: Metrics;
}) {
  const { interaction, config, forumChannels, pool, queues, semaphore, sendQueue, metrics } = input;
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
      return `• ${entry.threadName} (${entry.threadId}): active=${entry.active}, running=${queue?.isRunning ?? false}, queue=${queue?.pendingCount ?? 0}, pending=${entry.pendingMessages}, session=${entry.sessionId?.slice(0, 8) ?? "-"}`;
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
  if (!thread?.parentId) {
    await interaction.reply({ content: "Dieses Kommando muss in einem konfigurierten Arbeits-Thread ausgeführt werden.", ephemeral: true });
    return;
  }
  const forum = forumChannels.get(thread.parentId);
  if (!forum) {
    await interaction.reply({ content: "Dieser Thread gehört zu keinem konfigurierten Arbeits-Forum.", ephemeral: true });
    return;
  }

  const metadata = makeInteractionRouteMetadata(interaction, forum, thread);
  if (subcommand === "reset") {
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
  const knowledgebaseChannels = getKnowledgebaseChannels(config);
  if (forumChannels.size === 0) throw new Error("Keine forum Channels konfiguriert");

  const metrics: Metrics = { prompts: 0, errors: 0, kbUpdates: 0, startedAt: new Date() };
  const knowledgebase = new DiscordKnowledgebase();
  const pool = new PiSessionPool({ cwd: config.cwd ?? cwd });
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
      await handleAdminCommand({ interaction, config, forumChannels, pool, queues, semaphore, sendQueue, metrics });
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
    if (!thread?.parentId) return;
    const forum = forumChannels.get(thread.parentId);
    if (!forum) return;
    const normalized = normalizePrompt(message, config, client.user?.id);
    if (!normalized) return;

    const metadata = makeRouteMetadata(message, forum, thread);
    const queue = queues.get(metadata.routeKey) ?? new ThreadQueue();
    queues.set(metadata.routeKey, queue);

    await queue.enqueue(async () => {
      await semaphore.run(async () => {
        try {
          metrics.prompts += 1;
          if (config.discord.sendTyping) await thread.sendTyping().catch(() => undefined);

          const pooled = await pool.getOrCreate(metadata);
          const includeInitialContext = !pooled.mapping.initialized;
          const attachments = await normalizeDiscordAttachments(message, config.discord, config.redactionPatterns);
          const kbContext = knowledgebase.buildContext(`${thread.name}\n${normalized}\n${attachments.promptSection ?? ""}`, {
            forumIds: [...knowledgebaseChannels.keys()],
            limit: Math.max(1, ...[...knowledgebaseChannels.values()].map((channel) => channel.maxContextThreads ?? 3)),
          });
          const prompt = buildPrompt(message, thread, forum, normalized, includeInitialContext, kbContext?.markdown, attachments.promptSection);

          await pooled.session.sendUserMessage(prompt, pooled.session.isStreaming ? { deliverAs: "followUp" } : undefined);
          pool.markInitialized(metadata.routeKey);

          const answer = pooled.session.getLastAssistantText();
          if (answer?.trim()) {
            const safeAnswer = redactSecrets(answer, config.redactionPatterns);
            await sendPayloads(sendQueue, thread as SendableChannel, renderDiscordMessages(safeAnswer, config.discord, {
              title: `pi Antwort – ${thread.name}`,
              context: `Discord Thread ${thread.id}`,
              preferMarkdownAttachments: true,
              sourceLinks: [discordMessageUrl(message), ...(attachments.sourceLinks ?? []), ...(kbContext?.sourceLinks ?? [])],
            }));
          }
        } catch (error) {
          metrics.errors += 1;
          log("error", "forum thread processing failed", { routeKey: metadata.routeKey, error: error instanceof Error ? error.message : String(error) });
          await sendPayloads(sendQueue, thread as SendableChannel, renderErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error), config.redactionPatterns)));
        }
      });
    });
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
