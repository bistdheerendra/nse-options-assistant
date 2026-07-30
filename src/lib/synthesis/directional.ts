import type { LaneResult, TradingMode } from "../lanes/types";

export type DirectionalVerdict = "BULLISH" | "BEARISH" | "NEUTRAL";

export type DirectionalResult = {
  verdict: DirectionalVerdict;
  combinedScore: number;
  weights: Record<string, number>;
  components: Record<string, number>;
  notes: string[];
};

/**
 * Weighted combination of lane scores.
 * Sentiment/Macro are stubs (0) until Stage 2.5 — weighting is therefore incomplete.
 */
export function synthesizeDirectional(
  lanes: {
    technical: LaneResult;
    optionsFlow: LaneResult;
    sentiment: LaneResult;
    macro: LaneResult;
  },
  mode: TradingMode,
): DirectionalResult {
  // Scalp: momentum / OI flow heavier; Swing: trend + (future) FII/macro heavier
  const weights =
    mode === "SCALP"
      ? { technical: 0.35, optionsFlow: 0.45, sentiment: 0.1, macro: 0.1 }
      : { technical: 0.4, optionsFlow: 0.25, sentiment: 0.15, macro: 0.2 };

  const components = {
    technical: lanes.technical.score,
    optionsFlow: lanes.optionsFlow.score,
    sentiment: lanes.sentiment.score,
    macro: lanes.macro.score,
  };

  // combined = Σ w_i * score_i
  const combinedScore =
    weights.technical * components.technical +
    weights.optionsFlow * components.optionsFlow +
    weights.sentiment * components.sentiment +
    weights.macro * components.macro;

  const notes = [
    "Rules-based heuristic — not a validated statistical edge (no backtest gate passed yet for live claims).",
  ];
  if (lanes.sentiment.rawIndicators.stub || lanes.macro.rawIndicators.stub) {
    notes.push(
      "Sentiment + Macro lanes are stubs (score 0). Stage 2.5 required before weighting is real.",
    );
  }

  let verdict: DirectionalVerdict = "NEUTRAL";
  if (combinedScore >= 0.15) verdict = "BULLISH";
  else if (combinedScore <= -0.15) verdict = "BEARISH";

  return { verdict, combinedScore, weights, components, notes };
}
