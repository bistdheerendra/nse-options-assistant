import type { OhlcvCandle, OptionChainResult } from "@/lib/marketdata/angelone";
import { detectSwingPoints } from "./priceAction";
import { oiBuildupLevels } from "./oiVelocity";

/**
 * Scalp Stage 5 — stop-loss cluster / support-resistance levels.
 *
 * Sources (merged, deduped within mergeTolerance):
 *  1. Recent swing highs → resistance cluster candidates
 *  2. Recent swing lows  → support cluster candidates
 *  3. Round-number levels near spot (underlying step)
 *  4. OI concentration walls (PE max below spot = support; CE max above = resistance)
 *
 * Chart colors MUST NOT reuse bull/bear candle greens/reds — use theme.clusterSupport /
 * theme.clusterResistance (blue / violet).
 */

export const CLUSTER_SWING_LOOKBACK = 3;
export const CLUSTER_MAX_SWINGS = 4;
/** Merge levels within this fraction of spot (0.05% ≈ tight index clustering). */
export const CLUSTER_MERGE_TOLERANCE_PCT = 0.0005;
/** How far from spot to keep levels (2% — scalp-relevant). */
export const CLUSTER_NEAR_SPOT_PCT = 0.02;

export type ClusterKind = "support" | "resistance";
export type ClusterSource = "swing" | "round" | "oi_wall";

export type StopLossClusterLevel = {
  price: number;
  kind: ClusterKind;
  sources: ClusterSource[];
  /** Higher = more confluence (more sources / OI weight). */
  strength: number;
  label: string;
};

export type StopLossClusterResult = {
  spot: number;
  levels: StopLossClusterLevel[];
  support: StopLossClusterLevel[];
  resistance: StopLossClusterLevel[];
  signals: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function underlyingStep(underlying: string): number {
  if (underlying === "BANKNIFTY") return 100;
  if (underlying === "SENSEX") return 100;
  return 50; // NIFTY
}

/**
 * Round-number magnets near spot: nearest N steps below/above.
 */
export function roundNumberLevels(
  spot: number,
  step: number,
  countEachSide = 2,
): { price: number; kind: ClusterKind }[] {
  const base = Math.round(spot / step) * step;
  const out: { price: number; kind: ClusterKind }[] = [];
  for (let i = 1; i <= countEachSide; i++) {
    out.push({ price: base - i * step, kind: "support" });
    out.push({ price: base + i * step, kind: "resistance" });
  }
  // Include exact round ATM if it is a clean multiple
  if (Math.abs(base - spot) / spot < CLUSTER_NEAR_SPOT_PCT) {
    out.push({
      price: base,
      kind: base >= spot ? "resistance" : "support",
    });
  }
  return out;
}

type RawLevel = {
  price: number;
  kind: ClusterKind;
  source: ClusterSource;
  weight: number;
};

function mergeLevels(
  raw: RawLevel[],
  spot: number,
): StopLossClusterLevel[] {
  const tol = spot * CLUSTER_MERGE_TOLERANCE_PCT;
  const sorted = [...raw].sort((a, b) => a.price - b.price);
  const groups: RawLevel[][] = [];

  for (const lvl of sorted) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Math.abs(last[0]!.price - lvl.price) <= tol &&
      last[0]!.kind === lvl.kind
    ) {
      last.push(lvl);
    } else {
      groups.push([lvl]);
    }
  }

  return groups.map((g) => {
    const price = round2(g.reduce((s, x) => s + x.price, 0) / g.length);
    const sources = [...new Set(g.map((x) => x.source))];
    const strength = round2(g.reduce((s, x) => s + x.weight, 0));
    const kind = g[0]!.kind;
    const srcLabel = sources.join("+");
    return {
      price,
      kind,
      sources,
      strength,
      label: kind === "support" ? `S ${srcLabel}` : `R ${srcLabel}`,
    };
  });
}

/**
 * Derive SL-cluster / S-R levels from candles + option chain.
 * Pure — no I/O. OI walls via shared helper (Stage 6 module; static snapshot here).
 */
export function deriveStopLossClusters(params: {
  underlying: string;
  spot: number;
  candles: OhlcvCandle[];
  chain?: OptionChainResult | null;
}): StopLossClusterResult {
  const { spot, candles, chain } = params;
  const signals: string[] = [];
  const raw: RawLevel[] = [];
  const near = spot * CLUSTER_NEAR_SPOT_PCT;

  const { swingHighs, swingLows } = detectSwingPoints(
    candles,
    CLUSTER_SWING_LOOKBACK,
  );

  for (const s of swingHighs.slice(-CLUSTER_MAX_SWINGS)) {
    if (Math.abs(s.price - spot) <= near) {
      raw.push({
        price: s.price,
        kind: "resistance",
        source: "swing",
        weight: 1,
      });
    }
  }
  for (const s of swingLows.slice(-CLUSTER_MAX_SWINGS)) {
    if (Math.abs(s.price - spot) <= near) {
      raw.push({
        price: s.price,
        kind: "support",
        source: "swing",
        weight: 1,
      });
    }
  }

  const step = underlyingStep(params.underlying);
  for (const r of roundNumberLevels(spot, step, 2)) {
    if (Math.abs(r.price - spot) <= near && r.price > 0) {
      raw.push({
        price: r.price,
        kind: r.kind,
        source: "round",
        weight: 0.75,
      });
    }
  }

  if (chain) {
    const oi = oiBuildupLevels(chain);
    if (oi.support != null && Math.abs(oi.support - spot) <= near) {
      raw.push({
        price: oi.support,
        kind: "support",
        source: "oi_wall",
        weight: 1.5,
      });
      signals.push(`OI PE wall support ≈ ${oi.support}`);
    }
    if (oi.resistance != null && Math.abs(oi.resistance - spot) <= near) {
      raw.push({
        price: oi.resistance,
        kind: "resistance",
        source: "oi_wall",
        weight: 1.5,
      });
      signals.push(`OI CE wall resistance ≈ ${oi.resistance}`);
    }
  }

  const levels = mergeLevels(raw, spot)
    .filter((l) => Math.abs(l.price - spot) <= near)
    .sort((a, b) => a.price - b.price);

  const support = levels
    .filter((l) => l.kind === "support")
    .sort((a, b) => b.strength - a.strength);
  const resistance = levels
    .filter((l) => l.kind === "resistance")
    .sort((a, b) => b.strength - a.strength);

  if (support[0]) {
    signals.push(
      `Nearest SL-cluster support ${support[0].price} (${support[0].sources.join("+")}, str=${support[0].strength})`,
    );
  }
  if (resistance[0]) {
    signals.push(
      `Nearest SL-cluster resistance ${resistance[0].price} (${resistance[0].sources.join("+")}, str=${resistance[0].strength})`,
    );
  }

  return { spot, levels, support, resistance, signals };
}
