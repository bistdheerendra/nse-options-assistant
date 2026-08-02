/**
 * Stage 5 stop-loss cluster sanity checks.
 * Usage: npx tsx scripts/test-scalp-clusters.ts
 */
import { deriveStopLossClusters, roundNumberLevels } from "../src/lib/marketdata/scalp/stopLossClusters";
import type { OhlcvCandle, OptionChainResult } from "../src/lib/marketdata/angelone";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const rounds = roundNumberLevels(24523, 50, 2);
assert(rounds.some((r) => r.price === 24500), "expected 24500 round");
assert(rounds.some((r) => r.kind === "support"), "support rounds");
assert(rounds.some((r) => r.kind === "resistance"), "resistance rounds");

const candles: OhlcvCandle[] = [];
let px = 24500;
for (let i = 0; i < 40; i++) {
  const open = px;
  const close = px + ((i % 6) - 2) * 8;
  candles.push({
    time: `2026-01-01T10:${String(i).padStart(2, "0")}:00+05:30`,
    open,
    high: Math.max(open, close) + 15,
    low: Math.min(open, close) - 15,
    close,
    volume: 1000,
  });
  px = close;
}

const chain: OptionChainResult = {
  underlying: "NIFTY",
  spot: 24500,
  expiry: "2026-08-07",
  contracts: [
    {
      strike: 24400,
      optionType: "PE",
      tradingsymbol: "P",
      symboltoken: "1",
      ltp: 80,
      oi: 500_000,
      volume: 10_000,
      lotSize: 65,
      expiry: "2026-08-07",
    },
    {
      strike: 24600,
      optionType: "CE",
      tradingsymbol: "C",
      symboltoken: "2",
      ltp: 90,
      oi: 400_000,
      volume: 10_000,
      lotSize: 65,
      expiry: "2026-08-07",
    },
  ],
};

const result = deriveStopLossClusters({
  underlying: "NIFTY",
  spot: 24500,
  candles,
  chain,
});

assert(result.support.length > 0 || result.resistance.length > 0, "expected levels");
assert(
  result.levels.some((l) => l.sources.includes("oi_wall")),
  `expected oi_wall source, got ${JSON.stringify(result.levels)}`,
);

console.log("test-scalp-clusters: all passed", {
  levelCount: result.levels.length,
  support: result.support.slice(0, 2).map((s) => s.price),
  resistance: result.resistance.slice(0, 2).map((r) => r.price),
});
