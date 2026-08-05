/**
 * Pure checks for SCALP + SWING price-slope post-synthesis gate.
 * Run: npx tsx scripts/test-price-slope-gate.ts
 */
import type { OhlcvCandle } from "../src/lib/marketdata/angelone";
import type { OptionsFlowExtras } from "../src/lib/lanes/optionsFlow";
import { synthesizeStructure } from "../src/lib/synthesis/structure";
import {
  applyPriceSlopeGate,
  computePriceSlope,
  SCALP_SLOPE_LOOKBACK_BARS,
  SCALP_SLOPE_STRONG_THRESHOLD_PCT,
  SWING_SLOPE_LOOKBACK_BARS,
  SWING_SLOPE_STRONG_THRESHOLD_PCT,
  slopeParamsForMode,
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

/** Linear dump from start → end over n+1 closes (n = lookback). */
function dumpCloses(start: number, end: number, lookback: number): number[] {
  const n = lookback;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(start + ((end - start) * i) / n);
  }
  return out;
}

const extras: OptionsFlowExtras = {
  ivLevel: "low",
  ivTrend: "falling",
  avgIv: 12,
  pcr: { overall: 1, ntm: 1 },
  maxPain: 24600,
  lowLiquidityStrikes: [],
};

// ─── SCALP ───────────────────────────────────────────────────────────────────
const scalpDump = dumpCloses(24650, 24600, SCALP_SLOPE_LOOKBACK_BARS);
const scalpSlope = computePriceSlope(bars(scalpDump), slopeParamsForMode("SCALP"));
assert(scalpSlope.computable, "scalp dump computable");
assert(scalpSlope.slopeDirection === "down", `scalp dir ${scalpSlope.slopeDirection}`);
assert(scalpSlope.slopeStrong, `scalp strong |${scalpSlope.slopePct}| >= ${SCALP_SLOPE_STRONG_THRESHOLD_PCT}`);
assert(verdictConflictsWithSlope("BULLISH", scalpSlope), "SCALP BULLISH vs down");

const scalpPre = synthesizeStructure("BULLISH", extras);
const scalpGated = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: scalpPre,
  candles: bars(scalpDump),
  extras,
  mode: "SCALP",
});
assert(scalpGated.gate.applied, "scalp gate applies");
assert(scalpGated.directionalVerdict === "NEUTRAL", "scalp NEUTRAL");
assert(scalpGated.structure.branch === "NO_TRADE", "scalp NO_TRADE");
assert(scalpGated.gate.conflictReason === "price_slope_opposes_verdict", "scalp reason");
assert(scalpGated.gate.preGateVerdict === "BULLISH", "scalp preGate");
assert(scalpGated.gate.preGateStructureBranch === "BUY_CE", "scalp branch");

// Sell PE also gated on SCALP dump
const sellPeExtras: OptionsFlowExtras = {
  ...extras,
  ivLevel: "high",
  ivTrend: "rising",
};
const scalpSellPe = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: synthesizeStructure("BULLISH", sellPeExtras),
  candles: bars(scalpDump),
  extras: sellPeExtras,
  mode: "SCALP",
});
assert(scalpSellPe.gate.applied && scalpSellPe.structure.branch === "NO_TRADE", "SCALP Sell PE gated");

// Mild SCALP slope — no gate
const mildScalp = computePriceSlope(
  bars([25000, 25001, 25002, 25003, 25004, 25005]),
  slopeParamsForMode("SCALP"),
);
assert(!mildScalp.slopeStrong, "tiny scalp move not strong");

// ─── SWING ───────────────────────────────────────────────────────────────────
assert(SWING_SLOPE_LOOKBACK_BARS === 15, "SWING lookback 15");
assert(SWING_SLOPE_STRONG_THRESHOLD_PCT === 0.35, "SWING threshold 0.35");
assert(
  SWING_SLOPE_STRONG_THRESHOLD_PCT > SCALP_SLOPE_STRONG_THRESHOLD_PCT,
  "SWING threshold must exceed SCALP (1h noise >> 5m)",
);

// ~0.50% dump over 15×1h — above 0.35% strong threshold
const swingStart = 25000;
const swingEnd = 25000 * (1 - 0.005); // −0.50%
const swingDump = dumpCloses(swingStart, swingEnd, SWING_SLOPE_LOOKBACK_BARS);
const swingSlope = computePriceSlope(bars(swingDump), slopeParamsForMode("SWING"));
assert(swingSlope.computable, "swing dump computable");
assert(swingSlope.timeframe === "1h", "swing tf 1h");
assert(swingSlope.lookbackBars === 15, "swing lb 15");
assert(swingSlope.slopeDirection === "down", `swing dir ${swingSlope.slopeDirection}`);
assert(
  Math.abs(swingSlope.slopePct) >= SWING_SLOPE_STRONG_THRESHOLD_PCT,
  `swing |${swingSlope.slopePct.toFixed(4)}| >= ${SWING_SLOPE_STRONG_THRESHOLD_PCT}`,
);
assert(swingSlope.slopeStrong, "swing strong");
assert(verdictConflictsWithSlope("BULLISH", swingSlope), "SWING BULLISH vs down");

const swingPre = synthesizeStructure("BULLISH", extras);
const swingGated = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: swingPre,
  candles: bars(swingDump),
  extras,
  mode: "SWING",
});
assert(swingGated.gate.applied, "swing gate applies");
assert(swingGated.directionalVerdict === "NEUTRAL", "swing NEUTRAL");
assert(swingGated.structure.branch === "NO_TRADE", "swing NO_TRADE");
assert(
  swingGated.gate.conflictReason === "price_slope_opposes_verdict",
  "swing conflictReason",
);
assert(swingGated.gate.preGateVerdict === "BULLISH", "swing preGate");
assert(swingGated.gate.preGateStructureBranch === "BUY_CE", "swing BUY_CE");

// Same dump must NOT trip SCALP threshold logic wrongly if fed with SWING params only —
// and a 0.20% SWING move must NOT be strong (would be strong on SCALP 0.15%)
const quietSwing = dumpCloses(25000, 25000 * (1 - 0.002), SWING_SLOPE_LOOKBACK_BARS); // −0.20%
const quietSlope = computePriceSlope(bars(quietSwing), slopeParamsForMode("SWING"));
assert(
  !quietSlope.slopeStrong,
  `−0.20% must NOT be strong on SWING (threshold ${SWING_SLOPE_STRONG_THRESHOLD_PCT}); got ${quietSlope.slopePct.toFixed(4)}%`,
);
const quietGated = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: swingPre,
  candles: bars(quietSwing),
  extras,
  mode: "SWING",
});
assert(!quietGated.gate.applied, "quiet 0.20% dump must not gate SWING");

// Sell PE on SWING dump
const swingSellPe = applyPriceSlopeGate({
  verdict: "BULLISH",
  structure: synthesizeStructure("BULLISH", sellPeExtras),
  candles: bars(swingDump),
  extras: sellPeExtras,
  mode: "SWING",
});
assert(swingSellPe.gate.applied && swingSellPe.structure.branch === "NO_TRADE", "SWING Sell PE gated");

// Strong rally vs BEARISH on SWING
const swingRally = dumpCloses(24000, 24000 * 1.005, SWING_SLOPE_LOOKBACK_BARS);
const swingRallyGated = applyPriceSlopeGate({
  verdict: "BEARISH",
  structure: synthesizeStructure("BEARISH", extras),
  candles: bars(swingRally),
  extras,
  mode: "SWING",
});
assert(
  swingRallyGated.gate.applied && swingRallyGated.directionalVerdict === "NEUTRAL",
  "SWING bearish vs rally",
);

console.log("═══ price-slope gate tests OK (SCALP + SWING) ═══");
console.log(
  `  SCALP dump: slopePct=${scalpSlope.slopePct.toFixed(4)}% dir=${scalpSlope.slopeDirection} ` +
    `→ ${scalpPre.branch} → ${scalpGated.structure.branch} (${scalpGated.gate.conflictReason})`,
);
console.log(
  `  SWING dump: slopePct=${swingSlope.slopePct.toFixed(4)}% dir=${swingSlope.slopeDirection} ` +
    `lb=${swingSlope.lookbackBars}×${swingSlope.timeframe} thr=${swingSlope.strongThresholdPct}% ` +
    `→ pre ${swingPre.branch} → post ${swingGated.directionalVerdict}/${swingGated.structure.branch} ` +
    `(${swingGated.gate.conflictReason})`,
);
