/**
 * Empirical 1h slope distribution for SWING gate tuning.
 * Run: npx tsx scripts/tune-swing-slope-threshold.ts
 */
import {
  getUnderlyingCandles,
  type Underlying,
} from "../src/lib/marketdata/angelone";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];
const LOOKBACKS = [10, 12, 15, 20] as const;

function pctile(sortedAbs: number[], p: number): number {
  if (sortedAbs.length === 0) return NaN;
  const i = Math.min(
    sortedAbs.length - 1,
    Math.max(0, Math.floor((p / 100) * (sortedAbs.length - 1))),
  );
  return sortedAbs[i]!;
}

function slopesForLookback(
  closes: number[],
  lookback: number,
): number[] {
  const out: number[] = [];
  for (let i = lookback; i < closes.length; i++) {
    const prior = closes[i - lookback]!;
    const last = closes[i]!;
    if (!prior || !Number.isFinite(prior) || prior === 0) continue;
    out.push(((last - prior) / prior) * 100);
  }
  return out;
}

async function main() {
  console.log("═══ SWING 1h slope distribution (for threshold tuning) ═══\n");

  const byLb: Record<
    number,
    { all: number[]; per: Record<string, number[]> }
  > = {};
  for (const lb of LOOKBACKS) {
    byLb[lb] = { all: [], per: {} };
  }

  for (const u of UNDERLYINGS) {
    let candles: Awaited<ReturnType<typeof getUnderlyingCandles>> = [];
    try {
      // ~60 trading days of 1h ≈ enough for distribution
      candles = await getUnderlyingCandles(u, "ONE_HOUR", 60);
    } catch (e) {
      console.warn(u, "fetch failed:", e instanceof Error ? e.message : e);
      continue;
    }
    const closes = candles.map((c) => c.close);
    console.log(`${u}: ${candles.length} × 1h bars`);
    if (candles.length > 1) {
      const first = candles[0]!;
      const last = candles[candles.length - 1]!;
      console.log(`  range ${first.time} → ${last.time}`);
    }

    for (const lb of LOOKBACKS) {
      const slopes = slopesForLookback(closes, lb);
      byLb[lb]!.per[u] = slopes;
      byLb[lb]!.all.push(...slopes);
    }
  }

  console.log("\n|lookback| n | median|abs| | p70 | p80 | p85 | p90 | p95 | mean|abs| |");
  console.log("|-------:|--:|----------:|----:|----:|----:|----:|----:|---------:|");
  for (const lb of LOOKBACKS) {
    const abs = byLb[lb]!.all.map(Math.abs).sort((a, b) => a - b);
    if (!abs.length) continue;
    const mean = abs.reduce((s, x) => s + x, 0) / abs.length;
    console.log(
      `| ${lb} | ${abs.length} | ${pctile(abs, 50).toFixed(3)} | ${pctile(abs, 70).toFixed(3)} | ${pctile(abs, 80).toFixed(3)} | ${pctile(abs, 85).toFixed(3)} | ${pctile(abs, 90).toFixed(3)} | ${pctile(abs, 95).toFixed(3)} | ${mean.toFixed(3)} |`,
    );
  }

  console.log("\nPer-underlying p85 |abs slope| @ lookback=15:");
  for (const u of UNDERLYINGS) {
    const s = byLb[15]?.per[u];
    if (!s?.length) continue;
    const abs = s.map(Math.abs).sort((a, b) => a - b);
    console.log(
      `  ${u}: n=${abs.length} p50=${pctile(abs, 50).toFixed(3)}% p85=${pctile(abs, 85).toFixed(3)}% p90=${pctile(abs, 90).toFixed(3)}%`,
    );
  }

  // Also: fraction that would fire if threshold = SCALP 0.15% (too sensitive)
  const lb15 = byLb[15]?.all.map(Math.abs) ?? [];
  if (lb15.length) {
    const fire015 = lb15.filter((x) => x >= 0.15).length / lb15.length;
    const fire05 = lb15.filter((x) => x >= 0.5).length / lb15.length;
    const fire08 = lb15.filter((x) => x >= 0.8).length / lb15.length;
    const fire10 = lb15.filter((x) => x >= 1.0).length / lb15.length;
    const fire12 = lb15.filter((x) => x >= 1.2).length / lb15.length;
    console.log("\nFire rate @ lookback=15 (share of windows with |slope| ≥ thr):");
    console.log(`  0.15% (SCALP): ${(fire015 * 100).toFixed(1)}%  ← noise`);
    console.log(`  0.50%: ${(fire05 * 100).toFixed(1)}%`);
    console.log(`  0.80%: ${(fire08 * 100).toFixed(1)}%`);
    console.log(`  1.00%: ${(fire10 * 100).toFixed(1)}%`);
    console.log(`  1.20%: ${(fire12 * 100).toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
