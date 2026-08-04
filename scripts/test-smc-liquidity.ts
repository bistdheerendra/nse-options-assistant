/**
 * SMC Stage 5 — liquidity zones / sweeps / equal highs-lows.
 * Usage: npm run test:smc-liquidity
 *
 * Note: package script is test:smc-liquidity (SMC), distinct from
 * test:scalp-liquidity (option-chain bid/ask gate).
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  EQUAL_LEVEL_TOLERANCE,
  SWEEP_CONFIRM_BARS,
  analyzeSmcStructure,
  buildSmcStructureInput,
  clusterEqualSwings,
  detectSmcLiquidity,
  detectSweep,
  type SwingPoint,
} from "../src/lib/marketdata/smc";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function c(
  o: number,
  h: number,
  l: number,
  cl: number,
  i: number,
): OhlcvCandle {
  const mins = 15 + i * 5;
  const hh = String(Math.floor(mins / 60) + 9).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return {
    time: `2026-04-01T${hh}:${mm}:00+05:30`,
    open: o,
    high: h,
    low: l,
    close: cl,
    volume: 1000 + i,
  };
}

function swing(
  index: number,
  price: number,
  type: "high" | "low",
  time: string,
): SwingPoint {
  return { index, time, price, type, timeframe: "FIVE_MINUTE" };
}

// ─── Equal highs within 0.05% ────────────────────────────────────────────────
{
  assert(EQUAL_LEVEL_TOLERANCE === 0.0005, "EQUAL_LEVEL_TOLERANCE");
  // 10000 * 0.0005 = 5 → 10000 and 10003 are equal; 10020 is not
  const swings = [
    swing(2, 10000, "high", "t2"),
    swing(8, 10003, "high", "t8"),
    swing(14, 10020, "high", "t14"),
    swing(4, 9900, "low", "t4"),
    swing(10, 9902, "low", "t10"),
  ];
  const highs = clusterEqualSwings(swings, "high");
  assert(highs.length === 1, `expected 1 equal-high cluster, got ${highs.length}`);
  assert(highs[0]!.members.length === 2, "two highs in cluster");
  assert(highs[0]!.price === 10003, `buyside at max high, got ${highs[0]!.price}`);

  const lows = clusterEqualSwings(swings, "low");
  assert(lows.length === 1, `expected 1 equal-low cluster, got ${lows.length}`);
  assert(lows[0]!.price === 9900, `sellside at min low, got ${lows[0]!.price}`);
  console.log("equal clusters:", { highs, lows: lows.map((l) => l.price) });
}

// ─── Buyside sweep: wick above, close back below within 2 bars ───────────────
{
  assert(SWEEP_CONFIRM_BARS === 2, "SWEEP_CONFIRM_BARS");
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 12; i++) {
    candles.push(c(100, 100.5, 99.5, 100, i));
  }
  // After swing at idx 5: bar 7 wicks to 101.5 (>101), bar 8 closes 100.5 (<101)
  candles[7] = c(100.5, 101.5, 100.2, 101.2, 7); // wick through, still closed above
  candles[8] = c(101, 101.2, 100, 100.5, 8); // close back below 101

  const source = [swing(5, 101, "high", candles[5]!.time)];
  const sweep = detectSweep({
    candles,
    price: 101,
    side: "buyside",
    sourceSwings: source,
  });
  assert(sweep.swept, `expected buyside sweep, got ${JSON.stringify(sweep)}`);
  assert(sweep.sweepTime === candles[8]!.time, "sweepTime on close-back bar");
  console.log("buyside sweep:", sweep);
}

// ─── Sellside sweep ──────────────────────────────────────────────────────────
{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 12; i++) {
    candles.push(c(100, 100.5, 99.5, 100, i));
  }
  candles[7] = c(99.5, 99.8, 98.5, 98.8, 7); // wick below 99
  candles[8] = c(98.8, 99.5, 98.7, 99.3, 8); // close back above 99

  const sweep = detectSweep({
    candles,
    price: 99,
    side: "sellside",
    sourceSwings: [swing(5, 99, "low", candles[5]!.time)],
  });
  assert(sweep.swept, `expected sellside sweep, got ${JSON.stringify(sweep)}`);
  console.log("sellside sweep:", sweep);
}

// ─── Full detectSmcLiquidity ─────────────────────────────────────────────────
{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 20; i++) {
    candles.push(c(100 + (i % 3) * 0.1, 100.5, 99.5, 100, i));
  }
  candles[15] = c(100.2, 100.55, 100, 100.1, 15); // wick equal-high ~100.5
  candles[16] = c(100.1, 100.3, 99.8, 100, 16); // close back

  const swings: SwingPoint[] = [
    swing(3, 100.5, "high", candles[3]!.time),
    swing(9, 100.48, "high", candles[9]!.time), // within 0.05% of 100.5
    swing(5, 99.5, "low", candles[5]!.time),
    swing(11, 99.52, "low", candles[11]!.time),
  ];
  const result = detectSmcLiquidity({
    candles,
    swings,
    timeframe: "FIVE_MINUTE",
  });
  assert(
    result.zones.some((z) => z.type === "buyside" && z.equalLevel),
    `expected buyside equal level, got ${JSON.stringify(result.zones)}`,
  );
  assert(
    result.zones.some((z) => z.type === "sellside" && z.equalLevel),
    "expected sellside equal level",
  );
  console.log(
    "full zones:",
    result.zones.map((z) => ({
      type: z.type,
      price: z.price,
      swept: z.swept,
      n: z.sourceSwings.length,
    })),
  );
}

console.log("synthetic fixtures: all passed\n");

async function liveNifty(): Promise<void> {
  const source = isDemoMarketDataMode() ? "demo" : "angel";
  console.log(`live NIFTY fetch (source hint: ${source})…`);

  let scalp5m: OhlcvCandle[] = [];
  try {
    scalp5m = await getUnderlyingCandles("NIFTY", "FIVE_MINUTE", 5);
  } catch (err) {
    console.warn("live fetch failed:", err instanceof Error ? err.message : err);
    return;
  }
  if (scalp5m.length === 0) {
    console.warn("no candles — skip live worked example");
    return;
  }

  const structure = analyzeSmcStructure(
    buildSmcStructureInput({
      underlying: "NIFTY",
      mode: "SCALP",
      externalCandles: scalp5m,
      source,
    }),
  );
  const liq = detectSmcLiquidity({
    candles: scalp5m,
    swings: structure.swingPoints.external.swings,
    timeframe: "FIVE_MINUTE",
  });

  const lastClose = scalp5m[scalp5m.length - 1]!.close;
  const buyside = liq.zones.filter((z) => z.type === "buyside");
  const sellside = liq.zones.filter((z) => z.type === "sellside");
  const unswept = liq.zones.filter((z) => !z.swept);

  console.log("\n═══ LIVE NIFTY SCALP 5m — SMC Liquidity ═══");
  console.log({
    source,
    candles: scalp5m.length,
    lastClose,
    swings: structure.swingPoints.external.swings.length,
    buyside: buyside.length,
    sellside: sellside.length,
    swept: liq.zones.filter((z) => z.swept).length,
    unswept: unswept.length,
  });

  const sample = unswept[0] ?? liq.zones[0];
  if (sample) {
    console.log(
      `\nworked: lastClose=${lastClose} | ${sample.type} @ ${sample.price}` +
        ` equal=${sample.equalLevel} swings=${sample.sourceSwings.length}` +
        ` swept=${sample.swept}` +
        (sample.sweepTime ? ` @${sample.sweepTime}` : "") +
        ` | Δ vs spot=${(sample.price - lastClose).toFixed(2)}`,
    );
  }
  console.log("signals:", liq.signals);
}

liveNifty()
  .then(() => console.log("\ntest-smc-liquidity: all passed"))
  .catch((err) => {
    console.error("test-smc-liquidity failed:", err);
    process.exit(1);
  });
