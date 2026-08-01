"use client";

import { IndexQuoteCard, type IndexCardData } from "@/components/IndexQuoteCard";
import { LiveBadge } from "@/components/LiveBadge";
import { MacroDashboard } from "@/components/MacroDashboard";
import { PortfolioPnlCard } from "@/components/PortfolioPnlCard";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import { useRelativeClock } from "@/hooks/useLivePoll";
import { AlertTriangle, Loader2, Radio } from "lucide-react";

export function DashboardPanel() {
  const { cards, demoMode, feed, loading, live, error, fetchedAt, reconnect } =
    useDashboardLiveStream();
  const ago = useRelativeClock(fetchedAt);
  const angelLive = feed === "angel-ws" && !demoMode;

  return (
    <div className="space-y-4 sm:space-y-6">
      <PortfolioPnlCard />

      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-binance-gold sm:text-2xl">
              Markets
            </h1>
            <LiveBadge active={live && !loading} />
          </div>
          <p className="mt-1 text-xs text-binance-muted sm:text-sm">
            <span className="md:hidden">
              {demoMode
                ? "DEMO public feed"
                : angelLive
                  ? "Angel ticks · Gift ~0.5s"
                  : "Spot feed · reconnecting Angel"}
              {ago ? ` · ${ago}` : ""}
            </span>
            <span className="hidden md:inline">
              {demoMode
                ? "DEMO mode — public NSE + Gift (not Angel tick WebSocket)"
                : angelLive
                  ? "Angel One WebSocket ticks (Nifty / Bank Nifty / Sensex) · Gift ~0.5s · candles ~30s"
                  : "Server SSE · waiting for Angel WebSocket (public NSE fallback) · candles ~30s"}
              {ago ? ` · ${ago}` : ""}
            </span>
          </p>
        </div>
        {!live && (
          <button
            type="button"
            onClick={reconnect}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded bg-binance-gold px-3 py-2 text-sm font-semibold text-binance-bg disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radio className="h-4 w-4" />
            )}
            Reconnect
          </button>
        )}
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
          Connecting to live feed…
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          {cards.map((card: IndexCardData) => (
            <IndexQuoteCard key={card.id} card={card} live={live} />
          ))}
        </div>
      )}

      <div className="border-t border-binance-border pt-6">
        <MacroDashboard />
      </div>
    </div>
  );
}
