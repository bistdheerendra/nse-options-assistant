/**
 * Live (or demo) SnapQuote Δqty histogram + current-gate fire rate.
 * Usage: npx tsx scripts/report-large-order-live.ts [seconds]
 */
import { readFileSync } from "fs";
import { resolve } from "path";

try {
  const envPath = resolve(process.cwd(), ".env");
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]!.trim();
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  console.warn("No .env loaded");
}

import { isDemoMarketDataMode } from "../src/lib/marketdata/angelone/auth";
import { resolveAtmOptionTokens } from "../src/lib/marketdata/angelone/optionTokens";
import {
  angelWebsocketFeed,
  EXCHANGE_NSE_FO,
} from "../src/lib/marketdata/angelone/websocketFeed";
import {
  LARGE_ORDER_ABS_MIN,
  LARGE_ORDER_MULT,
  LARGE_ORDER_UNDERLYING_COOLDOWN_SEC,
  clearLargeOrderStore,
  ingestSnapQuoteBook,
  takeUnderlyingRateLimited,
} from "../src/lib/marketdata/largeOrder";

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function summarize(label: string, xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    label,
    n: s.length,
    p50: percentile(s, 50),
    p80: percentile(s, 80),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
  };
}

const seconds = Math.max(15, Number(process.argv[2] ?? 45));

async function main() {
  console.log("═══ LIVE large-order Δqty report ═══");
  console.log(`window=${seconds}s  gates MULT=${LARGE_ORDER_MULT} ABS_MIN=${LARGE_ORDER_ABS_MIN}`);
  console.log(`demo=${isDemoMarketDataMode()}`);

  if (isDemoMarketDataMode()) {
    console.log("No Angel credentials — cannot sample live books.");
    process.exit(0);
  }

  const set = await resolveAtmOptionTokens("NIFTY", { band: 10 });
  console.log(`tokens=${set.rows.length} spot=${set.spot} expiry=${set.expiry}`);

  const lastQty = new Map<string, number>();
  const lastLtp = new Map<string, number>();
  const lastOi = new Map<string, number>();
  const seededTokens = new Set<string>();
  const posDelta: number[] = [];
  const newPriceQty: number[] = [];
  const existingDelta: number[] = [];
  let ticks = 0;
  let ticksWithBook = 0;
  let bookOnlyNoLtpChange = 0;
  let ltpChanged = 0;
  let oiChanged = 0;
  let wouldFireCurrent = 0;
  let wouldFireNewPrice = 0;
  let wouldFireExisting = 0;
  let ingestFires = 0;
  let rateLimitedEmits = 0;
  const combo = {
    abs250_m3: 0,
    abs2500_m3: 0,
    abs4500_m3: 0,
    abs5000_m3: 0,
    abs7500_m3: 0,
    abs5000_m5: 0,
    abs7500_m5: 0,
  };

  clearLargeOrderStore();
  const release = angelWebsocketFeed.acquire();

  await new Promise<void>((resolveWait, reject) => {
    const t = setTimeout(() => reject(new Error("WS not live after 20s")), 20_000);
    const off = angelWebsocketFeed.onStatus((s) => {
      if (s === "live") {
        clearTimeout(t);
        off();
        resolveWait();
      }
      if (s === "error" || s === "demo") {
        console.warn("ws status", s);
      }
    });
    if (angelWebsocketFeed.getStatus() === "live") {
      clearTimeout(t);
      off();
      resolveWait();
    }
  }).catch((err) => {
    console.error(String(err));
    console.log("status", angelWebsocketFeed.getStatus());
  });

  console.log("ws", angelWebsocketFeed.getStatus());
  angelWebsocketFeed.setOptionSubscriptions([
    { exchangeType: EXCHANGE_NSE_FO, tokens: set.rows.map((r) => r.token) },
  ]);

  const unsub = angelWebsocketFeed.onOptionTick((tick) => {
    ticks += 1;
    const prevLtp = lastLtp.get(tick.token);
    if (prevLtp != null && prevLtp === tick.ltp) bookOnlyNoLtpChange += 1;
    else if (prevLtp != null) ltpChanged += 1;
    lastLtp.set(tick.token, tick.ltp);
    if (tick.oi != null) {
      const prevOi = lastOi.get(tick.token);
      if (prevOi != null && prevOi !== tick.oi) oiChanged += 1;
      lastOi.set(tick.token, tick.oi);
    }

    if (!tick.book) return;
    ticksWithBook += 1;

    if (!seededTokens.has(tick.token)) {
      const seed = (side: "bid" | "ask") => {
        for (const lv of side === "bid" ? tick.book!.bids : tick.book!.asks) {
          lastQty.set(`${tick.token}:${side}:${lv.price.toFixed(2)}`, lv.qty);
        }
      };
      seed("bid");
      seed("ask");
      seededTokens.add(tick.token);
      ingestSnapQuoteBook(tick.token, tick.book, tick.receivedAt);
      return;
    }

    const events = ingestSnapQuoteBook(tick.token, tick.book, tick.receivedAt);
    ingestFires += events.length;
    rateLimitedEmits += takeUnderlyingRateLimited(
      "NIFTY",
      events,
      tick.receivedAt,
    ).length;

    const walk = (side: "bid" | "ask") => {
      for (const lv of side === "bid" ? tick.book!.bids : tick.book!.asks) {
        const key = `${tick.token}:${side}:${lv.price.toFixed(2)}`;
        const prev = lastQty.get(key);
        lastQty.set(key, lv.qty);
        if (prev == null) {
          newPriceQty.push(lv.qty);
          if (lv.qty >= LARGE_ORDER_ABS_MIN) {
            wouldFireCurrent += 1;
            wouldFireNewPrice += 1;
          }
          continue;
        }
        const d = lv.qty - prev;
        if (d <= 0) continue;
        posDelta.push(d);
        existingDelta.push(d);
        const ge = (abs: number, mult: number) => d >= abs && d >= mult * prev;
        if (ge(250, 3)) combo.abs250_m3 += 1;
        if (ge(2500, 3)) combo.abs2500_m3 += 1;
        if (ge(4500, 3)) combo.abs4500_m3 += 1;
        if (ge(5000, 3)) combo.abs5000_m3 += 1;
        if (ge(7500, 3)) combo.abs7500_m3 += 1;
        if (ge(5000, 5)) combo.abs5000_m5 += 1;
        if (ge(7500, 5)) combo.abs7500_m5 += 1;
        if (d >= LARGE_ORDER_ABS_MIN && d >= LARGE_ORDER_MULT * prev) {
          wouldFireCurrent += 1;
          wouldFireExisting += 1;
        }
      }
    };
    walk("bid");
    walk("ask");
  });

  await new Promise((r) => setTimeout(r, seconds * 1000));
  unsub();
  angelWebsocketFeed.setOptionSubscriptions([]);
  release();

  const frac = (n: number, d: number) =>
    d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;

  console.log("\n── tick mix ──");
  console.log({
    ticks,
    ticksWithBook,
    bookOnlyNoLtpChange,
    ltpChanged,
    oiChanged,
    bookOnlyShare: frac(bookOnlyNoLtpChange, ticks),
  });

  console.log("\n── Δqty (existing price, positive only) ──");
  console.log(summarize("existing+Δ", existingDelta));
  console.log("\n── qty at NEW price (first seen / re-entry) ──");
  console.log(summarize("newPriceQty", newPriceQty));

  const existing = [...existingDelta].sort((a, b) => a - b);
  const cross = (absMin: number, mult: number) => {
    let n = 0;
    for (const d of existingDelta) {
      // crude: compare Δ to absMin only for this table; relative uses prev≈unknown
      if (d >= absMin) n += 1;
    }
    return { absMin, n, shareOfPosDelta: frac(n, existingDelta.length) };
  };

  console.log("\n── existing Δ AND 3×/5× prev (new prices excluded) ──");
  console.log(combo);
  const perMin = (n: number) => (n / seconds) * 60;
  console.log({
    abs250_m3_perMin: perMin(combo.abs250_m3),
    abs4500_m3_perMin: perMin(combo.abs4500_m3),
    abs5000_m3_perMin: perMin(combo.abs5000_m3),
    abs7500_m3_perMin: perMin(combo.abs7500_m3),
    abs5000_m5_perMin: perMin(combo.abs5000_m5),
    abs7500_m5_perMin: perMin(combo.abs7500_m5),
  });
  console.log({
    ingestFires,
    firesPerMin: (ingestFires / seconds) * 60,
    rateLimitedEmits,
    rateLimitedPerMin: (rateLimitedEmits / seconds) * 60,
    underlyingCooldownSec: LARGE_ORDER_UNDERLYING_COOLDOWN_SEC,
    naiveNewPriceGeAbsMin: wouldFireNewPrice,
    naiveExistingGeAbsAnd3xPrev: wouldFireExisting,
    naiveTotal: wouldFireCurrent,
  });

  console.log("\n── existing +Δqty ≥ absMin (ignores MULT; lower bound of noise) ──");
  for (const abs of [250, 500, 1000, 2000, 5000, 10000]) {
    console.log(cross(abs, LARGE_ORDER_MULT));
  }

  const p95 = percentile(existing, 95);
  const p99 = percentile(existing, 99);
  console.log("\n── suggested abs floor from this window ──");
  console.log({
    existingP95: p95,
    existingP99: p99,
    newPriceP50: percentile([...newPriceQty].sort((a, b) => a - b), 50),
    newPriceP90: percentile([...newPriceQty].sort((a, b) => a - b), 90),
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
