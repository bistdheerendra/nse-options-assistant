/**
 * Quick sanity checks for Stage 2 price-action helpers.
 * Usage: npx tsx scripts/test-scalp-price-action.ts
 */
import {
  analyzeTimeframePriceAction,
  candleStrengthMetrics,
  classifyStructure,
  detectCandlestickPatterns,
} from "../src/lib/marketdata/scalp/priceAction";
import type { OhlcvCandle } from "../src/lib/marketdata/angelone";

function c(
  o: number,
  h: number,
  l: number,
  cl: number,
  i = 0,
): OhlcvCandle {
  return {
    time: `2026-01-01T09:${String(15 + i).padStart(2, "0")}:00+05:30`,
    open: o,
    high: h,
    low: l,
    close: cl,
    volume: 1000,
  };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Bullish engulfing: prev bearish 100→98, current bullish 97.5→100.5
{
  const candles = [c(100, 100.5, 97.5, 98, 0), c(97.5, 101, 97, 100.5, 1)];
  const p = detectCandlestickPatterns(candles);
  assert(p.includes("bullish_engulfing"), `expected bullish_engulfing, got ${p}`);
}

// Doji
{
  const p = detectCandlestickPatterns([c(100, 101, 99, 100.05)]);
  assert(p.includes("doji"), `expected doji, got ${p}`);
}

// Hammer: long lower wick (not a doji — body/range ≥ 0.1)
{
  const p = detectCandlestickPatterns([c(100, 100.5, 97.5, 100.35)]);
  assert(p.includes("hammer"), `expected hammer, got ${p}`);
  assert(!p.includes("doji"), `hammer fixture should not be doji, got ${p}`);
}

// Inside bar
{
  const candles = [c(100, 102, 98, 101, 0), c(100.5, 101.5, 99, 100.8, 1)];
  const p = detectCandlestickPatterns(candles);
  assert(p.includes("inside_bar"), `expected inside_bar, got ${p}`);
}

// Structure HH_HL
{
  const { sequence, bias } = classifyStructure(
    [{ price: 100 }, { price: 105 }],
    [{ price: 90 }, { price: 95 }],
  );
  assert(sequence === "HH_HL" && bias === "bullish", `got ${sequence}/${bias}`);
}

// Strength metrics
{
  const { strength, direction } = candleStrengthMetrics(c(100, 110, 100, 109));
  assert(direction === 1, "expected bullish direction");
  assert(strength > 0.7, `expected strong candle, got ${strength}`);
}

// Full TF analysis on synthetic uptrend
{
  const candles: OhlcvCandle[] = [];
  let px = 100;
  for (let i = 0; i < 40; i++) {
    const open = px;
    const close = px + 0.4 + (i % 5 === 0 ? -0.2 : 0.3);
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - (i % 7 === 0 ? 0.8 : 0.15);
    candles.push(c(open, high, low, close, i));
    px = close;
  }
  const pa = analyzeTimeframePriceAction("FIVE_MINUTE", candles);
  assert(pa.candleCount === 40, "candleCount");
  assert(pa.signals.length > 0, "signals");
  console.log("FIVE_MINUTE sample:", {
    primaryPattern: pa.primaryPattern,
    structure: pa.structureSequence,
    bias: pa.structureBias,
    strength: pa.candleStrength,
  });
}

console.log("test-scalp-price-action: all passed");
