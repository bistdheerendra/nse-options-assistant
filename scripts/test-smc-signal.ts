/**
 * SMC Stage 8 — signal synthesis + engine assemble.
 * Usage: npm run test:smc-signal
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  SMC_DISCLAIMER,
  assembleSmcEngineResult,
  buildSmcOverlayLevels,
  runSmcEngineSync,
  synthesizeSmcSignal,
  type MarketStructureEvent,
  type MarketStructureResult,
  type OrderBlocksResult,
  type PremiumDiscountModel,
  type SmcLiquidityResult,
  type SupplyDemandResult,
  type SwingPoint,
} from "../src/lib/marketdata/smc";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function emptyStructure(
  events: MarketStructureEvent[],
  trend: MarketStructureResult["trend"] = "ranging",
): MarketStructureResult {
  return {
    timeframe: "FIVE_MINUTE",
    structureLevel: "external",
    trend,
    events,
    lastEvent: events[events.length - 1] ?? null,
    signals: [],
    status: "ok",
  };
}

// ─── BUY confluence all pass ─────────────────────────────────────────────────
{
  const events: MarketStructureEvent[] = [
    {
      type: "CHoCH",
      direction: "bullish",
      time: "t1",
      price: 100,
      brokenSwing: {
        index: 1,
        time: "t0",
        price: 99,
        type: "low",
        timeframe: "FIVE_MINUTE",
      },
      structureLevel: "external",
      confirmIndex: 10,
    },
  ];
  const orderBlocks: OrderBlocksResult = {
    timeframe: "FIVE_MINUTE",
    zones: [
      {
        type: "bullish_ob",
        high: 101,
        low: 99,
        originCandleTime: "t0",
        originCandleIndex: 5,
        status: "fresh",
        lowerConfidence: false,
        causedByEvent: "CHoCH",
        structureLevel: "external",
      },
    ],
    signals: [],
  };
  const supplyDemand: SupplyDemandResult = {
    timeframe: "FIVE_MINUTE",
    zones: [],
    signals: [],
  };
  const premiumDiscount: PremiumDiscountModel = {
    rangeHigh: 120,
    rangeLow: 100,
    equilibrium: 110,
    currentZone: "discount",
    currentPrice: 105,
    legStart: {
      index: 1,
      time: "t",
      price: 100,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
    legEnd: {
      index: 2,
      time: "t",
      price: 120,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    annotationOnly: true,
    signals: [],
  };
  const liquidity: SmcLiquidityResult = {
    timeframe: "FIVE_MINUTE",
    zones: [],
    signals: [],
  };

  const signal = synthesizeSmcSignal({
    underlying: "NIFTY",
    mode: "SCALP",
    structure: emptyStructure(events, "bullish"),
    orderBlocks,
    liquidity,
    premiumDiscount,
    supplyDemand,
    spot: 105,
  });
  assert(signal.entry === "BUY", `expected BUY, got ${signal.entry}`);
  assert(signal.checklist.every((c) => c.passed), "all checklist must pass");
  assert(signal.disclaimer === SMC_DISCLAIMER, "disclaimer");
  console.log("BUY confluence:", signal.entry, signal.checklist.map((c) => c.key));
}

// ─── Missing discount → NONE with failed premium_discount ────────────────────
{
  const events: MarketStructureEvent[] = [
    {
      type: "BOS",
      direction: "bullish",
      time: "t1",
      price: 100,
      brokenSwing: {
        index: 1,
        time: "t0",
        price: 99,
        type: "high",
        timeframe: "FIVE_MINUTE",
      },
      structureLevel: "external",
      confirmIndex: 10,
    },
  ];
  const signal = synthesizeSmcSignal({
    underlying: "NIFTY",
    mode: "SCALP",
    structure: emptyStructure(events),
    orderBlocks: {
      timeframe: "FIVE_MINUTE",
      zones: [
        {
          type: "bullish_ob",
          high: 101,
          low: 99,
          originCandleTime: "t",
          originCandleIndex: 1,
          status: "fresh",
          lowerConfidence: false,
          causedByEvent: "BOS",
          structureLevel: "external",
        },
      ],
      signals: [],
    },
    liquidity: { timeframe: "FIVE_MINUTE", zones: [], signals: [] },
    premiumDiscount: {
      rangeHigh: 120,
      rangeLow: 100,
      equilibrium: 110,
      currentZone: "premium", // wrong for BUY
      currentPrice: 115,
      legStart: {
        index: 1,
        time: "t",
        price: 100,
        type: "low",
        timeframe: "FIVE_MINUTE",
      },
      legEnd: {
        index: 2,
        time: "t",
        price: 120,
        type: "high",
        timeframe: "FIVE_MINUTE",
      },
      annotationOnly: true,
      signals: [],
    },
    supplyDemand: { timeframe: "FIVE_MINUTE", zones: [], signals: [] },
    spot: 115,
  });
  assert(signal.entry === "NONE", `expected NONE, got ${signal.entry}`);
  const pd = signal.checklist.find((c) => c.key === "premium_discount");
  assert(!!pd && pd.passed === false, "premium_discount should fail");
  console.log("NONE on premium fail:", pd?.detail);
}

// ─── Unswept buyside blocks BUY ──────────────────────────────────────────────
{
  const signal = synthesizeSmcSignal({
    underlying: "NIFTY",
    mode: "SCALP",
    structure: emptyStructure([
      {
        type: "CHoCH",
        direction: "bullish",
        time: "t",
        price: 100,
        brokenSwing: {
          index: 1,
          time: "t",
          price: 99,
          type: "low",
          timeframe: "FIVE_MINUTE",
        },
        structureLevel: "external",
        confirmIndex: 5,
      },
    ]),
    orderBlocks: {
      timeframe: "FIVE_MINUTE",
      zones: [
        {
          type: "bullish_ob",
          high: 101,
          low: 99,
          originCandleTime: "t",
          originCandleIndex: 1,
          status: "fresh",
          lowerConfidence: false,
          causedByEvent: "CHoCH",
          structureLevel: "external",
        },
      ],
      signals: [],
    },
    liquidity: {
      timeframe: "FIVE_MINUTE",
      zones: [
        {
          type: "buyside",
          price: 110,
          sourceSwings: [] as SwingPoint[],
          equalLevel: true,
          swept: false,
        },
      ],
      signals: [],
    },
    premiumDiscount: {
      rangeHigh: 120,
      rangeLow: 100,
      equilibrium: 110,
      currentZone: "discount",
      currentPrice: 105,
      legStart: {
        index: 1,
        time: "t",
        price: 100,
        type: "low",
        timeframe: "FIVE_MINUTE",
      },
      legEnd: {
        index: 2,
        time: "t",
        price: 120,
        type: "high",
        timeframe: "FIVE_MINUTE",
      },
      annotationOnly: true,
      signals: [],
    },
    supplyDemand: { timeframe: "FIVE_MINUTE", zones: [], signals: [] },
    spot: 105,
  });
  assert(signal.entry === "NONE", "liquidity should block BUY");
  const liq = signal.checklist.find((c) => c.key === "liquidity_clear");
  assert(!!liq && liq.passed === false, "liquidity_clear fail");
  console.log("blocked by liquidity:", liq?.detail);
}

console.log("synthetic Stage 8: passed\n");

async function liveNifty(): Promise<void> {
  const source = isDemoMarketDataMode() ? "demo" : "angel";
  console.log(`live NIFTY SCALP engine (source hint: ${source})…`);

  let scalp5m: OhlcvCandle[] = [];
  let scalp3m: OhlcvCandle[] = [];
  try {
    scalp5m = await getUnderlyingCandles("NIFTY", "FIVE_MINUTE", 5);
    scalp3m = await getUnderlyingCandles("NIFTY", "THREE_MINUTE", 5);
  } catch (err) {
    console.warn("fetch failed:", err instanceof Error ? err.message : err);
    return;
  }
  if (scalp5m.length === 0) {
    console.warn("no candles");
    return;
  }

  const result = runSmcEngineSync({
    underlying: "NIFTY",
    mode: "SCALP",
    externalCandles: scalp5m,
    internalCandles: scalp3m,
    source,
  });
  const overlays = buildSmcOverlayLevels(result);
  const lastClose = scalp5m[scalp5m.length - 1]!.close;

  console.log("\n═══ LIVE NIFTY SMC Stage 8 ═══");
  console.log({
    source: result.source,
    stagesComplete: result.stagesComplete,
    lastClose,
    entry: result.signal.entry,
    direction: result.signal.direction,
    checklist: result.signal.checklist.map((c) => ({
      key: c.key,
      passed: c.passed,
    })),
    exitReason: result.signal.exitReason,
    trend: result.marketStructure.external.trend,
    pdZone: result.premiumDiscount?.currentZone ?? null,
    overlayCount: overlays.length,
    internalStatus: result.marketStructure.internal?.status,
  });
  console.log(
    `\nworked: lastClose=${lastClose} | entry=${result.signal.entry} | ` +
      `passes=${result.signal.checklist.filter((c) => c.passed).length}/4 | ` +
      `disclaimer="${result.signal.disclaimer}"`,
  );
  for (const c of result.signal.checklist) {
    console.log(`  [${c.passed ? "PASS" : "FAIL"}] ${c.key}: ${c.detail}`);
  }

  // assembleSmcEngineResult sanity
  const assembled = assembleSmcEngineResult({
    structureBundle: {
      underlying: result.underlying,
      mode: result.mode,
      fetchedAt: result.fetchedAt,
      source: result.source,
      degraded: result.degraded,
      degradeReasons: result.degradeReasons,
      swingPoints: result.swingPoints,
      marketStructure: result.marketStructure,
      stagesComplete: [1, 2],
    },
    orderBlocks: result.orderBlocks,
    fairValueGaps: result.fairValueGaps,
    liquidity: result.liquidity,
    premiumDiscount: result.premiumDiscount,
    supplyDemand: result.supplyDemand,
    spot: lastClose,
  });
  assert(assembled.stagesComplete.includes(8), "stagesComplete includes 8");
  assert(assembled.signal.disclaimer === SMC_DISCLAIMER, "assembled disclaimer");
}

liveNifty()
  .then(() => console.log("\ntest-smc-signal: all passed"))
  .catch((err) => {
    console.error("test-smc-signal failed:", err);
    process.exit(1);
  });
