/**
 * Recent raw price momentum, independent of any lane score.
 * This is a sanity gate on the FINAL verdict, not a new scoring input —
 * it does not touch §2.5 lane weights or the ±0.15 neutral threshold.
 *
 * SCALP only for now (5m primary TF). SWING needs its own lookback /
 * threshold — ask before extending.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { DirectionalVerdict } from "./directional";
import type { StructureResult } from "./structure";
import { synthesizeStructure } from "./structure";
import type { OptionsFlowExtras } from "@/lib/lanes/optionsFlow";

/** Last N bars on the mode's primary TF (5m Scalp). */
export const SLOPE_LOOKBACK_BARS = 5;

/**
 * % move over lookback bars considered a "strong" slope.
 * Named constant — tune from real data, not guessed.
 */
export const SLOPE_STRONG_THRESHOLD_PCT = 0.15;

export type SlopeDirection = "up" | "down" | "flat";

export type PriceSlopeGateResult = {
  slopePct: number;
  slopeDirection: SlopeDirection;
  slopeStrong: boolean;
  lookbackBars: number;
  timeframe: string;
  /** True when enough candles existed to compute a slope. */
  computable: boolean;
};

export type PriceSlopeConflictReason = "price_slope_opposes_verdict";

/** Full SCALP gate outcome attached to SynthesisResult (null on SWING). */
export type PriceSlopeGateOutcome = PriceSlopeGateResult & {
  /** Gate fired and downgraded BULLISH/BEARISH → NEUTRAL. */
  applied: boolean;
  conflictReason: PriceSlopeConflictReason | null;
  /** Lane-based verdict before this gate (auditable). */
  preGateVerdict: DirectionalVerdict | null;
  preGateStructureBranch: StructureResult["branch"] | null;
};

/**
 * slopePct = (lastClose − closeNBarsAgo) / closeNBarsAgo × 100
 * Uses the most recent bars from the primary TF series (includes forming
 * bar when the feed returns it — matches live tape for the sanity check).
 */
export function computePriceSlope(
  candles: OhlcvCandle[],
  opts?: { lookbackBars?: number; timeframe?: string },
): PriceSlopeGateResult {
  const lookbackBars = opts?.lookbackBars ?? SLOPE_LOOKBACK_BARS;
  const timeframe = opts?.timeframe ?? "5m";

  if (candles.length < lookbackBars + 1) {
    return {
      slopePct: 0,
      slopeDirection: "flat",
      slopeStrong: false,
      lookbackBars,
      timeframe,
      computable: false,
    };
  }

  const last = candles[candles.length - 1]!;
  const prior = candles[candles.length - 1 - lookbackBars]!;
  const lastClose = last.close;
  const closeNBarsAgo = prior.close;

  if (
    !Number.isFinite(lastClose) ||
    !Number.isFinite(closeNBarsAgo) ||
    closeNBarsAgo === 0
  ) {
    return {
      slopePct: 0,
      slopeDirection: "flat",
      slopeStrong: false,
      lookbackBars,
      timeframe,
      computable: false,
    };
  }

  // slopePct = (lastClose − closeNBarsAgo) / closeNBarsAgo × 100
  const slopePct = ((lastClose - closeNBarsAgo) / closeNBarsAgo) * 100;
  const slopeDirection: SlopeDirection =
    slopePct > 0 ? "up" : slopePct < 0 ? "down" : "flat";
  const slopeStrong = Math.abs(slopePct) >= SLOPE_STRONG_THRESHOLD_PCT;

  return {
    slopePct,
    slopeDirection,
    slopeStrong,
    lookbackBars,
    timeframe,
    computable: true,
  };
}

/**
 * Gate: if the verdict direction conflicts with a STRONG recent price slope,
 * don't silently print LONG/SHORT against the tape — downgrade to NEUTRAL.
 * Applies to BOTH Buy-CE and Sell-PE "LONG" structures (Sell PE in a strong
 * downtrend carries the same conflict, and is the higher-risk uncapped-loss
 * case — treat at least as cautiously as Buy CE).
 */
export function verdictConflictsWithSlope(
  verdict: DirectionalVerdict,
  slope: PriceSlopeGateResult,
): boolean {
  if (!slope.computable || !slope.slopeStrong) return false;
  if (verdict === "BULLISH" && slope.slopeDirection === "down") return true;
  if (verdict === "BEARISH" && slope.slopeDirection === "up") return true;
  return false;
}

export type ApplyPriceSlopeGateParams = {
  verdict: DirectionalVerdict;
  structure: StructureResult;
  candles: OhlcvCandle[];
  extras: OptionsFlowExtras;
  timeframe?: string;
};

export type ApplyPriceSlopeGateResult = {
  directionalVerdict: DirectionalVerdict;
  structure: StructureResult;
  /** Notes to append onto DirectionalResult.notes */
  notes: string[];
  gate: PriceSlopeGateOutcome;
};

/**
 * Post-synthesis check (SCALP path). Pure — does not mutate lane scores.
 */
export function applyPriceSlopeGate(
  params: ApplyPriceSlopeGateParams,
): ApplyPriceSlopeGateResult {
  const slope = computePriceSlope(params.candles, {
    timeframe: params.timeframe ?? "5m",
  });

  const conflicts = verdictConflictsWithSlope(params.verdict, slope);

  if (!conflicts) {
    return {
      directionalVerdict: params.verdict,
      structure: params.structure,
      notes: [],
      gate: {
        ...slope,
        applied: false,
        conflictReason: null,
        preGateVerdict: null,
        preGateStructureBranch: null,
      },
    };
  }

  const preGateVerdict = params.verdict;
  const preGateStructureBranch = params.structure.branch;
  const conflictReason: PriceSlopeConflictReason = "price_slope_opposes_verdict";

  // Downgrade to NEUTRAL / NO_TRADE — lane score + pre-gate branch kept on `gate`
  const neutralStructure = synthesizeStructure("NEUTRAL", params.extras);
  const slopeLabel = `${slope.slopeDirection} ${slope.slopePct.toFixed(2)}% / ${slope.lookbackBars}×${slope.timeframe}`;
  const structure: StructureResult = {
    ...neutralStructure,
    reasoning: `Price-slope gate: recent momentum (${slopeLabel}) opposes lane verdict ${preGateVerdict} (${preGateStructureBranch}). Downgraded to NO_TRADE — conflictReason=${conflictReason}. Lane combined score unchanged (auditable on directional).`,
  };

  const notes = [
    `Price-slope gate applied: ${slopeLabel} conflicts with ${preGateVerdict} → NEUTRAL (${conflictReason}). Pre-gate structure was ${preGateStructureBranch}.`,
  ];

  return {
    directionalVerdict: "NEUTRAL",
    structure,
    notes,
    gate: {
      ...slope,
      applied: true,
      conflictReason,
      preGateVerdict,
      preGateStructureBranch,
    },
  };
}
