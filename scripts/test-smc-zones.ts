/**
 * SMC Stages 6–7 — premium/discount + supply/demand.
 * Usage: npm run test:smc-zones
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  analyzePremiumDiscount,
  analyzeSmcStructure,
  applySupplyDemandStatus,
  buildSmcStructureInput,
  classifyPremiumDiscountZone,
  detectSupplyDemand,
  findBaseBeforeDisplacement,
  findLastMajorLeg,
  isBaseCandle,
  isDisplacementCandle,
  type SupplyDemandZone,
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
): SwingPoint {
  return {
    index,
    time: `t${index}`,
    price,
    type,
    timeframe: "FIVE_MINUTE",
  };
}

// ═══════════════════════ Stage 6 ═══════════════════════

{
  const swings = [
    swing(2, 100, "low"),
    swing(5, 110, "high"),
    swing(8, 104, "low"),
    swing(12, 118, "high"),
  ];
  const leg = findLastMajorLeg(swings);
  assert(!!leg, "expected leg");
  assert(leg!.legStart.price === 104 && leg!.legEnd.price === 118, "leg prices");
  assert(
    classifyPremiumDiscountZone(108, 110, 100).zone === "premium",
    "premium",
  );
  assert(
    classifyPremiumDiscountZone(102, 110, 100).zone === "discount",
    "discount",
  );
  console.log("Stage 6 classify/leg ok");
}

{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 15; i++) {
    candles.push(c(100 + i, 101 + i, 99 + i, 100.5 + i, i));
  }
  candles[14] = c(114, 115, 113.5, 114.5, 14);
  const model = analyzePremiumDiscount({
    candles,
    swings: [
      swing(2, 100, "low"),
      swing(5, 110, "high"),
      swing(8, 104, "low"),
      swing(12, 118, "high"),
    ],
  });
  assert(model!.annotationOnly === true, "annotationOnly");
  assert(model!.currentZone === "premium", `zone ${model!.currentZone}`);
  console.log("Stage 6 model:", model!.currentZone, "eq", model!.equilibrium);
}

console.log("Stage 6 synthetic: passed\n");

// ═══════════════════════ Stage 7 ═══════════════════════

/** Build ATR history then quiet base + bullish displacement. */
function buildDemandSeries(): OhlcvCandle[] {
  const candles: OhlcvCandle[] = [];
  // Warm-up: ATR-building bars with ~1pt range
  for (let i = 0; i < 20; i++) {
    const px = 100 + (i % 5) * 0.2;
    candles.push(c(px, px + 0.5, px - 0.5, px + 0.1, i));
  }
  // Quiet base (small body/range) idx 20–21
  candles.push(c(101, 101.15, 100.9, 101.05, 20)); // body small
  candles.push(c(101.05, 101.2, 100.95, 101.1, 21));
  // Bullish displacement idx 22 — large body vs ATR(~1)
  candles.push(c(101.1, 104.5, 101.0, 104.2, 22));
  // Later: re-test then break (close well below any base low incl. warm-up)
  candles.push(c(104, 104.5, 103.5, 104.2, 23));
  candles.push(c(104, 104.2, 101.0, 101.5, 24)); // re-enter demand zone
  candles.push(c(101.5, 102, 99.0, 99.5, 25)); // close through → broken
  return candles;
}

{
  const candles = buildDemandSeries();
  assert(isBaseCandle(candles, 20), "idx20 should be base");
  assert(isBaseCandle(candles, 21), "idx21 should be base");
  const disp = isDisplacementCandle(candles, 22);
  assert(disp.ok, `expected displacement @22, got ${JSON.stringify(disp)}`);
  const base = findBaseBeforeDisplacement(candles, 22);
  assert(!!base, "expected base before displacement");
  assert(base!.end === 21, `base end ${base!.end}`);
  // Up to 3 quiet bars: may include last warm-up bar (idx 19)
  assert(
    base!.end - base!.start + 1 >= 1 && base!.end - base!.start + 1 <= 3,
    `base length ${base!.end - base!.start + 1}`,
  );
  assert(base!.start <= 21 && base!.start >= 19, `base start ${base!.start}`);
  console.log("Stage 7 base+displacement:", { base, dispMult: disp.mult });
}

{
  const candles = buildDemandSeries();
  const result = detectSupplyDemand({
    candles,
    timeframe: "FIVE_MINUTE",
  });
  const demand = result.zones.find((z) => z.type === "demand");
  assert(!!demand, `expected demand zone, got ${JSON.stringify(result.zones)}`);
  assert(
    demand!.status === "broken",
    `expected broken after close-through, got ${demand!.status}`,
  );
  assert(!!demand!.testTime, "expected testTime from re-entry");
  console.log("Stage 7 demand zone:", {
    high: demand!.high,
    low: demand!.low,
    status: demand!.status,
    testTime: demand!.testTime,
    base: [demand!.baseStartIndex, demand!.baseEndIndex],
  });
}

{
  // Supply: quiet base then bearish displacement; stay fresh if no retest
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 20; i++) {
    const px = 110 - (i % 4) * 0.15;
    candles.push(c(px, px + 0.4, px - 0.4, px - 0.05, i));
  }
  candles.push(c(108, 108.1, 107.9, 108.02, 20));
  candles.push(c(108.02, 108.12, 107.95, 108.0, 21));
  candles.push(c(108, 108.1, 104.5, 104.8, 22)); // bearish displacement
  candles.push(c(104.8, 105.2, 104.2, 104.5, 23));

  const result = detectSupplyDemand({
    candles,
    timeframe: "FIVE_MINUTE",
  });
  const supply = result.zones.find((z) => z.type === "supply");
  assert(!!supply, `expected supply, got ${JSON.stringify(result.zones)}`);
  console.log("Stage 7 supply zone:", {
    status: supply!.status,
    high: supply!.high,
    low: supply!.low,
  });
}

{
  // Status helper unit: fresh → tested
  const zone: SupplyDemandZone = {
    type: "demand",
    high: 101.2,
    low: 100.9,
    baseStart: "t0",
    baseEnd: "t1",
    baseStartIndex: 0,
    baseEndIndex: 1,
    status: "fresh",
  };
  const candles = [
    c(101, 101.2, 100.9, 101, 0),
    c(101, 101.15, 100.95, 101.05, 1),
    c(101.1, 103, 101, 102.8, 2),
    c(102.5, 102.8, 101.0, 101.1, 3), // re-enter, close still ≥ low
  ];
  const out = applySupplyDemandStatus(candles, [zone]);
  assert(out[0]!.status === "tested", `got ${out[0]!.status}`);
  console.log("Stage 7 tested helper ok");
}

console.log("Stage 7 synthetic: passed\n");

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
  const pd = analyzePremiumDiscount({
    candles: scalp5m,
    swings: structure.swingPoints.external.swings,
  });
  const sd = detectSupplyDemand({
    candles: scalp5m,
    timeframe: "FIVE_MINUTE",
  });

  const lastClose = scalp5m[scalp5m.length - 1]!.close;
  console.log("\n═══ LIVE NIFTY SCALP 5m — Zones (P/D + S/D) ═══");
  console.log({
    source,
    candles: scalp5m.length,
    lastClose,
    premiumDiscount: pd
      ? {
          zone: pd.currentZone,
          eq: pd.equilibrium,
          range: [pd.rangeLow, pd.rangeHigh],
        }
      : null,
    supplyDemand: {
      total: sd.zones.length,
      demand: sd.zones.filter((z) => z.type === "demand").length,
      supply: sd.zones.filter((z) => z.type === "supply").length,
      fresh: sd.zones.filter((z) => z.status === "fresh").length,
      tested: sd.zones.filter((z) => z.status === "tested").length,
      broken: sd.zones.filter((z) => z.status === "broken").length,
    },
  });

  if (pd) {
    console.log(
      `worked P/D: lastClose=${lastClose} | ${pd.currentZone} | eq=${pd.equilibrium}`,
    );
  }
  const sample =
    sd.zones.find((z) => z.status === "fresh") ??
    sd.zones.find((z) => z.status === "tested") ??
    sd.zones[0];
  if (sample) {
    console.log(
      `worked S/D: ${sample.type} [${sample.low}–${sample.high}] status=${sample.status}` +
        ` base=[${sample.baseStartIndex}–${sample.baseEndIndex}]`,
    );
  } else {
    console.log("worked S/D: no zones on this series (no base+displacement stack)");
  }
  console.log("S/D signals:", sd.signals);
}

liveNifty()
  .then(() => console.log("\ntest-smc-zones (Stages 6–7): all passed"))
  .catch((err) => {
    console.error("test-smc-zones failed:", err);
    process.exit(1);
  });
