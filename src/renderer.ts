import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { DiscordRenderingConfig } from "./types.js";

export const DISCORD_SAFE_MESSAGE_CHARS = 1900;
export const DISCORD_EMBED_DESCRIPTION_CHARS = 4096;
export const DISCORD_MAX_EMBEDS = 10;

const MIN_MESSAGE_CHARS = 500;
const MIN_CODE_INLINE_CHARS = 200;
const MAX_INLINE_CODE_CHARS = 3600;
const LONG_TEXT_ATTACHMENT_AFTER_CHUNKS = 4;
const PREVIEW_LINES = 18;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
}

export interface ListBlock {
  type: "list";
  text: string;
}

export interface TableBlock {
  type: "table";
  text: string;
}

export interface CodeBlock {
  type: "code";
  language: string;
  code: string;
}

export type MarkdownBlock = TextBlock | HeadingBlock | ListBlock | TableBlock | CodeBlock;

export interface RenderedDiscordPayload {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
}

export interface RenderDiscordMessagesOptions {
  title?: string;
  context?: string;
  sourceLinks?: string[];
  preferMarkdownAttachments?: boolean;
}

export interface RenderToolStatusOptions {
  toolName: string;
  status: "running" | "success" | "error";
  summary?: string;
  output?: string;
}

function normalizeLimit(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

function messageLimit(config: DiscordRenderingConfig): number {
  return normalizeLimit(config.maxMessageChars, DISCORD_SAFE_MESSAGE_CHARS, MIN_MESSAGE_CHARS, DISCORD_SAFE_MESSAGE_CHARS);
}

function codeInlineLimit(config: DiscordRenderingConfig): number {
  return normalizeLimit(config.maxCodeCharsInline, 900, MIN_CODE_INLINE_CHARS, MAX_INLINE_CODE_CHARS);
}

export function splitText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.4) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) cut = remaining.lastIndexOf(". ", limit);
    if (cut < limit * 0.4) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit * 0.4) cut = limit;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function flushParagraph(lines: string[], blocks: MarkdownBlock[]) {
  const text = lines.join("\n").trim();
  if (text) blocks.push({ type: "text", text });
  lines.length = 0;
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s+)/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const paragraph: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*```([\w.+-]*)\s*$/);
    if (fence) {
      flushParagraph(paragraph, blocks);
      const language = fence[1] || "text";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(paragraph, blocks);
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph(paragraph, blocks);
      const tableLines = [line, lines[i + 1] ?? ""];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        tableLines.push(lines[i] ?? "");
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "table", text: tableLines.join("\n") });
      continue;
    }

    if (isListLine(line)) {
      flushParagraph(paragraph, blocks);
      const listLines = [line];
      i += 1;
      while (i < lines.length && ((lines[i] ?? "").trim() === "" || isListLine(lines[i] ?? "") || /^\s{2,}\S/.test(lines[i] ?? ""))) {
        listLines.push(lines[i] ?? "");
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "list", text: listLines.join("\n").trim() });
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paragraph, blocks);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph(paragraph, blocks);
  return blocks;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function mdAttachment(name: string, markdown: string): AttachmentBuilder {
  return new AttachmentBuilder(Buffer.from(markdown, "utf8"), { name });
}

function sourcesMarkdown(sourceLinks?: string[]): string[] {
  if (!sourceLinks?.length) return [];
  return ["", "## Quellen", "", ...sourceLinks.map((link) => `- ${link}`)];
}

function markdownDocument(title: string, context: string | undefined, body: string, sourceLinks?: string[]): string {
  return [
    `# ${title}`,
    "",
    context ? `> Kontext: ${context}` : undefined,
    context ? "" : undefined,
    body,
    ...sourcesMarkdown(sourceLinks),
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function codeDocument(title: string, context: string | undefined, language: string, code: string, sourceLinks?: string[]): string {
  return markdownDocument(
    title,
    context,
    [`Sprache: ${language || "text"}`, "", `\`\`\`${language || "text"}`, code, "```"].join("\n"),
    sourceLinks,
  );
}

function previewText(text: string, maxChars: number): string {
  const byLines = text.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const preview = byLines.length > maxChars ? byLines.slice(0, maxChars) : byLines;
  return preview.trimEnd();
}

function codeFence(language: string, code: string): string {
  return `\`\`\`${language || "text"}\n${code}\n\`\`\``;
}

function pushTextPayloads(payloads: RenderedDiscordPayload[], text: string, maxChars: number) {
  for (const chunk of splitText(text, maxChars)) {
    payloads.push({ content: chunk });
  }
}

function renderTextLike(block: TextBlock | ListBlock | TableBlock, payloads: RenderedDiscordPayload[], maxChars: number) {
  const text = block.type === "table" ? `\`\`\`md\n${block.text}\n\`\`\`` : block.text;
  pushTextPayloads(payloads, text, maxChars);
}

function renderHeading(block: HeadingBlock, payloads: RenderedDiscordPayload[]) {
  const prefix = block.level <= 2 ? "##" : "**";
  const suffix = block.level <= 2 ? "" : "**";
  payloads.push({ content: `${prefix} ${block.text}${suffix}`.slice(0, DISCORD_SAFE_MESSAGE_CHARS) });
}

function renderCodeBlock(
  block: CodeBlock,
  payloads: RenderedDiscordPayload[],
  config: DiscordRenderingConfig,
  options: RenderDiscordMessagesOptions,
) {
  const language = block.language || "text";
  const code = block.code.trimEnd();
  const maxCodeInline = codeInlineLimit(config);
  const inlineDescriptionLimit = DISCORD_EMBED_DESCRIPTION_CHARS - language.length - 12;
  const canInline = code.length <= maxCodeInline && codeFence(language, code).length <= DISCORD_EMBED_DESCRIPTION_CHARS;

  if (canInline) {
    payloads.push({
      embeds: [new EmbedBuilder()
        .setTitle(`Code${language ? `: ${language}` : ""}`)
        .setDescription(codeFence(language, code))
        .setColor(0x5865f2)],
    });
    return;
  }

  const previewLimit = Math.max(200, Math.min(maxCodeInline, inlineDescriptionLimit - 20));
  const preview = previewText(code, previewLimit);
  const embed = new EmbedBuilder()
    .setTitle(`Code${language ? `: ${language}` : ""}`)
    .setDescription(codeFence(language, `${preview}\n…`))
    .setFooter({ text: "Gekürzt – vollständiger Inhalt als Markdown-Attachment" })
    .setColor(0x5865f2);

  payloads.push({
    embeds: [embed],
    files: config.largeCodeAsAttachment === false
      ? undefined
      : [mdAttachment(`pi-code-${timestamp()}.md`, codeDocument(options.title ?? "pi Code-Auszug", options.context, language, code, options.sourceLinks))],
  });
}

function compactPayloads(payloads: RenderedDiscordPayload[]): RenderedDiscordPayload[] {
  const compacted: RenderedDiscordPayload[] = [];
  let pendingEmbeds: EmbedBuilder[] = [];

  const flushEmbeds = () => {
    while (pendingEmbeds.length > 0) {
      compacted.push({ embeds: pendingEmbeds.splice(0, DISCORD_MAX_EMBEDS) });
    }
  };

  for (const payload of payloads) {
    if (payload.embeds?.length && !payload.content && !payload.files?.length) {
      pendingEmbeds.push(...payload.embeds);
      if (pendingEmbeds.length >= DISCORD_MAX_EMBEDS) flushEmbeds();
      continue;
    }
    flushEmbeds();
    compacted.push(payload);
  }

  flushEmbeds();
  return compacted;
}

export function renderDiscordMessages(
  markdown: string,
  config: DiscordRenderingConfig,
  options: RenderDiscordMessagesOptions = {},
): RenderedDiscordPayload[] {
  const payloads: RenderedDiscordPayload[] = [];
  const maxChars = messageLimit(config);
  const trimmed = markdown.trim();

  if (!trimmed) return [];

  const blocks = parseMarkdownBlocks(trimmed);
  const hasCode = blocks.some((block) => block.type === "code");
  const fullTextChunks = splitText(trimmed, maxChars);
  if (!hasCode && (options.preferMarkdownAttachments || fullTextChunks.length > LONG_TEXT_ATTACHMENT_AFTER_CHUNKS)) {
    const preview = fullTextChunks.slice(0, 2);
    for (const chunk of preview) payloads.push({ content: chunk });
    payloads.push({
      embeds: [new EmbedBuilder()
        .setTitle(options.title ?? "pi Antwort")
        .setDescription("Die vollständige Antwort ist als Markdown-Attachment angehängt.")
        .setColor(0x5865f2)],
      files: [mdAttachment(`pi-answer-${timestamp()}.md`, markdownDocument(options.title ?? "pi Antwort", options.context, trimmed, options.sourceLinks))],
    });
    return compactPayloads(payloads);
  }

  for (const block of blocks) {
    if (block.type === "heading") renderHeading(block, payloads);
    else if (block.type === "code") renderCodeBlock(block, payloads, config, options);
    else renderTextLike(block, payloads, maxChars);
  }

  return compactPayloads(payloads);
}

export function renderErrorMessage(error: unknown): RenderedDiscordPayload[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{
    embeds: [new EmbedBuilder()
      .setTitle("pi Fehler")
      .setDescription(message.slice(0, DISCORD_EMBED_DESCRIPTION_CHARS))
      .setColor(0xff5555)],
  }];
}

export function renderToolStatusMessage(options: RenderToolStatusOptions, config?: DiscordRenderingConfig): RenderedDiscordPayload[] {
  const color = options.status === "error" ? 0xff5555 : options.status === "success" ? 0x57f287 : 0xfee75c;
  const maxChars = config ? messageLimit(config) : DISCORD_SAFE_MESSAGE_CHARS;
  const summary = options.summary ?? (options.status === "running" ? "läuft…" : options.status);
  const embed = new EmbedBuilder()
    .setTitle(`Tool: ${options.toolName}`)
    .setDescription(summary.slice(0, DISCORD_EMBED_DESCRIPTION_CHARS))
    .setColor(color);

  if (!options.output || options.output.length <= maxChars) {
    if (options.output) embed.addFields({ name: "Ausgabe", value: options.output.slice(0, 1024) });
    return [{ embeds: [embed] }];
  }

  embed.setFooter({ text: "Große Toolausgabe gekürzt – vollständiger Log als Markdown-Attachment" });
  const body = markdownDocument(
    `pi Tool-Log: ${options.toolName}`,
    `Status: ${options.status}`,
    [`## Zusammenfassung`, "", summary, "", "## Ausgabe", "", "```text", options.output, "```"].join("\n"),
  );
  return [{ embeds: [embed], files: [mdAttachment(`pi-log-${timestamp()}.md`, body)] }];
}

export function validateRenderedPayloads(payloads: RenderedDiscordPayload[]): string[] {
  const errors: string[] = [];
  payloads.forEach((payload, index) => {
    if (payload.content && payload.content.length > DISCORD_SAFE_MESSAGE_CHARS) {
      errors.push(`payload ${index}: content exceeds ${DISCORD_SAFE_MESSAGE_CHARS} chars`);
    }
    if (payload.embeds && payload.embeds.length > DISCORD_MAX_EMBEDS) {
      errors.push(`payload ${index}: embeds exceed ${DISCORD_MAX_EMBEDS}`);
    }
    payload.embeds?.forEach((embed, embedIndex) => {
      const json = embed.toJSON();
      if (json.description && json.description.length > DISCORD_EMBED_DESCRIPTION_CHARS) {
        errors.push(`payload ${index} embed ${embedIndex}: description exceeds ${DISCORD_EMBED_DESCRIPTION_CHARS} chars`);
      }
    });
  });
  return errors;
}
