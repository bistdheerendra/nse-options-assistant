/**
 * SMC Stage 5 — Liquidity zones, sweeps, equal highs/lows.
 *
 * NAMESPACE: smc/smcLiquidity.ts — intentionally distinct from
 * scalp/liquidity.ts (option-chain bid/ask gate). Zero collision.
 *
 * Consumes Stage-1 SwingPoint[] only — never re-detects swings.
 *
 * Equal highs/lows: ≥2 swing highs (or lows) within EQUAL_LEVEL_TOLERANCE
 *   (0.05% of price — same band as CLUSTER_MERGE_TOLERANCE_PCT).
 * Buy-side liquidity = pool resting above equal highs.
 * Sell-side liquidity = pool resting below equal lows.
 *
 * Sweep: price wicks through the level and closes back on the opposite
 *   side within SWEEP_CONFIRM_BARS (1–2; constant = 2) → swept:true + sweepTime.
 *
 * Heuristic / rules-based — not ML-validated.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import {
  EQUAL_LEVEL_TOLERANCE,
  SWEEP_CONFIRM_BARS,
  type LiquidityZone,
  type SmcLiquidityResult,
  type SmcTimeframe,
  type SwingPoint,
} from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cluster swings of one type whose prices lie within
 * EQUAL_LEVEL_TOLERANCE × reference price of each other.
 * Only clusters with ≥2 members are returned (equal highs / equal lows).
 */
export function clusterEqualSwings(
  swings: SwingPoint[],
  type: "high" | "low",
  tolerance = EQUAL_LEVEL_TOLERANCE,
): { price: number; members: SwingPoint[] }[] {
  const same = swings
    .filter((s) => s.type === type)
    .slice()
    .sort((a, b) => a.price - b.price);
  if (same.length < 2) return [];

  const used = new Set<number>();
  const clusters: { price: number; members: SwingPoint[] }[] = [];

  for (let i = 0; i < same.length; i++) {
    if (used.has(i)) continue;
    const seed = same[i]!;
    const members: SwingPoint[] = [seed];
    used.add(i);
    // tol = price × EQUAL_LEVEL_TOLERANCE (0.0005 = 0.05%)
    const tol = seed.price * tolerance;

    for (let j = i + 1; j < same.length; j++) {
      if (used.has(j)) continue;
      const cand = same[j]!;
      // Expand cluster if within tol of any current member (transitive banding).
      const near = members.some(
        (m) => Math.abs(cand.price - m.price) <= m.price * tolerance ||
          Math.abs(cand.price - m.price) <= tol,
      );
      if (near) {
        members.push(cand);
        used.add(j);
      }
    }

    if (members.length >= 2) {
      // Buyside rests at the highest equal high; sellside at the lowest equal low.
      const price =
        type === "high"
          ? Math.max(...members.map((m) => m.price))
          : Math.min(...members.map((m) => m.price));
      clusters.push({
        price: round2(price),
        members: members.sort((a, b) => a.index - b.index),
      });
    }
  }

  return clusters;
}

/**
 * Detect sweep of a liquidity level.
 * Buyside: wick high > price, then close back below within confirmBars.
 * Sellside: wick low < price, then close back above within confirmBars.
 * Search starts after the latest source swing (level must exist first).
 */
export function detectSweep(params: {
  candles: OhlcvCandle[];
  price: number;
  side: "buyside" | "sellside";
  sourceSwings: SwingPoint[];
  confirmBars?: number;
}): { swept: boolean; sweepTime?: string; sweepIndex?: number } {
  const confirmBars = params.confirmBars ?? SWEEP_CONFIRM_BARS;
  const { candles, price, side, sourceSwings } = params;
  if (sourceSwings.length === 0 || candles.length === 0) {
    return { swept: false };
  }

  const lastSwingIdx = Math.max(...sourceSwings.map((s) => s.index));
  const start = lastSwingIdx + 1;

  for (let i = start; i < candles.length; i++) {
    const bar = candles[i]!;
    const wickedThrough =
      side === "buyside" ? bar.high > price : bar.low < price;
    if (!wickedThrough) continue;

    const end = Math.min(i + confirmBars, candles.length - 1);
    for (let j = i; j <= end; j++) {
      const confirm = candles[j]!;
      const closedBack =
        side === "buyside" ? confirm.close < price : confirm.close > price;
      if (closedBack) {
        return { swept: true, sweepTime: confirm.time, sweepIndex: j };
      }
    }
  }

  return { swept: false };
}

/**
 * Build buyside (equal highs) + sellside (equal lows) liquidity zones,
 * then mark sweeps.
 */
export function detectSmcLiquidity(params: {
  candles: OhlcvCandle[];
  swings: SwingPoint[];
  timeframe: SmcTimeframe;
}): SmcLiquidityResult {
  const { candles, swings, timeframe } = params;
  const signals: string[] = [];

  if (swings.length === 0) {
    return {
      timeframe,
      zones: [],
      signals: ["no Stage-1 swings for SMC liquidity"],
    };
  }

  const equalHighs = clusterEqualSwings(swings, "high");
  const equalLows = clusterEqualSwings(swings, "low");

  const zones: LiquidityZone[] = [];

  for (const cluster of equalHighs) {
    const sweep = detectSweep({
      candles,
      price: cluster.price,
      side: "buyside",
      sourceSwings: cluster.members,
    });
    zones.push({
      type: "buyside",
      price: cluster.price,
      sourceSwings: cluster.members,
      equalLevel: true,
      swept: sweep.swept,
      sweepTime: sweep.sweepTime,
    });
  }

  for (const cluster of equalLows) {
    const sweep = detectSweep({
      candles,
      price: cluster.price,
      side: "sellside",
      sourceSwings: cluster.members,
    });
    zones.push({
      type: "sellside",
      price: cluster.price,
      sourceSwings: cluster.members,
      equalLevel: true,
      swept: sweep.swept,
      sweepTime: sweep.sweepTime,
    });
  }

  // Stable order: price descending (buyside typically above sellside on chart)
  zones.sort((a, b) => b.price - a.price);

  const buyside = zones.filter((z) => z.type === "buyside");
  const sellside = zones.filter((z) => z.type === "sellside");
  const swept = zones.filter((z) => z.swept);

  signals.push(
    `equal highs→buyside: ${buyside.length}; equal lows→sellside: ${sellside.length} (tol=${EQUAL_LEVEL_TOLERANCE * 100}%)`,
  );
  signals.push(
    `swept=${swept.length} / ${zones.length} (confirm ≤${SWEEP_CONFIRM_BARS} bars after wick-through)`,
  );
  signals.push(
    "SMC liquidity ≠ scalp bid/ask gate (smcLiquidity.ts vs scalp/liquidity.ts)",
  );
  signals.push("SMC liquidity heuristic / rules-based — not ML-validated");

  return { timeframe, zones, signals };
}
