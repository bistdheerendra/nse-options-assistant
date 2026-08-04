/**
 * SMC Stage 4 — FVG / displacement / imbalance.
 * Usage: npm run test:smc-fvg
 */
import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type OhlcvCandle,
} from "../src/lib/marketdata/angelone";
import {
  DISPLACEMENT_ATR_MULT,
  IMBALANCE_BODY_RATIO,
  detectFairValueGaps,
  detectFairValueGapsOnly,
  detectSingleCandleImbalances,
  isDisplacementCandle,
  measureGapFill,
  rollingAvgVolumeAt,
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
  vol = 1000,
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
    volume: vol,
  };
}

// ─── Bullish FVG: c1.high < c3.low ───────────────────────────────────────────
{
  const candles = [
    c(100, 101, 99, 100.5, 0), // c1 high=101
    c(100.5, 104, 100.4, 103.5, 1), // middle impulse
    c(103.5, 105, 102.5, 104.5, 2), // c3 low=102.5 > 101 → gap [101, 102.5]
  ];
  const fvgs = detectFairValueGapsOnly(candles);
  const bull = fvgs.find((g) => g.type === "bullish" && g.kind === "fvg");
  assert(!!bull, `expected bullish FVG, got ${JSON.stringify(fvgs)}`);
  assert(bull!.bottom === 101, `bottom ${bull!.bottom}`);
  assert(bull!.top === 102.5, `top ${bull!.top}`);
  assert(bull!.originIndex === 1, "origin = middle");
  console.log("bullish FVG:", {
    top: bull!.top,
    bottom: bull!.bottom,
    fillPercent: bull!.fillPercent,
  });
}

// ─── Bearish FVG: c1.low > c3.high ───────────────────────────────────────────
{
  const candles = [
    c(105, 106, 104, 104.5, 0), // c1 low=104
    c(104.5, 104.6, 101, 101.5, 1),
    c(101.5, 102.5, 100, 101, 2), // c3 high=102.5 < 104 → gap
  ];
  const fvgs = detectFairValueGapsOnly(candles);
  const bear = fvgs.find((g) => g.type === "bearish");
  assert(!!bear, `expected bearish FVG, got ${JSON.stringify(fvgs)}`);
  assert(bear!.top === 104, `top ${bear!.top}`);
  assert(bear!.bottom === 102.5, `bottom ${bear!.bottom}`);
  console.log("bearish FVG:", { top: bear!.top, bottom: bear!.bottom });
}

// ─── Fill measurement ────────────────────────────────────────────────────────
{
  const candles = [
    c(100, 101, 99, 100.5, 0),
    c(100.5, 104, 100.4, 103.5, 1),
    c(103.5, 105, 102.5, 104.5, 2),
    c(104, 104.5, 101.2, 101.5, 3), // dips to 101.2 into gap [101, 102.5]
  ];
  const fill = measureGapFill(candles, {
    type: "bullish",
    top: 102.5,
    bottom: 101,
    originIndex: 1,
  });
  // penetration = 102.5 - 101.2 = 1.3; size = 1.5 → ~0.8667
  assert(fill.fillPercent > 0.8 && fill.fillPercent < 1, `fill ${fill.fillPercent}`);
  assert(!fill.filled, "not fully filled");
  console.log("partial fill:", fill);
}

// ─── Single-candle imbalance (body≥70% + above-avg volume) ───────────────────
{
  const candles: OhlcvCandle[] = [];
  for (let i = 0; i < 25; i++) {
    candles.push(c(100, 100.5, 99.5, 100.2, i, 1000));
  }
  // Big body candle with spike volume; not a 3-candle FVG middle
  candles[22] = c(100, 105, 99.9, 104.8, 22, 5000); // body/range ≈ 4.8/5.1 ≥ 0.7
  const avg = rollingAvgVolumeAt(candles, 22, 20);
  assert(avg !== null && avg! < 5000, `avg vol ${avg}`);
  const imb = detectSingleCandleImbalances(candles, new Set());
  assert(
    imb.some((g) => g.kind === "imbalance" && g.originIndex === 22),
    `expected imbalance @22, got ${JSON.stringify(imb)}`,
  );
  assert(IMBALANCE_BODY_RATIO === 0.7, "IMBALANCE_BODY_RATIO");
  console.log("imbalance:", imb.find((g) => g.originIndex === 22));
}

// ─── FVG not duplicated as imbalance ─────────────────────────────────────────
{
  const candles = [
    c(100, 101, 99, 100.5, 0),
    c(100.5, 104, 100.4, 103.5, 1),
    c(103.5, 105, 102.5, 104.5, 2),
  ];
  const result = detectFairValueGaps({
    candles,
    timeframe: "FIVE_MINUTE",
  });
  const middles = result.gaps.filter((g) => g.originIndex === 1);
  assert(
    middles.every((g) => g.kind === "fvg"),
    "3-candle gap must be kind=fvg only, not duplicated as imbalance",
  );
  console.log("no duplicate kinds @ middle:", middles.map((g) => g.kind));
}

// ─── Displacement helper constants ───────────────────────────────────────────
{
  assert(DISPLACEMENT_ATR_MULT === 1.5, "DISPLACEMENT_ATR_MULT");
  // Short series → ATR null → not displacement
  const short = [c(100, 101, 99, 100, 0), c(100, 110, 99, 109, 1)];
  const d = isDisplacementCandle(short, 1);
  assert(!d.ok, "insufficient ATR history → not displacement");
  console.log("displacement insufficient-history ok");
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

  const result = detectFairValueGaps({
    candles: scalp5m,
    timeframe: "FIVE_MINUTE",
  });
  const fvgs = result.gaps.filter((g) => g.kind === "fvg");
  const imbs = result.gaps.filter((g) => g.kind === "imbalance");
  const unfilled = result.gaps.filter((g) => !g.filled);
  const lastClose = scalp5m[scalp5m.length - 1]!.close;

  console.log("\n═══ LIVE NIFTY SCALP 5m — FVG / Imbalance ═══");
  console.log({
    source,
    candles: scalp5m.length,
    lastClose,
    fvgCount: fvgs.length,
    imbalanceCount: imbs.length,
    unfilled: unfilled.length,
    displacementTagged: result.gaps.filter((g) => g.displacementCandle).length,
  });

  const sample = unfilled[unfilled.length - 1] ?? result.gaps[result.gaps.length - 1];
  if (sample) {
    console.log(
      `\nworked: lastClose=${lastClose} | ${sample.kind} ${sample.type} ` +
        `[${sample.bottom}–${sample.top}] fill=${(sample.fillPercent * 100).toFixed(1)}%` +
        ` disp=${sample.displacementCandle}` +
        (sample.displacementAtrMult != null
          ? ` (${sample.displacementAtrMult}×ATR)`
          : ""),
    );
  }
  console.log("signals:", result.signals);
}

liveNifty()
  .then(() => console.log("\ntest-smc-fvg: all passed"))
  .catch((err) => {
    console.error("test-smc-fvg failed:", err);
    process.exit(1);
  });
