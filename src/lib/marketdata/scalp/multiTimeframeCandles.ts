import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  isMarketDataUnavailable,
  type Underlying,
} from "@/lib/marketdata/angelone";
import { cacheGet, cacheSet } from "@/lib/redis";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { readStoredCandles, upsertMarketCandles } from "./candleStore";
import { scalpCandleHub } from "./scalpCandleHub";
import {
  SCALP_CANDLE_BUNDLE_TTL_SEC,
  SCALP_LOOKBACK_DAYS,
  SCALP_POLL_GAP_MS,
  SCALP_TIMEFRAMES,
  type MultiTimeframeCandleBundle,
  type ScalpCandleSeries,
  type ScalpTimeframe,
} from "./types";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptySeries(interval: ScalpTimeframe): ScalpCandleSeries {
  return {
    interval,
    lookbackDays: SCALP_LOOKBACK_DAYS[interval],
    candles: [],
    source: "demo",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch one timeframe, optionally persist, fall back to DB cache on Angel failure.
 * `persist` defaults true for request-path cache fill; poll job sets false and
 * writes once after the full MTF bundle (avoids double upsert egress).
 */
async function fetchOneTimeframe(
  underlying: Underlying,
  interval: ScalpTimeframe,
  opts?: { persist?: boolean },
): Promise<{ series: ScalpCandleSeries; degradeReason?: string }> {
  const lookbackDays = SCALP_LOOKBACK_DAYS[interval];
  const fetchedAt = new Date().toISOString();
  const persist = opts?.persist !== false;

  try {
    const candles = await getUnderlyingCandles(
      underlying,
      interval,
      lookbackDays,
    );
    const source = isDemoMarketDataMode() ? "demo" : "angel";
    // Persist best-effort — never block the response path on store failure.
    if (persist) {
      void upsertMarketCandles({ underlying, interval, candles, source }).catch(
        () => undefined,
      );
    }

    return {
      series: {
        interval,
        lookbackDays,
        candles,
        source,
        fetchedAt,
      },
      degradeReason:
        source === "demo"
          ? `${underlying} ${interval}: labeled demo candles (no live Angel session)`
          : undefined,
    };
  } catch (err) {
    const cached = await readStoredCandles(underlying, interval);
    if (cached.length > 0) {
      const reason = isMarketDataUnavailable(err)
        ? `Angel ${err.code}: serving DB cache for ${underlying} ${interval}`
        : `fetch failed: serving DB cache for ${underlying} ${interval}`;
      return {
        series: {
          interval,
          lookbackDays,
          candles: cached,
          source: "db_cache",
          fetchedAt,
        },
        degradeReason: reason,
      };
    }

    const reason = isMarketDataUnavailable(err)
      ? `Angel ${err.code}: no candles for ${underlying} ${interval}`
      : `fetch failed and no DB cache for ${underlying} ${interval}`;
    return { series: emptySeries(interval), degradeReason: reason };
  }
}

async function buildMultiTimeframeBundle(
  underlying: Underlying,
  opts?: { persist?: boolean },
): Promise<MultiTimeframeCandleBundle> {
  const series = {} as Record<ScalpTimeframe, ScalpCandleSeries>;
  const degradeReasons: string[] = [];

  for (const interval of SCALP_TIMEFRAMES) {
    const { series: s, degradeReason } = await fetchOneTimeframe(
      underlying,
      interval,
      { persist: opts?.persist },
    );
    series[interval] = s;
    if (degradeReason) degradeReasons.push(degradeReason);
    // Extra gap between TF calls on top of angelThrottle.
    await sleep(SCALP_POLL_GAP_MS);
  }

  return {
    underlying,
    series,
    degraded: degradeReasons.length > 0,
    degradeReasons,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Multi-timeframe candle bundle for one underlying.
 * Timeframes are fetched **sequentially** (rate-limit aware) via angelThrottle.
 */
export async function getMultiTimeframeCandles(
  underlying: Underlying,
  opts?: {
    forceRefresh?: boolean;
    /** Persist candles (default true). Poll job uses false then writes once. */
    persist?: boolean;
  },
): Promise<MultiTimeframeCandleBundle> {
  const cacheKey = `scalp:mtf:${underlying}`;
  const persist = opts?.persist;

  if (!opts?.forceRefresh) {
    const fromRedis = await cacheGet<MultiTimeframeCandleBundle>(cacheKey);
    if (fromRedis) {
      // Delivery only — content-hash hub dedupes identical bars.
      scalpCandleHub.publish(fromRedis);
      return fromRedis;
    }

    const bundle = await withTtlCache(
      cacheKey,
      SCALP_CANDLE_BUNDLE_TTL_SEC * 1000,
      async () => {
        const built = await buildMultiTimeframeBundle(underlying, { persist });
        await cacheSet(cacheKey, built, SCALP_CANDLE_BUNDLE_TTL_SEC);
        return built;
      },
    );
    scalpCandleHub.publish(bundle);
    return bundle;
  }

  const bundle = await buildMultiTimeframeBundle(underlying, { persist });
  await cacheSet(cacheKey, bundle, SCALP_CANDLE_BUNDLE_TTL_SEC);
  scalpCandleHub.publish(bundle);
  return bundle;
}

export type ScalpCandlePollResult = {
  underlying: Underlying;
  written: number;
  degraded: boolean;
  degradeReasons: string[];
  intervals: ScalpTimeframe[];
};

/**
 * Rate-aware job: poll all underlyings × scalp timeframes with batching + delay.
 * Idempotent upserts — safe to re-run.
 * Fetches without inline persist, then writes once per TF (no double upsert).
 */
export async function pollScalpCandles(opts?: {
  underlyings?: Underlying[];
  /** Extra delay between underlyings (ms). Default 800. */
  underlyingGapMs?: number;
}): Promise<ScalpCandlePollResult[]> {
  const underlyings = opts?.underlyings ?? UNDERLYINGS;
  const underlyingGapMs = opts?.underlyingGapMs ?? 800;
  const results: ScalpCandlePollResult[] = [];

  for (let i = 0; i < underlyings.length; i++) {
    const underlying = underlyings[i]!;
    // Force-refresh Angel data; persist:false so we don't write during fetch.
    const bundle = await getMultiTimeframeCandles(underlying, {
      forceRefresh: true,
      persist: false,
    });

    let written = 0;
    for (const interval of SCALP_TIMEFRAMES) {
      const s = bundle.series[interval];
      if (s.source === "angel" || s.source === "demo") {
        written += await upsertMarketCandles({
          underlying,
          interval,
          candles: s.candles,
          source: s.source === "demo" ? "demo" : "angel",
        });
      }
    }

    results.push({
      underlying,
      written,
      degraded: bundle.degraded,
      degradeReasons: bundle.degradeReasons,
      intervals: [...SCALP_TIMEFRAMES],
    });

    if (i < underlyings.length - 1) {
      await sleep(underlyingGapMs);
    }
  }

  return results;
}
