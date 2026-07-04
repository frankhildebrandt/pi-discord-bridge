export interface DiscordSendQueueOptions {
  minDelayMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(error: unknown): number | undefined {
  const maybe = error as { retryAfter?: number; rawError?: { retry_after?: number }; headers?: { get?: (name: string) => string | null } };
  if (typeof maybe.retryAfter === "number") return maybe.retryAfter;
  if (typeof maybe.rawError?.retry_after === "number") return maybe.rawError.retry_after * 1000;
  const header = maybe.headers?.get?.("retry-after");
  if (header) {
    const parsed = Number(header);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }
  return undefined;
}

function isTransientDiscordError(error: unknown): boolean {
  const maybe = error as { status?: number; code?: number };
  const status = maybe.status ?? maybe.code;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class DiscordSendQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly minDelayMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(options: DiscordSendQueueOptions = {}) {
    this.minDelayMs = options.minDelayMs ?? 350;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
  }

  get pendingCount(): number {
    return this.pending;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const run = this.tail.then(() => this.runWithRetry(task), () => this.runWithRetry(task));
    this.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.pending -= 1;
    });
  }

  private async runWithRetry<T>(task: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const result = await task();
        if (this.minDelayMs > 0) await sleep(this.minDelayMs);
        return result;
      } catch (error) {
        if (attempt >= this.maxRetries || !isTransientDiscordError(error)) throw error;
        const delay = retryAfterMs(error) ?? this.baseBackoffMs * 2 ** attempt;
        await sleep(delay);
        attempt += 1;
      }
    }
  }
}
