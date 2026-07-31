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
