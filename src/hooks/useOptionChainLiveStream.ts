"use client";

import type { LiveOptionChainPayload } from "@/lib/marketdata/liveOptionChainHub";
import { useCallback, useEffect, useRef, useState } from "react";

export type OptionChainLiveContract = {
  strike: number;
  optionType: "CE" | "PE";
  tradingsymbol: string;
  symboltoken: string;
  ltp: number;
  change?: number;
  changePct?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
  iv?: number;
  lotSize: number;
  expiry: string;
};

/**
 * Subscribe to `/api/paper/chain/stream` — Angel WS ATM ticks + REST snapshots.
 * EventSource auto-reconnects; pauses reconnect spam when tab hidden.
 */
export function useOptionChainLiveStream(underlying: string) {
  const [contracts, setContracts] = useState<OptionChainLiveContract[]>([]);
  const [expiry, setExpiry] = useState("");
  const [spot, setSpot] = useState<number | null>(null);
  const [spotChange, setSpotChange] = useState(0);
  const [spotChangePct, setSpotChangePct] = useState(0);
  const [feed, setFeed] = useState<"angel-ws" | "rest" | "demo" | undefined>();
  const [subscribedTokens, setSubscribedTokens] = useState(0);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    hasDataRef.current = contracts.length > 0;
  }, [contracts.length]);

  const reconnect = useCallback(() => {
    setReconnectKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    setError(null);
    setContracts([]);
    setExpiry("");
    setSpot(null);
    setFeed(undefined);
    setSubscribedTokens(0);
    hasDataRef.current = false;

    const es = new EventSource(
      `/api/paper/chain/stream?underlying=${encodeURIComponent(underlying)}`,
    );

    const onChain = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as LiveOptionChainPayload;
        setFetchedAt(payload.fetchedAt);
        if (payload.ok) {
          setContracts(payload.contracts);
          setExpiry(payload.expiry);
          setSpot(payload.spot);
          setSpotChange(Number(payload.spotChange ?? 0));
          setSpotChangePct(Number(payload.spotChangePct ?? 0));
          setFeed(payload.feed);
          setSubscribedTokens(payload.subscribedTokens);
          setLive(true);
          setError(null);
        } else {
          setLive(false);
          setError(payload.uiHint ?? payload.error);
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.addEventListener("chain", onChain as EventListener);

    es.onopen = () => {
      if (!cancelled) setLive(true);
    };

    es.onerror = () => {
      if (cancelled) return;
      setLive(false);
      if (es.readyState === EventSource.CLOSED) {
        setError("Option chain stream disconnected");
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
      es.removeEventListener("chain", onChain as EventListener);
      es.close();
    };
  }, [underlying, reconnectKey, reconnect]);

  return {
    contracts,
    expiry,
    spot,
    spotChange,
    spotChangePct,
    feed,
    subscribedTokens,
    live,
    error,
    fetchedAt,
    reconnect,
  };
}
