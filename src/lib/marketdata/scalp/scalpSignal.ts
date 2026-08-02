import type { Underlying } from "@/lib/marketdata/angelone";
import type { MultiTimeframeCandleBundle } from "./types";
import {
  analyzeMultiTimeframePriceAction,
  type MultiTimeframePriceAction,
} from "./priceAction";
import {
  analyzeMultiTimeframeVolume,
  type MultiTimeframeVolume,
} from "./volume";
import type { LiquidityAssessment } from "./liquidity";
import type { StopLossClusterResult } from "./stopLossClusters";
import type { OiVelocityResult } from "./oiVelocity";
import {
  evaluateConfirmationCandle,
  type ConfirmationCandleResult,
  type ConfirmationRuleConfig,
} from "./confirmationCandle";
import type { ScalpTimeframe } from "./types";

/**
 * Scalp Stage 8 — combine Stages 2–7 into inputs for the existing synthesizer.
 * Does NOT create a second scoring system; produces a scalpSignal card payload
 * + a technical-lane score adjustment that reuses §2.5 SCALP weights.
 */

export type ScalpSignalCard = {
  underlying: Underlying;
  /** Which of 1m/3m/5m/15m agree on structure bias. */
  timeframeConfluence: {
    bullish: ScalpTimeframe[];
    bearish: ScalpTimeframe[];
    ranging: ScalpTimeframe[];
    insufficient: ScalpTimeframe[];
    /** Dominant bias if ≥2 TFs agree; else null. */
    dominant: "bullish" | "bearish" | null;
  };
  primaryPattern: string | null;
  patternTimeframe: ScalpTimeframe | null;
  volumeConfirmation: "confirm" | "neutral" | "disqualify" | "insufficient";
  liquidityStatus: LiquidityAssessment["status"];
  liquidityBadge: string;
  stopLossClusters: {
    nearestSupport: number | null;
    nearestResistance: number | null;
    levels: StopLossClusterResult["levels"];
  };
  oiVelocity: {
    status: OiVelocityResult["status"];
    netPerMin: number | null;
    notable: boolean;
    reading: string;
  };
  confirmation: {
    status: ConfirmationCandleResult["status"];
    direction: ConfirmationCandleResult["direction"];
    reason: string;
    reliabilityNote: string;
  };
  /**
   * Actionable only when confirmation=confirmed AND liquidity≠fail AND volume≠disqualify.
   * Still heuristic — UI must not imply validated edge.
   */
  actionable: boolean;
  actionableNote: string;
  /** Soft lean −1..1 fed into technical lane boost under SCALP weights. */
  technicalBiasAdj: number;
  priceAction: MultiTimeframePriceAction;
  volume: MultiTimeframeVolume;
};

function clamp(n: number, lo = -1, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

export function buildScalpSignalCard(params: {
  underlying: Underlying;
  candleBundle: MultiTimeframeCandleBundle;
  liquidity: LiquidityAssessment;
  clusters: StopLossClusterResult;
  oiVelocity: OiVelocityResult;
  confirmationRule?: Partial<ConfirmationRuleConfig>;
}): ScalpSignalCard {
  const priceAction = analyzeMultiTimeframePriceAction({
    underlying: params.underlying,
    series: params.candleBundle.series,
  });
  const volume = analyzeMultiTimeframeVolume({
    underlying: params.underlying,
    series: params.candleBundle.series,
    priceAction: priceAction.byTimeframe,
  });

  const conf = priceAction.structureConfluence;
  let dominant: "bullish" | "bearish" | null = null;
  if (conf.bullish.length >= 2 && conf.bullish.length > conf.bearish.length) {
    dominant = "bullish";
  } else if (
    conf.bearish.length >= 2 &&
    conf.bearish.length > conf.bullish.length
  ) {
    dominant = "bearish";
  }

  const triggerTf =
    params.confirmationRule?.triggerTimeframe ?? "FIVE_MINUTE";
  const paTf = priceAction.byTimeframe[triggerTf];
  const volTf = volume.confirmations[triggerTf];
  const confirmation = evaluateConfirmationCandle({
    candles: params.candleBundle.series[triggerTf]?.candles ?? [],
    priceAction: paTf,
    volumeConfirmation: volTf,
    rule: params.confirmationRule,
  });

  // Pick a primary pattern from trigger TF, else first TF that has one
  let primaryPattern: string | null = paTf?.primaryPattern ?? null;
  let patternTimeframe: ScalpTimeframe | null = primaryPattern
    ? triggerTf
    : null;
  if (!primaryPattern) {
    for (const tf of [
      "ONE_MINUTE",
      "THREE_MINUTE",
      "FIVE_MINUTE",
      "FIFTEEN_MINUTE",
    ] as ScalpTimeframe[]) {
      const p = priceAction.byTimeframe[tf]?.primaryPattern;
      if (p) {
        primaryPattern = p;
        patternTimeframe = tf;
        break;
      }
    }
  }

  const volumeConfirmation = volTf?.role ?? "insufficient";

  const nearestSupport =
    params.clusters.support
      .filter((s) => s.price < params.clusters.spot)
      .sort((a, b) => b.price - a.price)[0]?.price ??
    params.clusters.support[0]?.price ??
    null;
  const nearestResistance =
    params.clusters.resistance
      .filter((r) => r.price > params.clusters.spot)
      .sort((a, b) => a.price - b.price)[0]?.price ??
    params.clusters.resistance[0]?.price ??
    null;

  const oiReading =
    params.oiVelocity.status === "ready"
      ? `net ${params.oiVelocity.netVelocityPerMin}/min (CE ${params.oiVelocity.callVelocityPerMin}, PE ${params.oiVelocity.putVelocityPerMin})`
      : params.oiVelocity.status === "warming_up"
        ? "warming up — awaiting prior OI snapshot"
        : "unavailable";

  const actionable =
    confirmation.status === "confirmed" &&
    params.liquidity.status !== "fail" &&
    volumeConfirmation !== "disqualify";

  const actionableNote = actionable
    ? "Rule stack cleared (confirm candle + liquidity + volume) — still a heuristic, not a validated edge."
    : confirmation.status !== "confirmed"
      ? `Not actionable: confirmation=${confirmation.status}`
      : params.liquidity.status === "fail"
        ? "Not actionable: liquidity fail (unsuitable for scalping)"
        : "Not actionable: volume disqualified the pattern";

  // Soft technical bias for existing weighted synthesizer (SCALP technical weight 0.35)
  let adj = 0;
  if (dominant === "bullish") adj += 0.25;
  if (dominant === "bearish") adj -= 0.25;
  if (confirmation.status === "confirmed" && confirmation.direction === "bullish")
    adj += 0.2;
  if (confirmation.status === "confirmed" && confirmation.direction === "bearish")
    adj -= 0.2;
  if (confirmation.status === "failed") adj *= 0.3;
  if (volumeConfirmation === "confirm") adj *= 1.1;
  if (volumeConfirmation === "disqualify") adj *= 0.4;
  if (params.liquidity.status === "fail") adj *= 0.2;
  if (
    params.oiVelocity.status === "ready" &&
    params.oiVelocity.netVelocityPerMin != null
  ) {
    // Positive net (call OI rising) mild bullish lean for scalp flow
    adj += clamp(params.oiVelocity.netVelocityPerMin / 20_000, -0.15, 0.15);
  }

  return {
    underlying: params.underlying,
    timeframeConfluence: {
      ...conf,
      dominant,
    },
    primaryPattern,
    patternTimeframe,
    volumeConfirmation,
    liquidityStatus: params.liquidity.status,
    liquidityBadge: params.liquidity.badgeLabel,
    stopLossClusters: {
      nearestSupport,
      nearestResistance,
      levels: params.clusters.levels,
    },
    oiVelocity: {
      status: params.oiVelocity.status,
      netPerMin: params.oiVelocity.netVelocityPerMin,
      notable: params.oiVelocity.notable,
      reading: oiReading,
    },
    confirmation: {
      status: confirmation.status,
      direction: confirmation.direction,
      reason: confirmation.reason,
      reliabilityNote: confirmation.reliabilityNote,
    },
    actionable,
    actionableNote,
    technicalBiasAdj: clamp(adj),
    priceAction,
    volume,
  };
}
