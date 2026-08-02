/**
 * Rate-aware scalp candle poller — fetches 1m/3m/5m/15m for NIFTY/BANKNIFTY/SENSEX
 * with inter-request gaps, upserts into MarketCandle (idempotent).
 *
 * Usage: npx tsx scripts/poll-scalp-candles.ts
 */
import { pollScalpCandles } from "../src/lib/marketdata/scalp/multiTimeframeCandles";

async function main() {
  console.log("[poll-scalp-candles] starting…");
  const results = await pollScalpCandles();
  for (const r of results) {
    console.log(
      `  ${r.underlying}: written=${r.written} degraded=${r.degraded}` +
        (r.degradeReasons.length
          ? `\n    reasons: ${r.degradeReasons.join("; ")}`
          : ""),
    );
  }
  console.log("[poll-scalp-candles] done");
}

main().catch((err) => {
  console.error("[poll-scalp-candles] failed:", err);
  process.exit(1);
});
