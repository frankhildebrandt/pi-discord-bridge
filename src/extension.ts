import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialMessage,
  type ThreadChannel,
} from "discord.js";
import { normalizeDiscordAttachments } from "./attachments.js";
import { loadConfig } from "./config.js";
import { sendPayloadsQueued, StreamingDiscordResponse } from "./discord-output.js";
import { DiscordKnowledgebase } from "./knowledgebase.js";
import { DiscordSendQueue } from "./rate-limit.js";
import { redactSecrets } from "./redaction.js";
import { renderDiscordMessages, renderErrorMessage, renderToolStatusMessage } from "./renderer.js";
import type { DiscordBridgeConfig, KnowledgebaseChannelConfig, SingleSessionChannelConfig } from "./types.js";

function getTextFromAssistantMessage(message: unknown): string {
  const typed = message as { content?: Array<{ type?: string; text?: string }> | string };
  if (typeof typed.content === "string") return typed.content;
  if (!Array.isArray(typed.content)) return "";
  return typed.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function getSingleSessionChannels(config: DiscordBridgeConfig): Map<string, SingleSessionChannelConfig> {
  const channels = new Map<string, SingleSessionChannelConfig>();
  for (const channel of config.channels) {
    if (channel.mode === "single-session") channels.set(channel.channelId, channel);
  }
  return channels;
}

function getKnowledgebaseChannels(config: DiscordBridgeConfig): Map<string, KnowledgebaseChannelConfig> {
  const channels = new Map<string, KnowledgebaseChannelConfig>();
  for (const channel of config.channels) {
    if (channel.mode === "knowledgebase") channels.set(channel.channelId, channel);
  }
  return channels;
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

function normalizePrompt(message: Message, config: DiscordBridgeConfig, clientId?: string): string | undefined {
  let content = message.content.trim();
  if (!content && message.attachments.size === 0) return undefined;

  if (config.requireMention) {
    if (!clientId || !message.mentions.users.has(clientId)) return undefined;
    content = content
      .replace(new RegExp(`<@!?${clientId}>`, "g"), "")
      .trim();
  }

  if (config.prefix) {
    if (!content.startsWith(config.prefix)) {
      if (config.requireMention) return content || undefined;
      return undefined;
    }
    content = content.slice(config.prefix.length).trim();
  }

  return content;
}

type SendableChannel = Message["channel"] & { send: Message["reply"] };

function canSend(channel: Message["channel"]): channel is SendableChannel {
  return "send" in channel && typeof channel.send === "function";
}

function getThreadChannel(message: Message): ThreadChannel | undefined {
  if (!message.channel.isThread()) return undefined;
  if (message.channel.type !== ChannelType.PublicThread && message.channel.type !== ChannelType.PrivateThread) return undefined;
  return message.channel;
}

function discordMessageUrl(message: Message): string {
  return `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`;
}

async function resolveFullMessage(message: Message | PartialMessage): Promise<Message | undefined> {
  if (!message.partial) return message as Message;
  return message.fetch().catch(() => undefined);
}

export default function discordBridge(pi: ExtensionAPI) {
  let client: Client | undefined;
  let config: DiscordBridgeConfig | undefined;
  let activeResponseChannel: SendableChannel | undefined;
  let activeSourceLinks: string[] = [];
  let currentAssistantText = "";
  const sendQueue = new DiscordSendQueue();
  let streamer: StreamingDiscordResponse | undefined;

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    if (!config) return;

    const token = process.env[config.tokenEnv];
    if (!token) {
      ctx.ui.notify(`Discord bridge: env ${config.tokenEnv} fehlt`, "warning");
      return;
    }

    const singleSessionChannels = getSingleSessionChannels(config);
    const knowledgebaseChannels = getKnowledgebaseChannels(config);
    const knowledgebase = new DiscordKnowledgebase({
      config: config.knowledgebase,
      discord: config.discord,
      redactionPatterns: config.redactionPatterns,
    });
    if (singleSessionChannels.size === 0) {
      ctx.ui.notify("Discord bridge: keine single-session Channels konfiguriert", "warning");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel],
    });

    client.on("ready", () => {
      ctx.ui.notify(`Discord bridge verbunden als ${client?.user?.tag ?? "Bot"}`, "info");
    });

    client.on("messageCreate", async (message) => {
      try {
        if (!config || !client) return;
        if (!message.guild) return;
        if (config.guildId && message.guild.id !== config.guildId) return;

        const thread = getThreadChannel(message);
        if (thread && knowledgebase.isKnowledgebaseThread(thread, knowledgebaseChannels)) {
          await knowledgebase.upsertThread(thread);
          return;
        }

        if (message.author.bot) return;
        if (!isAllowedUser(message, config)) return;
        if (!hasAllowedRole(message, config)) return;
        if (!singleSessionChannels.has(message.channelId)) return;

        const prompt = normalizePrompt(message, config, client.user?.id);
        if (!prompt) return;

        if (!canSend(message.channel)) return;
        activeResponseChannel = message.channel;
        streamer = config.discord.streamUpdates ? new StreamingDiscordResponse(message.channel, sendQueue, config.discord) : undefined;
        if (config.discord.sendTyping && "sendTyping" in message.channel) {
          await message.channel.sendTyping();
        }

        const author = message.author.tag;
        const attachments = await normalizeDiscordAttachments(message, config.discord, config.redactionPatterns);
        const kbContext = knowledgebase.buildContext(`${prompt}\n${attachments.promptSection ?? ""}`, {
          forumIds: [...knowledgebaseChannels.keys()],
          limit: Math.max(1, ...[...knowledgebaseChannels.values()].map((channel) => channel.maxContextThreads ?? 3)),
        });
        activeSourceLinks = [discordMessageUrl(message), ...attachments.sourceLinks, ...(kbContext?.sourceLinks ?? [])];
        const discordPrompt = [
          kbContext?.markdown,
          `Discord-Nachricht von ${author} im Channel ${message.channelId}:`,
          prompt.trim() || "_(kein Nachrichtentext)_",
          attachments.promptSection,
        ].filter((part): part is string => Boolean(part)).join("\n\n");

        if (ctx.isIdle()) {
          pi.sendUserMessage(discordPrompt);
        } else {
          pi.sendUserMessage(discordPrompt, { deliverAs: "followUp" });
          await message.react("⏳").catch(() => undefined);
        }
      } catch (error) {
        ctx.ui.notify(`Discord bridge input error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });

    client.on("messageUpdate", async (_oldMessage, newMessage) => {
      try {
        if (!config) return;
        const message = await resolveFullMessage(newMessage);
        if (!message?.guild) return;
        if (config.guildId && message.guild.id !== config.guildId) return;
        const thread = getThreadChannel(message);
        if (thread && knowledgebase.isKnowledgebaseThread(thread, knowledgebaseChannels)) {
          await knowledgebase.upsertThread(thread);
        }
      } catch (error) {
        ctx.ui.notify(`Discord bridge KB update error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    });

    await client.login(token);
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    if (event.assistantMessageEvent.type === "text_delta") {
      currentAssistantText += event.assistantMessageEvent.delta;
      if (config?.discord.streamUpdates) streamer?.append(redactSecrets(event.assistantMessageEvent.delta, config.redactionPatterns));
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (!config?.discord.postToolEvents || !activeResponseChannel) return;
    const typed = event as unknown as { toolName?: string; name?: string };
    await sendPayloadsQueued(sendQueue, activeResponseChannel, renderToolStatusMessage({
      toolName: typed.toolName ?? typed.name ?? "tool",
      status: "running",
      summary: "Tool wird ausgeführt…",
    }, config.discord)).catch(() => undefined);
  });

  pi.on("tool_execution_end", async (event) => {
    if (!config?.discord.postToolEvents || !activeResponseChannel) return;
    const typed = event as unknown as { toolName?: string; name?: string; error?: unknown; result?: unknown; output?: unknown };
    const rawOutput = typeof typed.output === "string" ? typed.output : typeof typed.result === "string" ? typed.result : typed.result ? JSON.stringify(typed.result) : undefined;
    const output = rawOutput ? redactSecrets(rawOutput.slice(0, config.discord.maxToolOutputChars ?? 4000), config.redactionPatterns) : undefined;
    await sendPayloadsQueued(sendQueue, activeResponseChannel, renderToolStatusMessage({
      toolName: typed.toolName ?? typed.name ?? "tool",
      status: typed.error ? "error" : "success",
      summary: typed.error ? redactSecrets(String(typed.error), config.redactionPatterns) : "Tool abgeschlossen.",
      output,
    }, config.discord)).catch(() => undefined);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!config) return;
    if (event.message.role !== "assistant") return;
    if (!activeResponseChannel) return;

    try {
      const text = getTextFromAssistantMessage(event.message) || currentAssistantText;
      currentAssistantText = "";
      await streamer?.finish();
      if (!text.trim()) return;
      await sendPayloadsQueued(sendQueue, activeResponseChannel, renderDiscordMessages(redactSecrets(text, config.redactionPatterns), config.discord, { title: "pi Antwort", sourceLinks: activeSourceLinks }));
      activeSourceLinks = [];
    } catch (error) {
      ctx.ui.notify(`Discord bridge output error: ${error instanceof Error ? error.message : String(error)}`, "error");
      try {
        await sendPayloadsQueued(sendQueue, activeResponseChannel, renderErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error), config.redactionPatterns)) as ReturnType<typeof renderDiscordMessages>);
      } catch {
        // ignore nested Discord send failures
      }
    }
  });

  pi.on("session_shutdown", async () => {
    activeResponseChannel = undefined;
    activeSourceLinks = [];
    currentAssistantText = "";
    streamer?.reset();
    streamer = undefined;
    if (client) {
      await client.destroy();
      client = undefined;
    }
  });
}
