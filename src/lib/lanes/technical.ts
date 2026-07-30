import {
  getUnderlyingCandles,
  type CandleInterval,
  type OhlcvCandle,
  type Underlying,
} from "@/lib/marketdata/angelone";
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

  const signals: string[] = [];
  let score = 0;

  // Trend: price vs EMA50/EMA200 + EMA stack
  if (e50 > e200) {
    score += 0.35;
    signals.push("EMA50 above EMA200 (bullish stack)");
  } else {
    score -= 0.35;
    signals.push("EMA50 below EMA200 (bearish stack)");
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
      rsi14,
      lastClose,
      swingHigh: swings.swingHigh,
      swingLow: swings.swingLow,
      patterns,
      candleCount: candles.length,
    },
  };
}
