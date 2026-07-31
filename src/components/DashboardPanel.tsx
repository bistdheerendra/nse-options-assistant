"use client";

import { IndexQuoteCard, type IndexCardData } from "@/components/IndexQuoteCard";
import { LiveBadge } from "@/components/LiveBadge";
import { MacroDashboard } from "@/components/MacroDashboard";
import { PortfolioPnlCard } from "@/components/PortfolioPnlCard";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import { useRelativeClock } from "@/hooks/useLivePoll";
import { AlertTriangle, Loader2, Radio } from "lucide-react";

export function DashboardPanel() {
  const { cards, demoMode, loading, live, error, fetchedAt, reconnect } =
    useDashboardLiveStream();
  const ago = useRelativeClock(fetchedAt);

  return (
    <div className="space-y-6">
      <PortfolioPnlCard />

      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-binance-gold">
              Markets
            </h1>
            <LiveBadge active={live && !loading} />
          </div>
          <p className="mt-1 text-sm text-binance-muted">
            Server SSE push · spot tick ~0.3s (NSE + Gift) · candles refresh
            ~30s
            {demoMode
              ? " · DEMO mode — public feeds (not Angel tick WebSocket)"
              : ""}
            {ago ? ` · ${ago}` : ""}
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
