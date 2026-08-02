/**
 * Stage 4 liquidity gate sanity checks.
 * Usage: npx tsx scripts/test-scalp-liquidity.ts
 */
import {
  LIQUIDITY_MIN_OI,
  LIQUIDITY_MIN_VOLUME,
  LIQUIDITY_SPREAD_WIDE_PCT,
  assessScalpLiquidity,
  calcSpreadPct,
  scoreStrikeLiquidity,
} from "../src/lib/marketdata/scalp/liquidity";
import type { OptionChainResult, OptionContractQuote } from "../src/lib/marketdata/angelone";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function contract(
  partial: Partial<OptionContractQuote> & Pick<OptionContractQuote, "strike" | "optionType" | "ltp">,
): OptionContractQuote {
  return {
    tradingsymbol: "T",
    symboltoken: "1",
    lotSize: 65,
    expiry: "2026-08-07",
    volume: LIQUIDITY_MIN_VOLUME * 5,
    oi: LIQUIDITY_MIN_OI * 3,
    bid: partial.ltp * 0.99,
    ask: partial.ltp * 1.01,
    ...partial,
  };
}

assert(
  calcSpreadPct(10, 10.8, 10) === 0.08,
  `spread calc, got ${calcSpreadPct(10, 10.8, 10)}`,
);

const wide = scoreStrikeLiquidity(
  contract({
    strike: 24500,
    optionType: "CE",
    ltp: 100,
    bid: 90,
    ask: 110, // 20% spread
    volume: 50,
    oi: 1000,
  }),
);
assert(wide.unsuitableForScalp, "wide+thin should be unsuitable");
assert(wide.spreadPct! > LIQUIDITY_SPREAD_WIDE_PCT, "spread should be wide");

const tight = scoreStrikeLiquidity(
  contract({
    strike: 24500,
    optionType: "CE",
    ltp: 100,
    bid: 99,
    ask: 101,
  }),
);
assert(!tight.unsuitableForScalp, "tight liquid contract should pass");
assert(tight.tier === "high" || tight.tier === "medium", `tier ${tight.tier}`);

const chain: OptionChainResult = {
  underlying: "NIFTY",
  spot: 24500,
  expiry: "2026-08-07",
  contracts: [
    contract({ strike: 24500, optionType: "CE", ltp: 120, bid: 100, ask: 140, volume: 10, oi: 100 }),
    contract({ strike: 24500, optionType: "PE", ltp: 110, bid: 100, ask: 140, volume: 10, oi: 100 }),
  ],
};

const fail = assessScalpLiquidity(chain, "CE");
assert(fail.status === "fail", `expected fail, got ${fail.status}`);
assert(fail.badgeLabel.toLowerCase().includes("unsuitable"), fail.badgeLabel);

const goodChain: OptionChainResult = {
  ...chain,
  contracts: [
    contract({ strike: 24500, optionType: "CE", ltp: 100 }),
    contract({ strike: 24500, optionType: "PE", ltp: 95 }),
    contract({ strike: 24450, optionType: "CE", ltp: 130 }),
    contract({ strike: 24450, optionType: "PE", ltp: 80 }),
  ],
};
const pass = assessScalpLiquidity(goodChain, "CE");
assert(pass.status === "pass" || pass.status === "warn", `got ${pass.status}`);

console.log("test-scalp-liquidity: all passed", {
  fail: fail.status,
  pass: pass.status,
  wideSpread: wide.spreadPct,
});
