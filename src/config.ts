import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { DiscordBridgeConfig } from "./types.js";

const DEFAULT_CONFIG: DiscordBridgeConfig = {
  tokenEnv: "DISCORD_BOT_TOKEN",
  allowedUserIds: [],
  allowedRoleIds: [],
  requireMention: false,
  idleDisposeMs: 30 * 60 * 1000,
  channels: [],
  knowledgebase: {
    downloadAttachments: true,
    maxAttachmentBytes: 262144,
    enableVectorSearch: false,
    maxStoredThreadChars: 500000,
  },
  discord: {
    sendTyping: true,
    streamUpdates: false,
    streamUpdateIntervalMs: 5000,
    postToolEvents: false,
    maxToolOutputChars: 4000,
    maxMessageChars: 1900,
    maxCodeCharsInline: 900,
    largeCodeAsAttachment: true,
    maxAttachmentBytes: 262144,
    allowedAttachmentMimeTypes: [
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
    ],
    downloadAttachments: true,
  },
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mergeConfig(base: DiscordBridgeConfig, override: Partial<DiscordBridgeConfig>): DiscordBridgeConfig {
  return {
    ...base,
    ...override,
    allowedUserIds: override.allowedUserIds ?? base.allowedUserIds,
    allowedRoleIds: override.allowedRoleIds ?? base.allowedRoleIds,
    channels: override.channels ?? base.channels,
    knowledgebase: {
      ...(base.knowledgebase ?? {}),
      ...(override.knowledgebase ?? {}),
    },
    discord: {
      ...base.discord,
      ...(override.discord ?? {}),
    },
  };
}

function assertStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

export interface LoadConfigOptions {
  cwd: string;
  projectTrusted: boolean;
}

export function loadConfig({ cwd, projectTrusted }: LoadConfigOptions): DiscordBridgeConfig | undefined {
  const globalPath = join(homedir(), ".pi", "agent", "discord-bridge.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "discord-bridge.json");

  let config = { ...DEFAULT_CONFIG };
  let loaded = false;

  if (existsSync(globalPath)) {
    config = mergeConfig(config, readJson(globalPath) as Partial<DiscordBridgeConfig>);
    loaded = true;
  }

  if (projectTrusted && existsSync(projectPath)) {
    config = mergeConfig(config, readJson(projectPath) as Partial<DiscordBridgeConfig>);
    loaded = true;
  }

  if (!loaded) return undefined;

  config.allowedUserIds = assertStringArray(config.allowedUserIds, "allowedUserIds");
  config.allowedRoleIds = assertStringArray(config.allowedRoleIds, "allowedRoleIds");
  config.redactionPatterns = assertStringArray(config.redactionPatterns, "redactionPatterns");
  config.discord.allowedAttachmentMimeTypes = assertStringArray(config.discord.allowedAttachmentMimeTypes, "discord.allowedAttachmentMimeTypes");

  if (!Array.isArray(config.channels)) {
    throw new Error("channels must be an array");
  }

  for (const channel of config.channels) {
    if (!channel || typeof channel !== "object") throw new Error("channel entries must be objects");
    if (typeof channel.channelId !== "string") throw new Error("channel.channelId must be a string");
    if (!["single-session", "forum", "knowledgebase"].includes(channel.mode)) {
      throw new Error(`unsupported channel mode: ${String(channel.mode)}`);
    }
  }

  return config;
}
