"use client";

import { IndexQuoteCard, type IndexCardData } from "@/components/IndexQuoteCard";
import { MacroDashboard } from "@/components/MacroDashboard";
import {
  LIVE_QUOTE_POLL_MS,
  useLivePoll,
  useRelativeClock,
} from "@/hooks/useLivePoll";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";

type DashboardResponse = {
  ok: boolean;
  cards?: IndexCardData[];
  demoMode?: boolean;
  error?: string;
  uiHint?: string;
  fetchedAt?: string;
};

export function DashboardPanel() {
  const [cards, setCards] = useState<IndexCardData[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const ago = useRelativeClock(fetchedAt);

  const load = useCallback(async ({ silent }: { silent: boolean }) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    if (!silent) setError(null);
    try {
      const res = await fetch(`/api/dashboard?t=${Date.now()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as DashboardResponse;
      if (!res.ok || !json.ok) {
        throw new Error(json.uiHint ?? json.error ?? "Failed to load dashboard");
      }
      setCards(json.cards ?? []);
      setDemoMode(Boolean(json.demoMode));
      setFetchedAt(json.fetchedAt ?? new Date().toISOString());
      setError(null);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useLivePoll(load, LIVE_QUOTE_POLL_MS);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-binance-gold">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-binance-muted">
            Live index LTP · auto-refresh ~{LIVE_QUOTE_POLL_MS / 1000}s · Nifty
            50, Bank Nifty, Sensex, Gift Nifty · Global & macro below
            {demoMode ? " · Angel lanes still in demo mode" : ""}
            {ago ? ` · Updated ${ago}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load({ silent: false })}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded bg-binance-gold px-3 py-2 text-sm font-semibold text-binance-bg disabled:opacity-60"
        >
          {loading || refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </button>
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded border border-binance-bear/40 bg-binance-elevated px-3 py-2 text-sm text-binance-bear">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && cards.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-binance-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading quotes…
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <IndexQuoteCard key={card.id} card={card} />
          ))}
        </div>
      )}

      <div className="border-t border-binance-border pt-6">
        <MacroDashboard />
      </div>
    </div>
  );
}
