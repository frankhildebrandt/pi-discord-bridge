import type { Attachment, Message } from "discord.js";
import type { DiscordRenderingConfig } from "./types.js";
import { redactSecrets } from "./redaction.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8000;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".html", ".sh", ".bash",
  ".py", ".rs", ".go", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb",
  ".sql", ".log", ".diff", ".patch", ".dockerfile", ".env.example",
]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DEFAULT_ALLOWED_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/css", "application/json", "application/jsonl",
  "application/x-yaml", "application/yaml", "text/yaml", "application/xml", "text/xml", "application/toml",
  "application/javascript", "text/javascript", "application/typescript", "application/octet-stream",
  ...IMAGE_MIME_TYPES,
]);

export interface NormalizedAttachmentResult {
  promptSection?: string;
  sourceLinks: string[];
  ignored: Array<{ name: string; reason: string; url: string }>;
}

function maxAttachmentBytes(config: DiscordRenderingConfig): number {
  return Math.max(1024, config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES);
}

function allowedMimeTypes(config: DiscordRenderingConfig): Set<string> {
  return new Set(config.allowedAttachmentMimeTypes ?? [...DEFAULT_ALLOWED_MIME_TYPES]);
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

function isTextAttachment(attachment: Attachment): boolean {
  const mime = attachment.contentType?.toLowerCase() ?? "";
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/jsonl", "application/x-yaml", "application/yaml", "application/xml", "application/toml", "application/javascript", "application/typescript"].includes(mime)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(attachment.name ?? attachment.id));
}

function isImageAttachment(attachment: Attachment): boolean {
  const mime = attachment.contentType?.toLowerCase() ?? "";
  return IMAGE_MIME_TYPES.has(mime);
}

function isAllowed(attachment: Attachment, config: DiscordRenderingConfig): boolean {
  const mime = attachment.contentType?.toLowerCase();
  if (mime && allowedMimeTypes(config).has(mime)) return true;
  // Discord sometimes omits or generalizes content types for text/code snippets.
  return isTextAttachment(attachment) || isImageAttachment(attachment);
}

function languageFor(name: string): string {
  const ext = extensionOf(name).slice(1);
  if (!ext) return "text";
  if (ext === "markdown") return "md";
  if (ext === "yml") return "yaml";
  return ext;
}

async function downloadTextAttachment(attachment: Attachment, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(attachment.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) throw new Error(`größer als ${maxBytes} Bytes`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`größer als ${maxBytes} Bytes`);
    const text = buffer.toString("utf8");
    if (text.includes("\u0000")) throw new Error("wirkt binär und wurde nicht eingebettet");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function metaLine(attachment: Attachment): string {
  return `- ${attachment.name ?? attachment.id} (${attachment.contentType ?? "unbekannter MIME-Typ"}, ${attachment.size} Bytes): ${attachment.url}`;
}

export async function normalizeDiscordAttachments(
  message: Message,
  config: DiscordRenderingConfig,
  redactionPatterns: string[] = [],
): Promise<NormalizedAttachmentResult> {
  if (message.attachments.size === 0) return { sourceLinks: [], ignored: [] };

  const lines: string[] = ["Discord-Anhänge:", ""];
  const ignored: NormalizedAttachmentResult["ignored"] = [];
  const sourceLinks: string[] = [];
  const maxBytes = maxAttachmentBytes(config);
  const shouldDownload = config.downloadAttachments ?? true;

  for (const attachment of message.attachments.values()) {
    sourceLinks.push(attachment.url);
    const name = attachment.name ?? attachment.id;

    if (!isAllowed(attachment, config)) {
      const reason = `nicht erlaubter Dateityp (${attachment.contentType ?? (extensionOf(name) || "unbekannt")})`;
      ignored.push({ name, reason, url: attachment.url });
      lines.push(`## Ignoriert: ${name}`, reason, metaLine(attachment), "");
      continue;
    }

    if (isImageAttachment(attachment)) {
      lines.push(`## Bild: ${name}`, metaLine(attachment), "Hinweis: Bilddaten werden in diesem Bridge-Modus als Discord-Link/Metadaten weitergereicht.", "");
      continue;
    }

    if (!isTextAttachment(attachment)) {
      const reason = "kein unterstützter Text-/Bildanhang";
      ignored.push({ name, reason, url: attachment.url });
      lines.push(`## Ignoriert: ${name}`, reason, metaLine(attachment), "");
      continue;
    }

    if (attachment.size > maxBytes) {
      const reason = `zu groß für Download (${attachment.size} > ${maxBytes} Bytes)`;
      ignored.push({ name, reason, url: attachment.url });
      lines.push(`## Nicht heruntergeladen: ${name}`, reason, metaLine(attachment), "");
      continue;
    }

    if (!shouldDownload) {
      lines.push(`## Datei verlinkt: ${name}`, "Download von Attachments ist deaktiviert.", metaLine(attachment), "");
      continue;
    }

    try {
      const content = redactSecrets(await downloadTextAttachment(attachment, maxBytes), redactionPatterns);
      lines.push(`## Datei: ${name}`, metaLine(attachment), "", `\`\`\`${languageFor(name)}`, content, "```", "");
    } catch (error) {
      const reason = `Download fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
      ignored.push({ name, reason, url: attachment.url });
      lines.push(`## Nicht heruntergeladen: ${name}`, reason, metaLine(attachment), "");
    }
  }

  return { promptSection: lines.join("\n").trim(), sourceLinks, ignored };
}
