"use client";

import { MiniCandleChart } from "@/components/MiniCandleChart";
import { theme } from "@/lib/theme";
import { Link2 } from "lucide-react";
import Link from "next/link";

export type IndexCardData = {
  id: string;
  label: string;
  ltp: number;
  change: number;
  changePct: number;
  candles: Array<{ open: number; high: number; low: number; close: number }>;
  demo: boolean;
  note: string | null;
  analysisUnderlying: string | null;
  source?: string;
};

function formatPrice(n: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function IndexQuoteCard({ card }: { card: IndexCardData }) {
  const up = card.change >= 0;
  const changeColor = up ? theme.colors.bull : theme.colors.bear;
  const href = card.analysisUnderlying
    ? `/analysis?underlying=${card.analysisUnderlying}`
    : null;

  return (
    <article className="flex flex-col rounded-xl border border-binance-border bg-binance-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium" style={{ color: theme.colors.text }}>
            {card.label}
          </h2>
          {(card.demo || card.note) && (
            <p
              className="mt-0.5 text-[10px] uppercase tracking-wide"
              style={{ color: theme.colors.muted }}
            >
              {card.demo ? "Proxy / demo" : card.source ?? "Live"}
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 flex justify-center py-1">
        <MiniCandleChart candles={card.candles} />
      </div>

      <div className="mt-auto flex items-end justify-between gap-3">
        <div>
          <p
            className="text-2xl font-semibold tabular-nums leading-tight"
            style={{ color: theme.colors.text }}
          >
            {formatPrice(card.ltp)}
          </p>
          <p
            className="mt-1 text-xs tabular-nums"
            style={{ color: changeColor }}
          >
            {up ? "+" : ""}
            {Number.isFinite(card.change) ? card.change.toFixed(2) : "—"} (
            {up ? "+" : ""}
            {Number.isFinite(card.changePct) ? card.changePct.toFixed(2) : "—"}%)
          </p>
        </div>
        {href ? (
          <Link
            href={href}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-binance-border transition hover:bg-binance-elevated"
            style={{ color: theme.colors.gold }}
            aria-label={`Open ${card.label} analysis`}
            title="Open analysis"
          >
            <Link2 className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-binance-border opacity-40"
            style={{ color: theme.colors.muted }}
            title={card.note ?? "No analysis link"}
          >
            <Link2 className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </article>
  );
}
