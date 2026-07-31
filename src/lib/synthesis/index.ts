import { getOptionChain, type Underlying } from "@/lib/marketdata/angelone";
import { runMacroLane } from "@/lib/lanes/macro";
import { runOptionsFlowLane } from "@/lib/lanes/optionsFlow";
import { runSentimentLane } from "@/lib/lanes/sentiment";
import { runTechnicalLane } from "@/lib/lanes/technical";
import type { TradingMode } from "@/lib/lanes/types";
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

  const [technical, optionsFlow, sentiment, macro] = await Promise.all([
    runTechnicalLane({ underlying: params.underlying, mode }),
    runOptionsFlowLane({
      underlying: params.underlying,
      mode,
      chain,
      expiry: params.expiry,
    }),
    runSentimentLane({ underlying: params.underlying, mode }),
    runMacroLane({ underlying: params.underlying, mode }),
  ]);

  const directional = synthesizeDirectional(
    { technical, optionsFlow, sentiment, macro },
    mode,
  );
  const structure = synthesizeStructure(directional.verdict, optionsFlow.extras);

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

  let scalpLiquidityWarning: string | null = null;
  if (mode === "SCALP" && optionsFlow.extras.lowLiquidityStrikes.length) {
    scalpLiquidityWarning = `Scalp mode: ${optionsFlow.extras.lowLiquidityStrikes.length} strikes flagged low-liquidity (wide bid-ask / low volume) — unsuitable even if direction looks good.`;
  }

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
