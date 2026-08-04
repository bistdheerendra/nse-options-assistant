import {
  getUnderlyingCandles,
  type CandleInterval,
  type OhlcvCandle,
  type Underlying,
} from "@/lib/marketdata/angelone";
import { calcAtr } from "@/lib/indicators/atr";
import { clampScore, type LaneResult, type TradingMode } from "./types";

function ema(values: number[], period: number): number[] {
  // EMA_t = close_t * k + EMA_{t-1} * (1 - k), where k = 2 / (period + 1)
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes: number[], period = 14): number {
  // RSI = 100 - 100 / (1 + RS); RS = avgGain / avgLoss over `period`
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    // Wilder smoothing: avg = (prevAvg * (period - 1) + value) / period
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function swingPoints(candles: OhlcvCandle[], lookback = 3) {
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.high >= h || candles[i + j]!.high >= h) isHigh = false;
      if (candles[i - j]!.low <= l || candles[i + j]!.low <= l) isLow = false;
    }
    if (isHigh) swingHigh = h;
    if (isLow) swingLow = l;
  }
  return { swingHigh, swingLow };
}

function candlePatterns(c: OhlcvCandle, prev?: OhlcvCandle): string[] {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-9);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const found: string[] = [];

  // Doji: |close - open| / (high - low) is very small
  if (body / range < 0.1) found.push("doji");

  // Pin bar (hammer/shooting): long wick, small body
  if (lower > body * 2 && upper < body) found.push("pin_bar_bullish");
  if (upper > body * 2 && lower < body) found.push("pin_bar_bearish");

  if (prev) {
    const prevBear = prev.close < prev.open;
    const prevBull = prev.close > prev.open;
    // Bullish engulfing: prior bearish, current bullish body engulfs prior body
    if (
      prevBear &&
      c.close > c.open &&
      c.open <= prev.close &&
      c.close >= prev.open
    ) {
      found.push("bullish_engulfing");
    }
    // Bearish engulfing
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

function intervalForMode(mode: TradingMode): CandleInterval {
  // Scalp prefers fast TF; swing prefers higher TF
  return mode === "SCALP" ? "FIVE_MINUTE" : "ONE_HOUR";
}

/**
 * Classic Technical EMA50 vs EMA200 stack contribution (±this weight).
 * Used for SWING (1h). On SCALP 5m bars this is still multi-session lag
 * (≈4h / ≈2 sessions) — SCALP uses EMA_STACK_SCALP_WEIGHT instead.
 */
export const EMA_STACK_BASE_WEIGHT = 0.35;

/**
 * SCALP EMA50/200 regime term (±this weight). Reduced from 0.35 → 0.25 to
 * make room for FAST_EMA_TERM_WEIGHT without stacking uncapped weight.
 */
export const EMA_STACK_SCALP_WEIGHT = 0.25;

/**
 * SCALP-only fast EMA10/20 cross — same-session momentum confirmation.
 * Weighted lighter than the primary regime stack; flat ± for v1 (ATR-scaled
 * magnitude is a possible later refinement).
 */
export const FAST_EMA_TERM_WEIGHT = 0.2;

/**
 * SCALP-only: when Stage-8 MTF confluence strongly disagrees with the EMA
 * regime direction, multiply the EMA term by this factor (dampen, don't zero)
 * so lagging regime can inform but not single-handedly cancel near-term PA.
 */
export const EMA_DAMPEN_FACTOR = 0.5;

/** Structure TFs used for EMA dampen strength (1m excluded — too noisy). */
const SCALP_EMA_CONFLUENCE_TFS = [
  "THREE_MINUTE",
  "FIVE_MINUTE",
  "FIFTEEN_MINUTE",
] as const;

export type ScalpConfluenceForEmaDampen = {
  bullish: string[];
  bearish: string[];
  dominant: "bullish" | "bearish" | null;
};

/**
 * Dampen classic EMA stack term when SCALP multi-TF confluence (3m/5m/15m)
 * is unanimous opposite to EMA50/200. Does not change Stage-8 technicalBiasAdj.
 *
 * emaTermWeight = |emaStackTerm| (= EMA_STACK_SCALP_WEIGHT normally on SCALP)
 *   if dominant opposite to EMA and ≥3 of {3m,5m,15m} agree → × EMA_DAMPEN_FACTOR
 * score' = score − emaStackTerm + sign(emaStackTerm) × emaTermWeight
 * Does not touch fastEmaTerm (10/20) — only the lagging 50/200 regime term.
 */
export function applyScalpEmaStackDampen(params: {
  score: number;
  /** Signed EMA stack contribution already in `score` (±EMA_STACK_SCALP_WEIGHT on SCALP). */
  emaStackTerm: number;
  timeframeConfluence: ScalpConfluenceForEmaDampen;
}): {
  score: number;
  dampened: boolean;
  emaTermWeight: number;
  signal: string | null;
} {
  const { emaStackTerm, timeframeConfluence } = params;
  let emaTermWeight = Math.abs(emaStackTerm);
  if (emaTermWeight === 0 || timeframeConfluence.dominant == null) {
    return {
      score: params.score,
      dampened: false,
      emaTermWeight,
      signal: null,
    };
  }

  const emaDir: "bullish" | "bearish" =
    emaStackTerm > 0 ? "bullish" : "bearish";
  const dominant = timeframeConfluence.dominant;
  const opposite = dominant !== emaDir;
  const agreeing = SCALP_EMA_CONFLUENCE_TFS.filter((tf) =>
    timeframeConfluence[dominant].includes(tf),
  ).length;

  // Require full 3m+5m+15m agreement on the opposite dominant (strength ≥ 3).
  if (opposite && agreeing >= 3) {
    // Dampen: replace full ±w with ±(w × EMA_DAMPEN_FACTOR)
    // Δscore = emaStackTerm × (EMA_DAMPEN_FACTOR − 1)
    emaTermWeight = emaTermWeight * EMA_DAMPEN_FACTOR;
    const dampenedScore = clampScore(
      params.score + emaStackTerm * (EMA_DAMPEN_FACTOR - 1),
    );
    return {
      score: dampenedScore,
      dampened: true,
      emaTermWeight,
      signal: `EMA stack dampened ×${EMA_DAMPEN_FACTOR} — ${agreeing}/3 of {3m,5m,15m} ${dominant} vs EMA ${emaDir} regime`,
    };
  }

  return {
    score: params.score,
    dampened: false,
    emaTermWeight,
    signal: null,
  };
}

export async function runTechnicalLane(params: {
  underlying: Underlying;
  mode?: TradingMode;
  candles?: OhlcvCandle[];
}): Promise<LaneResult> {
  const mode = params.mode ?? "SWING";
  const candles =
    params.candles ??
    (await getUnderlyingCandles(
      params.underlying,
      intervalForMode(mode),
      mode === "SCALP" ? 5 : 60,
    ));

  const closes = candles.map((c) => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, Math.min(200, Math.max(closes.length - 1, 2)));
  const last = closes.length - 1;
  const e50 = ema50[last]!;
  const e200 = ema200[last]!;
  const lastClose = closes[last]!;
  const rsi14 = rsi(closes, 14);
  const swings = swingPoints(candles);
  const patterns = candlePatterns(candles[last]!, candles[last - 1]);
  const atr14 = calcAtr(candles, 14);

  // SCALP only: fast 10/20 on the same 5m series (no second candle fetch).
  // Flat ±FAST_EMA_TERM_WEIGHT for v1 — ATR-scaled |ema10−ema20| is a possible refinement.
  let e10: number | undefined;
  let e20: number | undefined;
  let fastEmaTerm = 0;
  if (mode === "SCALP") {
    const ema10 = ema(closes, 10);
    const ema20 = ema(closes, 20);
    e10 = ema10[last]!;
    e20 = ema20[last]!;
  }

  const signals: string[] = [];
  let score = 0;

  // Trend: price vs EMA50/EMA200 + EMA stack
  // SCALP uses EMA_STACK_SCALP_WEIGHT (0.25); SWING keeps EMA_STACK_BASE_WEIGHT (0.35)
  const emaStackWeight =
    mode === "SCALP" ? EMA_STACK_SCALP_WEIGHT : EMA_STACK_BASE_WEIGHT;
  // EMA_t stack: e50 > e200 → +w; else −w
  let emaStackTerm = 0;
  if (e50 > e200) {
    emaStackTerm = emaStackWeight;
    score += emaStackTerm;
    signals.push("EMA50 above EMA200 (bullish stack)");
  } else {
    emaStackTerm = -emaStackWeight;
    score += emaStackTerm;
    signals.push("EMA50 below EMA200 (bearish stack)");
  }

  // Fast EMA cross (10/20) — captures same-session scalp momentum, unlike
  // the 50/200 regime term (~4h+ lookback even on 5m candles). Weighted
  // lighter than the primary EMA stack since this is a supplementary
  // confirmation signal, not the dominant regime read.
  // ema10 > ema20 → bullish momentum; ema10 < ema20 → bearish momentum
  if (mode === "SCALP" && e10 != null && e20 != null) {
    fastEmaTerm = e10 > e20 ? +FAST_EMA_TERM_WEIGHT : -FAST_EMA_TERM_WEIGHT;
    score += fastEmaTerm;
    signals.push(
      e10 > e20
        ? `EMA10 above EMA20 (fast bullish cross, term=${fastEmaTerm})`
        : `EMA10 below EMA20 (fast bearish cross, term=${fastEmaTerm})`,
    );
  }

  if (lastClose > e50) {
    score += 0.2;
    signals.push("Price above EMA50");
  } else {
    score -= 0.2;
    signals.push("Price below EMA50");
  }

  // RSI: >70 overbought (-), <30 oversold (+)
  if (rsi14 >= 70) {
    score -= 0.25;
    signals.push(`RSI(14)=${rsi14.toFixed(1)} overbought`);
  } else if (rsi14 <= 30) {
    score += 0.25;
    signals.push(`RSI(14)=${rsi14.toFixed(1)} oversold`);
  } else {
    signals.push(`RSI(14)=${rsi14.toFixed(1)} neutral zone`);
    score += (50 - rsi14) / 200; // mild mean-reversion tilt
  }

  if (patterns.includes("bullish_engulfing") || patterns.includes("pin_bar_bullish")) {
    score += 0.15;
    signals.push(`Bullish pattern: ${patterns.filter((p) => p.includes("bull")).join(", ")}`);
  }
  if (patterns.includes("bearish_engulfing") || patterns.includes("pin_bar_bearish")) {
    score -= 0.15;
    signals.push(`Bearish pattern: ${patterns.filter((p) => p.includes("bear")).join(", ")}`);
  }
  if (patterns.includes("doji")) signals.push("Doji — indecision");

  // Scalp weights momentum harder (short return)
  if (mode === "SCALP" && closes.length > 5) {
    const mom = (lastClose - closes[last - 5]!) / closes[last - 5]!;
    score += clampScore(mom * 20) * 0.3;
    signals.push(`Scalp momentum(5 bars)=${(mom * 100).toFixed(2)}%`);
  }

  return {
    score: clampScore(score),
    signals,
    rawIndicators: {
      mode,
      interval: intervalForMode(mode),
      ema50: e50,
      ema200: e200,
      ...(mode === "SCALP" && e10 != null && e20 != null
        ? { ema10: e10, ema20: e20, fastEmaTerm }
        : {}),
      emaStackTerm,
      rsi14,
      lastClose,
      atr14,
      swingHigh: swings.swingHigh,
      swingLow: swings.swingLow,
      patterns,
      candleCount: candles.length,
    },
  };
}
