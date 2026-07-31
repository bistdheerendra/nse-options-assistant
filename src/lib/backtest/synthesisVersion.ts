/**
 * Synthesis-version cohort tags for track-record / backtest.
 * Pre-Stage-2.5 records had Macro + Sentiment stubbed at 0 — not the same
 * as a genuine 4-lane neutral reading. Never pool them into "current system" metrics.
 */

export const SYNTHESIS_VERSION = {
  /** Technical + Options Flow effective; Macro/Sentiment forced stub score 0 */
  LEGACY_2LANE: "lanes-v1-2lane-effective",
  /** All four lanes live (post Stage 2.5a Macro + 2.5b Sentiment) */
  FOUR_LANE: "lanes-v2-4lane",
} as const;

export type SynthesisVersion =
  (typeof SYNTHESIS_VERSION)[keyof typeof SYNTHESIS_VERSION];

/** What new TradeIdeas / outcomes write going forward. */
export const CURRENT_SYNTHESIS_VERSION: SynthesisVersion =
  SYNTHESIS_VERSION.FOUR_LANE;

/**
 * Stage 2.5b ship window (UTC). Records decided before this without explicit
 * 4-lane evidence are treated as legacy 2-lane-effective.
 */
export const FOUR_LANE_ERA_START = new Date("2026-07-31T06:00:00.000Z");

/**
 * Minimum resolved outcomes in the post-4-lane cohort before we surface a
 * win-rate number as "current system" edge. Below this → insufficient sample.
 */
export const MIN_SAMPLE_FOR_EDGE_REPORT = 10;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function laneRaw(
  snapshot: unknown,
  lane: string,
): Record<string, unknown> | null {
  const root = asRecord(snapshot);
  const lanes = asRecord(root?.lanes);
  const laneObj = asRecord(lanes?.[lane]);
  return asRecord(laneObj?.rawIndicators);
}

/**
 * Infer synthesis version for a historical TradeIdea / BacktestOutcome.
 * Prefer explicit field; else inspect stub flags / laneScores shape / era cutoff.
 */
export function inferSynthesisVersion(input: {
  synthesisVersion?: string | null;
  laneScores?: Record<string, number> | null;
  featureSnapshot?: unknown;
  decidedAt?: string | Date | null;
}): SynthesisVersion {
  if (
    input.synthesisVersion === SYNTHESIS_VERSION.FOUR_LANE ||
    input.synthesisVersion === SYNTHESIS_VERSION.LEGACY_2LANE
  ) {
    return input.synthesisVersion;
  }

  const macroRaw = laneRaw(input.featureSnapshot, "macro");
  const sentimentRaw = laneRaw(input.featureSnapshot, "sentiment");

  if (macroRaw?.stub === true || sentimentRaw?.stub === true) {
    return SYNTHESIS_VERSION.LEGACY_2LANE;
  }

  // Live 4-lane snapshots set heuristic (and no stub) on both Macro + Sentiment
  if (
    macroRaw?.heuristic === true &&
    sentimentRaw?.heuristic === true &&
    macroRaw.stub !== true &&
    sentimentRaw.stub !== true
  ) {
    return SYNTHESIS_VERSION.FOUR_LANE;
  }

  const scores = input.laneScores ?? {};
  const hasMacroKey = Object.prototype.hasOwnProperty.call(scores, "macro");
  const hasSentimentKey = Object.prototype.hasOwnProperty.call(
    scores,
    "sentiment",
  );

  // Seed / early outcomes only stored technical + optionsFlow
  if (!hasMacroKey && !hasSentimentKey) {
    return SYNTHESIS_VERSION.LEGACY_2LANE;
  }

  if (input.decidedAt) {
    const t = new Date(input.decidedAt);
    if (!Number.isNaN(t.getTime()) && t < FOUR_LANE_ERA_START) {
      return SYNTHESIS_VERSION.LEGACY_2LANE;
    }
  }

  // Post-era with macro+sentiment keys present → current system
  if (hasMacroKey && hasSentimentKey) {
    return SYNTHESIS_VERSION.FOUR_LANE;
  }

  return SYNTHESIS_VERSION.LEGACY_2LANE;
}

export function isCurrentSynthesisVersion(v: string | null | undefined): boolean {
  return v === SYNTHESIS_VERSION.FOUR_LANE;
}

export function cohortLabelFor(version: SynthesisVersion, sampleSize: number): string {
  if (version === SYNTHESIS_VERSION.LEGACY_2LANE) {
    return (
      "Legacy cohort — Macro + Sentiment were stubbed at score 0 (pre Stage 2.5). " +
      "Not comparable to the current 4-lane system. Experimental / unvalidated."
    );
  }
  if (sampleSize < MIN_SAMPLE_FOR_EDGE_REPORT) {
    return (
      `Post-4-lane cohort (n=${sampleSize}) — insufficient sample yet ` +
      `(need ≥${MIN_SAMPLE_FOR_EDGE_REPORT} resolved outcomes before reporting a win-rate as current-system edge). ` +
      "Experimental / unvalidated."
    );
  }
  return (
    "Post-4-lane cohort — experimental / unvalidated; sample may still be regime-narrow. " +
    "Not an edge claim."
  );
}
