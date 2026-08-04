/**
 * SMC Stage 3 — order blocks / breaker / mitigation / rejection.
 * Usage: npm run test:smc-blocks
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  analyzeSmcStructure,
  applyMitigationAndBreakers,
  buildSmcStructureInput,
  detectOrderBlocks,
  detectRejectionBlocks,
  findOrderBlockOriginIndex,
  REJECTION_WICK_RATIO,
  type MarketStructureEvent,
  type OrderBlockZone,
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

// ─── Rejection: swing low with long lower wick (≥2× body) ────────────────────
{
  // body = |100.2-100| = 0.2; lower wick = min(100,100.2)-97 = 3 ≥ 2×0.2
  const candles = [
    c(100, 101, 99, 100.5, 0),
    c(100.5, 101, 100, 100.8, 1),
    c(100, 100.3, 97, 100.2, 2), // rejection at swing low idx 2
    c(100.2, 101, 100, 100.5, 3),
    c(100.5, 101.2, 100.2, 101, 4),
  ];
  const swings: SwingPoint[] = [
    {
      index: 2,
      time: candles[2]!.time,
      price: 97,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
  ];
  const rej = detectRejectionBlocks(candles, swings, "external");
  assert(
    rej.some((z) => z.type === "bullish_rejection" && z.lowerConfidence),
    `expected bullish_rejection, got ${JSON.stringify(rej)}`,
  );
  assert(REJECTION_WICK_RATIO === 2, "REJECTION_WICK_RATIO");
  console.log("rejection block:", rej[0]);
}

// ─── OB origin: last bearish candle before bullish BOS ───────────────────────
{
  const candles = [
    c(100, 101, 99, 100.5, 0), // bullish
    c(100.5, 100.8, 99.5, 99.7, 1), // bearish ← OB
    c(99.7, 102, 99.6, 101.5, 2), // impulse
    c(101.5, 104, 101, 103.5, 3), // BOS confirm
  ];
  const event: MarketStructureEvent = {
    type: "BOS",
    direction: "bullish",
    time: candles[3]!.time,
    price: 103.5,
    brokenSwing: {
      index: 0,
      time: candles[0]!.time,
      price: 101,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    structureLevel: "external",
    confirmIndex: 3,
  };
  const idx = findOrderBlockOriginIndex(candles, event);
  assert(idx === 1, `expected OB origin idx 1, got ${idx}`);
  console.log("OB origin candle:", candles[idx!], "idx", idx);
}

// ─── Mitigation then invalidation → breaker ──────────────────────────────────
{
  // Bullish OB zone high=101 low=99. Then dip into zone (mitigate), later close through.
  const zone: OrderBlockZone = {
    type: "bullish_ob",
    high: 101,
    low: 99,
    originCandleTime: "t0",
    originCandleIndex: 0,
    status: "fresh",
    lowerConfidence: false,
    causedByEvent: "BOS",
    structureLevel: "external",
  };
  const candles = [
    c(100.5, 101, 99, 99.5, 0), // origin (bearish)
    c(101.5, 103, 101.2, 102.5, 1), // leave zone entirely above
    c(101.5, 102, 99.5, 100.5, 2), // re-enter, close 100.5 ≥ 99 → mitigate
    c(100.5, 101, 98, 98.5, 3), // close through below → invalidate
    c(98.5, 98.8, 97.5, 98, 4), // stays below zone — breaker remains fresh
  ];
  const out = applyMitigationAndBreakers(candles, [zone]);
  const orig = out.find((z) => z.type === "bullish_ob")!;
  assert(orig.status === "invalidated", `expected invalidated, got ${orig.status}`);
  assert(
    orig.mitigationTime === candles[2]!.time,
    `mitigationTime expected ${candles[2]!.time}, got ${orig.mitigationTime}`,
  );
  const br = out.find((z) => z.type === "bearish_breaker");
  assert(!!br, "expected bearish_breaker after invalidation");
  assert(
    br!.status === "fresh",
    `breaker should stay fresh after spawn (track from invalidation), got ${br!.status}`,
  );
  console.log("mitigation→breaker:", {
    ob: orig.status,
    mitigationTime: orig.mitigationTime,
    breaker: br?.type,
    breakerStatus: br?.status,
  });
}

// ─── Full detectOrderBlocks on synthetic structure ───────────────────────────
{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 20; i++) {
    const base = 100 + i * 0.3;
    candles.push(c(base, base + 0.8, base - 0.5, base + 0.2, i));
  }
  // Force a bearish candle mid-impulse and a BOS-like close
  candles[10] = c(103, 103.2, 101.5, 101.8, 10); // bearish OB candidate
  candles[14] = c(104, 106, 103.5, 105.5, 14); // break close

  const swings: SwingPoint[] = [
    {
      index: 5,
      time: candles[5]!.time,
      price: candles[5]!.high,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 8,
      time: candles[8]!.time,
      price: candles[8]!.low,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
  ];
  const events: MarketStructureEvent[] = [
    {
      type: "BOS",
      direction: "bullish",
      time: candles[14]!.time,
      price: 105.5,
      brokenSwing: swings[0]!,
      structureLevel: "external",
      confirmIndex: 14,
    },
  ];
  const result = detectOrderBlocks({
    candles,
    swings,
    events,
    timeframe: "FIVE_MINUTE",
    structureLevel: "external",
  });
  assert(
    result.zones.some((z) => z.type === "bullish_ob"),
    `expected bullish_ob, got ${result.zones.map((z) => z.type)}`,
  );
  console.log(
    "full detect:",
    result.zones.map((z) => ({
      type: z.type,
      status: z.status,
      high: z.high,
      low: z.low,
      idx: z.originCandleIndex,
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
  const ob = detectOrderBlocks({
    candles: scalp5m,
    swings: structure.swingPoints.external.swings,
    events: structure.marketStructure.external.events,
    timeframe: "FIVE_MINUTE",
    structureLevel: "external",
  });

  const byStatus = {
    fresh: ob.zones.filter((z) => z.status === "fresh"),
    mitigated: ob.zones.filter((z) => z.status === "mitigated"),
    invalidated: ob.zones.filter((z) => z.status === "invalidated"),
  };
  const lastClose = scalp5m[scalp5m.length - 1]!.close;

  console.log("\n═══ LIVE NIFTY SCALP 5m — Order Blocks ═══");
  console.log({
    source,
    candles: scalp5m.length,
    lastClose,
    structureEvents: structure.marketStructure.external.events.length,
    swings: structure.swingPoints.external.swings.length,
    zones: ob.zones.length,
    fresh: byStatus.fresh.length,
    mitigated: byStatus.mitigated.length,
    invalidated: byStatus.invalidated.length,
    breakers: ob.zones.filter((z) => z.type.includes("breaker")).length,
    rejections: ob.zones.filter((z) => z.type.includes("rejection")).length,
  });

  const sample =
    byStatus.fresh[0] ?? byStatus.mitigated[0] ?? ob.zones[ob.zones.length - 1];
  if (sample) {
    console.log(
      `\nworked: lastClose=${lastClose} | sample ${sample.type} [${sample.low}–${sample.high}] status=${sample.status}` +
        (sample.mitigationTime ? ` mitigated@${sample.mitigationTime}` : ""),
    );
  }
  console.log("signals:", ob.signals);
}

liveNifty()
  .then(() => console.log("\ntest-smc-blocks: all passed"))
  .catch((err) => {
    console.error("test-smc-blocks failed:", err);
    process.exit(1);
  });
