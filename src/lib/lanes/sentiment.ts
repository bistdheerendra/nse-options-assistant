import type { Underlying } from "@/lib/marketdata/angelone";
import {
  aggregateNewsBias,
  type NewsBiasAggregate,
} from "@/lib/marketdata/marketBias";
import {
  getCachedFiiDiiSnapshot,
  type FiiDiiSnapshot,
} from "@/lib/marketdata/fiiDii";
import { getCachedMarketNews } from "@/lib/marketdata/marketNews";
import { clampScore, type LaneResult, type TradingMode } from "./types";

/**
 * Tunable v1 component weights (sum = 1.0).
 * Heuristic only — not a validated statistical edge.
 *
 * Starting split: FII/DII higher than news because cash-flow figures are a
 * harder/more concrete signal than keyword headline bias. Easy to retune.
 *
 * fiiDii: institutional cash net (FII primary, DII confirming)
 * news:   aggregated BULL/BEAR/MIXED headline pills (market-wide weighted)
 */
export const SENTIMENT_COMPONENT_WEIGHTS = {
  fiiDii: 0.65,
  news: 0.35,
} as const;

export type SentimentComponentKey = keyof typeof SENTIMENT_COMPONENT_WEIGHTS;

/** Within FII/DII sub-score: FII leads; DII is secondary (often opposite). */
const FII_VS_DII = { fii: 0.75, dii: 0.25 } as const;

/** Soft-cap for tanh(netCr / softCap) — ~₹2,000 Cr maps near ±0.76. */
const FLOW_SOFT_CAP_CR = 2000;

function pctToUnit(netCr: number, softCap: number): number {
  // unit = tanh(netCr / softCap)
  return Math.tanh(netCr / softCap);
}

function fmtCr(n: number): string {
  const abs = Math.abs(n);
  const formatted =
    abs >= 100
      ? abs.toLocaleString("en-IN", { maximumFractionDigits: 0 })
      : abs.toLocaleString("en-IN", { maximumFractionDigits: 1 });
  return `₹${formatted} Cr`;
}

export type SentimentScoreInput = {
  fiiDii: FiiDiiSnapshot | null;
  newsTitles: string[] | null;
  mode?: TradingMode;
};

export type SentimentScoreBreakdown = {
  components: Partial<Record<SentimentComponentKey, number>>;
  weightsUsed: Partial<Record<SentimentComponentKey, number>>;
  newsAgg: NewsBiasAggregate | null;
};

/**
 * Pure scoring from already-fetched inputs (unit-testable, no I/O).
 * Missing sub-signals are omitted and remaining weights re-normalized.
 */
export function scoreSentiment(input: SentimentScoreInput): LaneResult & {
  breakdown: SentimentScoreBreakdown;
} {
  const signals: string[] = [];
  const components: Partial<Record<SentimentComponentKey, number>> = {};
  const rawIndicators: Record<string, unknown> = {
    heuristic: true,
    label: "experimental / rules-based sentiment lean — not a validated edge",
  };
  let newsAgg: NewsBiasAggregate | null = null;

  // --- FII / DII cash flow ---
  if (input.fiiDii) {
    const snap = input.fiiDii;
    rawIndicators.fiiDii = {
      date: snap.date,
      fiiNet: snap.fiiNet,
      diiNet: snap.diiNet,
      fiiBuy: snap.fiiBuy,
      fiiSell: snap.fiiSell,
      diiBuy: snap.diiBuy,
      diiSell: snap.diiSell,
      source: snap.source,
      note: snap.note,
    };
    const fiiUnit = pctToUnit(snap.fiiNet, FLOW_SOFT_CAP_CR);
    const diiUnit = pctToUnit(snap.diiNet, FLOW_SOFT_CAP_CR);
    // flowScore = 0.75 * fii + 0.25 * dii
    const flowScore = clampScore(
      FII_VS_DII.fii * fiiUnit + FII_VS_DII.dii * diiUnit,
    );
    components.fiiDii = flowScore;

    if (snap.fiiNet >= 200) {
      signals.push(`FII net bought ${fmtCr(snap.fiiNet)} — bullish`);
    } else if (snap.fiiNet <= -200) {
      signals.push(`FII net sold ${fmtCr(Math.abs(snap.fiiNet))} — bearish`);
    } else {
      signals.push(`FII near flat (${fmtCr(snap.fiiNet)} net)`);
    }

    if (snap.diiNet >= 200) {
      signals.push(`DII net bought ${fmtCr(snap.diiNet)} — confirming domestic bid`);
    } else if (snap.diiNet <= -200) {
      signals.push(`DII net sold ${fmtCr(Math.abs(snap.diiNet))} — domestic offering`);
    }
  } else {
    rawIndicators.fiiDiiMissing = true;
  }

  // --- News headline bias ---
  if (input.newsTitles && input.newsTitles.length > 0) {
    newsAgg = aggregateNewsBias(input.newsTitles);
    rawIndicators.news = newsAgg;
    components.news = clampScore(newsAgg.score);
    signals.push(
      `News flow: ${newsAgg.bullCount} bullish / ${newsAgg.bearCount} bearish headlines today` +
        (newsAgg.marketWideCount > 0
          ? ` (${newsAgg.marketWideCount} market-wide weighted)`
          : ""),
    );
  } else {
    rawIndicators.newsMissing = true;
  }

  const presentKeys = (
    Object.keys(components) as SentimentComponentKey[]
  ).filter((k) => components[k] != null);

  if (presentKeys.length === 0) {
    return {
      score: 0,
      signals: ["sentiment data unavailable"],
      rawIndicators: { ...rawIndicators, unavailable: true },
      breakdown: { components: {}, weightsUsed: {}, newsAgg: null },
    };
  }

  // Gap flags only when the other sub-signal is present (partial score).
  if (!input.fiiDii) {
    signals.unshift("FII/DII flow unavailable — scoring from news only");
  }
  if (!input.newsTitles || input.newsTitles.length === 0) {
    signals.unshift("News headlines unavailable — scoring from FII/DII only");
  }

  let weightSum = 0;
  for (const k of presentKeys) weightSum += SENTIMENT_COMPONENT_WEIGHTS[k];
  const weightsUsed: Partial<Record<SentimentComponentKey, number>> = {};
  let combined = 0;
  for (const k of presentKeys) {
    const w = SENTIMENT_COMPONENT_WEIGHTS[k] / weightSum;
    weightsUsed[k] = w;
    combined += w * (components[k] as number);
  }

  // Scalp: dampen FII/DII (daily lag) vs fresher news; Swing keeps full blend.
  let score = clampScore(combined);
  if (input.mode === "SCALP" && components.news != null && components.fiiDii != null) {
    // score = 0.45 * flow + 0.55 * news  (news relatively more useful intraday)
    score = clampScore(0.45 * components.fiiDii + 0.55 * components.news);
  }

  rawIndicators.components = components;
  rawIndicators.weightsUsed = weightsUsed;
  rawIndicators.combinedBeforeClamp = combined;

  return {
    score,
    signals,
    rawIndicators,
    breakdown: { components, weightsUsed, newsAgg },
  };
}

/**
 * Live Sentiment lane — Stage 2.5b.
 * Reuses cached news RSS + FII/DII snapshot. Each sub-signal degrades independently.
 * Never throws — full failure → score 0 + "sentiment data unavailable".
 */
export async function runSentimentLane(params: {
  underlying: Underlying;
  mode?: TradingMode;
}): Promise<LaneResult> {
  try {
    const [fiiDii, news] = await Promise.all([
      getCachedFiiDiiSnapshot().catch(() => null),
      getCachedMarketNews(16).catch(() => null),
    ]);

    const newsTitles =
      news && news.items.length > 0
        ? news.items.map((i) => i.title)
        : null;

    const { breakdown: _b, ...result } = scoreSentiment({
      fiiDii,
      newsTitles,
      mode: params.mode,
    });

    return {
      ...result,
      rawIndicators: {
        ...result.rawIndicators,
        underlying: params.underlying,
        mode: params.mode ?? "SWING",
        newsSource: news?.source ?? null,
      },
    };
  } catch {
    return {
      score: 0,
      signals: ["sentiment data unavailable"],
      rawIndicators: {
        unavailable: true,
        heuristic: true,
        underlying: params.underlying,
        mode: params.mode ?? "SWING",
      },
    };
  }
}
