/**
 * Pure checks for SCALP price-slope post-synthesis gate.
 * Run: npx tsx scripts/test-price-slope-gate.ts
 */
import type { OhlcvCandle } from "../src/lib/marketdata/angelone";
import type { OptionsFlowExtras } from "../src/lib/lanes/optionsFlow";
import { synthesizeStructure } from "../src/lib/synthesis/structure";
import {
  applyPriceSlopeGate,
  computePriceSlope,
  SLOPE_LOOKBACK_BARS,
  SLOPE_STRONG_THRESHOLD_PCT,
  verdictConflictsWithSlope,
} from "../src/lib/synthesis/priceSlopeGate";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function bars(closes: number[]): OhlcvCandle[] {
  return closes.map((close, i) => ({
    time: String(i),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

const extras: OptionsFlowExtras = {
  ivLevel: "low",
  ivTrend: "falling",
  avgIv: 12,
  pcr: { overall: 1, ntm: 1 },
  maxPain: 24600,
  lowLiquidityStrikes: [],
};

// Strong dump over 5 bars: 24650 → 24600 ≈ −0.203%
const dumpCloses = [24650, 24640, 24630, 24620, 24610, 24600];
const dumpSlope = computePriceSlope(bars(dumpCloses), { timeframe: "5m" });
assert(dumpSlope.computable, "dump slope computable");
assert(dumpSlope.slopeDirection === "down", `expected down got ${dumpSlope.slopeDirection}`);
assert(dumpSlope.slopeStrong, `expected strong |${dumpSlope.slopePct}| >= ${SLOPE_STRONG_THRESHOLD_PCT}`);
assert(
  verdictConflictsWithSlope("BULLISH", dumpSlope),
  "BULLISH must conflict with strong down slope",
);

const preStructure = synthesizeStructure("BULLISH", extras);
assert(preStructure.branch === "BUY_CE", "pre-gate Buy CE");

const gated = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: preStructure,
  candles: bars(dumpCloses),
  extras,
  timeframe: "5m",
});

assert(gated.gate.applied, "gate should apply");
assert(gated.directionalVerdict === "NEUTRAL", "post-gate NEUTRAL");
assert(gated.structure.branch === "NO_TRADE", "post-gate NO_TRADE");
assert(
  gated.gate.conflictReason === "price_slope_opposes_verdict",
  "conflictReason set",
);
assert(gated.gate.preGateVerdict === "BULLISH", "preGateVerdict kept");
assert(gated.gate.preGateStructureBranch === "BUY_CE", "preGate branch kept");

// Sell PE (high IV bullish) also downgraded on dump — same caution as Buy CE
const sellPeExtras: OptionsFlowExtras = {
  ...extras,
  ivLevel: "high",
  ivTrend: "rising",
};
const sellPe = synthesizeStructure("BULLISH", sellPeExtras);
assert(sellPe.branch === "SELL_PE", "Sell PE path");
const gatedSellPe = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: sellPe,
  candles: bars(dumpCloses),
  extras: sellPeExtras,
});
assert(gatedSellPe.gate.applied, "Sell PE also gated on strong dump");
assert(gatedSellPe.structure.branch === "NO_TRADE", "Sell PE → NO_TRADE");

// Mild slope below threshold — no gate
const mild = computePriceSlope(
  bars([25000, 25001, 25002, 25003, 25004, 25005]),
);
assert(!mild.slopeStrong, "tiny up move not strong");
assert(!verdictConflictsWithSlope("BEARISH", mild), "no conflict when weak");

// Strong rally vs BEARISH → gate
const rally = bars([24000, 24100, 24200, 24300, 24400, 24500]);
const rallySlope = computePriceSlope(rally);
assert(rallySlope.slopeDirection === "up" && rallySlope.slopeStrong, "rally strong");
const gatedShort = applyPriceSlopeGate({
  verdict: "BEARISH",
  structure: synthesizeStructure("BEARISH", extras),
  candles: rally,
  extras,
});
assert(gatedShort.gate.applied && gatedShort.directionalVerdict === "NEUTRAL", "bearish vs rally");

// Insufficient candles
const short = computePriceSlope(bars([1, 2, 3]));
assert(!short.computable, "need lookback+1 bars");
assert(short.lookbackBars === SLOPE_LOOKBACK_BARS, "default lookback");

console.log("═══ price-slope gate tests OK ═══");
console.log(
  `  Worked dump example: slopePct=${dumpSlope.slopePct.toFixed(4)}% ` +
    `dir=${dumpSlope.slopeDirection} strong=${dumpSlope.slopeStrong}`,
);
console.log(
  `  Pre-gate: BULLISH / ${preStructure.branch} → Post-gate: ${gated.directionalVerdict} / ${gated.structure.branch}`,
);
console.log(`  conflictReason=${gated.gate.conflictReason}`);
