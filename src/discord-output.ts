import type { Message } from "discord.js";
import { DiscordSendQueue } from "./rate-limit.js";
import { DISCORD_SAFE_MESSAGE_CHARS, type RenderedDiscordPayload } from "./renderer.js";
import type { DiscordRenderingConfig } from "./types.js";

export type DiscordSendable = {
  send: (payload: string | RenderedDiscordPayload) => Promise<Message>;
};

function streamInterval(config: DiscordRenderingConfig): number {
  return Math.max(1500, config.streamUpdateIntervalMs ?? 5000);
}

function preview(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "pi arbeitet…";
  const slice = trimmed.slice(Math.max(0, trimmed.length - (DISCORD_SAFE_MESSAGE_CHARS - 20)));
  return slice.length < trimmed.length ? `…${slice}` : slice;
}

export async function sendPayloadsQueued(queue: DiscordSendQueue, channel: DiscordSendable, payloads: RenderedDiscordPayload[]) {
  for (const payload of payloads) await queue.enqueue(() => channel.send(payload));
}

export class StreamingDiscordResponse {
  private readonly intervalMs: number;
  private statusMessage: Message | undefined;
  private buffer = "";
  private lastFlush = 0;
  private timer: NodeJS.Timeout | undefined;
  private disabled = false;

  constructor(
    private readonly channel: DiscordSendable,
    private readonly queue: DiscordSendQueue,
    config: DiscordRenderingConfig,
  ) {
    this.intervalMs = streamInterval(config);
  }

  append(delta: string) {
    if (this.disabled || !delta) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  async finish(message = "✅ Antwort abgeschlossen – finale Ausgabe folgt.") {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disabled) return;
    try {
      if (this.statusMessage) {
        await this.queue.enqueue(() => this.statusMessage!.edit({ content: message, embeds: [], files: [] }));
      }
    } catch {
      this.disabled = true;
    } finally {
      this.buffer = "";
      this.statusMessage = undefined;
      this.lastFlush = 0;
    }
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = "";
    this.statusMessage = undefined;
    this.lastFlush = 0;
    this.disabled = false;
  }

  private scheduleFlush() {
    const now = Date.now();
    const dueIn = Math.max(0, this.intervalMs - (now - this.lastFlush));
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, dueIn);
  }

  private async flush() {
    if (this.disabled || !this.buffer.trim()) return;
    this.lastFlush = Date.now();
    const content = preview(this.buffer);
    try {
      if (!this.statusMessage) {
        this.statusMessage = await this.queue.enqueue(() => this.channel.send({ content }));
      } else {
        await this.queue.enqueue(() => this.statusMessage!.edit({ content }));
      }
    } catch {
      // Missing permissions/deleted message/etc.: keep final-only behavior.
      this.disabled = true;
    }
  }
}
