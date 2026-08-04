/**
 * SMC Stage 7 — Supply / Demand zones.
 *
 * DISTINCT from Order Blocks (Stage 3):
 *   OB  = last opposite-color candle before a BOS/CHoCH displacement.
 *   S/D = consolidation base (1–3 low-range / low-body candles) immediately
 *         before a displacement move (reuses Stage-4 isDisplacementCandle).
 *
 * Bullish break away from base → demand zone.
 * Bearish break away from base → supply zone.
 *
 * Status (same mitigation spirit as Order Blocks):
 *   fresh → tested when price re-enters range without closing through
 *   broken when close through the zone (demand: close < low; supply: close > high)
 *
 * Heuristic / rules-based — not ML-validated.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import { isDisplacementCandle, atrAtIndex } from "./fairValueGaps";
import type {
  SmcTimeframe,
  SupplyDemandKind,
  SupplyDemandResult,
  SupplyDemandStatus,
  SupplyDemandZone,
} from "./types";

/** Max candles in a consolidation base. */
export const SD_BASE_MAX_CANDLES = 3;

/**
 * Base candle: range ≤ SD_BASE_RANGE_ATR_MULT × ATR(14)
 * (quiet relative to volatility).
 */
export const SD_BASE_RANGE_ATR_MULT = 0.7;

/**
 * Or body/range ≤ this — indecisive / overlapping base bar.
 */
export const SD_BASE_BODY_RATIO = 0.45;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function candleRange(c: OhlcvCandle): number {
  return Math.max(c.high - c.low, 1e-9);
}

function candleBody(c: OhlcvCandle): number {
  return Math.abs(c.close - c.open);
}

/**
 * Quiet consolidation bar: small range vs ATR and/or small body vs range.
 */
export function isBaseCandle(
  candles: OhlcvCandle[],
  index: number,
): boolean {
  const c = candles[index];
  if (!c) return false;
  const range = candleRange(c);
  const bodyRatio = candleBody(c) / range;
  if (bodyRatio <= SD_BASE_BODY_RATIO) return true;

  const atr = atrAtIndex(candles, index);
  if (atr !== null && atr > 0 && range <= SD_BASE_RANGE_ATR_MULT * atr) {
    return true;
  }
  return false;
}

/**
 * Walk back from `beforeIndex - 1` collecting 1..SD_BASE_MAX_CANDLES
 * consecutive base candles.
 */
export function findBaseBeforeDisplacement(
  candles: OhlcvCandle[],
  displacementIndex: number,
): { start: number; end: number } | null {
  if (displacementIndex < 1) return null;

  let end = displacementIndex - 1;
  if (!isBaseCandle(candles, end)) return null;

  let start = end;
  while (
    start > 0 &&
    end - (start - 1) + 1 <= SD_BASE_MAX_CANDLES &&
    isBaseCandle(candles, start - 1)
  ) {
    start -= 1;
  }

  const len = end - start + 1;
  if (len < 1 || len > SD_BASE_MAX_CANDLES) return null;
  return { start, end };
}

function zoneFromBase(
  candles: OhlcvCandle[],
  start: number,
  end: number,
  type: SupplyDemandKind,
): SupplyDemandZone {
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= end; i++) {
    high = Math.max(high, candles[i]!.high);
    low = Math.min(low, candles[i]!.low);
  }
  return {
    type,
    high: round2(high),
    low: round2(low),
    baseStart: candles[start]!.time,
    baseEnd: candles[end]!.time,
    baseStartIndex: start,
    baseEndIndex: end,
    status: "fresh",
  };
}

/**
 * Apply tested / broken status after the base ends
 * (same spirit as OB mitigation / invalidation).
 */
export function applySupplyDemandStatus(
  candles: OhlcvCandle[],
  zones: SupplyDemandZone[],
): SupplyDemandZone[] {
  return zones.map((z) => {
    const zone: SupplyDemandZone = { ...z };
    for (let i = zone.baseEndIndex + 1; i < candles.length; i++) {
      if (zone.status === "broken") break;
      const bar = candles[i]!;
      const overlaps = bar.low <= zone.high && bar.high >= zone.low;

      if (zone.type === "demand") {
        // Close through below → broken
        if (bar.close < zone.low) {
          zone.status = "broken";
          break;
        }
        // Re-enter without close-through → tested
        if (overlaps && bar.close >= zone.low && zone.status === "fresh") {
          zone.status = "tested";
          zone.testTime = bar.time;
        }
      } else {
        if (bar.close > zone.high) {
          zone.status = "broken";
          break;
        }
        if (overlaps && bar.close <= zone.high && zone.status === "fresh") {
          zone.status = "tested";
          zone.testTime = bar.time;
        }
      }
    }
    return zone;
  });
}

/**
 * Detect supply/demand zones from consolidation bases before displacement.
 */
export function detectSupplyDemand(params: {
  candles: OhlcvCandle[];
  timeframe: SmcTimeframe;
}): SupplyDemandResult {
  const { candles, timeframe } = params;
  const signals: string[] = [];
  const raw: SupplyDemandZone[] = [];

  if (candles.length < 3) {
    return {
      timeframe,
      zones: [],
      signals: ["insufficient candles for supply/demand"],
    };
  }

  // Skip indices already claimed as part of a prior base to reduce overlap spam.
  const claimed = new Set<number>();

  for (let i = 1; i < candles.length; i++) {
    const disp = isDisplacementCandle(candles, i);
    if (!disp.ok) continue;

    const base = findBaseBeforeDisplacement(candles, i);
    if (!base) continue;

    // Skip if base fully claimed
    let overlap = false;
    for (let j = base.start; j <= base.end; j++) {
      if (claimed.has(j)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    const c = candles[i]!;
    const bullishBreak = c.close > c.open;
    const type: SupplyDemandKind = bullishBreak ? "demand" : "supply";
    raw.push(zoneFromBase(candles, base.start, base.end, type));

    for (let j = base.start; j <= base.end; j++) claimed.add(j);
  }

  const zones = applySupplyDemandStatus(candles, raw);

  const fresh = zones.filter((z) => z.status === "fresh").length;
  const tested = zones.filter((z) => z.status === "tested").length;
  const broken = zones.filter((z) => z.status === "broken").length;
  const demand = zones.filter((z) => z.type === "demand").length;
  const supply = zones.filter((z) => z.type === "supply").length;

  signals.push(
    `S/D zones: ${zones.length} (demand=${demand}, supply=${supply}; fresh=${fresh}, tested=${tested}, broken=${broken})`,
  );
  signals.push(
    `base = 1–${SD_BASE_MAX_CANDLES} quiet candles before Stage-4 displacement (≠ Order Block)`,
  );
  signals.push("Supply/demand heuristic / rules-based — not ML-validated");

  return { timeframe, zones, signals };
}

/** Re-export status union for tests. */
export type { SupplyDemandStatus };
