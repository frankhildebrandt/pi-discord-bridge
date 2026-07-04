import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

export type SessionRouteKind = "forum-thread" | "text-channel";

export interface SessionRouteMetadata {
  routeKey: string;
  kind: SessionRouteKind;
  guildId: string;
  channelId?: string;
  channelName?: string;
  forumId?: string;
  threadId?: string;
  threadName?: string;
  sessionName: string;
}

export interface PersistedSessionMappingEntry extends SessionRouteMetadata {
  sessionFile?: string;
  initialized: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

export interface SessionPoolStatusEntry {
  routeKey: string;
  kind: SessionRouteKind;
  label: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  active: boolean;
  streaming: boolean;
  pendingMessages: number;
  initialized: boolean;
  updatedAt: string;
  lastUsedAt: string;
}

interface PersistedSessionMapping {
  version: 2;
  routes: Record<string, PersistedSessionMappingEntry>;
}

export interface PooledSession {
  session: AgentSession;
  mapping: PersistedSessionMappingEntry;
  isNew: boolean;
}

export interface SessionPoolOptions {
  cwd: string;
  agentDir?: string;
  mappingPath?: string;
  sessionNamePrefix?: string;
  idleDisposeMs?: number;
  onDispose?: (routeKey: string) => void;
}

export function buildForumRouteKey(input: { guildId: string; forumId: string; threadId: string }): string {
  return `discord:guild:${input.guildId}:forum:${input.forumId}:thread:${input.threadId}`;
}

export function buildTextChannelRouteKey(input: { guildId: string; channelId: string }): string {
  return `discord:guild:${input.guildId}:channel:${input.channelId}`;
}

function defaultMappingPath(): string {
  return join(homedir(), ".pi", "agent", "discord-bridge-sessions.json");
}

function emptyMapping(): PersistedSessionMapping {
  return { version: 2, routes: {} };
}

function migrateEntry(routeKey: string, value: unknown): PersistedSessionMappingEntry {
  const raw = value as Partial<PersistedSessionMappingEntry> & { forumId?: string; threadId?: string; threadName?: string };
  const now = new Date().toISOString();
  const kind: SessionRouteKind = raw.kind ?? (raw.threadId ? "forum-thread" : "text-channel");
  return {
    routeKey: raw.routeKey ?? routeKey,
    kind,
    guildId: raw.guildId ?? "unknown",
    channelId: raw.channelId,
    channelName: raw.channelName,
    forumId: raw.forumId,
    threadId: raw.threadId,
    threadName: raw.threadName,
    sessionName: raw.sessionName ?? raw.threadName ?? raw.channelName ?? "discord-session",
    sessionFile: raw.sessionFile,
    initialized: raw.initialized ?? false,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    lastUsedAt: raw.lastUsedAt ?? raw.updatedAt ?? now,
  };
}

function readMapping(path: string): PersistedSessionMapping {
  if (!existsSync(path)) return emptyMapping();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { routes?: Record<string, unknown> };
  const routes: Record<string, PersistedSessionMappingEntry> = {};
  for (const [routeKey, entry] of Object.entries(parsed.routes ?? {})) {
    routes[routeKey] = migrateEntry(routeKey, entry);
  }
  return { version: 2, routes };
}

function writeMapping(path: string, mapping: PersistedSessionMapping) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
}

export class PiSessionPool {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly mappingPath: string;
  private readonly sessionNamePrefix: string;
  private readonly idleDisposeMs: number | undefined;
  private readonly onDispose: ((routeKey: string) => void) | undefined;
  private readonly active = new Map<string, PooledSession>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private mapping: PersistedSessionMapping;

  constructor(options: SessionPoolOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.mappingPath = options.mappingPath ?? defaultMappingPath();
    this.sessionNamePrefix = options.sessionNamePrefix ?? "forum-";
    this.idleDisposeMs = options.idleDisposeMs && options.idleDisposeMs > 0 ? options.idleDisposeMs : undefined;
    this.onDispose = options.onDispose;
    this.mapping = readMapping(this.mappingPath);
    this.save();
  }

  getMapping(routeKey: string): PersistedSessionMappingEntry | undefined {
    return this.mapping.routes[routeKey];
  }

  markInitialized(routeKey: string) {
    const entry = this.mapping.routes[routeKey];
    if (!entry) return;
    entry.initialized = true;
    this.touch(routeKey);
  }

  touch(routeKey: string) {
    const entry = this.mapping.routes[routeKey];
    if (!entry) return;
    const now = new Date().toISOString();
    entry.updatedAt = now;
    entry.lastUsedAt = now;
    this.save();
    this.scheduleIdleDispose(routeKey);
  }

  reset(routeKey: string) {
    this.disposeRoute(routeKey);
    delete this.mapping.routes[routeKey];
    this.save();
  }

  disposeRoute(routeKey: string) {
    const timer = this.idleTimers.get(routeKey);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(routeKey);
    const active = this.active.get(routeKey);
    active?.session.dispose();
    this.active.delete(routeKey);
    this.onDispose?.(routeKey);
  }

  disposeIdleRoutes() {
    if (!this.idleDisposeMs) return;
    const now = Date.now();
    for (const [routeKey, pooled] of this.active.entries()) {
      if (pooled.session.isStreaming || pooled.session.pendingMessageCount > 0) continue;
      const lastUsed = Date.parse(pooled.mapping.lastUsedAt || pooled.mapping.updatedAt);
      if (Number.isFinite(lastUsed) && now - lastUsed >= this.idleDisposeMs) this.disposeRoute(routeKey);
    }
  }

  getActive(routeKey: string): PooledSession | undefined {
    return this.active.get(routeKey);
  }

  getStatus(): SessionPoolStatusEntry[] {
    const routeKeys = new Set([...Object.keys(this.mapping.routes), ...this.active.keys()]);
    return [...routeKeys].map((routeKey) => {
      const mapping = this.mapping.routes[routeKey];
      const active = this.active.get(routeKey);
      const kind = mapping?.kind ?? active?.mapping.kind ?? "forum-thread";
      return {
        routeKey,
        kind,
        label: mapping?.threadName ?? mapping?.channelName ?? active?.mapping.threadName ?? active?.mapping.channelName ?? routeKey,
        channelId: mapping?.channelId ?? active?.mapping.channelId,
        threadId: mapping?.threadId ?? active?.mapping.threadId,
        sessionId: active?.session.sessionId,
        active: Boolean(active),
        streaming: active?.session.isStreaming ?? false,
        pendingMessages: active?.session.pendingMessageCount ?? 0,
        initialized: mapping?.initialized ?? false,
        updatedAt: mapping?.updatedAt ?? active?.mapping.updatedAt ?? "unknown",
        lastUsedAt: mapping?.lastUsedAt ?? active?.mapping.lastUsedAt ?? "unknown",
      };
    });
  }

  async getOrCreate(metadata: SessionRouteMetadata): Promise<PooledSession> {
    const active = this.active.get(metadata.routeKey);
    if (active) {
      this.touch(metadata.routeKey);
      return active;
    }

    const now = new Date().toISOString();
    let mapping = this.mapping.routes[metadata.routeKey];
    let isNew = false;

    if (!mapping) {
      mapping = { ...metadata, initialized: false, createdAt: now, updatedAt: now, lastUsedAt: now };
      this.mapping.routes[metadata.routeKey] = mapping;
      isNew = true;
    } else {
      Object.assign(mapping, metadata, { updatedAt: now, lastUsedAt: now });
    }

    const settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
    });
    await resourceLoader.reload();

    const sessionManager = mapping.sessionFile && existsSync(mapping.sessionFile)
      ? SessionManager.open(mapping.sessionFile, undefined, this.cwd)
      : SessionManager.create(this.cwd);

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    if (!mapping.sessionFile && session.sessionFile) mapping.sessionFile = session.sessionFile;
    if (session.sessionName !== metadata.sessionName) session.setSessionName(metadata.sessionName);

    this.save();
    const pooled: PooledSession = { session, mapping, isNew };
    this.active.set(metadata.routeKey, pooled);
    this.scheduleIdleDispose(metadata.routeKey);
    return pooled;
  }

  dispose() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const pooled of this.active.values()) pooled.session.dispose();
    this.active.clear();
  }

  private scheduleIdleDispose(routeKey: string) {
    if (!this.idleDisposeMs) return;
    const existing = this.idleTimers.get(routeKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const pooled = this.active.get(routeKey);
      if (!pooled) return;
      if (pooled.session.isStreaming || pooled.session.pendingMessageCount > 0) {
        this.scheduleIdleDispose(routeKey);
        return;
      }
      this.disposeRoute(routeKey);
    }, this.idleDisposeMs);
    this.idleTimers.set(routeKey, timer);
  }

  private save() {
    writeMapping(this.mappingPath, this.mapping);
  }
}
