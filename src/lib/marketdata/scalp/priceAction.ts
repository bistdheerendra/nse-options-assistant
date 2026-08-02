import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { ScalpTimeframe } from "@/lib/marketdata/scalp/types";

/**
 * Scalp Stage 2 — per-timeframe price action + candlestick patterns.
 * Outputs feed the synthesizer; this module does NOT emit a trade verdict.
 */

export type CandlestickPattern =
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "doji"
  | "hammer"
  | "shooting_star"
  | "inside_bar";

export type StructureBias = "bullish" | "bearish" | "ranging" | "insufficient";

export type StructureSequence =
  | "HH_HL" // higher highs + higher lows
  | "LH_LL" // lower highs + lower lows
  | "HH_LL" // expanding / mixed
  | "LH_HL" // contracting / mixed
  | "FLAT"
  | "INSUFFICIENT";

export type TimeframePriceAction = {
  interval: ScalpTimeframe;
  patterns: CandlestickPattern[];
  /** Highest-priority directional pattern on the last closed bar, else null. */
  primaryPattern: CandlestickPattern | null;
  structureBias: StructureBias;
  structureSequence: StructureSequence;
  /**
   * Candle strength on last bar ∈ [0, 1].
   * strength = 0.5 * (body/range) + 0.5 * closeLocation
   * where closeLocation = (close - low) / range  (1 = closed at high).
   * Directional sign is separate — strength is magnitude only.
   */
  candleStrength: number;
  /** +1 bullish close bias, −1 bearish, 0 doji-ish. */
  candleDirection: -1 | 0 | 1;
  swingHigh: number | null;
  swingLow: number | null;
  recentSwingHighs: number[];
  recentSwingLows: number[];
  signals: string[];
  candleCount: number;
};

export type MultiTimeframePriceAction = {
  underlying: string;
  byTimeframe: Record<ScalpTimeframe, TimeframePriceAction>;
  /** Count of TFs with matching bullish / bearish structure (for confluence later). */
  structureConfluence: {
    bullish: ScalpTimeframe[];
    bearish: ScalpTimeframe[];
    ranging: ScalpTimeframe[];
    insufficient: ScalpTimeframe[];
  };
};

const PATTERN_PRIORITY: CandlestickPattern[] = [
  "bullish_engulfing",
  "bearish_engulfing",
  "hammer",
  "shooting_star",
  "inside_bar",
  "doji",
];

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Detect swing highs/lows: bar i is a swing high if high[i] ≥ high of ±lookback neighbors.
 * lookback default 3 (same heuristic as technical lane).
 */
export function detectSwingPoints(
  candles: OhlcvCandle[],
  lookback = 3,
): {
  swingHighs: { index: number; price: number }[];
  swingLows: { index: number; price: number }[];
} {
  const swingHighs: { index: number; price: number }[] = [];
  const swingLows: { index: number; price: number }[] = [];
  if (candles.length < lookback * 2 + 1) {
    return { swingHighs, swingLows };
  }

  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.high >= h || candles[i + j]!.high >= h) isHigh = false;
      if (candles[i - j]!.low <= l || candles[i + j]!.low <= l) isLow = false;
    }
    if (isHigh) swingHighs.push({ index: i, price: h });
    if (isLow) swingLows.push({ index: i, price: l });
  }
  return { swingHighs, swingLows };
}

/**
 * Classify HH/HL vs LH/LL from the last two confirmed swing highs and lows.
 * Requires ≥2 of each; else INSUFFICIENT.
 */
export function classifyStructure(
  swingHighs: { price: number }[],
  swingLows: { price: number }[],
): { sequence: StructureSequence; bias: StructureBias } {
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { sequence: "INSUFFICIENT", bias: "insufficient" };
  }

  const h1 = swingHighs[swingHighs.length - 2]!.price;
  const h2 = swingHighs[swingHighs.length - 1]!.price;
  const l1 = swingLows[swingLows.length - 2]!.price;
  const l2 = swingLows[swingLows.length - 1]!.price;

  // Tolerance: 0.02% of price so micro noise doesn't flip structure on indices.
  const eps = Math.max(h2, h1, l2, l1) * 0.0002;
  const higherHigh = h2 > h1 + eps;
  const lowerHigh = h2 < h1 - eps;
  const higherLow = l2 > l1 + eps;
  const lowerLow = l2 < l1 - eps;

  if (higherHigh && higherLow) {
    return { sequence: "HH_HL", bias: "bullish" };
  }
  if (lowerHigh && lowerLow) {
    return { sequence: "LH_LL", bias: "bearish" };
  }
  if (higherHigh && lowerLow) {
    return { sequence: "HH_LL", bias: "ranging" };
  }
  if (lowerHigh && higherLow) {
    return { sequence: "LH_HL", bias: "ranging" };
  }
  return { sequence: "FLAT", bias: "ranging" };
}

/**
 * Candlestick patterns on the last bar (and previous where needed).
 * Formulas documented inline per .cursorrules §4.
 */
export function detectCandlestickPatterns(
  candles: OhlcvCandle[],
): CandlestickPattern[] {
  if (candles.length < 1) return [];
  const c = candles[candles.length - 1]!;
  const prev = candles.length >= 2 ? candles[candles.length - 2] : undefined;

  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-9);
  // upper wick = high - max(open, close); lower wick = min(open, close) - low
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const found: CandlestickPattern[] = [];

  // Doji: body / range < 0.1
  if (body / range < 0.1) found.push("doji");

  // Hammer (bullish pin): lower wick > 2× body AND upper wick ≤ body
  if (lower > body * 2 && upper <= body) found.push("hammer");

  // Shooting star (bearish pin): upper wick > 2× body AND lower wick ≤ body
  if (upper > body * 2 && lower <= body) found.push("shooting_star");

  if (prev) {
    // Inside bar: high < prev.high AND low > prev.low
    if (c.high < prev.high && c.low > prev.low) {
      found.push("inside_bar");
    }

    const prevBear = prev.close < prev.open;
    const prevBull = prev.close > prev.open;
    // Bullish engulfing: prior bearish; current bullish body engulfs prior body
    // (open ≤ prev.close AND close ≥ prev.open)
    if (
      prevBear &&
      c.close > c.open &&
      c.open <= prev.close &&
      c.close >= prev.open
    ) {
      found.push("bullish_engulfing");
    }
    // Bearish engulfing: prior bullish; current bearish body engulfs prior body
    if (
      prevBull &&
      c.close < c.open &&
      c.open >= prev.close &&
      c.close <= prev.open
    ) {
      found.push("bearish_engulfing");
    }
  }

  return found;
}

/**
 * strength ∈ [0,1] = 0.5*(body/range) + 0.5*((close-low)/range)
 * direction: sign of (close - open), 0 if |body|/range < 0.1
 */
export function candleStrengthMetrics(c: OhlcvCandle): {
  strength: number;
  direction: -1 | 0 | 1;
} {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-9);
  const bodyRatio = Math.min(1, body / range);
  // closeLocation: 0 = at low, 1 = at high
  const closeLocation = (c.close - c.low) / range;
  const strength = round4(0.5 * bodyRatio + 0.5 * closeLocation);

  let direction: -1 | 0 | 1 = 0;
  if (body / range >= 0.1) {
    direction = c.close > c.open ? 1 : -1;
  }
  return { strength, direction };
}

function pickPrimary(patterns: CandlestickPattern[]): CandlestickPattern | null {
  for (const p of PATTERN_PRIORITY) {
    if (patterns.includes(p)) return p;
  }
  return null;
}

/**
 * Analyze a single timeframe series. Pure — no I/O.
 */
export function analyzeTimeframePriceAction(
  interval: ScalpTimeframe,
  candles: OhlcvCandle[],
): TimeframePriceAction {
  const signals: string[] = [];

  if (candles.length < 5) {
    return {
      interval,
      patterns: [],
      primaryPattern: null,
      structureBias: "insufficient",
      structureSequence: "INSUFFICIENT",
      candleStrength: 0,
      candleDirection: 0,
      swingHigh: null,
      swingLow: null,
      recentSwingHighs: [],
      recentSwingLows: [],
      signals: ["insufficient candles for price-action analysis"],
      candleCount: candles.length,
    };
  }

  const { swingHighs, swingLows } = detectSwingPoints(candles, 3);
  const { sequence, bias } = classifyStructure(swingHighs, swingLows);
  const patterns = detectCandlestickPatterns(candles);
  const last = candles[candles.length - 1]!;
  const { strength, direction } = candleStrengthMetrics(last);
  const primary = pickPrimary(patterns);

  const recentSwingHighs = swingHighs.slice(-3).map((s) => s.price);
  const recentSwingLows = swingLows.slice(-3).map((s) => s.price);

  if (primary) signals.push(`pattern: ${primary}`);
  else if (patterns.length) signals.push(`patterns: ${patterns.join(", ")}`);
  else signals.push("no classic pattern on last bar");

  signals.push(`structure: ${sequence} → ${bias}`);
  signals.push(
    `candleStrength=${strength.toFixed(2)} dir=${direction > 0 ? "bull" : direction < 0 ? "bear" : "flat"}`,
  );

  return {
    interval,
    patterns,
    primaryPattern: primary,
    structureBias: bias,
    structureSequence: sequence,
    candleStrength: strength,
    candleDirection: direction,
    swingHigh: recentSwingHighs[recentSwingHighs.length - 1] ?? null,
    swingLow: recentSwingLows[recentSwingLows.length - 1] ?? null,
    recentSwingHighs,
    recentSwingLows,
    signals,
    candleCount: candles.length,
  };
}

/**
 * Run Stage 2 across all scalp timeframes from an MTF candle bundle.
 */
export function analyzeMultiTimeframePriceAction(params: {
  underlying: string;
  series: Partial<
    Record<ScalpTimeframe, { candles: OhlcvCandle[] } | undefined>
  >;
  timeframes?: ScalpTimeframe[];
}): MultiTimeframePriceAction {
  const timeframes: ScalpTimeframe[] = params.timeframes ?? [
    "ONE_MINUTE",
    "THREE_MINUTE",
    "FIVE_MINUTE",
    "FIFTEEN_MINUTE",
  ];

  const byTimeframe = {} as Record<ScalpTimeframe, TimeframePriceAction>;
  const structureConfluence: MultiTimeframePriceAction["structureConfluence"] = {
    bullish: [],
    bearish: [],
    ranging: [],
    insufficient: [],
  };

  for (const tf of timeframes) {
    const candles = params.series[tf]?.candles ?? [];
    const pa = analyzeTimeframePriceAction(tf, candles);
    byTimeframe[tf] = pa;
    structureConfluence[pa.structureBias].push(tf);
  }

  return {
    underlying: params.underlying,
    byTimeframe,
    structureConfluence,
  };
}
