export class MarketDataUnavailableError extends Error {
  readonly code: "RATE_LIMITED" | "DOWN" | "AUTH" | "INVALID" | "UNKNOWN";
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: MarketDataUnavailableError["code"] = "UNKNOWN",
    opts?: { status?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "MarketDataUnavailableError";
    this.code = code;
    this.status = opts?.status;
    this.retryable =
      opts?.retryable ?? (code === "RATE_LIMITED" || code === "DOWN");
  }
}

export function isMarketDataUnavailable(
  err: unknown,
): err is MarketDataUnavailableError {
  return err instanceof MarketDataUnavailableError;
}
