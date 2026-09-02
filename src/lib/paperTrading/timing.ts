/**
 * Paper open/exit wall-clock traces. Off by default.
 * Server: PAPER_TIMING=true
 * Client: NEXT_PUBLIC_PAPER_TIMING=true
 */
export function paperTimingEnabled(): boolean {
  return (
    process.env.PAPER_TIMING === "true" ||
    process.env.NEXT_PUBLIC_PAPER_TIMING === "true"
  );
}

export function paperTiming(
  step: string,
  startedAt: number,
  extra?: string,
): number {
  const ms = Date.now() - startedAt;
  if (paperTimingEnabled()) {
    console.log(
      `[paper-timing] ${step} ${ms}ms${extra ? ` ${extra}` : ""}`,
    );
  }
  return ms;
}

export function clientPaperTiming(message: string): void {
  if (paperTimingEnabled()) {
    console.log(`[paper-timing] ${message}`);
  }
}
