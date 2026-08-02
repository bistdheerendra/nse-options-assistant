import { getOptionChain, getUnderlyingCandles, type OhlcvCandle, type Underlying } from "@/lib/marketdata/angelone";
import {
  assessScalpLiquidity,
  type LiquidityAssessment,
} from "@/lib/marketdata/scalp/liquidity";
import {
  computeOiVelocity,
  type OiVelocityResult,
} from "@/lib/marketdata/scalp/oiVelocity";
import {
  deriveStopLossClusters,
  type StopLossClusterResult,
} from "@/lib/marketdata/scalp/stopLossClusters";
import { getMultiTimeframeCandles } from "@/lib/marketdata/scalp/multiTimeframeCandles";
import {
  buildScalpSignalCard,
  type ScalpSignalCard,
} from "@/lib/marketdata/scalp/scalpSignal";
import { runMacroLane } from "@/lib/lanes/macro";
import { runOptionsFlowLane } from "@/lib/lanes/optionsFlow";
import { runSentimentLane } from "@/lib/lanes/sentiment";
import { runTechnicalLane } from "@/lib/lanes/technical";
import type { TradingMode } from "@/lib/lanes/types";
import { clampScore } from "@/lib/lanes/types";
import { hasDatabase, prisma } from "@/lib/prisma";
import {
  computeTrackRecord,
  edgeFromTrackRecord,
} from "@/lib/backtest/trackRecord";
import { CURRENT_SYNTHESIS_VERSION } from "@/lib/backtest/synthesisVersion";
import { computeLaneAlignment } from "./alignment";
import { synthesizeDirectional } from "./directional";
import { detectRegime } from "./regime";
import { synthesizeStructure } from "./structure";
import { buildTradePlan } from "./tradePlan";
import type { Prisma } from "@prisma/client";

export type ExperimentalEdge = {
  winRatePct: number | null;
  sampleSize: number;
  branch: string;
  label: string;
  experimental: true;
  synthesisVersion?: string;
  insufficientSample?: boolean;
  legacySampleSize?: number;
};

export type SynthesisResult = {
  underlying: Underlying;
  mode: TradingMode;
  directional: ReturnType<typeof synthesizeDirectional>;
  structure: ReturnType<typeof synthesizeStructure>;
  lanes: {
    technical: Awaited<ReturnType<typeof runTechnicalLane>>;
    optionsFlow: Awaited<ReturnType<typeof runOptionsFlowLane>>;
    sentiment: Awaited<ReturnType<typeof runSentimentLane>>;
    macro: Awaited<ReturnType<typeof runMacroLane>>;
  };
  confidenceLabel: string;
  scalpLiquidityWarning: string | null;
  /** Stage 4 structured liquidity gate (SCALP only; null on SWING). */
  scalpLiquidity: LiquidityAssessment | null;
  /** Stage 5 SL-cluster / S-R levels (SCALP only). */
  stopLossClusters: StopLossClusterResult | null;
  /** Stage 6 OI velocity (SCALP only). */
  oiVelocity: OiVelocityResult | null;
  /** Stage 7–8 scalp signal card (SCALP only). */
  scalpSignal: ScalpSignalCard | null;
  swingThetaWarning: string | null;
  daysToExpiry: number | null;
  tradeIdeaId: string | null;
  persisted: boolean;
  regime: ReturnType<typeof detectRegime>;
  alignment: ReturnType<typeof computeLaneAlignment>;
  tradePlan: ReturnType<typeof buildTradePlan>;
  experimentalEdge: ExperimentalEdge;
  spot: number;
  expiry: string;
};

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, (b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function edgeForBranch(branch: string): Promise<ExperimentalEdge> {
  try {
    const tr = await computeTrackRecord();
    return edgeFromTrackRecord(tr, branch);
  } catch {
    return {
      winRatePct: null,
      sampleSize: 0,
      branch,
      label: "Experimental / unvalidated — track record unavailable.",
      experimental: true,
      synthesisVersion: CURRENT_SYNTHESIS_VERSION,
      insufficientSample: true,
      legacySampleSize: 0,
    };
  }
}

export async function runSynthesis(params: {
  underlying: Underlying;
  mode?: TradingMode;
  expiry?: string;
  persist?: boolean;
}): Promise<SynthesisResult> {
  const mode = params.mode ?? "SWING";
  const chain = await getOptionChain(params.underlying, params.expiry);

  // Scalp uses 5m candles for clusters; swing keeps hour series via technical lane.
  let scalpCandles: OhlcvCandle[] | undefined;
  if (mode === "SCALP") {
    try {
      scalpCandles = await getUnderlyingCandles(
        params.underlying,
        "FIVE_MINUTE",
        5,
      );
    } catch {
      scalpCandles = undefined;
    }
  }

  const [technicalRaw, optionsFlow, sentiment, macro] = await Promise.all([
    runTechnicalLane({
      underlying: params.underlying,
      mode,
      candles: scalpCandles,
    }),
    runOptionsFlowLane({
      underlying: params.underlying,
      mode,
      chain,
      expiry: params.expiry,
    }),
    runSentimentLane({ underlying: params.underlying, mode }),
    runMacroLane({ underlying: params.underlying, mode }),
  ]);

  let scalpLiquidity: LiquidityAssessment | null = null;
  let scalpLiquidityWarning: string | null = null;
  let stopLossClusters: StopLossClusterResult | null = null;
  let oiVelocity: OiVelocityResult | null = null;
  let scalpSignal: ScalpSignalCard | null = null;

  let technical = technicalRaw;

  if (mode === "SCALP") {
    // Pre-structure liquidity gate (ATM CE focus); refined after structure below.
    scalpLiquidity = assessScalpLiquidity(chain, null);
    stopLossClusters = deriveStopLossClusters({
      underlying: params.underlying,
      spot: chain.spot,
      candles: scalpCandles ?? [],
      chain,
    });
    oiVelocity = computeOiVelocity(chain);

    try {
      const mtf = await getMultiTimeframeCandles(params.underlying);
      scalpSignal = buildScalpSignalCard({
        underlying: params.underlying,
        candleBundle: mtf,
        liquidity: scalpLiquidity,
        clusters: stopLossClusters,
        oiVelocity,
      });
      // Feed Stage 2–7 lean into existing §2.5 SCALP technical weight (0.35) — not a second scorer.
      technical = {
        ...technicalRaw,
        score: clampScore(
          technicalRaw.score + scalpSignal.technicalBiasAdj * 0.5,
        ),
        signals: [
          ...technicalRaw.signals,
          `Scalp PA/volume/OI adj=${scalpSignal.technicalBiasAdj.toFixed(2)} (heuristic)`,
        ],
        rawIndicators: {
          ...technicalRaw.rawIndicators,
          scalpTechnicalBiasAdj: scalpSignal.technicalBiasAdj,
          scalpConfirmation: scalpSignal.confirmation.status,
        },
      };
    } catch {
      // MTF fetch failed — leave scalpSignal null; synthesis still runs on lanes.
    }
  }

  const directional = synthesizeDirectional(
    { technical, optionsFlow, sentiment, macro },
    mode,
  );
  const structure = synthesizeStructure(directional.verdict, optionsFlow.extras);

  if (mode === "SCALP" && scalpLiquidity) {
    const preferredSide =
      structure.optionType === "CE" || structure.optionType === "PE"
        ? structure.optionType
        : null;
    scalpLiquidity = assessScalpLiquidity(chain, preferredSide);
    scalpLiquidityWarning = scalpLiquidity.warning;
    if (scalpSignal) {
      scalpSignal = {
        ...scalpSignal,
        liquidityStatus: scalpLiquidity.status,
        liquidityBadge: scalpLiquidity.badgeLabel,
        actionable:
          scalpSignal.confirmation.status === "confirmed" &&
          scalpLiquidity.status !== "fail" &&
          scalpSignal.volumeConfirmation !== "disqualify",
        actionableNote:
          scalpSignal.confirmation.status === "confirmed" &&
          scalpLiquidity.status !== "fail" &&
          scalpSignal.volumeConfirmation !== "disqualify"
            ? "Rule stack cleared (confirm candle + liquidity + volume) — still a heuristic, not a validated edge."
            : scalpLiquidity.status === "fail"
              ? "Not actionable: liquidity fail (unsuitable for scalping)"
              : scalpSignal.actionableNote,
      };
    }
  }

  const atr = num(technical.rawIndicators.atr14);
  const regime = detectRegime({
    spot: chain.spot,
    atr,
    ema50: num(technical.rawIndicators.ema50) ?? undefined,
    ema200: num(technical.rawIndicators.ema200) ?? undefined,
  });

  const alignment = computeLaneAlignment(directional.verdict, {
    technical,
    optionsFlow,
    sentiment,
    macro,
  });

  const aligningLanes = Object.entries(alignment.perLane)
    .filter(([, v]) => v === "aligned")
    .map(([k]) => k);

  const tradePlan = buildTradePlan({
    spot: chain.spot,
    atr,
    mode,
    verdict: directional.verdict,
    structure,
    chain,
    swingHigh: num(technical.rawIndicators.swingHigh),
    swingLow: num(technical.rawIndicators.swingLow),
    laneNotes:
      aligningLanes.length > 0
        ? [
            `${aligningLanes.map((n) => n[0]!.toUpperCase() + n.slice(1)).join(" + ")} lane(s) flag ${
              directional.verdict === "BULLISH" ? "upside" : "downside"
            } bias.`,
          ]
        : undefined,
  });

  const experimentalEdge = await edgeForBranch(structure.branch);

  const expiryDate = new Date(chain.expiry);
  const dte = daysBetween(new Date(), expiryDate);

  let swingThetaWarning: string | null = null;
  if (mode === "SWING") {
    if (dte <= 3) {
      swingThetaWarning =
        "Swing mode: ≤3 DTE — Theta decay likely to outpace modest directional gains on long premium; prefer defined risk or avoid.";
    } else if (dte <= 7 && structure.action === "BUY") {
      swingThetaWarning =
        "Swing mode: ≤7 DTE on a Buy recommendation — Theta may dominate if the move is slow.";
    }
  }

  const confidenceLabel =
    "Rules-based heuristic (not a validated statistical edge — Stage 6 track record is experimental until multi-regime sample size).";

  const featureSnapshot = {
    underlying: params.underlying,
    mode,
    spot: chain.spot,
    expiry: chain.expiry,
    synthesisVersion: CURRENT_SYNTHESIS_VERSION,
    directional,
    structure,
    regime,
    alignment,
    tradePlan,
    experimentalEdge,
    lanes: {
      technical: { score: technical.score, signals: technical.signals, rawIndicators: technical.rawIndicators },
      optionsFlow: {
        score: optionsFlow.score,
        signals: optionsFlow.signals,
        rawIndicators: optionsFlow.rawIndicators,
        extras: optionsFlow.extras,
      },
      sentiment: { score: sentiment.score, signals: sentiment.signals, rawIndicators: sentiment.rawIndicators },
      macro: { score: macro.score, signals: macro.signals, rawIndicators: macro.rawIndicators },
    },
    warnings: { scalpLiquidityWarning, swingThetaWarning },
    scalpLiquidity,
    stopLossClusters,
    oiVelocity,
    scalpSignal,
  };

  let tradeIdeaId: string | null = null;
  let persisted = false;
  if (params.persist !== false && hasDatabase() && prisma) {
    try {
      const row = await prisma.tradeIdea.create({
        data: {
          underlying: params.underlying,
          mode,
          directionalVerdict: directional.verdict,
          structureAction: structure.branch,
          structureSide: structure.action,
          isSellWrite: structure.isSellWrite,
          reasoning: structure.reasoning,
          confidenceLabel,
          featureSnapshot: featureSnapshot as Prisma.InputJsonValue,
          synthesisVersion: CURRENT_SYNTHESIS_VERSION,
        },
      });
      tradeIdeaId = row.id;
      persisted = true;
    } catch (err) {
      // DATABASE_URL may be set but unreachable (e.g. local Postgres down).
      // Analysis still returns; UI already handles persisted === false.
      console.warn(
        "[synthesis] tradeIdea persist skipped — database unreachable:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    underlying: params.underlying,
    mode,
    directional,
    structure,
    lanes: { technical, optionsFlow, sentiment, macro },
    confidenceLabel,
    scalpLiquidityWarning,
    scalpLiquidity,
    stopLossClusters,
    oiVelocity,
    scalpSignal,
    swingThetaWarning,
    daysToExpiry: dte,
    tradeIdeaId,
    persisted,
    regime,
    alignment,
    tradePlan,
    experimentalEdge,
    spot: chain.spot,
    expiry: chain.expiry,
  };
}

export { synthesizeDirectional, synthesizeStructure };
export { buildTradePlan } from "./tradePlan";
export { detectRegime } from "./regime";
export { computeLaneAlignment } from "./alignment";
