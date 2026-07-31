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
 * All four lanes are live (Stage 2.5b). Each lane's own scoring remains
 * rules-based / heuristic — not ML-validated (see Section 6 track-record gate).
 *
 * Scalp weights: OI/momentum dominate; Sentiment 0.10 (FII/DII is daily-lagged),
 * Macro 0.10 (overnight cues matter less tick-to-tick).
 * Swing weights: Macro 0.20 + Sentiment 0.15 for multi-day FII/news/global context;
 * Technical 0.40 + Options Flow 0.25 for structure/trend.
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
  if (lanes.sentiment.rawIndicators.unavailable) {
    notes.push(
      "Sentiment lane degraded — data unavailable; score forced to 0 this run.",
    );
  }
  if (lanes.macro.rawIndicators.unavailable) {
    notes.push("Macro lane degraded — data unavailable; score forced to 0 this run.");
  }

  let verdict: DirectionalVerdict = "NEUTRAL";
  if (combinedScore >= 0.15) verdict = "BULLISH";
  else if (combinedScore <= -0.15) verdict = "BEARISH";

  return { verdict, combinedScore, weights, components, notes };
}
