export type ChannelMode = "single-session" | "forum" | "knowledgebase";

export interface BaseChannelConfig {
  channelId: string;
  mode: ChannelMode;
}

export interface SingleSessionChannelConfig extends BaseChannelConfig {
  mode: "single-session";
  sessionName?: string;
}

export interface ForumChannelConfig extends BaseChannelConfig {
  mode: "forum";
  sessionNamePrefix?: string;
}

export interface KnowledgebaseChannelConfig extends BaseChannelConfig {
  mode: "knowledgebase";
  indexName?: string;
  maxContextThreads?: number;
}

export type DiscordBridgeChannelConfig =
  | SingleSessionChannelConfig
  | ForumChannelConfig
  | KnowledgebaseChannelConfig;

export interface DiscordRenderingConfig {
  sendTyping: boolean;
  streamUpdates: boolean;
  maxMessageChars: number;
  maxCodeCharsInline: number;
  largeCodeAsAttachment: boolean;
  maxAttachmentBytes?: number;
  allowedAttachmentMimeTypes?: string[];
  downloadAttachments?: boolean;
}

export interface DiscordBridgeConfig {
  tokenEnv: string;
  clientId?: string;
  guildId?: string;
  cwd?: string;
  maxConcurrentSessions?: number;
  redactionPatterns?: string[];
  allowedUserIds: string[];
  allowedRoleIds: string[];
  requireMention: boolean;
  prefix?: string;
  channels: DiscordBridgeChannelConfig[];
  discord: DiscordRenderingConfig;
}

export interface RenderedDiscordPayload {
  content?: string;
  embeds?: unknown[];
  files?: Array<{ name: string; attachment: Buffer }>;
}
