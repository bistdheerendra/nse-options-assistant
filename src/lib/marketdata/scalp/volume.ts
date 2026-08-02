import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { ScalpTimeframe } from "@/lib/marketdata/scalp/types";
import type { TimeframePriceAction } from "./priceAction";

/**
 * Scalp Stage 3 — volume as confirm / disqualify (not a standalone signal).
 *
 * Parameters (documented — tunable later via env / config, not buried magic):
 *   VOLUME_LOOKBACK = 20   → rolling mean of prior N completed bars (excludes current)
 *   VOLUME_SPIKE_MULT = 1.5 → current vol ≥ 1.5 × rolling mean ⇒ spike
 *   VOLUME_WEAK_MULT = 0.6  → current vol < 0.6 × rolling mean ⇒ weak (disqualifies pattern confidence)
 *
 * Confidence adjustment applied to an incoming pattern/structure confidence ∈ [0,1]:
 *   spike + aligned direction → +0.15 (confirm)
 *   normal volume             → +0.00
 *   weak volume               → −0.25 (disqualify pressure)
 *   Result clamped to [0, 1]
 */

export const VOLUME_LOOKBACK = 20;
export const VOLUME_SPIKE_MULT = 1.5;
export const VOLUME_WEAK_MULT = 0.6;

export const VOLUME_CONFIRM_BOOST = 0.15;
export const VOLUME_WEAK_PENALTY = 0.25;

export type VolumeFlag = "spike" | "normal" | "weak" | "insufficient";

export type TimeframeVolumeAnalysis = {
  interval: ScalpTimeframe;
  currentVolume: number;
  /** Rolling mean of prior VOLUME_LOOKBACK bars (excludes current). */
  avgVolume: number | null;
  /** current / avg — null if insufficient history. */
  volumeRatio: number | null;
  flag: VolumeFlag;
  lookback: number;
  spikeMult: number;
  weakMult: number;
  signals: string[];
};

export type VolumeConfirmation = {
  interval: ScalpTimeframe;
  volume: TimeframeVolumeAnalysis;
  /**
   * Input confidence before volume (from pattern/structure heuristics).
   * Stage 3 does not invent directional edge — it only adjusts confidence.
   */
  inputConfidence: number;
  /** Confidence after volume confirm/disqualify, clamped [0,1]. */
  adjustedConfidence: number;
  /** confirm | neutral | disqualify */
  role: "confirm" | "neutral" | "disqualify" | "insufficient";
};

export type MultiTimeframeVolume = {
  underlying: string;
  byTimeframe: Record<ScalpTimeframe, TimeframeVolumeAnalysis>;
  confirmations: Record<ScalpTimeframe, VolumeConfirmation>;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Rolling average volume of the prior `lookback` bars, excluding the last bar.
 * avg = sum(vol[i] for i in [n-1-lookback, n-2]) / lookback
 */
export function rollingAvgVolume(
  candles: OhlcvCandle[],
  lookback = VOLUME_LOOKBACK,
): number | null {
  // Need lookback prior bars + current ⇒ length ≥ lookback + 1
  if (candles.length < lookback + 1) return null;
  const end = candles.length - 1; // exclude current (last)
  const start = end - lookback;
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += candles[i]!.volume;
  }
  return sum / lookback;
}

export function analyzeTimeframeVolume(
  interval: ScalpTimeframe,
  candles: OhlcvCandle[],
  opts?: {
    lookback?: number;
    spikeMult?: number;
    weakMult?: number;
  },
): TimeframeVolumeAnalysis {
  const lookback = opts?.lookback ?? VOLUME_LOOKBACK;
  const spikeMult = opts?.spikeMult ?? VOLUME_SPIKE_MULT;
  const weakMult = opts?.weakMult ?? VOLUME_WEAK_MULT;
  const signals: string[] = [];

  if (candles.length === 0) {
    return {
      interval,
      currentVolume: 0,
      avgVolume: null,
      volumeRatio: null,
      flag: "insufficient",
      lookback,
      spikeMult,
      weakMult,
      signals: ["no candles for volume analysis"],
    };
  }

  const currentVolume = candles[candles.length - 1]!.volume;
  const avgVolume = rollingAvgVolume(candles, lookback);

  if (avgVolume === null || avgVolume <= 0) {
    signals.push(
      `insufficient history for ${lookback}-bar volume average (have ${Math.max(0, candles.length - 1)} prior bars)`,
    );
    return {
      interval,
      currentVolume,
      avgVolume,
      volumeRatio: null,
      flag: "insufficient",
      lookback,
      spikeMult,
      weakMult,
      signals,
    };
  }

  // ratio = currentVolume / avgVolume
  const volumeRatio = round4(currentVolume / avgVolume);
  let flag: VolumeFlag = "normal";
  if (volumeRatio >= spikeMult) {
    flag = "spike";
    signals.push(
      `volume spike: ${currentVolume.toFixed(0)} ≥ ${spikeMult}× avg(${lookback})=${avgVolume.toFixed(0)} (ratio=${volumeRatio})`,
    );
  } else if (volumeRatio < weakMult) {
    flag = "weak";
    signals.push(
      `weak volume: ${currentVolume.toFixed(0)} < ${weakMult}× avg(${lookback})=${avgVolume.toFixed(0)} (ratio=${volumeRatio})`,
    );
  } else {
    signals.push(
      `normal volume: ratio=${volumeRatio} vs spike≥${spikeMult} / weak<${weakMult}`,
    );
  }

  return {
    interval,
    currentVolume,
    avgVolume: round4(avgVolume),
    volumeRatio,
    flag,
    lookback,
    spikeMult,
    weakMult,
    signals,
  };
}

/**
 * Seed confidence from Stage 2 price-action object (heuristic, not validated edge).
 * pattern present → 0.55 base; structure aligned with candle dir → +0.2; strength × 0.25
 */
export function seedConfidenceFromPriceAction(
  pa: TimeframePriceAction,
): number {
  let c = 0.35;
  if (pa.primaryPattern && pa.primaryPattern !== "doji") c += 0.2;
  if (pa.primaryPattern === "doji" || pa.primaryPattern === "inside_bar") c += 0.05;
  if (
    (pa.structureBias === "bullish" && pa.candleDirection >= 0) ||
    (pa.structureBias === "bearish" && pa.candleDirection <= 0)
  ) {
    c += 0.2;
  }
  c += pa.candleStrength * 0.25;
  return clamp01(round4(c));
}

/**
 * Apply volume as confirm/disqualify to an input confidence.
 * Spike confirms only when candleDirection ≠ 0 (has a directional close).
 */
export function applyVolumeConfirmation(
  volume: TimeframeVolumeAnalysis,
  inputConfidence: number,
  candleDirection: -1 | 0 | 1,
): VolumeConfirmation {
  let adjusted = inputConfidence;
  let role: VolumeConfirmation["role"] = "neutral";

  if (volume.flag === "insufficient") {
    role = "insufficient";
  } else if (volume.flag === "spike" && candleDirection !== 0) {
    adjusted = inputConfidence + VOLUME_CONFIRM_BOOST;
    role = "confirm";
  } else if (volume.flag === "spike" && candleDirection === 0) {
    // Spike on a doji — not directional confirmation
    role = "neutral";
  } else if (volume.flag === "weak") {
    adjusted = inputConfidence - VOLUME_WEAK_PENALTY;
    role = "disqualify";
  }

  return {
    interval: volume.interval,
    volume,
    inputConfidence: round4(inputConfidence),
    adjustedConfidence: round4(clamp01(adjusted)),
    role,
  };
}

export function analyzeMultiTimeframeVolume(params: {
  underlying: string;
  series: Partial<
    Record<ScalpTimeframe, { candles: OhlcvCandle[] } | undefined>
  >;
  priceAction?: Partial<
    Record<ScalpTimeframe, TimeframePriceAction | undefined>
  >;
  timeframes?: ScalpTimeframe[];
}): MultiTimeframeVolume {
  const timeframes: ScalpTimeframe[] = params.timeframes ?? [
    "ONE_MINUTE",
    "THREE_MINUTE",
    "FIVE_MINUTE",
    "FIFTEEN_MINUTE",
  ];

  const byTimeframe = {} as Record<ScalpTimeframe, TimeframeVolumeAnalysis>;
  const confirmations = {} as Record<ScalpTimeframe, VolumeConfirmation>;

  for (const tf of timeframes) {
    const candles = params.series[tf]?.candles ?? [];
    const vol = analyzeTimeframeVolume(tf, candles);
    byTimeframe[tf] = vol;

    const pa = params.priceAction?.[tf];
    const input = pa ? seedConfidenceFromPriceAction(pa) : 0.5;
    const dir = pa?.candleDirection ?? 0;
    confirmations[tf] = applyVolumeConfirmation(vol, input, dir);
  }

  return { underlying: params.underlying, byTimeframe, confirmations };
}
