"use client";

import { SmcChartOverlaysLegend } from "@/components/analysis/SmcChartOverlays";
import { AlertTriangle, Check, X } from "lucide-react";
import type { SmcSignal } from "@/lib/marketdata/smc";

export type SmcSignalCardProps = {
  signal: SmcSignal;
  /** Optional extras for context row */
  meta?: {
    trend?: string;
    zone?: string;
    degraded?: boolean;
  };
};

/**
 * Read-only SMC confluence card — checklist of pass/fail conditions.
 * NOT wired to §2.5 synthesizer or paper trading.
 * Overlay legend sits in the right column to fill unused width.
 */
export function SmcSignalCard({ signal, meta }: SmcSignalCardProps) {
  const entryColor =
    signal.entry === "BUY"
      ? "border-binance-bull/40 text-binance-bull bg-binance-bull/10"
      : signal.entry === "SELL"
        ? "border-binance-bear/40 text-binance-bear bg-binance-bear/10"
        : "border-binance-border text-binance-muted";

  return (
    <div className="rounded-lg border border-binance-border bg-binance-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
          SMC signal
        </p>
        <span
          className={`rounded border px-2 py-0.5 text-xs font-semibold ${entryColor}`}
        >
          Entry: {signal.entry}
          {signal.direction ? ` · ${signal.direction}` : ""}
        </span>
        {meta?.trend && (
          <span className="text-xs text-binance-muted">
            Structure trend: {meta.trend}
          </span>
        )}
        {meta?.zone && (
          <span className="text-xs text-binance-muted">P/D: {meta.zone}</span>
        )}
        {meta?.degraded && (
          <span className="rounded border border-binance-gold/40 px-2 py-0.5 text-[10px] text-binance-gold">
            degraded data
          </span>
        )}
        <span className="rounded border border-binance-border px-2 py-0.5 text-[10px] text-binance-muted">
          Standalone · not in §2.5
        </span>
      </div>

      <div className="grid gap-4 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-6">
        <div className="min-w-0 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-binance-muted">
            Confluence checklist
          </p>
          {signal.checklist.map((item) => (
            <div
              key={item.key}
              className="flex items-start gap-2 text-sm text-binance-text"
            >
              {item.passed ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-binance-bull" />
              ) : (
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-binance-bear" />
              )}
              <div>
                <span className="font-medium">
                  {item.key.replaceAll("_", " ")}
                </span>
                <span className="text-binance-muted"> — {item.detail}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0 border-t border-binance-border pt-3 md:border-l md:border-t-0 md:pl-5 md:pt-0">
          <SmcChartOverlaysLegend embedded />
        </div>
      </div>

      {(signal.exitReason || signal.exitDetail) && (
        <div className="border-t border-binance-border px-4 py-3 text-xs text-binance-muted">
          Exit hint:{" "}
          <span className="text-binance-text">
            {signal.exitReason ?? "—"}
            {signal.exitDetail ? ` — ${signal.exitDetail}` : ""}
          </span>
        </div>
      )}

      <div className="flex items-start gap-1.5 border-t border-binance-border px-4 py-3 text-[10px] leading-relaxed text-binance-muted">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-binance-gold" />
        <span>
          {signal.disclaimer}. Read-only — does not place paper or live orders.
        </span>
      </div>
    </div>
  );
}
