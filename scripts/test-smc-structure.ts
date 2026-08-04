/**
 * SMC Stages 1–2 — swing points + market structure.
 * Usage: npm run test:smc-structure
 *
 * 1) Synthetic fixtures (assert BOS/CHoCH/trend/deferred)
 * 2) Live NIFTY 5m + 1h candles (Angel → labeled demo/db_cache if needed)
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  analyzeMarketStructure,
  analyzeSmcStructure,
  buildSmcStructureInput,
  classifySmcTrend,
  detectSmcSwingPoints,
  SWING_LOOKBACK,
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

// ─── Synthetic: fractal lookback=2 ───────────────────────────────────────────
{
  // Build a clear V-bottom then rally so swing low/high are unambiguous.
  // Indices: need lookback=2 → pivots at least 2 bars from edges.
  const candles: OhlcvCandle[] = [
    c(100, 101, 99.5, 100.5, 0),
    c(100.5, 101.2, 100, 100.8, 1),
    c(100.8, 102, 100.5, 101.5, 2), // local high candidate
    c(101.5, 101.8, 100.2, 100.5, 3),
    c(100.5, 100.8, 98, 98.5, 4), // swing low (low=98, neighbors higher)
    c(98.5, 99.5, 98.2, 99, 5),
    c(99, 101, 98.8, 100.5, 6),
    c(100.5, 103, 100, 102.5, 7), // swing high
    c(102.5, 102.8, 101, 101.5, 8),
    c(101.5, 102, 100.5, 101, 9),
    c(101, 104, 100.8, 103.5, 10), // higher high break zone
    c(103.5, 105, 103, 104.5, 11),
    c(104.5, 105.2, 103.5, 104, 12),
  ];

  const sw = detectSmcSwingPoints(candles, "FIVE_MINUTE", SWING_LOOKBACK);
  assert(sw.lookback === 2, `lookback expected 2, got ${sw.lookback}`);
  assert(sw.swings.length >= 2, `expected ≥2 swings, got ${sw.swings.length}`);

  const lows = sw.swings.filter((s) => s.type === "low");
  const highs = sw.swings.filter((s) => s.type === "high");
  assert(lows.length >= 1, "expected ≥1 swing low");
  assert(highs.length >= 1, "expected ≥1 swing high");

  console.log("synthetic swings:", {
    count: sw.swings.length,
    highs: highs.map((s) => ({ i: s.index, p: s.price })),
    lows: lows.map((s) => ({ i: s.index, p: s.price })),
  });
}

// ─── Synthetic: HH+HL → bullish; BOS on close above last high ────────────────
{
  // Construct explicit swing highs/lows chronologically, then candles that BOS.
  const swings: SwingPoint[] = [
    {
      index: 2,
      time: "t2",
      price: 100,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 5,
      time: "t5",
      price: 110,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 8,
      time: "t8",
      price: 104,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 11,
      time: "t11",
      price: 115,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
  ];
  assert(classifySmcTrend(
    swings.filter((s) => s.type === "high"),
    swings.filter((s) => s.type === "low"),
  ) === "bullish", "expected bullish HH+HL");

  // Candles: length > last swing + lookback; bar 14 closes above 115 → BOS
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 16; i++) {
    const base = 100 + i * 0.5;
    candles.push(c(base, base + 1, base - 1, base, i));
  }
  // Force close beyond last swing high after confirmation lag (lookback=2 → after idx 13)
  candles[14] = c(114, 118, 113.5, 117, 14); // close 117 > 115

  const ms = analyzeMarketStructure({
    candles,
    swings,
    timeframe: "FIVE_MINUTE",
    structureLevel: "external",
    lookback: 2,
  });
  assert(ms.trend === "bullish", `expected bullish trend, got ${ms.trend}`);
  const bos = ms.events.filter((e) => e.type === "BOS" && e.direction === "bullish");
  assert(bos.length >= 1, `expected ≥1 bullish BOS, got ${JSON.stringify(ms.events)}`);
  console.log("synthetic BOS:", bos[bos.length - 1]);
}

// ─── Synthetic: LH+LL → bearish; CHoCH on close above last high ──────────────
{
  const swings: SwingPoint[] = [
    {
      index: 2,
      time: "t2",
      price: 120,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 5,
      time: "t5",
      price: 110,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 8,
      time: "t8",
      price: 116,
      type: "high",
      timeframe: "FIVE_MINUTE",
    },
    {
      index: 11,
      time: "t11",
      price: 105,
      type: "low",
      timeframe: "FIVE_MINUTE",
    },
  ];
  assert(
    classifySmcTrend(
      swings.filter((s) => s.type === "high"),
      swings.filter((s) => s.type === "low"),
    ) === "bearish",
    "expected bearish LH+LL",
  );

  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 16; i++) {
    const base = 120 - i * 0.8;
    candles.push(c(base, base + 1, base - 1, base, i));
  }
  // Against bearish trend: close above last swing high 116 → CHoCH bullish
  candles[14] = c(114, 119, 113, 118, 14);

  const ms = analyzeMarketStructure({
    candles,
    swings,
    timeframe: "FIVE_MINUTE",
    structureLevel: "external",
    lookback: 2,
  });
  const choch = ms.events.filter(
    (e) => e.type === "CHoCH" && e.direction === "bullish",
  );
  assert(
    choch.length >= 1,
    `expected ≥1 bullish CHoCH, got ${JSON.stringify(ms.events)}`,
  );
  console.log("synthetic CHoCH:", choch[choch.length - 1]);
}

// ─── Synthetic: Swing mode internal deferred (option a) ──────────────────────
{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 30; i++) {
    candles.push(c(100 + i, 101 + i, 99 + i, 100.5 + i, i));
  }
  const bundle = analyzeSmcStructure(
    buildSmcStructureInput({
      underlying: "NIFTY",
      mode: "SWING",
      externalCandles: candles,
      // Even if caller passes internal, Swing must ignore / defer.
      internalCandles: candles,
      source: "demo",
    }),
  );
  assert(
    bundle.marketStructure.internal?.status === "deferred",
    `expected deferred, got ${bundle.marketStructure.internal?.status}`,
  );
  assert(
    bundle.swingPoints.internal === null,
    "Swing must not populate internal swings (option a)",
  );
  assert(bundle.stagesComplete.includes(1) && bundle.stagesComplete.includes(2), "stages");
  console.log("swing deferred ok:", bundle.marketStructure.internal?.statusNote);
}

console.log("synthetic fixtures: all passed\n");

// ─── Live NIFTY ──────────────────────────────────────────────────────────────
async function liveNifty(): Promise<void> {
  const source = isDemoMarketDataMode() ? "demo" : "angel";
  console.log(`live NIFTY fetch (source hint: ${source})…`);

  let scalp5m: OhlcvCandle[] = [];
  let scalp3m: OhlcvCandle[] = [];
  let swing1h: OhlcvCandle[] = [];
  let liveSource: "angel" | "demo" | "unavailable" = source;

  try {
    scalp5m = await getUnderlyingCandles("NIFTY", "FIVE_MINUTE", 5);
    scalp3m = await getUnderlyingCandles("NIFTY", "THREE_MINUTE", 5);
    swing1h = await getUnderlyingCandles("NIFTY", "ONE_HOUR", 60);
  } catch (err) {
    liveSource = "unavailable";
    console.warn("live fetch failed:", err instanceof Error ? err.message : err);
  }

  if (scalp5m.length === 0 && swing1h.length === 0) {
    console.warn(
      "no live candles — skipping live worked example (credentials/demo/market closed).",
    );
    return;
  }

  if (scalp5m.length > 0) {
    const scalp = analyzeSmcStructure(
      buildSmcStructureInput({
        underlying: "NIFTY",
        mode: "SCALP",
        externalCandles: scalp5m,
        internalCandles: scalp3m.length > 0 ? scalp3m : null,
        source: liveSource,
      }),
    );
    const ext = scalp.marketStructure.external;
    const sw = scalp.swingPoints.external;
    const lastH = [...sw.swings].reverse().find((s) => s.type === "high");
    const lastL = [...sw.swings].reverse().find((s) => s.type === "low");
    const lastClose = scalp5m[scalp5m.length - 1]!.close;

    console.log("\n═══ LIVE NIFTY SCALP (5m external / 3m internal) ═══");
    console.log({
      source: scalp.source,
      degraded: scalp.degraded,
      candles5m: scalp5m.length,
      candles3m: scalp3m.length,
      lastClose,
      swingHighs: sw.swings.filter((s) => s.type === "high").length,
      swingLows: sw.swings.filter((s) => s.type === "low").length,
      lastSwingHigh: lastH ? { price: lastH.price, time: lastH.time } : null,
      lastSwingLow: lastL ? { price: lastL.price, time: lastL.time } : null,
      trend: ext.trend,
      bosCount: ext.events.filter((e) => e.type === "BOS").length,
      chochCount: ext.events.filter((e) => e.type === "CHoCH").length,
      lastEvent: ext.lastEvent
        ? {
            type: ext.lastEvent.type,
            direction: ext.lastEvent.direction,
            price: ext.lastEvent.price,
            broke: `${ext.lastEvent.brokenSwing.type}@${ext.lastEvent.brokenSwing.price}`,
          }
        : null,
      internalStatus: scalp.marketStructure.internal?.status,
      internalTrend: scalp.marketStructure.internal?.trend,
      signals: ext.signals,
    });

    // Worked numeric before/after style
    if (lastH && lastL) {
      console.log(
        `\nworked (SCALP 5m): lastClose=${lastClose} | lastSwingHigh=${lastH.price} | lastSwingLow=${lastL.price} | trend=${ext.trend}`,
      );
      if (ext.lastEvent) {
        const e = ext.lastEvent;
        console.log(
          `  event: ${e.type} ${e.direction} close=${e.price} broke ${e.brokenSwing.type} ${e.brokenSwing.price} (Δ vs swing=${(e.price - e.brokenSwing.price).toFixed(2)})`,
        );
      }
    }
  }

  if (swing1h.length > 0) {
    const swing = analyzeSmcStructure(
      buildSmcStructureInput({
        underlying: "NIFTY",
        mode: "SWING",
        externalCandles: swing1h,
        source: liveSource,
      }),
    );
    const ext = swing.marketStructure.external;
    const sw = swing.swingPoints.external;
    const lastClose = swing1h[swing1h.length - 1]!.close;
    console.log("\n═══ LIVE NIFTY SWING (1h external only) ═══");
    console.log({
      source: swing.source,
      candles1h: swing1h.length,
      lastClose,
      swingCount: sw.swings.length,
      trend: ext.trend,
      bosCount: ext.events.filter((e) => e.type === "BOS").length,
      chochCount: ext.events.filter((e) => e.type === "CHoCH").length,
      lastEvent: ext.lastEvent
        ? {
            type: ext.lastEvent.type,
            direction: ext.lastEvent.direction,
            price: ext.lastEvent.price,
          }
        : null,
      internalStatus: swing.marketStructure.internal?.status,
      internalNote: swing.marketStructure.internal?.statusNote,
    });
    console.log(
      `\nworked (SWING 1h): lastClose=${lastClose} | trend=${ext.trend} | internal=${swing.marketStructure.internal?.status}`,
    );
  }
}

liveNifty()
  .then(() => {
    console.log("\ntest-smc-structure: all passed");
  })
  .catch((err) => {
    console.error("test-smc-structure failed:", err);
    process.exit(1);
  });
