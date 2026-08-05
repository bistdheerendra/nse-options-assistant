/**
 * Extended 1h slope percentiles across lookback windows.
 * Run: npx tsx scripts/tune-swing-slope-extended.ts
 */
import {
  getUnderlyingCandles,
  type Underlying,
} from "../src/lib/marketdata/angelone";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];
const LB = 15;

function pctile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  ]!;
}

async function analyze(days: number) {
  console.log(`\n=== lookbackDays=${days}  slopeLookback=${LB} ===`);
  const all: number[] = [];
  for (const u of UNDERLYINGS) {
    try {
      const c = await getUnderlyingCandles(u, "ONE_HOUR", days);
      const closes = c.map((x) => x.close);
      const abs: number[] = [];
      for (let i = LB; i < closes.length; i++) {
        const prior = closes[i - LB]!;
        const last = closes[i]!;
        if (!prior) continue;
        abs.push(Math.abs(((last - prior) / prior) * 100));
      }
      abs.sort((a, b) => a - b);
      const max = abs.length ? abs[abs.length - 1]! : 0;
      const mean = abs.length ? abs.reduce((s, x) => s + x, 0) / abs.length : 0;
      console.log(
        `${u}: bars=${c.length} wins=${abs.length} max=${max.toFixed(3)}% mean=${mean.toFixed(3)}% ` +
          `p50=${pctile(abs, 50).toFixed(3)} p80=${pctile(abs, 80).toFixed(3)} ` +
          `p90=${pctile(abs, 90).toFixed(3)} p95=${pctile(abs, 95).toFixed(3)} p99=${pctile(abs, 99).toFixed(3)}`,
      );
      if (c.length) {
        console.log(`  first=${c[0]!.time} last=${c[c.length - 1]!.time}`);
      }
      all.push(...abs);
    } catch (e) {
      console.warn(u, e instanceof Error ? e.message : e);
    }
  }
  all.sort((a, b) => a - b);
  if (!all.length) return;
  const fire = (thr: number) =>
    ((all.filter((x) => x >= thr).length / all.length) * 100).toFixed(1);
  console.log(
    `COMBINED n=${all.length} p80=${pctile(all, 80).toFixed(3)} p90=${pctile(all, 90).toFixed(3)} ` +
      `p95=${pctile(all, 95).toFixed(3)} p99=${pctile(all, 99).toFixed(3)} max=${pctile(all, 100).toFixed(3)}`,
  );
  console.log(
    `fire rates: 0.15=${fire(0.15)}% 0.25=${fire(0.25)}% 0.35=${fire(0.35)}% ` +
      `0.50=${fire(0.5)}% 0.75=${fire(0.75)}% 1.0=${fire(1)}%`,
  );
}

async function main() {
  for (const d of [60, 120, 200]) {
    await analyze(d);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
