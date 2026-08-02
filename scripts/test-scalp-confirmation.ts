/**
 * Stage 7 confirmation candle sanity checks.
 * Usage: npx tsx scripts/test-scalp-confirmation.ts
 */
import {
  DEFAULT_CONFIRMATION_RULE,
  evaluateConfirmationCandle,
} from "../src/lib/marketdata/scalp/confirmationCandle";
import type { OhlcvCandle } from "../src/lib/marketdata/angelone";
import type { TimeframePriceAction } from "../src/lib/marketdata/scalp/priceAction";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function bar(
  o: number,
  h: number,
  l: number,
  c: number,
  volume: number,
  i: number,
): OhlcvCandle {
  return {
    time: `2026-01-01T10:${String(i).padStart(2, "0")}:00+05:30`,
    open: o,
    high: h,
    low: l,
    close: c,
    volume,
  };
}

const bullPa = {
  interval: "FIVE_MINUTE",
  patterns: ["bullish_engulfing"],
  primaryPattern: "bullish_engulfing",
  structureBias: "bullish",
  structureSequence: "HH_HL",
  candleStrength: 0.8,
  candleDirection: 1,
  swingHigh: 101,
  swingLow: 99,
  recentSwingHighs: [100, 101],
  recentSwingLows: [98, 99],
  signals: [],
  candleCount: 2,
} as TimeframePriceAction;

// Signal bar then confirm that closes above signal high on rising volume
const confirmed = evaluateConfirmationCandle({
  candles: [
    bar(100, 100.5, 99.5, 99.8, 1000, 0), // signal
    bar(100.4, 101.2, 100.3, 101.0, 1500, 1), // confirm — close > 100.5, vol up
  ],
  priceAction: bullPa,
});
assert(confirmed.status === "confirmed", `expected confirmed, got ${confirmed.status}: ${confirmed.reason}`);

const failed = evaluateConfirmationCandle({
  candles: [
    bar(100, 100.5, 99.5, 99.8, 1000, 0),
    bar(100.4, 100.6, 99.9, 100.2, 800, 1), // close below trigger + weak vol
  ],
  priceAction: bullPa,
});
assert(failed.status === "failed", `expected failed, got ${failed.status}`);

const none = evaluateConfirmationCandle({
  candles: [bar(100, 101, 99, 100.5, 1000, 0), bar(100.5, 101, 100, 100.8, 1100, 1)],
  priceAction: { ...bullPa, primaryPattern: "doji", structureBias: "ranging", candleDirection: 0 },
});
assert(none.status === "none", `expected none, got ${none.status}`);

assert(DEFAULT_CONFIRMATION_RULE.triggerTimeframe === "FIVE_MINUTE", "default TF");
assert(DEFAULT_CONFIRMATION_RULE.requireRisingVolume === true, "default rising vol");

console.log("test-scalp-confirmation: all passed", {
  confirmed: confirmed.status,
  failed: failed.status,
  none: none.status,
});
