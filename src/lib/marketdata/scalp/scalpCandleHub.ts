import type { Underlying } from "@/lib/marketdata/angelone/types";
import { cacheGet } from "@/lib/redis";
import {
  SCALP_TIMEFRAMES,
  type MultiTimeframeCandleBundle,
} from "./types";

export type ScalpCandleStreamOk = {
  ok: true;
  underlying: Underlying;
  fetchedAt: string;
  contentHash: string;
  degraded: boolean;
  degradeReasons: string[];
  bundle: MultiTimeframeCandleBundle;
};

export type ScalpCandleStreamErr = {
  ok: false;
  underlying: Underlying;
  fetchedAt: string;
  error: string;
  uiHint?: string;
};

export type ScalpCandleStreamPayload =
  | ScalpCandleStreamOk
  | ScalpCandleStreamErr;

type Listener = (payload: ScalpCandleStreamPayload) => void;

/** Soft Redis re-read when SSE listeners exist — delivers poll-job cache writes with zero Angel calls. */
const REDIS_WATCH_MS = 5_000;

/**
 * Content fingerprint of last closed bar per TF (time/close/volume/source).
 * Ignores fetchedAt so poll ticks with unchanged bars do not re-emit.
 */
export function scalpBundleContentHash(
  bundle: MultiTimeframeCandleBundle,
): string {
  const parts = SCALP_TIMEFRAMES.map((tf) => {
    const series = bundle.series[tf];
    const last = series.candles[series.candles.length - 1];
    if (!last) return `${tf}:empty:${series.source}`;
    return `${tf}:${last.time}:${last.close}:${last.volume}:${series.source}`;
  });
  return parts.join("|");
}

type UnderlyingState = {
  listeners: Set<Listener>;
  last: ScalpCandleStreamPayload | null;
  lastContentHash: string | null;
  seedInFlight: boolean;
};

/**
 * In-process scalp MTF candle hub (single-instance).
 * Publishers: getMultiTimeframeCandles + Redis soft-watch (poll job bridge).
 * Consumers: GET /api/scalp/candles/stream via subscribe().
 */
class ScalpCandleHub {
  private byUnderlying = new Map<Underlying, UnderlyingState>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  getLatest(underlying: Underlying): ScalpCandleStreamPayload | null {
    return this.byUnderlying.get(underlying)?.last ?? null;
  }

  /**
   * Push a successful MTF bundle if content changed.
   * @returns true when listeners were notified
   */
  publish(bundle: MultiTimeframeCandleBundle): boolean {
    const hash = scalpBundleContentHash(bundle);
    const state = this.ensureState(bundle.underlying);

    if (state.lastContentHash === hash && state.last?.ok) {
      // Refresh last pointer timestamps only — no client re-render fan-out
      return false;
    }

    const payload: ScalpCandleStreamOk = {
      ok: true,
      underlying: bundle.underlying,
      fetchedAt: bundle.fetchedAt,
      contentHash: hash,
      degraded: bundle.degraded,
      degradeReasons: bundle.degradeReasons,
      bundle,
    };
    state.lastContentHash = hash;
    this.broadcast(bundle.underlying, payload);
    return true;
  }

  subscribe(underlying: Underlying, listener: Listener): () => void {
    const state = this.ensureState(underlying);
    state.listeners.add(listener);

    if (state.last) {
      try {
        listener(state.last);
      } catch {
        // ignore bad subscriber
      }
    } else {
      void this.ensureSeeded(underlying);
    }

    this.ensureWatchRunning();

    return () => {
      const s = this.byUnderlying.get(underlying);
      if (!s) return;
      s.listeners.delete(listener);
      if (s.listeners.size === 0 && this.totalListeners() === 0) {
        this.stopWatch();
      }
    };
  }

  private ensureState(underlying: Underlying): UnderlyingState {
    let state = this.byUnderlying.get(underlying);
    if (!state) {
      state = {
        listeners: new Set(),
        last: null,
        lastContentHash: null,
        seedInFlight: false,
      };
      this.byUnderlying.set(underlying, state);
    }
    return state;
  }

  private totalListeners(): number {
    let n = 0;
    for (const s of this.byUnderlying.values()) n += s.listeners.size;
    return n;
  }

  private broadcast(underlying: Underlying, payload: ScalpCandleStreamPayload) {
    const state = this.ensureState(underlying);
    state.last = payload;
    for (const listener of state.listeners) {
      try {
        listener(payload);
      } catch {
        // ignore bad subscriber
      }
    }
  }

  /**
   * Seed last-known for a new SSE client: Redis → request-time MTF fetch
   * (demo / db_cache labeled bundles are valid — never leave the client empty).
   */
  private async ensureSeeded(underlying: Underlying) {
    const state = this.ensureState(underlying);
    if (state.last || state.seedInFlight) return;
    state.seedInFlight = true;
    try {
      const cacheKey = `scalp:mtf:${underlying}`;
      const fromRedis = await cacheGet<MultiTimeframeCandleBundle>(cacheKey);
      if (fromRedis) {
        this.publish(fromRedis);
        return;
      }

      // Dynamic import avoids circular dep with multiTimeframeCandles → hub.publish
      const { getMultiTimeframeCandles } = await import(
        "./multiTimeframeCandles"
      );
      const bundle = await getMultiTimeframeCandles(underlying);
      this.publish(bundle);
    } catch (err) {
      if (state.last) return;
      this.broadcast(underlying, {
        ok: false,
        underlying,
        fetchedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : "scalp candles unavailable",
        uiHint: "market data unavailable",
      });
    } finally {
      state.seedInFlight = false;
    }
  }

  private ensureWatchRunning() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      void this.tickRedisWatch();
    }, REDIS_WATCH_MS);
  }

  private stopWatch() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** Pick up bundles written by `poll:scalp-candles` (separate process) via Redis. */
  private async tickRedisWatch() {
    if (this.totalListeners() === 0) {
      this.stopWatch();
      return;
    }
    for (const [underlying, state] of this.byUnderlying) {
      if (state.listeners.size === 0) continue;
      try {
        const fromRedis = await cacheGet<MultiTimeframeCandleBundle>(
          `scalp:mtf:${underlying}`,
        );
        if (fromRedis) this.publish(fromRedis);
      } catch {
        // cache optional
      }
    }
  }
}

const globalForHub = globalThis as typeof globalThis & {
  __nseScalpCandleHub?: ScalpCandleHub;
};

export const scalpCandleHub =
  globalForHub.__nseScalpCandleHub ?? new ScalpCandleHub();
globalForHub.__nseScalpCandleHub = scalpCandleHub;
