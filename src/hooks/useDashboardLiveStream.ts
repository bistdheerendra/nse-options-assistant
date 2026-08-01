"use client";

import type { IndexCardData } from "@/components/IndexQuoteCard";
import { useCallback, useEffect, useRef, useState } from "react";

type StreamOk = {
  ok: true;
  fetchedAt: string;
  cards: IndexCardData[];
  demoMode: boolean;
  feed?: "angel-ws" | "public-spot" | "snapshot";
};

type StreamErr = {
  ok: false;
  fetchedAt: string;
  error: string;
  uiHint?: string;
};

type StreamPayload = StreamOk | StreamErr;

/**
 * Subscribe to backend SSE live quote stream (`/api/dashboard/stream`).
 * Client does not poll — server pushes quotes; EventSource auto-reconnects.
 */
export function useDashboardLiveStream() {
  const [cards, setCards] = useState<IndexCardData[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [feed, setFeed] = useState<StreamOk["feed"]>(undefined);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const hasCardsRef = useRef(false);

  useEffect(() => {
    hasCardsRef.current = cards.length > 0;
  }, [cards.length]);

  const reconnect = useCallback(() => {
    setReconnectKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasCardsRef.current) setLoading(true);
    setError(null);

    const es = new EventSource("/api/dashboard/stream");

    const onQuote = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as StreamPayload;
        setFetchedAt(payload.fetchedAt);
        if (payload.ok) {
          setCards(payload.cards);
          setDemoMode(payload.demoMode);
          setFeed(payload.feed);
          setLive(true);
          setError(null);
          setLoading(false);
        } else {
          setLive(false);
          setError(payload.uiHint ?? payload.error);
          setLoading(false);
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.addEventListener("quote", onQuote as EventListener);

    es.onopen = () => {
      if (!cancelled) setLive(true);
    };

    es.onerror = () => {
      if (cancelled) return;
      setLive(false);
      if (es.readyState === EventSource.CLOSED) {
        setError("Live stream disconnected");
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
      es.removeEventListener("quote", onQuote as EventListener);
      es.close();
    };
  }, [reconnectKey, reconnect]);

  return {
    cards,
    demoMode,
    feed,
    loading,
    live,
    error,
    fetchedAt,
    reconnect,
  };
}
