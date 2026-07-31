"use client";

import { theme } from "@/lib/theme";
import { motion } from "framer-motion";
import {
  Eye,
  EyeOff,
  Info,
  Loader2,
  ChevronDown,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";

type Position = {
  status: string;
  realizedPnl?: number | null;
  closedAt?: string | null;
  openedAt: string;
};

type PaperPayload = {
  account: {
    name: string;
    cashBalance: number;
    startingCash: number;
    positions: Position[];
  };
  summary: {
    cashBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    totalPortfolioValue: number;
  };
};

function formatInr(n: number, digits = 2): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Walk closed trades chronologically → equity points for the sparkline. */
function buildEquitySeries(
  startingCash: number,
  positions: Position[],
  totalPortfolioValue: number,
): number[] {
  const closed = positions
    .filter((p) => p.status !== "OPEN" && p.closedAt)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime(),
    );

  const points: number[] = [startingCash];
  let equity = startingCash;
  for (const p of closed) {
    equity += p.realizedPnl ?? 0;
    points.push(equity);
  }
  // Mark-to-market end point (cash + unrealized)
  if (
    points.length === 1 ||
    Math.abs(points[points.length - 1]! - totalPortfolioValue) > 0.5
  ) {
    points.push(totalPortfolioValue);
  }

  // Pad so the chart always has a smooth look when few trades exist
  while (points.length < 8) {
    const last = points[points.length - 1]!;
    const prev = points[Math.max(0, points.length - 2)]!;
    points.push(last + (last - prev) * 0.15);
  }
  return points;
}

function Sparkline({ values }: { values: number[] }) {
  const gradId = useId().replace(/:/g, "");
  const w = 280;
  const h = 72;
  const padY = 4;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = padY + (1 - (v - min) / range) * (h - padY * 2);
    return { x, y };
  });

  const line = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-18 w-full max-w-[320px]"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.colors.gold} stopOpacity={0.35} />
          <stop offset="100%" stopColor={theme.colors.gold} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path
        d={line}
        fill="none"
        stroke={theme.colors.gold}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PortfolioPnlCard() {
  const [data, setData] = useState<PaperPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    const load = async () => {
      attempt += 1;
      try {
        const res = await fetch("/api/paper", { cache: "no-store" });
        const json = (await res.json()) as PaperPayload & {
          error?: string;
          uiHint?: string;
        };
        if (!res.ok) {
          throw new Error(json.uiHint ?? json.error ?? `Paper API ${res.status}`);
        }
        if (!cancelled) {
          setData(json);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Failed to load paper P&L";
        // Retry a few times — DB cold starts often recover quickly
        if (attempt < 3) {
          window.setTimeout(() => {
            if (!cancelled) void load();
          }, 600 * attempt);
          return;
        }
        setError(msg);
        setLoading(false);
      }
    };

    setLoading(true);
    void load();
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const metrics = useMemo(() => {
    if (!data) return null;
    const { account, summary } = data;
    const today = startOfTodayIso();
    const todayRealized = account.positions
      .filter(
        (p) =>
          p.status !== "OPEN" &&
          p.closedAt &&
          p.closedAt >= today,
      )
      .reduce((a, p) => a + (p.realizedPnl ?? 0), 0);
    // Today's P&L ≈ closed-today realized + open mark-to-market
    const todayPnl = todayRealized + summary.unrealizedPnl;
    const totalPnl = summary.totalPortfolioValue - account.startingCash;
    const baseline = summary.totalPortfolioValue - todayPnl;
    const todayPct = baseline !== 0 ? (todayPnl / Math.abs(baseline)) * 100 : 0;
    const openCount = account.positions.filter((p) => p.status === "OPEN").length;

    return {
      totalValue: summary.totalPortfolioValue,
      cashBalance: summary.cashBalance,
      todayPnl,
      todayPct,
      totalPnl,
      unrealized: summary.unrealizedPnl,
      realized: summary.realizedPnl,
      startingCash: account.startingCash,
      openCount,
      name: account.name,
      series: buildEquitySeries(
        account.startingCash,
        account.positions,
        summary.totalPortfolioValue,
      ),
    };
  }, [data]);

  const mask = (s: string) => (hidden ? "••••••••" : s);
  const pnlPositive = (metrics?.todayPnl ?? 0) >= 0;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl border border-binance-border bg-binance-elevated p-4 sm:rounded-2xl sm:p-6"
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-stretch lg:justify-between">
        {/* Left — balance + P&L */}
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-binance-muted">Est. Total Value</p>
            <button
              type="button"
              onClick={() => setHidden((v) => !v)}
              className="rounded p-0.5 text-binance-muted hover:text-binance-text"
              aria-label={hidden ? "Show balances" : "Hide balances"}
            >
              {hidden ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
            {loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-binance-muted" />
            )}
          </div>

          {error && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-binance-bear">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setRetryKey((k) => k + 1)}
                className="rounded border border-binance-bear/40 px-2 py-0.5 text-xs text-binance-text hover:bg-binance-elevated"
              >
                Retry
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[1.75rem] font-semibold tracking-tight tabular-nums text-binance-text sm:text-4xl">
              {metrics
                ? mask(formatInr(metrics.totalValue))
                : loading
                  ? "—"
                  : "0.00"}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-sm font-medium text-binance-muted"
              disabled
              title="Paper account settles in INR"
            >
              INR
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </button>
          </div>

          <p className="text-sm tabular-nums text-binance-muted">
            {metrics
              ? mask(`≈ ₹${formatInr(metrics.cashBalance)} cash`)
              : "≈ ₹— cash"}
            {metrics && !hidden
              ? ` · ${metrics.openCount} open`
              : ""}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1 text-sm text-binance-muted">
              Today&apos;s PnL
              <span
                title="Closed-today realized + open unrealized (paper). Heuristic — not a broker statement."
                className="inline-flex"
              >
                <Info className="h-3.5 w-3.5" />
              </span>
            </span>
            <span
              className={`text-sm font-semibold tabular-nums ${
                pnlPositive ? "text-binance-bull" : "text-binance-bear"
              }`}
            >
              {metrics
                ? mask(
                    `${pnlPositive ? "+" : ""}₹${formatInr(metrics.todayPnl)}(${pnlPositive ? "+" : ""}${metrics.todayPct.toFixed(2)}%)`,
                  )
                : "—"}
            </span>
            {metrics && !hidden && (
              <span className="text-xs text-binance-muted">
                Total{" "}
                <span
                  className={
                    metrics.totalPnl >= 0
                      ? "text-binance-bull"
                      : "text-binance-bear"
                  }
                >
                  {metrics.totalPnl >= 0 ? "+" : ""}₹
                  {formatInr(metrics.totalPnl, 0)}
                </span>
                {" "}vs start
              </span>
            )}
          </div>
        </div>

        {/* Right — actions + sparkline */}
        <div className="flex min-w-0 flex-col items-stretch gap-4 lg:w-[min(100%,360px)] lg:items-end">
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap lg:justify-end">
            <Link
              href="/paper"
              className="rounded-lg bg-binance-surface px-2 py-2.5 text-center text-xs font-medium text-binance-text transition hover:bg-binance-border/60 sm:px-3.5 sm:py-2 sm:text-sm"
            >
              Paper
            </Link>
            <Link
              href="/analysis"
              className="rounded-lg bg-binance-surface px-2 py-2.5 text-center text-xs font-medium text-binance-text transition hover:bg-binance-border/60 sm:px-3.5 sm:py-2 sm:text-sm"
            >
              Analysis
            </Link>
            <Link
              href="/backtest"
              className="rounded-lg bg-binance-surface px-2 py-2.5 text-center text-xs font-medium text-binance-text transition hover:bg-binance-border/60 sm:px-3.5 sm:py-2 sm:text-sm"
            >
              Record
            </Link>
          </div>

          <div className="mt-auto w-full opacity-90">
            {metrics ? (
              <Sparkline values={metrics.series} />
            ) : (
              <div className="h-18 w-full rounded bg-binance-surface/40" />
            )}
          </div>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-binance-muted">
        Paper account only · Buy max-loss = premium paid · Sell/write risk is
        uncapped (CE) / large (PE)
      </p>
    </motion.section>
  );
}
