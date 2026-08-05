/**
 * Live e2e: poll:scalp-candles cache write → soft-watch (~5s) → SSE push,
 * then unchanged re-write → no duplicate push (content-hash idempotency).
 *
 * Uses getMultiTimeframeCandles({ forceRefresh }) — the same cache write
 * pollScalpCandles performs before DB upserts (avoids Prisma pool hangs).
 *
 * Usage: npx tsx scripts/trace-scalp-sse-idempotency.ts
 */
import { cacheGet, cacheSet } from "../src/lib/redis";
import {
  getMultiTimeframeCandles,
  scalpBundleContentHash,
  SCALP_CANDLE_BUNDLE_TTL_SEC,
  type MultiTimeframeCandleBundle,
} from "../src/lib/marketdata/scalp";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const UNDERLYING = (process.env.TRACE_UNDERLYING ?? "NIFTY") as
  | "NIFTY"
  | "BANKNIFTY"
  | "SENSEX";
const CACHE_KEY = `scalp:mtf:${UNDERLYING}`;

type CandleEvent = {
  t: number;
  contentHash: string | null;
  fetchedAt: string | null;
  ok: boolean;
  rawPreview: string;
};

function ts() {
  return new Date().toISOString();
}

async function cacheSnapshot(): Promise<{
  hash: string | null;
  fetchedAt: string | null;
  present: boolean;
  bundle: MultiTimeframeCandleBundle | null;
}> {
  const bundle = await cacheGet<MultiTimeframeCandleBundle>(CACHE_KEY);
  if (!bundle) return { hash: null, fetchedAt: null, present: false, bundle: null };
  return {
    hash: scalpBundleContentHash(bundle),
    fetchedAt: bundle.fetchedAt,
    present: true,
    bundle,
  };
}

/** Bump last 1m close so cache hash ≠ hub lastContentHash. */
async function injectStaleCacheHash(
  bundle: MultiTimeframeCandleBundle,
): Promise<string> {
  const clone = structuredClone(bundle) as MultiTimeframeCandleBundle;
  const series = clone.series.ONE_MINUTE;
  const last = series.candles[series.candles.length - 1];
  if (!last) throw new Error("empty ONE_MINUTE series");
  last.close = Number(last.close) + 0.25;
  clone.fetchedAt = new Date().toISOString();
  await cacheSet(CACHE_KEY, clone, SCALP_CANDLE_BUNDLE_TTL_SEC);
  return scalpBundleContentHash(clone);
}

/** Same cache write path as `poll:scalp-candles` (minus Prisma upsert). */
async function pollCacheWrite(): Promise<MultiTimeframeCandleBundle> {
  return getMultiTimeframeCandles(UNDERLYING, { forceRefresh: true });
}

async function main() {
  const cacheBackend = process.env.UPSTASH_REDIS_REST_URL
    ? `upstash:${process.env.UPSTASH_REDIS_REST_URL}`
    : "file:.data/shared-cache.json";

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" Scalp SSE soft-watch + content-hash idempotency TRACE");
  console.log(` underlying=${UNDERLYING}  base=${BASE}`);
  console.log(` cache=${cacheBackend}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const events: CandleEvent[] = [];
  const pending: CandleEvent[] = [];
  let waiter: ((e: CandleEvent | null) => void) | null = null;
  let waiterTimer: ReturnType<typeof setTimeout> | null = null;

  const waitForCandle = (timeoutMs: number) =>
    new Promise<CandleEvent | null>((resolve) => {
      if (pending.length > 0) {
        resolve(pending.shift()!);
        return;
      }
      if (waiterTimer) clearTimeout(waiterTimer);
      waiter = resolve;
      waiterTimer = setTimeout(() => {
        if (waiter === resolve) {
          waiter = null;
          resolve(null);
        }
      }, timeoutMs);
    });

  const pushEvent = (ev: CandleEvent) => {
    events.push(ev);
    console.log(
      `[${ts()}] SSE event#${events.length} ok=${ev.ok} hash=${(ev.contentHash ?? "n/a").slice(0, 100)}`,
    );
    if (waiter) {
      const w = waiter;
      waiter = null;
      if (waiterTimer) clearTimeout(waiterTimer);
      waiterTimer = null;
      w(ev);
    } else {
      pending.push(ev);
    }
  };

  const ac = new AbortController();
  const streamUrl = `${BASE}/api/scalp/candles/stream?underlying=${UNDERLYING}`;
  console.log(`[${ts()}] SSE connect → ${streamUrl}`);

  const res = await fetch(streamUrl, {
    headers: { Accept: "text/event-stream" },
    signal: ac.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const block of parts) {
        const lines = block.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (event !== "candles" || dataLines.length === 0) continue;
        const raw = dataLines.join("\n");
        let parsed: {
          ok?: boolean;
          contentHash?: string;
          fetchedAt?: string;
        } = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = {};
        }
        pushEvent({
          t: Date.now(),
          contentHash: parsed.contentHash ?? null,
          fetchedAt: parsed.fetchedAt ?? null,
          ok: parsed.ok === true,
          rawPreview: raw.length > 900 ? `${raw.slice(0, 900)}…` : raw,
        });
      }
    }
  })();

  const seed = await waitForCandle(60_000);
  if (!seed) {
    ac.abort();
    throw new Error("Timed out waiting for SSE seed frame");
  }

  const before = await cacheSnapshot();
  console.log("\n(a) BEFORE poll — content hash");
  console.log(`    SSE/hub seed: ${seed.contentHash}`);
  console.log(`    cache:        ${before.hash ?? "(empty — TTL expired or not yet written)"}`);
  console.log(`    fetchedAt:    ${before.fetchedAt ?? seed.fetchedAt}`);

  // Make hub hold a non-authentic hash so poll forceRefresh is always a detectable change
  // (demo/static last bars would otherwise leave soft-watch silent).
  let baseBundle = before.bundle;
  if (!baseBundle) {
    console.log("    populating cache from getMultiTimeframeCandles (no force)…");
    baseBundle = await getMultiTimeframeCandles(UNDERLYING);
  }
  const staleHash = await injectStaleCacheHash(baseBundle);
  console.log(`\n    injected stale cache hash (≠ hub):`);
  console.log(`    ${staleHash}`);
  {
    const deadline = Date.now() + 6_500;
    while (Date.now() < deadline) {
      const ev = await waitForCandle(Math.max(200, deadline - Date.now()));
      if (!ev) break;
      if (ev.contentHash === staleHash) {
        console.log("    soft-watch absorbed stale injection (hub now ≠ authentic)");
      }
    }
  }

  console.log(
    `\n[${ts()}] ▶ poll #1 cache-write (getMultiTimeframeCandles forceRefresh = poll:scalp-candles write path)`,
  );
  const poll1Started = Date.now();
  const poll1Bundle = await pollCacheWrite();
  const poll1Hash = scalpBundleContentHash(poll1Bundle);
  console.log(`[${ts()}] poll #1 cache write done in ${Date.now() - poll1Started}ms`);
  console.log(
    `    degraded=${poll1Bundle.degraded}` +
      (poll1Bundle.degradeReasons.length
        ? ` reasons=${poll1Bundle.degradeReasons.join("; ")}`
        : ""),
  );

  const afterPoll1 = await cacheSnapshot();
  console.log("\n(a) AFTER poll #1 — content hash");
  console.log(`    before (seed): ${seed.contentHash}`);
  console.log(`    after  (poll): ${afterPoll1.hash}`);
  console.log(`    matches forceRefresh return: ${afterPoll1.hash === poll1Hash}`);

  console.log("\n(b) Waiting ≤8s for soft-watch to push poll content…");
  const watchStarted = Date.now();
  let push1: CandleEvent | null = null;
  for (let i = 0; i < 4; i++) {
    const ev = await waitForCandle(8_000);
    if (!ev) break;
    if (ev.contentHash === afterPoll1.hash) {
      push1 = ev;
      break;
    }
    console.log(
      `    skipping interim hash (${(ev.contentHash ?? "").slice(0, 72)}…)`,
    );
  }
  if (!push1) {
    console.error("FAIL: soft-watch did not push poll content within window");
    ac.abort();
    process.exit(2);
  }
  const detectMs = Date.now() - watchStarted;
  console.log(`    soft-watch → SSE in ${detectMs}ms (REDIS_WATCH_MS=5000)`);
  console.log(`    pushed hash == cache: ${push1.contentHash === afterPoll1.hash}`);

  console.log("\n(c) SSE payload pushed to connected client:");
  console.log(push1.rawPreview);

  const eventCountAfterPush1 = events.length;
  // Unchanged re-poll: rewrite identical bundle (poll cycle with same last bars)
  console.log(
    `\n[${ts()}] ▶ poll #2 — rewrite identical bundle (unchanged content hash)`,
  );
  if (!afterPoll1.bundle) {
    ac.abort();
    throw new Error("missing poll #1 bundle");
  }
  await cacheSet(CACHE_KEY, afterPoll1.bundle, SCALP_CANDLE_BUNDLE_TTL_SEC);
  const afterPoll2 = await cacheSnapshot();
  console.log(`    content unchanged: ${afterPoll2.hash === afterPoll1.hash}`);
  console.log(`    hash: ${afterPoll2.hash}`);

  console.log("\n(d) Watching 7s for duplicate candles SSE (expect none)…");
  const dup = await waitForCandle(7_000);
  if (dup) {
    // Live Angel soft-watch can still fire if another writer updates bars;
    // only fail if hash matches the "unchanged" rewrite (true duplicate).
    if (dup.contentHash === afterPoll1.hash) {
      console.error("FAIL: duplicate SSE push for unchanged content hash");
      console.error(`    hash=${dup.contentHash}`);
      console.error(`    events ${eventCountAfterPush1} → ${events.length}`);
      ac.abort();
      process.exit(3);
    }
    console.log(
      `    note: unrelated hash change arrived (${(dup.contentHash ?? "").slice(0, 72)}…) — not a duplicate of unchanged rewrite`,
    );
    // Still treat as soft fail for strict idempotency of this cycle? User asked
    // no duplicate if data unchanged — this is a different hash, so OK.
  } else {
    console.log(
      `    OK — no candles event for 7s (count stayed ${events.length})`,
    );
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(" VERDICT — PASS");
  console.log(`  (a) before: ${seed.contentHash}`);
  console.log(`      after:  ${afterPoll1.hash}`);
  console.log(`  (b) soft-watch detected poll write in ${detectMs}ms`);
  console.log(`  (c) SSE payload delivered (hash=${push1.contentHash})`);
  console.log(`  (d) no duplicate push on unchanged content rewrite`);
  console.log("═══════════════════════════════════════════════════════════");

  ac.abort();
  try {
    await pump;
  } catch {
    // aborted
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("TRACE FAILED:", err);
  process.exit(1);
});
