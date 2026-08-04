/**
 * SMC Stage 4 — Fair Value Gaps, Displacement, Imbalance.
 *
 * IMPORTANT — do not conflate in code or UI:
 *   FVG (kind: "fvg")         = strict 3-candle gap (subset).
 *   Imbalance (kind: "imbalance") = looser volume-confirmed single-candle
 *                                   form (superset conceptually). We emit
 *                                   kind="fvg" for the 3-candle pattern and
 *                                   kind="imbalance" only for the single-candle
 *                                   body/volume path so the UI can label them
 *                                   distinctly. A 3-candle FVG is NOT also
 *                                   duplicated as kind="imbalance".
 *
 * FVG rules:
 *   Bullish: candle[i].high < candle[i+2].low
 *            zone top = candle[i+2].low, bottom = candle[i].high
 *   Bearish: candle[i].low > candle[i+2].high
 *            zone top = candle[i].low, bottom = candle[i+2].high
 *   originIndex = middle candle (i+1) — the displacement candidate.
 *
 * Displacement candle (middle of FVG, or any bar tested via isDisplacementCandle):
 *   body ≥ DISPLACEMENT_ATR_MULT (1.5) × ATR(14) as of that bar.
 *
 * Imbalance (single-candle, not already an FVG middle):
 *   body / range ≥ IMBALANCE_BODY_RATIO (0.7)
 *   AND volume > rolling avg of prior VOLUME_LOOKBACK (20) bars
 *   (same spirit as scalp Stage-3 volume lookback).
 *
 * Fill: subsequent price that re-enters the gap.
 *   fillPercent ∈ [0,1]; filled = fillPercent ≥ 1.
 *
 * Heuristic / rules-based — not ML-validated.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import { calcAtr } from "@/lib/indicators/atr";
import { VOLUME_LOOKBACK } from "@/lib/marketdata/scalp/volume";
import {
  DISPLACEMENT_ATR_MULT,
  IMBALANCE_BODY_RATIO,
  type FairValueGap,
  type FairValueGapsResult,
  type SmcDirection,
  type SmcTimeframe,
} from "./types";

export const FVG_ATR_PERIOD = 14;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function candleBody(c: OhlcvCandle): number {
  return Math.abs(c.close - c.open);
}

function candleRange(c: OhlcvCandle): number {
  return Math.max(c.high - c.low, 1e-9);
}

/**
 * ATR(14) as of bar `index` (Wilder via calcAtr on prefix).
 * atr = Wilder smooth of TR over period bars ending at index.
 */
export function atrAtIndex(
  candles: OhlcvCandle[],
  index: number,
  period = FVG_ATR_PERIOD,
): number | null {
  if (index < period) return null;
  return calcAtr(candles.slice(0, index + 1), period);
}

/**
 * Rolling mean volume of the `lookback` bars immediately before `index`
 * (excludes bar[index]). Same formula spirit as scalp rollingAvgVolume.
 * avg = sum(vol[index-lookback .. index-1]) / lookback
 */
export function rollingAvgVolumeAt(
  candles: OhlcvCandle[],
  index: number,
  lookback = VOLUME_LOOKBACK,
): number | null {
  if (index < lookback) return null;
  let sum = 0;
  for (let i = index - lookback; i < index; i++) {
    sum += candles[i]!.volume;
  }
  return sum / lookback;
}

/**
 * Displacement test: body ≥ DISPLACEMENT_ATR_MULT × ATR(14).
 * Exported for Stage 7 supply/demand reuse.
 */
export function isDisplacementCandle(
  candles: OhlcvCandle[],
  index: number,
  atrMult = DISPLACEMENT_ATR_MULT,
): { ok: boolean; body: number; atr: number | null; mult: number | null } {
  const c = candles[index];
  if (!c) return { ok: false, body: 0, atr: null, mult: null };
  const b = candleBody(c);
  const atr = atrAtIndex(candles, index);
  if (atr === null || atr <= 0) {
    return { ok: false, body: b, atr, mult: null };
  }
  // body ≥ atrMult × ATR(14)
  const mult = b / atr;
  return { ok: mult >= atrMult, body: b, atr, mult: round4(mult) };
}

/**
 * Measure how much of the gap [bottom, top] has been filled by bars after origin.
 * Bullish: fill from the top down (lows dipping into the gap).
 * Bearish: fill from the bottom up (highs rising into the gap).
 */
export function measureGapFill(
  candles: OhlcvCandle[],
  gap: { type: SmcDirection; top: number; bottom: number; originIndex: number },
): { fillPercent: number; filled: boolean } {
  const size = gap.top - gap.bottom;
  if (size <= 0) return { fillPercent: 1, filled: true };

  let penetration = 0;
  for (let i = gap.originIndex + 1; i < candles.length; i++) {
    const bar = candles[i]!;
    if (gap.type === "bullish") {
      // How far below the gap top has price traded?
      if (bar.low < gap.top) {
        penetration = Math.max(penetration, gap.top - bar.low);
      }
    } else {
      if (bar.high > gap.bottom) {
        penetration = Math.max(penetration, bar.high - gap.bottom);
      }
    }
  }

  const fillPercent = round4(Math.min(1, Math.max(0, penetration / size)));
  return { fillPercent, filled: fillPercent >= 1 };
}

function makeGap(
  kind: FairValueGap["kind"],
  type: SmcDirection,
  top: number,
  bottom: number,
  time: string,
  originIndex: number,
  candles: OhlcvCandle[],
  displacement: ReturnType<typeof isDisplacementCandle>,
): FairValueGap {
  const fill = measureGapFill(candles, {
    type,
    top,
    bottom,
    originIndex,
  });
  return {
    kind,
    type,
    top: round2(top),
    bottom: round2(bottom),
    time,
    originIndex,
    filled: fill.filled,
    fillPercent: fill.fillPercent,
    displacementCandle: displacement.ok,
    displacementAtrMult: displacement.mult ?? undefined,
  };
}

/**
 * Strict 3-candle FVG scan. Middle candle is origin / displacement candidate.
 */
export function detectFairValueGapsOnly(
  candles: OhlcvCandle[],
): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  if (candles.length < 3) return gaps;

  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i]!;
    const c2 = candles[i + 1]!;
    const c3 = candles[i + 2]!;
    const mid = i + 1;
    const disp = isDisplacementCandle(candles, mid);

    // Bullish FVG: c1.high < c3.low → gap [c1.high, c3.low]
    if (c1.high < c3.low) {
      gaps.push(
        makeGap(
          "fvg",
          "bullish",
          c3.low,
          c1.high,
          c2.time,
          mid,
          candles,
          disp,
        ),
      );
    }
    // Bearish FVG: c1.low > c3.high → gap [c3.high, c1.low]
    if (c1.low > c3.high) {
      gaps.push(
        makeGap(
          "fvg",
          "bearish",
          c1.low,
          c3.high,
          c2.time,
          mid,
          candles,
          disp,
        ),
      );
    }
  }
  return gaps;
}

/**
 * Single-candle imbalance: body/range ≥ IMBALANCE_BODY_RATIO and
 * volume > prior rolling average. Skips indices that are already FVG middles.
 */
export function detectSingleCandleImbalances(
  candles: OhlcvCandle[],
  skipOriginIndexes: Set<number>,
): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (skipOriginIndexes.has(i)) continue;
    const c = candles[i]!;
    const range = candleRange(c);
    const body = candleBody(c);
    // body / range ≥ IMBALANCE_BODY_RATIO (0.7)
    if (body / range < IMBALANCE_BODY_RATIO) continue;

    const avg = rollingAvgVolumeAt(candles, i, VOLUME_LOOKBACK);
    if (avg === null || !(c.volume > avg)) continue;

    const type: SmcDirection = c.close >= c.open ? "bullish" : "bearish";
    // Zone = the candle's body (imbalance core), not full wick range.
    const top = Math.max(c.open, c.close);
    const bottom = Math.min(c.open, c.close);
    const disp = isDisplacementCandle(candles, i);

    gaps.push(
      makeGap("imbalance", type, top, bottom, c.time, i, candles, disp),
    );
  }
  return gaps;
}

/**
 * Full Stage-4 scan: FVGs (strict) + single-candle imbalances (looser).
 */
export function detectFairValueGaps(params: {
  candles: OhlcvCandle[];
  timeframe: SmcTimeframe;
}): FairValueGapsResult {
  const { candles, timeframe } = params;
  const signals: string[] = [];

  if (candles.length < 3) {
    return {
      timeframe,
      gaps: [],
      signals: ["insufficient candles for FVG/imbalance detection"],
    };
  }

  const fvgs = detectFairValueGapsOnly(candles);
  const fvgMiddles = new Set(fvgs.map((g) => g.originIndex));
  const imbalances = detectSingleCandleImbalances(candles, fvgMiddles);
  const gaps = [...fvgs, ...imbalances].sort(
    (a, b) => a.originIndex - b.originIndex,
  );

  const unfilled = gaps.filter((g) => !g.filled);
  const withDisp = gaps.filter((g) => g.displacementCandle);

  signals.push(
    `FVG (strict 3-candle): ${fvgs.length}; imbalance (single-candle body≥${IMBALANCE_BODY_RATIO * 100}%+vol): ${imbalances.length}`,
  );
  signals.push(
    `unfilled=${unfilled.length}, displacement-tagged=${withDisp.length} (body≥${DISPLACEMENT_ATR_MULT}×ATR${FVG_ATR_PERIOD})`,
  );
  signals.push(
    "FVG = strict subset; imbalance = looser volume-confirmed form — do not conflate in UI",
  );
  signals.push("FVG/imbalance heuristic / rules-based — not ML-validated");

  return { timeframe, gaps, signals };
}
