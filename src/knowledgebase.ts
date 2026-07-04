import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Message, ThreadChannel } from "discord.js";
import type { KnowledgebaseChannelConfig } from "./types.js";

export interface KnowledgebaseIndexEntry {
  threadId: string;
  forumId: string;
  title: string;
  link: string;
  path: string;
  hash: string;
  updatedAt: string;
  tags: string[];
  excerpt: string;
  keywords: Record<string, number>;
}

export interface KnowledgebaseIndex {
  version: 1;
  updatedAt: string;
  threads: Record<string, KnowledgebaseIndexEntry>;
}

export interface KnowledgebaseHit {
  threadId: string;
  title: string;
  link: string;
  excerpt: string;
  score: number;
}

export interface KnowledgebaseContext {
  markdown: string;
  sourceLinks: string[];
  hits: KnowledgebaseHit[];
}

const DEFAULT_BASE_DIR = join(homedir(), ".pi", "agent", "discord-bridge-kb");
const MAX_MESSAGES_PER_THREAD = 100;
const EXCERPT_CHARS = 700;
const STOP_WORDS = new Set([
  "der", "die", "das", "den", "dem", "und", "oder", "aber", "mit", "für", "von", "auf", "ist", "sind", "ein", "eine", "the", "and", "or", "for", "with", "from", "that", "this", "you", "your", "und", "nicht", "ich", "wir", "sie", "als", "bei", "aus", "zur", "zum",
]);

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeFileName(id: string): string {
  return basename(id).replace(/[^\w.-]/g, "_");
}

function messageUrl(message: Message): string {
  return `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`;
}

function threadUrl(thread: ThreadChannel): string {
  return `https://discord.com/channels/${thread.guildId}/${thread.id}`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9äöüß_-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function keywordCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokenize(text)) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

function excerpt(markdown: string): string {
  return markdown
    .replace(/^# .+$/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_CHARS);
}

function extractTags(title: string, markdown: string): string[] {
  const tagMatches = `${title}\n${markdown}`.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(tagMatches.map((tag) => tag.slice(1).toLowerCase()))].slice(0, 20);
}

function attachmentLines(message: Message): string[] {
  if (message.attachments.size === 0) return [];
  return ["", "Anhänge:", ...message.attachments.map((attachment) => `- [${attachment.name ?? attachment.id}](${attachment.url})`)];
}

function renderMessage(message: Message, label: string): string {
  const timestamp = message.createdAt.toISOString();
  const body = message.content.trim() || "_(kein Text)_";
  return [
    `## ${label}: ${message.author.tag} – ${timestamp}`,
    "",
    `Quelle: ${messageUrl(message)}`,
    "",
    body,
    ...attachmentLines(message),
    "",
  ].join("\n");
}

function readIndex(path: string): KnowledgebaseIndex {
  if (!existsSync(path)) return { version: 1, updatedAt: new Date(0).toISOString(), threads: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KnowledgebaseIndex>;
  return { version: 1, updatedAt: parsed.updatedAt ?? new Date(0).toISOString(), threads: parsed.threads ?? {} };
}

export class DiscordKnowledgebase {
  private readonly baseDir: string;
  private readonly threadsDir: string;
  private readonly indexPath: string;
  private index: KnowledgebaseIndex;

  constructor(baseDir = DEFAULT_BASE_DIR) {
    this.baseDir = baseDir;
    this.threadsDir = join(baseDir, "threads");
    this.indexPath = join(baseDir, "index.json");
    ensureDir(this.threadsDir);
    this.index = readIndex(this.indexPath);
  }

  isKnowledgebaseThread(thread: ThreadChannel, channels: Map<string, KnowledgebaseChannelConfig>): boolean {
    return Boolean(thread.parentId && channels.has(thread.parentId));
  }

  async upsertThread(thread: ThreadChannel): Promise<KnowledgebaseIndexEntry> {
    const fetched = await thread.messages.fetch({ limit: MAX_MESSAGES_PER_THREAD });
    const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const first = messages[0];
    const forumId = thread.parentId ?? "unknown";
    const link = first ? messageUrl(first) : threadUrl(thread);

    const document = [
      `# ${thread.name}`,
      "",
      `- Thread-ID: ${thread.id}`,
      `- Forum-ID: ${forumId}`,
      `- Discord-Link: ${link}`,
      `- Aktualisiert: ${new Date().toISOString()}`,
      "",
      ...messages.map((message, index) => renderMessage(message, index === 0 ? "Startpost" : "Antwort")),
    ].join("\n");

    const hash = sha256(document);
    const relativePath = `threads/${safeFileName(thread.id)}.md`;
    const fullPath = join(this.baseDir, relativePath);
    const existing = this.index.threads[thread.id];

    if (!existing || existing.hash !== hash) {
      writeFileSync(fullPath, document, "utf8");
      const searchable = `${thread.name}\n${document}`;
      this.index.threads[thread.id] = {
        threadId: thread.id,
        forumId,
        title: thread.name,
        link,
        path: relativePath,
        hash,
        updatedAt: new Date().toISOString(),
        tags: extractTags(thread.name, document),
        excerpt: excerpt(document),
        keywords: keywordCounts(searchable),
      };
      this.save();
    }

    return this.index.threads[thread.id];
  }

  search(query: string, options: { forumIds?: string[]; limit?: number } = {}): KnowledgebaseHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const forumFilter = options.forumIds ? new Set(options.forumIds) : undefined;
    const hits: KnowledgebaseHit[] = [];

    for (const entry of Object.values(this.index.threads)) {
      if (forumFilter && !forumFilter.has(entry.forumId)) continue;
      let score = 0;
      const titleTokens = new Set(tokenize(entry.title));
      for (const token of tokens) {
        score += entry.keywords[token] ?? 0;
        if (titleTokens.has(token)) score += 5;
        if (entry.tags.includes(token)) score += 3;
      }
      if (score > 0) hits.push({ threadId: entry.threadId, title: entry.title, link: entry.link, excerpt: entry.excerpt, score });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 3);
  }

  buildContext(query: string, options: { forumIds?: string[]; limit?: number } = {}): KnowledgebaseContext | undefined {
    const hits = this.search(query, options);
    if (hits.length === 0) return undefined;

    const markdown = [
      "Discord Knowledgebase Kontext:",
      "",
      "Nutze diese Auszüge nur, wenn sie für die Anfrage relevant sind. Wenn du sie verwendest, nenne die Quellenlinks in der Antwort.",
      "",
      ...hits.flatMap((hit, index) => [
        `### ${index + 1}. ${hit.title}`,
        `Quelle: ${hit.link}`,
        `Score: ${hit.score}`,
        "",
        hit.excerpt,
        "",
      ]),
    ].join("\n");

    return { markdown, sourceLinks: hits.map((hit) => hit.link), hits };
  }

  private save() {
    this.index.updatedAt = new Date().toISOString();
    writeFileSync(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`, "utf8");
  }
}
