/**
 * SMC Stage 1 — fractal swing highs / lows.
 *
 * INTENTIONAL DIVERGENCE (not a bug — do not "unify" with scalp swings):
 *   - smc/swingPoints.ts          → SWING_LOOKBACK = 2 (SMC fractal foundation)
 *   - scalp/priceAction.ts        → lookback = 3 (structureBias / HH-HL)
 *   - scalp/stopLossClusters.ts   → CLUSTER_SWING_LOOKBACK = 3 (S-R clusters)
 *   - lanes/technical.ts          → lookback = 3 (legacy technical swings)
 *
 * These are three independent swing detectors with different purposes.
 * Stages 3–7 MUST consume the SwingPoint[] from this module only —
 * never re-detect swings inside later SMC stages.
 *
 * Rule: bar i is a swing high iff high[i] > high of every bar in
 *   [i−lookback, i) ∪ (i, i+lookback] (strict; ties do not qualify).
 * Mirror for swing low with lows. Requires length ≥ lookback*2+1.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import {
  SWING_LOOKBACK,
  type SmcTimeframe,
  type SwingPoint,
  type SwingPointsResult,
} from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Detect fractal swing highs and lows on a single candle series.
 * @param lookback half-window (default SWING_LOOKBACK=2). Configurable for tests.
 */
export function detectSmcSwingPoints(
  candles: OhlcvCandle[],
  timeframe: SmcTimeframe,
  lookback: number = SWING_LOOKBACK,
): SwingPointsResult {
  const swings: SwingPoint[] = [];
  const signals: string[] = [];

  if (candles.length < lookback * 2 + 1) {
    signals.push(
      `insufficient candles for swing detection (need ≥${lookback * 2 + 1}, have ${candles.length})`,
    );
    return { timeframe, lookback, swings, signals };
  }

  for (let i = lookback; i < candles.length - lookback; i++) {
    const bar = candles[i]!;
    const h = bar.high;
    const l = bar.low;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      // Strict fractal: neighbor ≥ high disqualifies (ties are not swings).
      if (candles[i - j]!.high >= h || candles[i + j]!.high >= h) isHigh = false;
      // Strict fractal: neighbor ≤ low disqualifies.
      if (candles[i - j]!.low <= l || candles[i + j]!.low <= l) isLow = false;
    }

    if (isHigh) {
      swings.push({
        index: i,
        time: bar.time,
        price: round2(h),
        type: "high",
        timeframe,
      });
    }
    if (isLow) {
      swings.push({
        index: i,
        time: bar.time,
        price: round2(l),
        type: "low",
        timeframe,
      });
    }
  }

  // Chronological order (same index high+low keeps high before low).
  swings.sort((a, b) => a.index - b.index || (a.type === "high" ? -1 : 1));

  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  signals.push(
    `swings: ${highs.length} high(s), ${lows.length} low(s) (lookback=${lookback})`,
  );
  if (highs.length > 0) {
    const last = highs[highs.length - 1]!;
    signals.push(`last swing high @ ${last.price} (idx ${last.index})`);
  }
  if (lows.length > 0) {
    const last = lows[lows.length - 1]!;
    signals.push(`last swing low @ ${last.price} (idx ${last.index})`);
  }

  return { timeframe, lookback, swings, signals };
}
