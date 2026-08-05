"use client";

import type {
  ScalpCandleStreamPayload,
} from "@/lib/marketdata/scalp/scalpCandleHub";
import type { MultiTimeframeCandleBundle } from "@/lib/marketdata/scalp/types";
import { SCALP_CANDLE_BUNDLE_TTL_SEC } from "@/lib/marketdata/scalp/types";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_FALLBACK_MS = SCALP_CANDLE_BUNDLE_TTL_SEC * 1000;

type ScalpCandlesRestOk = {
  ok: true;
  underlying: string;
  degraded: boolean;
  degradeReasons: string[];
  fetchedAt: string;
  series: MultiTimeframeCandleBundle["series"];
};

/**
 * Subscribe to scalp MTF candle SSE (`/api/scalp/candles/stream`).
 * On stream error/disconnect, fall back to polling `GET /api/scalp/candles`
 * so Scalp UI is never stuck without updates.
 */
export function useScalpCandlesLiveStream(
  underlying: string,
  enabled = true,
) {
  const [bundle, setBundle] = useState<MultiTimeframeCandleBundle | null>(null);
  const [contentHash, setContentHash] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [degradeReasons, setDegradeReasons] = useState<string[]>([]);
  const [live, setLive] = useState(false);
  const [polling, setPolling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const hasDataRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    hasDataRef.current = bundle != null;
  }, [bundle]);

  const reconnect = useCallback(() => {
    setReconnectKey((k) => k + 1);
  }, []);

  const applyOkBundle = useCallback(
    (next: MultiTimeframeCandleBundle, hash?: string) => {
      setBundle(next);
      setDegraded(next.degraded);
      setDegradeReasons(next.degradeReasons);
      setFetchedAt(next.fetchedAt);
      if (hash) setContentHash(hash);
      setError(null);
      setLoading(false);
    },
    [],
  );

  const pollOnce = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/scalp/candles?underlying=${encodeURIComponent(underlying)}`,
      );
      const json = (await res.json()) as ScalpCandlesRestOk & {
        ok: boolean;
        error?: string;
        uiHint?: string;
      };
      if (!res.ok || !json.ok || !("series" in json)) {
        setError(json.uiHint ?? json.error ?? "Scalp candles poll failed");
        if (!hasDataRef.current) setLoading(false);
        return;
      }
      applyOkBundle({
        underlying: json.underlying as MultiTimeframeCandleBundle["underlying"],
        series: json.series,
        degraded: json.degraded,
        degradeReasons: json.degradeReasons,
        fetchedAt: json.fetchedAt,
      });
    } catch {
      setError("Scalp candles poll failed");
      if (!hasDataRef.current) setLoading(false);
    }
  }, [underlying, applyOkBundle]);

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPolling(false);
  }, []);

  const startPollFallback = useCallback(() => {
    if (pollTimerRef.current) return;
    setPolling(true);
    setLive(false);
    void pollOnce();
    pollTimerRef.current = setInterval(() => {
      void pollOnce();
    }, POLL_FALLBACK_MS);
  }, [pollOnce]);

  useEffect(() => {
    if (!enabled) {
      stopPoll();
      setLive(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    stopPoll();

    const es = new EventSource(
      `/api/scalp/candles/stream?underlying=${encodeURIComponent(underlying)}`,
    );

    const onCandles = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as ScalpCandleStreamPayload;
        setFetchedAt(payload.fetchedAt);
        if (payload.ok) {
          stopPoll();
          applyOkBundle(payload.bundle, payload.contentHash);
          setLive(true);
        } else {
          setLive(false);
          setError(payload.uiHint ?? payload.error);
          setLoading(false);
          // Keep serving last-known bundle; start REST poll for recovery
          startPollFallback();
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.addEventListener("candles", onCandles as EventListener);

    es.onopen = () => {
      if (!cancelled) {
        setLive(true);
        stopPoll();
      }
    };

    es.onerror = () => {
      if (cancelled) return;
      setLive(false);
      // EventSource auto-reconnects while CONNECTING; only fall back when fully closed
      if (es.readyState === EventSource.CLOSED) {
        setError("Scalp candle stream disconnected");
        if (!hasDataRef.current) setLoading(false);
        startPollFallback();
      }
    };

    const onVis = () => {
      if (
        document.visibilityState === "visible" &&
        es.readyState === EventSource.CLOSED
      ) {
        reconnect();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      es.removeEventListener("candles", onCandles as EventListener);
      es.close();
      stopPoll();
    };
  }, [
    underlying,
    enabled,
    reconnectKey,
    reconnect,
    applyOkBundle,
    startPollFallback,
    stopPoll,
  ]);

  return {
    bundle,
    contentHash,
    degraded,
    degradeReasons,
    live,
    polling,
    loading,
    error,
    fetchedAt,
    reconnect,
  };
}
