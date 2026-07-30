import type { Underlying } from "@/lib/marketdata/angelone";
import type { LaneResult, TradingMode } from "./types";

/**
 * STUB — Stage 2.5 not implemented.
 * Returns neutral score 0. Do NOT treat as live India VIX / USDINR / SGX / crude.
 */
export async function runMacroLane(_params: {
  underlying: Underlying;
  mode?: TradingMode;
}): Promise<LaneResult> {
  return {
    score: 0,
    signals: [
      "Macro lane STUB: India VIX/USDINR/SGX Nifty/crude not wired (Stage 2.5) — score forced to 0",
    ],
    rawIndicators: {
      stub: true,
      reason: "Stage 2.5 pending — no fabricated macro data",
    },
  };
}
