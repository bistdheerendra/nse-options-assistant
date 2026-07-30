/**
 * Simple in-process token-bucket style throttle.
 * Prevents unthrottled parallel option-chain hammering of Angel One free tier.
 */
export class RequestThrottle {
  private queue: Promise<void> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastAt);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastAt = Date.now();
      return fn();
    });
    // Keep queue moving even if a call fails
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** ~4 req/s default — conservative for free-tier SmartAPI */
export const angelThrottle = new RequestThrottle(250);

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof Error &&
        "retryable" in err &&
        Boolean((err as { retryable?: boolean }).retryable);
      if (!retryable || attempt === retries) break;
      // Exponential backoff: base * 2^attempt (+ small jitter)
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
