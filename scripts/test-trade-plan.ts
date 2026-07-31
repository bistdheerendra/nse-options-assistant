/**
 * Quick pure-function checks for ATR trade-plan math.
 * Run: npx tsx scripts/test-trade-plan.ts
 */
import { calcAtr } from "../src/lib/indicators/atr";
import { computeLaneAlignment } from "../src/lib/synthesis/alignment";
import { detectRegime } from "../src/lib/synthesis/regime";
import { buildTradePlan } from "../src/lib/synthesis/tradePlan";
import type { OptionChainResult } from "../src/lib/marketdata/angelone";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const candles = Array.from({ length: 30 }, (_, i) => {
  const c = 100 + i * 0.1;
  return {
    time: String(i),
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1000,
  };
});

const atr = calcAtr(candles, 14);
assert(atr != null && atr > 0, "ATR should be positive");

const regime = detectRegime({ spot: 100, atr: 0.5, ema50: 100.1, ema200: 100.05 });
assert(regime.regime === "CHOPPY", `expected CHOPPY got ${regime.regime}`);

const alignment = computeLaneAlignment("BEARISH", {
  technical: { score: -0.4 },
  optionsFlow: { score: -0.3 },
  sentiment: { score: 0, rawIndicators: { stub: true } },
  macro: { score: 0, rawIndicators: { stub: true } },
});
assert(alignment.alignedCount === 2 && alignment.activeCount === 2, alignment.label);

const chain: OptionChainResult = {
  underlying: "NIFTY",
  spot: 25000,
  expiry: "2026-08-07",
  contracts: [
    {
      strike: 25000,
      optionType: "PE",
      tradingsymbol: "NIFTY25000PE",
      symboltoken: "1",
      ltp: 120,
      lotSize: 65,
      expiry: "2026-08-07",
    },
  ],
};

const plan = buildTradePlan({
  spot: 25000,
  atr: 100,
  mode: "SWING",
  verdict: "BEARISH",
  structure: {
    branch: "BUY_PE",
    action: "BUY",
    optionType: "PE",
    isSellWrite: false,
    reasoning: "test",
    riskWarning: null,
  },
  chain,
});

assert(plan.sideLabel === "SHORT", "SHORT for BUY_PE");
assert(plan.stopLoss != null && plan.stopLoss > 25000, "SL above spot for short");
assert(plan.takeProfit1 != null && plan.takeProfit1 < 25000, "TP1 below spot");
assert(plan.riskReward === 2, `R:R should be 2 got ${plan.riskReward}`);
assert(plan.suggestedContract?.strike === 25000, "ATM PE suggested");

// Worked example (buy): spot 25000, ATR 100, Swing k=2.25
// SL = 25000 + 2.25*100 = 25225; risk = 225
// TP1 = 25000 - 450 = 24550; R:R = 450/225 = 2
console.log("Buy PE worked example:");
console.log(`  Entry spot ${plan.entry}, SL ${plan.stopLoss}, TP1 ${plan.takeProfit1}, TP2 ${plan.takeProfit2}`);
console.log(`  R:R 1:${plan.riskReward}, premium entry ₹${plan.suggestedContract?.entryPremium}`);

const sellPlan = buildTradePlan({
  spot: 25000,
  atr: 100,
  mode: "SWING",
  verdict: "BEARISH",
  structure: {
    branch: "SELL_CE",
    action: "SELL",
    optionType: "CE",
    isSellWrite: true,
    reasoning: "test sell",
    riskWarning: "uncapped",
  },
  chain: {
    ...chain,
    contracts: [
      {
        strike: 25000,
        optionType: "CE",
        tradingsymbol: "NIFTY25000CE",
        symboltoken: "2",
        ltp: 110,
        lotSize: 65,
        expiry: "2026-08-07",
      },
    ],
  },
});
console.log("Sell CE worked example (same spot levels; premium credit ₹110):");
console.log(`  Entry ${sellPlan.entry}, SL ${sellPlan.stopLoss}, TP1 ${sellPlan.takeProfit1}`);
console.log(`  WARNING: sell/write CE loss is theoretically uncapped above SL invalidation.`);

console.log("\nAll trade-plan checks passed.");
