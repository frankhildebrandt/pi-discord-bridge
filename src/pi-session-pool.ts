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

export interface SessionRouteMetadata {
  routeKey: string;
  guildId: string;
  forumId: string;
  threadId: string;
  threadName: string;
  sessionName: string;
}

export interface PersistedSessionMappingEntry extends SessionRouteMetadata {
  sessionFile?: string;
  initialized: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPoolStatusEntry {
  routeKey: string;
  threadId: string;
  threadName: string;
  sessionId?: string;
  active: boolean;
  streaming: boolean;
  pendingMessages: number;
  initialized: boolean;
  updatedAt: string;
}

interface PersistedSessionMapping {
  version: 1;
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
}

export function buildForumRouteKey(input: { guildId: string; forumId: string; threadId: string }): string {
  return `discord:guild:${input.guildId}:forum:${input.forumId}:thread:${input.threadId}`;
}

function defaultMappingPath(): string {
  return join(homedir(), ".pi", "agent", "discord-bridge-sessions.json");
}

function emptyMapping(): PersistedSessionMapping {
  return { version: 1, routes: {} };
}

function readMapping(path: string): PersistedSessionMapping {
  if (!existsSync(path)) return emptyMapping();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedSessionMapping>;
  return { version: 1, routes: parsed.routes ?? {} };
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
  private readonly active = new Map<string, PooledSession>();
  private mapping: PersistedSessionMapping;

  constructor(options: SessionPoolOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.mappingPath = options.mappingPath ?? defaultMappingPath();
    this.sessionNamePrefix = options.sessionNamePrefix ?? "forum-";
    this.mapping = readMapping(this.mappingPath);
  }

  getMapping(routeKey: string): PersistedSessionMappingEntry | undefined {
    return this.mapping.routes[routeKey];
  }

  markInitialized(routeKey: string) {
    const entry = this.mapping.routes[routeKey];
    if (!entry || entry.initialized) return;
    entry.initialized = true;
    entry.updatedAt = new Date().toISOString();
    this.save();
  }

  reset(routeKey: string) {
    const active = this.active.get(routeKey);
    active?.session.dispose();
    this.active.delete(routeKey);
    delete this.mapping.routes[routeKey];
    this.save();
  }

  getActive(routeKey: string): PooledSession | undefined {
    return this.active.get(routeKey);
  }

  getStatus(): SessionPoolStatusEntry[] {
    const routeKeys = new Set([...Object.keys(this.mapping.routes), ...this.active.keys()]);
    return [...routeKeys].map((routeKey) => {
      const mapping = this.mapping.routes[routeKey];
      const active = this.active.get(routeKey);
      return {
        routeKey,
        threadId: mapping?.threadId ?? active?.mapping.threadId ?? "unknown",
        threadName: mapping?.threadName ?? active?.mapping.threadName ?? "unknown",
        sessionId: active?.session.sessionId,
        active: Boolean(active),
        streaming: active?.session.isStreaming ?? false,
        pendingMessages: active?.session.pendingMessageCount ?? 0,
        initialized: mapping?.initialized ?? false,
        updatedAt: mapping?.updatedAt ?? active?.mapping.updatedAt ?? "unknown",
      };
    });
  }

  async getOrCreate(metadata: SessionRouteMetadata): Promise<PooledSession> {
    const active = this.active.get(metadata.routeKey);
    if (active) return active;

    const now = new Date().toISOString();
    let mapping = this.mapping.routes[metadata.routeKey];
    let isNew = false;

    if (!mapping) {
      mapping = {
        ...metadata,
        initialized: false,
        createdAt: now,
        updatedAt: now,
      };
      this.mapping.routes[metadata.routeKey] = mapping;
      isNew = true;
    } else {
      mapping.threadName = metadata.threadName;
      mapping.sessionName = metadata.sessionName;
      mapping.updatedAt = now;
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

    if (!mapping.sessionFile && session.sessionFile) {
      mapping.sessionFile = session.sessionFile;
    }

    if (session.sessionName !== metadata.sessionName) {
      session.setSessionName(metadata.sessionName);
    }

    this.save();
    const pooled: PooledSession = { session, mapping, isNew };
    this.active.set(metadata.routeKey, pooled);
    return pooled;
  }

  dispose() {
    for (const pooled of this.active.values()) {
      pooled.session.dispose();
    }
    this.active.clear();
  }

  private save() {
    writeMapping(this.mappingPath, this.mapping);
  }
}
