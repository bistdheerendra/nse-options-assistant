import type { Underlying } from "@/lib/marketdata/angelone";
import type { LaneResult, TradingMode } from "./types";

/**
 * STUB — Stage 2.5 not implemented.
 * Returns neutral score 0. Do NOT treat as live sentiment / FII-DII data.
 */
export async function runSentimentLane(_params: {
  underlying: Underlying;
  mode?: TradingMode;
}): Promise<LaneResult> {
  return {
    score: 0,
    signals: [
      "Sentiment lane STUB: news/FII-DII feed not wired (Stage 2.5) — score forced to 0",
    ],
    rawIndicators: {
      stub: true,
      reason: "Stage 2.5 pending — no fabricated sentiment data",
    },
  };
}
