export type MarketRegime = "TRENDING" | "CHOPPY" | "VOLATILE";

export type RegimeResult = {
  regime: MarketRegime;
  atr: number | null;
  /** ATR as % of spot: atrPct = (ATR / spot) * 100 */
  atrPct: number | null;
  /** |EMA50 − EMA200| / spot — crude trend-strength proxy */
  trendStrength: number | null;
  note: string;
};

/**
 * Heuristic regime from ATR% + EMA stack distance.
 * Not an ML classifier — rules-based until backtests prove edge.
 */
export function detectRegime(params: {
  spot: number;
  atr: number | null;
  ema50?: number;
  ema200?: number;
}): RegimeResult {
  const { spot, atr } = params;
  if (!spot || atr == null || atr <= 0) {
    return {
      regime: "CHOPPY",
      atr: null,
      atrPct: null,
      trendStrength: null,
      note: "Insufficient ATR — defaulting to CHOPPY (avoid oversized conviction).",
    };
  }

  // atrPct = (ATR / spot) * 100
  const atrPct = (atr / spot) * 100;
  const e50 = params.ema50;
  const e200 = params.ema200;
  const trendStrength =
    e50 != null && e200 != null ? Math.abs(e50 - e200) / spot : null;

  // Elevated ATR% → VOLATILE (index heuristics; not calibrated)
  if (atrPct >= 1.2) {
    return {
      regime: "VOLATILE",
      atr,
      atrPct,
      trendStrength,
      note: `ATR ${atr.toFixed(1)} (${atrPct.toFixed(2)}% of spot) — wide swings; size down.`,
    };
  }

  // Weak EMA separation → CHOPPY
  if (trendStrength != null && trendStrength < 0.004) {
    return {
      regime: "CHOPPY",
      atr,
      atrPct,
      trendStrength,
      note: `Weak EMA50/200 separation (${(trendStrength * 100).toFixed(2)}%) — choppy / range-bound.`,
    };
  }

  return {
    regime: "TRENDING",
    atr,
    atrPct,
    trendStrength,
    note:
      trendStrength != null
        ? `EMA stack separation ${(trendStrength * 100).toFixed(2)}% with ATR ${atrPct.toFixed(2)}% — trending bias.`
        : `ATR ${atrPct.toFixed(2)}% of spot — treating as trending.`,
  };
}
