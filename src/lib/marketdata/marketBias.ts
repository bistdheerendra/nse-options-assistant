/**
 * Heuristic market-bias tags for news / calendar items.
 * Rules-based keyword + print-vs-forecast cues — experimental, not a prediction.
 */

export type MarketBias = "BULL" | "BEAR" | "MIXED";

const BULL_RE =
  /\b(surge|rally|soar|jump|gain|rises?|rose|record high|all[- ]time high|beat(s|en)?|outperform|growth|expansion|rate cut|easing|stimulus|ceasefire|peace|approval|upgrade|bullish|profit(s)? (jump|rise|surge)|strong(er)? (jobs|payroll|gdp|growth))\b/i;

const BEAR_RE =
  /\b(crash|plunge|slump|tumble|fall(s|en)?|drops?|decline|loss(es)?|miss(es|ed)?|war|tariff|sanction|recession|layoff|default|downgrade|hawkish|rate hike|tightening|inflation (surge|spike|hot|jumps?)|weak(er)? (jobs|payroll|gdp|growth)|bearish|sell[- ]off|panic)\b/i;

function parseNum(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%KkMmBb,]/g, "").trim();
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a news headline. Keyword heuristic only.
 */
export function biasFromHeadline(title: string): MarketBias {
  const bull = BULL_RE.test(title);
  const bear = BEAR_RE.test(title);
  if (bull && !bear) return "BULL";
  if (bear && !bull) return "BEAR";
  return "MIXED";
}

/** Market-wide / policy headlines get heavier weight than single-name stories. */
const MARKET_WIDE_RE =
  /\b(nifty|sensex|bank\s*nifty|rbi|budget|fii|dii|fpi|india\s+market|sgx|gift\s*nifty|repo\s*rate|monetary\s*policy|sebi|crude|usd\s*\/?\s*inr|rupee|vix)\b/i;

export function isMarketWideHeadline(title: string): boolean {
  return MARKET_WIDE_RE.test(title);
}

export type NewsBiasAggregate = {
  /** -1..1 lean from weighted BULL/BEAR counts */
  score: number;
  bullCount: number;
  bearCount: number;
  mixedCount: number;
  marketWideCount: number;
  weightedBull: number;
  weightedBear: number;
  headlineCount: number;
};

/**
 * Aggregate today's headline bias pills into one directional lean.
 * Market-wide stories (Nifty/Sensex/RBI/…) weigh 1.5× vs single-stock.
 * MIXED contributes 0 to the numerator but still dilutes via denominator.
 */
export function aggregateNewsBias(
  titles: string[],
): NewsBiasAggregate {
  let bullCount = 0;
  let bearCount = 0;
  let mixedCount = 0;
  let marketWideCount = 0;
  let weightedBull = 0;
  let weightedBear = 0;
  let weightSum = 0;

  for (const title of titles) {
    const bias = biasFromHeadline(title);
    const marketWide = isMarketWideHeadline(title);
    const w = marketWide ? 1.5 : 1;
    if (marketWide) marketWideCount += 1;
    weightSum += w;
    if (bias === "BULL") {
      bullCount += 1;
      weightedBull += w;
    } else if (bias === "BEAR") {
      bearCount += 1;
      weightedBear += w;
    } else {
      mixedCount += 1;
    }
  }

  // score = (weightedBull - weightedBear) / weightSum  ∈ [-1, 1]
  const score =
    weightSum > 0 ? (weightedBull - weightedBear) / weightSum : 0;

  return {
    score,
    bullCount,
    bearCount,
    mixedCount,
    marketWideCount,
    weightedBull,
    weightedBear,
    headlineCount: titles.length,
  };
}

/**
 * Classify an economic-calendar print for typical equity-market reaction.
 * Higher CPI / hawkish rates → BEAR; stronger growth/jobs vs forecast → BULL.
 * Scheduled (no actual) high-impact → MIXED (uncertainty).
 */
export function biasFromEconomicEvent(e: {
  title: string;
  category: string;
  impact: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}): MarketBias {
  const title = e.title.toLowerCase();
  const actual = parseNum(e.actual);
  const forecast = parseNum(e.forecast);
  const previous = parseNum(e.previous);

  if (actual != null && forecast != null) {
    const delta = actual - forecast;
    // Inflation / CPI / PCE: hotter than forecast = bearish for risk assets
    if (e.category === "cpi" || /\bcpi\b|pce|inflation/.test(title)) {
      if (Math.abs(delta) < 1e-9) return "MIXED";
      return delta > 0 ? "BEAR" : "BULL";
    }
    // Rates: higher than expected = hawkish / BEAR
    if (e.category === "fed" || e.category === "rbi" || /rate|fomc|repo/.test(title)) {
      if (Math.abs(delta) < 1e-9) return "MIXED";
      return delta > 0 ? "BEAR" : "BULL";
    }
    // Growth / jobs: stronger = BULL
    if (
      e.category === "gdp" ||
      e.category === "nfp" ||
      /gdp|payroll|employment|non-farm|nonfarm/.test(title)
    ) {
      if (Math.abs(delta) < 1e-9) return "MIXED";
      return delta > 0 ? "BULL" : "BEAR";
    }
    // Generic: beat forecast → mild bull, miss → mild bear
    if (Math.abs(delta) < 1e-9) return "MIXED";
    return delta > 0 ? "BULL" : "BEAR";
  }

  // Actual vs previous only
  if (actual != null && previous != null) {
    const delta = actual - previous;
    if (e.category === "cpi" || /\bcpi\b|pce|inflation/.test(title)) {
      return delta > 0 ? "BEAR" : delta < 0 ? "BULL" : "MIXED";
    }
    if (e.category === "fed" || e.category === "rbi" || /rate|repo/.test(title)) {
      return delta > 0 ? "BEAR" : delta < 0 ? "BULL" : "MIXED";
    }
    if (e.category === "gdp" || e.category === "nfp") {
      return delta > 0 ? "BULL" : delta < 0 ? "BEAR" : "MIXED";
    }
  }

  // Title cues for rate decisions without prints
  if (/rate cut|dovish|easing/.test(title)) return "BULL";
  if (/rate hike|hawkish|tightening/.test(title)) return "BEAR";

  // Upcoming high-impact = uncertainty
  if (e.impact === "High") return "MIXED";

  return biasFromHeadline(e.title);
}
