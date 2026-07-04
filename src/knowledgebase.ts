import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Message, ThreadChannel } from "discord.js";
import { normalizeDiscordAttachments } from "./attachments.js";
import type { DiscordRenderingConfig, KnowledgebaseChannelConfig, KnowledgebaseConfig } from "./types.js";

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
  titleKeywords: Record<string, number>;
  tagKeywords: Record<string, number>;
  startpostKeywords: Record<string, number>;
  replyKeywords: Record<string, number>;
  attachmentKeywords: Record<string, number>;
  documentLength: number;
}

export interface KnowledgebaseIndex {
  version: 1;
  updatedAt: string;
  vectorSearchEnabled: boolean;
  threads: Record<string, KnowledgebaseIndexEntry>;
}

export interface KnowledgebaseHit {
  threadId: string;
  title: string;
  link: string;
  path: string;
  excerpt: string;
  score: number;
}

export interface KnowledgebaseContext {
  markdown: string;
  sourceLinks: string[];
  hits: KnowledgebaseHit[];
}

export interface DiscordKnowledgebaseOptions {
  config?: KnowledgebaseConfig;
  discord?: DiscordRenderingConfig;
  redactionPatterns?: string[];
  baseDir?: string;
}

const DEFAULT_BASE_DIR = join(homedir(), ".pi", "agent", "discord-bridge-kb");
const MAX_MESSAGES_PER_THREAD = 100;
const EXCERPT_CHARS = 700;
const DEFAULT_MAX_STORED_THREAD_CHARS = 500_000;
const STOP_WORDS = new Set([
  "der", "die", "das", "den", "dem", "und", "oder", "aber", "mit", "für", "von", "auf", "ist", "sind", "ein", "eine", "the", "and", "or", "for", "with", "from", "that", "this", "you", "your", "nicht", "ich", "wir", "sie", "als", "bei", "aus", "zur", "zum",
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

function mergeCounts(...counts: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const count of counts) {
    for (const [token, value] of Object.entries(count)) merged[token] = (merged[token] ?? 0) + value;
  }
  return merged;
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

function readIndex(path: string): KnowledgebaseIndex {
  if (!existsSync(path)) return { version: 1, updatedAt: new Date(0).toISOString(), vectorSearchEnabled: false, threads: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KnowledgebaseIndex>;
  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    vectorSearchEnabled: parsed.vectorSearchEnabled ?? false,
    threads: parsed.threads ?? {},
  };
}

function limitStoredDocument(document: string, maxChars: number): string {
  if (document.length <= maxChars) return document;
  return `${document.slice(0, maxChars)}\n\n> Dokument wurde wegen knowledgebase.maxStoredThreadChars gekürzt (${document.length} Zeichen original).\n`;
}

function kbAttachmentConfig(kb: KnowledgebaseConfig | undefined, discord: DiscordRenderingConfig | undefined): DiscordRenderingConfig {
  return {
    sendTyping: discord?.sendTyping ?? true,
    streamUpdates: false,
    maxMessageChars: discord?.maxMessageChars ?? 1900,
    maxCodeCharsInline: discord?.maxCodeCharsInline ?? 900,
    largeCodeAsAttachment: true,
    allowedAttachmentMimeTypes: discord?.allowedAttachmentMimeTypes,
    downloadAttachments: kb?.downloadAttachments ?? discord?.downloadAttachments ?? true,
    maxAttachmentBytes: kb?.maxAttachmentBytes ?? discord?.maxAttachmentBytes ?? 262144,
  };
}

export class DiscordKnowledgebase {
  private readonly baseDir: string;
  private readonly threadsDir: string;
  private readonly vectorsDir: string;
  private readonly indexPath: string;
  private readonly config?: KnowledgebaseConfig;
  private readonly discord?: DiscordRenderingConfig;
  private readonly redactionPatterns: string[];
  private index: KnowledgebaseIndex;

  constructor(options: DiscordKnowledgebaseOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.threadsDir = join(this.baseDir, "threads");
    this.vectorsDir = join(this.baseDir, "vectors");
    this.indexPath = join(this.baseDir, "index.json");
    this.config = options.config;
    this.discord = options.discord;
    this.redactionPatterns = options.redactionPatterns ?? [];
    ensureDir(this.threadsDir);
    if (this.config?.enableVectorSearch) ensureDir(this.vectorsDir);
    this.index = readIndex(this.indexPath);
    this.index.vectorSearchEnabled = Boolean(this.config?.enableVectorSearch);
    if (this.config?.enableVectorSearch) this.writeVectorStub();
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
    const renderedMessages = await Promise.all(messages.map((message, index) => this.renderMessage(message, index === 0 ? "Startpost" : "Antwort")));

    const documentBody = [
      `# ${thread.name}`,
      "",
      `- Thread-ID: ${thread.id}`,
      `- Forum-ID: ${forumId}`,
      `- Discord-Link: ${link}`,
      "",
      ...renderedMessages.map((rendered) => rendered.markdown),
    ].join("\n");
    const hash = sha256(documentBody);
    const storedDocument = limitStoredDocument([
      `# ${thread.name}`,
      "",
      `- Thread-ID: ${thread.id}`,
      `- Forum-ID: ${forumId}`,
      `- Discord-Link: ${link}`,
      `- Aktualisiert: ${new Date().toISOString()}`,
      "",
      ...renderedMessages.map((rendered) => rendered.markdown),
    ].join("\n"), this.config?.maxStoredThreadChars ?? DEFAULT_MAX_STORED_THREAD_CHARS);

    const relativePath = `threads/${safeFileName(thread.id)}.md`;
    const fullPath = join(this.baseDir, relativePath);
    const existing = this.index.threads[thread.id];

    if (!existing || existing.hash !== hash) {
      writeFileSync(fullPath, storedDocument, "utf8");
      const startpostText = renderedMessages[0]?.searchableText ?? "";
      const replyText = renderedMessages.slice(1).map((item) => item.searchableText).join("\n");
      const attachmentText = renderedMessages.map((item) => item.attachmentText).join("\n");
      const tags = extractTags(thread.name, storedDocument);
      const titleKeywords = keywordCounts(thread.name);
      const tagKeywords = keywordCounts(tags.join(" "));
      const startpostKeywords = keywordCounts(startpostText);
      const replyKeywords = keywordCounts(replyText);
      const attachmentKeywords = keywordCounts(attachmentText);
      const keywords = mergeCounts(titleKeywords, tagKeywords, startpostKeywords, replyKeywords, attachmentKeywords, keywordCounts(storedDocument));
      this.index.threads[thread.id] = {
        threadId: thread.id,
        forumId,
        title: thread.name,
        link,
        path: relativePath,
        hash,
        updatedAt: new Date().toISOString(),
        tags,
        excerpt: excerpt(storedDocument),
        keywords,
        titleKeywords,
        tagKeywords,
        startpostKeywords,
        replyKeywords,
        attachmentKeywords,
        documentLength: storedDocument.length,
      };
      this.save();
    }

    return this.index.threads[thread.id];
  }

  loadDocument(threadId: string): string | undefined {
    const entry = this.index.threads[threadId];
    if (!entry) return undefined;
    const path = join(this.baseDir, entry.path);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  }

  search(query: string, options: { forumIds?: string[]; limit?: number; includeFullTextChars?: number } = {}): KnowledgebaseHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const forumFilter = options.forumIds ? new Set(options.forumIds) : undefined;
    const hits: KnowledgebaseHit[] = [];
    const totalDocs = Math.max(1, Object.keys(this.index.threads).length);

    for (const entry of Object.values(this.index.threads)) {
      if (forumFilter && !forumFilter.has(entry.forumId)) continue;
      let score = 0;
      for (const token of tokens) {
        const df = Object.values(this.index.threads).filter((doc) => (doc.keywords[token] ?? 0) > 0).length;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const tf = (entry.keywords[token] ?? 0) / Math.sqrt(Math.max(1, entry.documentLength / 1000));
        score += tf * idf;
        score += (entry.titleKeywords[token] ?? 0) * 8;
        score += (entry.tagKeywords[token] ?? 0) * 5;
        score += (entry.startpostKeywords[token] ?? 0) * 3;
        score += (entry.replyKeywords[token] ?? 0) * 1.5;
        score += (entry.attachmentKeywords[token] ?? 0) * 2.5;
      }
      if (score > 0) {
        const fullText = options.includeFullTextChars ? this.loadDocument(entry.threadId)?.slice(0, options.includeFullTextChars) : undefined;
        hits.push({ threadId: entry.threadId, title: entry.title, link: entry.link, path: entry.path, excerpt: fullText ?? entry.excerpt, score: Math.round(score * 100) / 100 });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 3);
  }

  buildContext(query: string, options: { forumIds?: string[]; limit?: number; includeFullTextChars?: number } = {}): KnowledgebaseContext | undefined {
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
        `Thread-ID: ${hit.threadId}`,
        `Pfad: ${hit.path}`,
        `Score: ${hit.score}`,
        "",
        hit.excerpt,
        "",
      ]),
    ].join("\n");

    return { markdown, sourceLinks: hits.map((hit) => hit.link), hits };
  }

  private async renderMessage(message: Message, label: string): Promise<{ markdown: string; searchableText: string; attachmentText: string }> {
    const timestamp = message.createdAt.toISOString();
    const body = message.content.trim() || "_(kein Text)_";
    const attachmentResult = await normalizeDiscordAttachments(message, kbAttachmentConfig(this.config, this.discord), this.redactionPatterns).catch((error: unknown) => ({
      promptSection: `Discord-Anhänge:\n\n## Nicht indexiert\nAttachment-Indexierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      sourceLinks: [],
      ignored: [],
    }));
    const markdown = [
      `## ${label}: ${message.author.tag} – ${timestamp}`,
      "",
      `Quelle: ${messageUrl(message)}`,
      "",
      body,
      attachmentResult.promptSection ? ["", attachmentResult.promptSection].join("\n") : undefined,
      "",
    ].filter((line): line is string => line !== undefined).join("\n");
    return { markdown, searchableText: `${message.author.tag}\n${body}`, attachmentText: attachmentResult.promptSection ?? "" };
  }

  private writeVectorStub() {
    ensureDir(this.vectorsDir);
    const metadataPath = join(this.vectorsDir, "README.md");
    if (!existsSync(metadataPath)) {
      writeFileSync(metadataPath, [
        "# pi Discord Bridge Vector Index",
        "",
        "Vector search is enabled in config, but this MVP intentionally has no provider-specific embedding dependency.",
        "Keyword/BM25-style search remains the fallback until a local embedding integration is configured.",
        "",
      ].join("\n"), "utf8");
    }
  }

  private save() {
    this.index.updatedAt = new Date().toISOString();
    this.index.vectorSearchEnabled = Boolean(this.config?.enableVectorSearch);
    writeFileSync(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`, "utf8");
  }
}
