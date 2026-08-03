"use client";

import { AnalysisLiveChart } from "@/components/AnalysisLiveChart";
import { LiveBadge } from "@/components/LiveBadge";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import type { Underlying } from "@/lib/marketdata/angelone/types";
import { useMemo, useState } from "react";

const INDICES: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

const LABELS: Record<Underlying, string> = {
  NIFTY: "Nifty 50",
  BANKNIFTY: "Bank Nifty",
  SENSEX: "Sensex",
};

/**
 * Dedicated Chart tab — live NIFTY / BANKNIFTY / SENSEX candlesticks together.
 * Candles via `/api/analysis/candles`; forming bar from dashboard SSE LTP.
 */
export function ChartsPanel() {
  const [mode, setMode] = useState<"SCALP" | "SWING">("SCALP");
  const { cards, live, error, feed } = useDashboardLiveStream();

  const ltpById = useMemo(() => {
    const map: Partial<Record<Underlying, number>> = {};
    for (const c of cards) {
      if (
        (c.id === "NIFTY" || c.id === "BANKNIFTY" || c.id === "SENSEX") &&
        Number.isFinite(c.ltp)
      ) {
        map[c.id] = c.ltp;
      }
    }
    return map;
  }, [cards]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-binance-text sm:text-xl">
            Live charts
          </h1>
          <p className="mt-0.5 text-xs text-binance-muted sm:text-sm">
            Nifty, Bank Nifty &amp; Sensex · same candle + SSE path as Analysis
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <LiveBadge active={live} />
          {feed && (
            <span className="text-[11px] text-binance-muted">
              {feed === "angel-ws"
                ? "Angel WS"
                : feed === "public-spot"
                  ? "Public spot"
                  : "Snapshot"}
            </span>
          )}
          <div
            className="inline-flex rounded-md bg-binance-elevated p-0.5"
            role="group"
            aria-label="Chart mode"
          >
            {(["SCALP", "SWING"] as const).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-binance-gold text-binance-bg"
                      : "text-binance-muted hover:text-binance-text"
                  }`}
                >
                  {m === "SCALP" ? "Scalp" : "Swing"}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-binance-bear/40 bg-binance-bear/10 px-3 py-2 text-sm text-binance-bear">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {INDICES.map((underlying) => (
          <section key={underlying} className="flex min-h-0 flex-col gap-1.5">
            <h2 className="px-0.5 text-sm font-medium text-binance-muted">
              {LABELS[underlying]}
            </h2>
            <AnalysisLiveChart
              underlying={underlying}
              mode={mode}
              liveLtp={ltpById[underlying] ?? null}
              live={live}
              compact
            />
          </section>
        ))}
      </div>
    </div>
  );
}
