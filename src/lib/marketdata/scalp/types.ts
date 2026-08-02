import type { CandleInterval, OhlcvCandle, Underlying } from "@/lib/marketdata/angelone";

/**
 * Scalping Mode multi-timeframe set (docs/PROJECT.md §3.1 / Stage 1 pipeline).
 * Angel One Historical API interval constants (verified SmartAPI docs):
 *   ONE_MINUTE | THREE_MINUTE | FIVE_MINUTE | FIFTEEN_MINUTE
 */
export const SCALP_TIMEFRAMES = [
  "ONE_MINUTE",
  "THREE_MINUTE",
  "FIVE_MINUTE",
  "FIFTEEN_MINUTE",
] as const;

export type ScalpTimeframe = (typeof SCALP_TIMEFRAMES)[number];

export function isScalpTimeframe(v: string): v is ScalpTimeframe {
  return (SCALP_TIMEFRAMES as readonly string[]).includes(v);
}

/**
 * Lookback days per timeframe — capped by Angel "Max Days in one Request"
 * and the practical ~500-row response ceiling.
 *
 * Official max days: 1m=30, 3m=60, 5m=100, 15m=200.
 * We request far less so a single call stays under ~500 bars of NSE session data.
 */
export const SCALP_LOOKBACK_DAYS: Record<ScalpTimeframe, number> = {
  ONE_MINUTE: 2,
  THREE_MINUTE: 5,
  FIVE_MINUTE: 5,
  FIFTEEN_MINUTE: 10,
};

/** Soft TTL for in-process / Redis cache of a full MTF bundle (seconds). */
export const SCALP_CANDLE_BUNDLE_TTL_SEC = 45;

/**
 * Inter-request delay when polling multiple underlyings × timeframes.
 * Stacks on top of angelThrottle (~250ms) for idempotent, rate-aware jobs.
 */
export const SCALP_POLL_GAP_MS = 350;

export type ScalpCandleSeries = {
  interval: ScalpTimeframe;
  lookbackDays: number;
  candles: OhlcvCandle[];
  source: "angel" | "demo" | "db_cache";
  fetchedAt: string;
};

export type MultiTimeframeCandleBundle = {
  underlying: Underlying;
  series: Record<ScalpTimeframe, ScalpCandleSeries>;
  /** True when any series fell back to demo mocks or stale DB cache. */
  degraded: boolean;
  /** Human-readable degrade reasons for UI. */
  degradeReasons: string[];
  fetchedAt: string;
};

export type CandleIntervalCompat = CandleInterval;
