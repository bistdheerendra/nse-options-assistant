/**
 * Recent raw price momentum, independent of any lane score.
 * This is a sanity gate on the FINAL verdict, not a new scoring input —
 * it does not touch §2.5 lane weights or the ±0.15 neutral threshold.
 *
 * Mode-specific lookback / strong-threshold (do NOT share SCALP↔SWING numbers).
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { OptionsFlowExtras } from "@/lib/lanes/optionsFlow";
import type { TradingMode } from "@/lib/lanes/types";
import type { DirectionalVerdict } from "./directional";
import type { StructureResult } from "./structure";
import { synthesizeStructure } from "./structure";

/** SCALP: last N bars on 5m primary TF. */
export const SCALP_SLOPE_LOOKBACK_BARS = 5;
/**
 * SCALP: % move over lookback considered "strong" on 5m.
 * Tuned for short-horizon scalp tape — do not reuse on 1h.
 */
export const SCALP_SLOPE_STRONG_THRESHOLD_PCT = 0.15;

/**
 * SWING: last N × 1h bars.
 * NSE cash session ≈ 6.25h → 15 bars ≈ 2–2.5 trading days — long enough to
 * represent a multi-day swing "trend conflict", short enough not to lag a
 * full week past the trade horizon. (5 bars = 5h is too short at this TF;
 * 20 ≈ 3 days is an alternate — 15 chosen as mid of the 10–20 band.)
 */
export const SWING_SLOPE_LOOKBACK_BARS = 15;

/**
 * SWING: % move over lookback considered "strong" on 1h.
 * From live Angel 1h series (NIFTY+BANKNIFTY+SENSEX, n=618 windows @ lb=15,
 * ~9 calendar days available from feed): |slope| p80≈0.21%, p90≈0.26%,
 * p95≈0.32%, p99≈0.38%, max≈0.42%. SCALP's 0.15% fires ~40% of windows
 * (ordinary 1h noise). 0.35% ≈ above p95 / fires ~3% in that sample —
 * "strong" without copying the 5m constant. Retune if a multi-regime
 * history window becomes available (this feed capped ~221 bars).
 */
export const SWING_SLOPE_STRONG_THRESHOLD_PCT = 0.35;

/** @deprecated Prefer SCALP_SLOPE_LOOKBACK_BARS — kept for existing imports/tests. */
export const SLOPE_LOOKBACK_BARS = SCALP_SLOPE_LOOKBACK_BARS;
/** @deprecated Prefer SCALP_SLOPE_STRONG_THRESHOLD_PCT */
export const SLOPE_STRONG_THRESHOLD_PCT = SCALP_SLOPE_STRONG_THRESHOLD_PCT;

export type SlopeDirection = "up" | "down" | "flat";

export type PriceSlopeGateResult = {
  slopePct: number;
  slopeDirection: SlopeDirection;
  slopeStrong: boolean;
  lookbackBars: number;
  timeframe: string;
  /** Threshold used for slopeStrong (mode-specific). */
  strongThresholdPct: number;
  /** True when enough candles existed to compute a slope. */
  computable: boolean;
};

export type PriceSlopeConflictReason = "price_slope_opposes_verdict";

/** Gate outcome attached to SynthesisResult (SCALP + SWING). */
export type PriceSlopeGateOutcome = PriceSlopeGateResult & {
  /** Gate fired and downgraded BULLISH/BEARISH → NEUTRAL. */
  applied: boolean;
  conflictReason: PriceSlopeConflictReason | null;
  /** Lane-based verdict before this gate (auditable). */
  preGateVerdict: DirectionalVerdict | null;
  preGateStructureBranch: StructureResult["branch"] | null;
};

export function slopeParamsForMode(mode: TradingMode): {
  lookbackBars: number;
  strongThresholdPct: number;
  timeframe: string;
} {
  if (mode === "SCALP") {
    return {
      lookbackBars: SCALP_SLOPE_LOOKBACK_BARS,
      strongThresholdPct: SCALP_SLOPE_STRONG_THRESHOLD_PCT,
      timeframe: "5m",
    };
  }
  return {
    lookbackBars: SWING_SLOPE_LOOKBACK_BARS,
    strongThresholdPct: SWING_SLOPE_STRONG_THRESHOLD_PCT,
    timeframe: "1h",
  };
}

/**
 * slopePct = (lastClose − closeNBarsAgo) / closeNBarsAgo × 100
 * Uses the most recent bars from the primary TF series (includes forming
 * bar when the feed returns it — matches live tape for the sanity check).
 */
export function computePriceSlope(
  candles: OhlcvCandle[],
  opts?: {
    lookbackBars?: number;
    timeframe?: string;
    strongThresholdPct?: number;
  },
): PriceSlopeGateResult {
  const lookbackBars = opts?.lookbackBars ?? SCALP_SLOPE_LOOKBACK_BARS;
  const timeframe = opts?.timeframe ?? "5m";
  const strongThresholdPct =
    opts?.strongThresholdPct ?? SCALP_SLOPE_STRONG_THRESHOLD_PCT;

  if (candles.length < lookbackBars + 1) {
    return {
      slopePct: 0,
      slopeDirection: "flat",
      slopeStrong: false,
      lookbackBars,
      timeframe,
      strongThresholdPct,
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
      strongThresholdPct,
      computable: false,
    };
  }

  // slopePct = (lastClose − closeNBarsAgo) / closeNBarsAgo × 100
  const slopePct = ((lastClose - closeNBarsAgo) / closeNBarsAgo) * 100;
  const slopeDirection: SlopeDirection =
    slopePct > 0 ? "up" : slopePct < 0 ? "down" : "flat";
  const slopeStrong = Math.abs(slopePct) >= strongThresholdPct;

  return {
    slopePct,
    slopeDirection,
    slopeStrong,
    lookbackBars,
    timeframe,
    strongThresholdPct,
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
  mode: TradingMode;
};

export type ApplyPriceSlopeGateResult = {
  directionalVerdict: DirectionalVerdict;
  structure: StructureResult;
  /** Notes to append onto DirectionalResult.notes */
  notes: string[];
  gate: PriceSlopeGateOutcome;
};

/**
 * Post-synthesis check (SCALP + SWING). Pure — does not mutate lane scores.
 */
export function applyPriceSlopeGate(
  params: ApplyPriceSlopeGateParams,
): ApplyPriceSlopeGateResult {
  const cfg = slopeParamsForMode(params.mode);
  const slope = computePriceSlope(params.candles, cfg);

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
