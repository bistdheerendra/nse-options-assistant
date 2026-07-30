export type LaneResult = {
  /** -1 (bearish) … +1 (bullish) */
  score: number;
  signals: string[];
  rawIndicators: Record<string, unknown>;
};

export type TradingMode = "SCALP" | "SWING";

export function clampScore(n: number): number {
  return Math.max(-1, Math.min(1, n));
}
