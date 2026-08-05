/**
 * Live (or demo) SCALP synthesis + price-slope gate report.
 * Run: npx tsx scripts/report-price-slope-live.ts
 */
import { getUnderlyingCandles } from "../src/lib/marketdata/angelone";
import { runSynthesis } from "../src/lib/synthesis";
import {
  computePriceSlope,
  SLOPE_LOOKBACK_BARS,
  SLOPE_STRONG_THRESHOLD_PCT,
} from "../src/lib/synthesis/priceSlopeGate";

async function main() {
  const underlying = "NIFTY" as const;
  console.log("═══ LIVE SCALP price-slope gate report ═══\n");

  let candles: Awaited<ReturnType<typeof getUnderlyingCandles>> = [];
  try {
    candles = await getUnderlyingCandles(underlying, "FIVE_MINUTE", 5);
  } catch (e) {
    console.warn(
      "Candle fetch failed:",
      e instanceof Error ? e.message : e,
    );
  }

  const slope = computePriceSlope(candles, { timeframe: "5m" });
  console.log("5m slope (raw):");
  console.log(
    `  bars=${candles.length} lookback=${SLOPE_LOOKBACK_BARS} threshold=${SLOPE_STRONG_THRESHOLD_PCT}%`,
  );
  console.log(
    `  slopePct=${slope.slopePct.toFixed(4)}% direction=${slope.slopeDirection} strong=${slope.slopeStrong} computable=${slope.computable}`,
  );
  if (candles.length >= SLOPE_LOOKBACK_BARS + 1) {
    const last = candles[candles.length - 1]!;
    const prior = candles[candles.length - 1 - SLOPE_LOOKBACK_BARS]!;
    console.log(
      `  close[${SLOPE_LOOKBACK_BARS} ago]=${prior.close} → lastClose=${last.close}`,
    );
  }

  console.log("\nRunning SCALP synthesis…");
  const syn = await runSynthesis({
    underlying,
    mode: "SCALP",
    persist: false,
  });

  const g = syn.priceSlopeGate;
  console.log("\nPost-gate synthesis:");
  console.log(`  directional.verdict=${syn.directional.verdict}`);
  console.log(`  combinedScore=${syn.directional.combinedScore.toFixed(4)}`);
  console.log(`  structure.branch=${syn.structure.branch}`);
  console.log(`  tradePlan.sideLabel=${syn.tradePlan.sideLabel}`);
  if (g) {
    console.log(
      `  gate.applied=${g.applied} conflictReason=${g.conflictReason}`,
    );
    console.log(
      `  preGateVerdict=${g.preGateVerdict} preGateBranch=${g.preGateStructureBranch}`,
    );
    console.log(
      `  gate.slopePct=${g.slopePct.toFixed(4)}% dir=${g.slopeDirection} strong=${g.slopeStrong}`,
    );
  } else {
    console.log("  priceSlopeGate=null (unexpected on SCALP)");
  }

  if (g?.applied) {
    console.log(
      `\nWorked example: lanes said ${g.preGateVerdict}/${g.preGateStructureBranch} ` +
        `but tape ${g.slopeDirection} ${g.slopePct.toFixed(2)}% / ${g.lookbackBars}×${g.timeframe} ` +
        `→ post-gate ${syn.directional.verdict}/${syn.structure.branch} (${g.conflictReason})`,
    );
  } else {
    console.log(
      "\nGate did not fire on this live snapshot (no strong opposing slope, or lanes already NEUTRAL).",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
