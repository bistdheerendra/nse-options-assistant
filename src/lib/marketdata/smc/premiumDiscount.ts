/**
 * SMC Stage 6 — Premium / Discount (equilibrium).
 *
 * Last major swing-low→high leg (or reverse high→low):
 *   rangeHigh / rangeLow from the two swing ends,
 *   equilibrium = 50% = (rangeHigh + rangeLow) / 2.
 *   Premium  = price in the upper half (sell-bias *context*)
 *   Discount = price in the lower half (buy-bias *context*)
 *   Equilibrium = at/near the 50% level
 *
 * CONTEXT / ANNOTATION ONLY — never flips a trade decision on its own
 * (same spirit as the existing "Lanes disagree" badge).
 * `annotationOnly: true` is a literal on the model.
 *
 * Consumes Stage-1 SwingPoint[] — never re-detects swings.
 * Heuristic / rules-based — not ML-validated.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type {
  PremiumDiscountModel,
  PremiumDiscountZone,
  SwingPoint,
} from "./types";

/** Half-range band around 50% treated as "at equilibrium" (2% of leg range). */
export const EQUILIBRIUM_BAND_PCT = 0.02;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pick the last major dealing-range leg from Stage-1 swings:
 * most recent swing high + most recent swing low (whichever came first
 * is legStart; the later is legEnd).
 */
export function findLastMajorLeg(
  swings: SwingPoint[],
): { legStart: SwingPoint; legEnd: SwingPoint } | null {
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length === 0 || lows.length === 0) return null;

  // Most recent by candle index (not array order).
  const lastHigh = highs.reduce((a, b) => (a.index >= b.index ? a : b));
  const lastLow = lows.reduce((a, b) => (a.index >= b.index ? a : b));

  if (lastHigh.index === lastLow.index) return null;

  const legStart = lastHigh.index < lastLow.index ? lastHigh : lastLow;
  const legEnd = lastHigh.index < lastLow.index ? lastLow : lastHigh;
  return { legStart, legEnd };
}

/**
 * Classify price vs equilibrium of [rangeLow, rangeHigh].
 * Mid band: |price − eq| ≤ EQUILIBRIUM_BAND_PCT × range → equilibrium.
 * Above band → premium; below → discount.
 */
export function classifyPremiumDiscountZone(
  price: number,
  rangeHigh: number,
  rangeLow: number,
  bandPct = EQUILIBRIUM_BAND_PCT,
): { zone: PremiumDiscountZone; equilibrium: number } {
  const equilibrium = (rangeHigh + rangeLow) / 2;
  const range = Math.max(rangeHigh - rangeLow, 1e-9);
  const band = range * bandPct;

  if (Math.abs(price - equilibrium) <= band) {
    return { zone: "equilibrium", equilibrium };
  }
  if (price > equilibrium) {
    return { zone: "premium", equilibrium };
  }
  return { zone: "discount", equilibrium };
}

/**
 * Build premium/discount annotation from Stage-1 swings + current price.
 * Returns null when swings are insufficient for a leg.
 */
export function analyzePremiumDiscount(params: {
  candles: OhlcvCandle[];
  swings: SwingPoint[];
  /** Override spot; default = last candle close. */
  currentPrice?: number;
}): PremiumDiscountModel | null {
  const { candles, swings } = params;
  const signals: string[] = [];

  if (candles.length === 0) {
    signals.push("no candles for premium/discount");
    return null;
  }

  const leg = findLastMajorLeg(swings);
  if (!leg) {
    signals.push("insufficient swings for major leg (need ≥1 high and ≥1 low)");
    return null;
  }

  const { legStart, legEnd } = leg;
  const rangeHigh = Math.max(legStart.price, legEnd.price);
  const rangeLow = Math.min(legStart.price, legEnd.price);
  const currentPrice =
    params.currentPrice ?? candles[candles.length - 1]!.close;

  const { zone, equilibrium } = classifyPremiumDiscountZone(
    currentPrice,
    rangeHigh,
    rangeLow,
  );

  const legDir =
    legStart.type === "low" && legEnd.type === "high"
      ? "swing-low→high"
      : legStart.type === "high" && legEnd.type === "low"
        ? "swing-high→low"
        : `${legStart.type}→${legEnd.type}`;

  signals.push(
    `major leg ${legDir}: ${round2(rangeLow)} → ${round2(rangeHigh)} (eq=${round2(equilibrium)})`,
  );
  signals.push(
    `price ${round2(currentPrice)} → ${zone} (annotation only — does not flip decisions)`,
  );
  signals.push(
    "Premium/discount heuristic / rules-based — not ML-validated",
  );

  return {
    rangeHigh: round2(rangeHigh),
    rangeLow: round2(rangeLow),
    equilibrium: round2(equilibrium),
    currentZone: zone,
    currentPrice: round2(currentPrice),
    legStart,
    legEnd,
    annotationOnly: true,
    signals,
  };
}
