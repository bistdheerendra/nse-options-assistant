"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

type HeatmapCell = {
  ticker: string;
  name: string;
  weightPct: number;
  ltp: number | null;
  changePct: number | null;
  pointsEst: number | null;
};

type HeatmapResponse =
  | {
      ok: true;
      underlying: Underlying;
      indexLevel: number | null;
      cells: HeatmapCell[];
      note: string;
      netPointsEst: number | null;
      fetchedAt: string;
      source: string;
    }
  | { ok: false; error?: string; uiHint?: string };

type Props = {
  underlying: Underlying;
};

const REFRESH_MS = 45_000;

function cellTone(changePct: number | null): {
  bg: string;
  text: string;
} {
  if (changePct == null || !Number.isFinite(changePct)) {
    return { bg: "bg-binance-elevated", text: "text-binance-muted" };
  }
  const abs = Math.abs(changePct);
  const strong = abs >= 1.5;
  const mid = abs >= 0.6;
  if (changePct > 0) {
    return {
      bg: strong
        ? "bg-binance-bull/35"
        : mid
          ? "bg-binance-bull/20"
          : "bg-binance-bull/10",
      text: "text-binance-bull",
    };
  }
  if (changePct < 0) {
    return {
      bg: strong
        ? "bg-binance-bear/35"
        : mid
          ? "bg-binance-bear/20"
          : "bg-binance-bear/10",
      text: "text-binance-bear",
    };
  }
  return { bg: "bg-binance-elevated", text: "text-binance-muted" };
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPts(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}`;
}

function titleFor(u: Underlying): string {
  if (u === "BANKNIFTY") return "Bank Nifty drivers";
  if (u === "SENSEX") return "Sensex drivers";
  return "Nifty 50 drivers";
}

/**
 * Constituent heatmap with estimated index-point contribution.
 */
export function IndexDriversHeatmap({ underlying }: Props) {
  const [cells, setCells] = useState<HeatmapCell[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [netPointsEst, setNetPointsEst] = useState<number | null>(null);
  const [indexLevel, setIndexLevel] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/analysis/heatmap?underlying=${underlying}`,
      );
      const json = (await res.json()) as HeatmapResponse;
      if (!res.ok || !json.ok) {
        throw new Error(
          !json.ok
            ? (json.uiHint ?? json.error ?? "Unavailable")
            : "Unavailable",
        );
      }
      setCells(json.cells);
      setNote(json.note);
      setNetPointsEst(json.netPointsEst);
      setIndexLevel(json.indexLevel);
      setFetchedAt(json.fetchedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load heatmap");
      setCells([]);
    } finally {
      setLoading(false);
    }
  }, [underlying]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="overflow-hidden rounded-lg border border-binance-border bg-binance-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
          Heatmap
        </p>
        <h2 className="text-sm font-semibold text-binance-text">
          {titleFor(underlying)}
        </h2>
        {indexLevel != null && (
          <span className="text-xs tabular-nums text-binance-muted">
            @ {indexLevel.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </span>
        )}
        {netPointsEst != null && (
          <span
            className={`rounded border px-2 py-0.5 text-xs font-semibold tabular-nums ${
              netPointsEst > 0.5
                ? "border-binance-bull/40 text-binance-bull"
                : netPointsEst < -0.5
                  ? "border-binance-bear/40 text-binance-bear"
                  : "border-binance-border text-binance-muted"
            }`}
            title="Sum of estimated contribution points (shown names only)"
          >
            Est. net {fmtPts(netPointsEst)} pts
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded border border-binance-border px-2 py-1 text-xs text-binance-muted hover:border-binance-gold hover:text-binance-gold disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <p className="px-4 py-3 text-sm text-binance-bear">{error}</p>
      )}

      {!error && cells.length === 0 && loading && (
        <div className="flex items-center gap-2 px-4 py-8 text-sm text-binance-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading drivers…
        </div>
      )}

      {cells.length > 0 && (
        <div
          className="grid w-full gap-1.5 p-3"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          }}
        >
          {cells.map((c) => {
            const tone = cellTone(c.changePct);
            return (
              <div
                key={c.ticker}
                title={`${c.name}: ${fmtPct(c.changePct)} → est. ${fmtPts(c.pointsEst)} index pts (wt ~${c.weightPct.toFixed(1)}%)`}
                className={`${tone.bg} flex min-h-[80px] w-full flex-col justify-between rounded border border-binance-border/60 px-2.5 py-2`}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-binance-text">
                    {c.ticker}
                  </p>
                  <p className="truncate text-[10px] text-binance-muted">
                    {c.name}
                  </p>
                </div>
                <div className="mt-1 space-y-0.5">
                  <p
                    className={`font-mono text-base font-bold tabular-nums leading-none ${tone.text}`}
                  >
                    {fmtPts(c.pointsEst)}
                    <span className="ml-0.5 text-[10px] font-medium opacity-80">
                      pts
                    </span>
                  </p>
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`font-mono text-[11px] tabular-nums ${tone.text}`}
                    >
                      {fmtPct(c.changePct)}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-binance-muted">
                      ~{c.weightPct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="border-t border-binance-border px-4 py-2 text-[11px] leading-relaxed text-binance-muted">
        {note ??
          "Est. pts = weight% × day% × index ÷ 10000 · sorted by |points|"}
        {fetchedAt
          ? ` · ${new Date(fetchedAt).toLocaleTimeString("en-IN")}`
          : ""}
      </p>
    </section>
  );
}
