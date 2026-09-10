"use client";

import type {
  LargeOrderAlert,
  LiveOptionChainPayload,
} from "@/lib/marketdata/liveOptionChainHub";
import { useCallback, useEffect, useRef, useState } from "react";

const LARGE_ORDER_TOAST_CAP = 2;
const LARGE_ORDER_TOAST_MS = 6000;

function chainDisplayFingerprint(contracts: OptionChainLiveContract[]): string {
  let s = "";
  for (const c of contracts) {
    s += `${c.strike}${c.optionType}:${c.ltp.toFixed(2)}:${c.oi ?? ""}:${c.changePct ?? ""}|`;
  }
  return s;
}

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
  delta?: number | null;
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
  const [greeksStatus, setGreeksStatus] = useState<
    "ok" | "unavailable" | "skipped" | undefined
  >();
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [largeOrders, setLargeOrders] = useState<LargeOrderAlert[]>([]);
  const hasDataRef = useRef(false);
  const toastTimersRef = useRef<number[]>([]);
  const chainFpRef = useRef("");

  useEffect(() => {
    hasDataRef.current = contracts.length > 0;
  }, [contracts.length]);

  const reconnect = useCallback(() => {
    setReconnectKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLive(false);
    setError(null);
    setContracts([]);
    setExpiry("");
    setSpot(null);
    setFeed(undefined);
    setSubscribedTokens(0);
    setGreeksStatus(undefined);
    setLargeOrders([]);
    hasDataRef.current = false;
    chainFpRef.current = "";

    const es = new EventSource(
      `/api/paper/chain/stream?underlying=${encodeURIComponent(underlying)}`,
    );

    const onChain = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as LiveOptionChainPayload;
        if (payload.ok) {
          const fp = `${payload.spot}|${payload.expiry}|${chainDisplayFingerprint(payload.contracts)}`;
          if (fp === chainFpRef.current) {
            setLive(true);
            setError(null);
            setLoading(false);
            return;
          }
          chainFpRef.current = fp;
          setFetchedAt(payload.fetchedAt);
          setContracts(payload.contracts);
          setExpiry(payload.expiry);
          setSpot(payload.spot);
          setSpotChange(Number(payload.spotChange ?? 0));
          setSpotChangePct(Number(payload.spotChangePct ?? 0));
          setFeed(payload.feed);
          setSubscribedTokens(payload.subscribedTokens);
          setGreeksStatus(payload.greeksStatus);
          setLive(true);
          setError(null);
          setLoading(false);
        } else {
          setFetchedAt(payload.fetchedAt);
          setLive(false);
          setError(payload.uiHint ?? payload.error);
          setLoading(false);
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.addEventListener("chain", onChain as EventListener);

    const onLargeOrder = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse(ev.data) as LargeOrderAlert;
        if (!payload?.inferred || !payload.alertText) return;
        setLargeOrders((prev) => {
          const next = [payload, ...prev];
          return next.slice(0, LARGE_ORDER_TOAST_CAP);
        });
        const timer = window.setTimeout(() => {
          setLargeOrders((prev) => prev.filter((x) => x !== payload));
        }, LARGE_ORDER_TOAST_MS);
        toastTimersRef.current.push(timer);
      } catch {
        // ignore malformed frames
      }
    };
    es.addEventListener("largeOrder", onLargeOrder as EventListener);

    es.onopen = () => {
      if (!cancelled) setLive(true);
    };

    es.onerror = () => {
      if (cancelled) return;
      setLive(false);
      if (es.readyState === EventSource.CLOSED) {
        setError("Option chain stream disconnected");
        if (!hasDataRef.current) setLoading(false);
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
      es.removeEventListener("largeOrder", onLargeOrder as EventListener);
      es.close();
      for (const t of toastTimersRef.current) window.clearTimeout(t);
      toastTimersRef.current = [];
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
    greeksStatus,
    live,
    loading,
    error,
    fetchedAt,
    largeOrders,
    reconnect,
  };
}
