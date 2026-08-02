"use client";

import { LiveBadge } from "@/components/LiveBadge";
import { theme } from "@/lib/theme";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

export type ChartTradeLevels = {
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
};

/** Stage 5 SL-cluster / S-R lines (colors distinct from candle bull/bear). */
export type ChartClusterLevel = {
  price: number;
  kind: "support" | "resistance";
  label: string;
};

type CandleBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type CandlesResponse =
  | {
      ok: true;
      timeframeLabel: string;
      demoMode: boolean;
      source?: "yahoo" | "angel";
      fetchedAt: string;
      candles: CandleBar[];
    }
  | { ok: false; error?: string; uiHint?: string };

type Props = {
  underlying: Underlying;
  mode: "SCALP" | "SWING";
  /** Live LTP from dashboard SSE — updates the forming candle. */
  liveLtp: number | null;
  live: boolean;
  levels?: ChartTradeLevels | null;
  /** Optional stop-loss cluster horizontals (Scalp Stage 5). */
  clusterLevels?: ChartClusterLevel[] | null;
};

const REFRESH_MS = 30_000;
/** Reject live patch if LTP is far from last close (wrong series / stale mock). */
const MAX_LIVE_GAP_PCT = 0.005; // 0.5%

function toBar(c: CandleBar): CandlestickData {
  return {
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function applyLiveToLast(
  bars: CandlestickData[],
  ltp: number,
): CandlestickData[] {
  if (bars.length === 0 || !Number.isFinite(ltp)) return bars;
  const last = bars[bars.length - 1]!;
  const basis = Math.abs(last.close) || 1;
  const gapPct = Math.abs(ltp - last.close) / basis;
  // Do not stretch a candle across mismatched feeds (demo mock vs live NSE).
  if (gapPct > MAX_LIVE_GAP_PCT) return bars;
  const next = {
    ...last,
    close: ltp,
    high: Math.max(last.high, ltp),
    low: Math.min(last.low, ltp),
  };
  return [...bars.slice(0, -1), next];
}

export function AnalysisLiveChart({
  underlying,
  mode,
  liveLtp,
  live,
  levels,
  clusterLevels,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const barsRef = useRef<CandlestickData[]>([]);
  const liveLtpRef = useRef(liveLtp);
  const levelsRef = useRef(levels);
  const clusterRef = useRef(clusterLevels);
  liveLtpRef.current = liveLtp;
  levelsRef.current = levels;
  clusterRef.current = clusterLevels;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [candleSource, setCandleSource] = useState<"yahoo" | "angel" | null>(
    null,
  );
  const [tfLabel, setTfLabel] = useState(mode === "SCALP" ? "5m" : "1h");
  const [displayLtp, setDisplayLtp] = useState<number | null>(liveLtp);

  function clearPriceLines(series: ISeriesApi<"Candlestick">) {
    for (const line of linesRef.current) {
      series.removePriceLine(line);
    }
    linesRef.current = [];
  }

  function paintPriceLines(
    series: ISeriesApi<"Candlestick">,
    next: ChartTradeLevels | null | undefined,
    clusters?: ChartClusterLevel[] | null,
  ) {
    clearPriceLines(series);
    if (next) {
      const specs: Array<{
        price: number | null;
        color: string;
        title: string;
      }> = [
        { price: next.entry, color: theme.colors.gold, title: "Entry" },
        { price: next.stopLoss, color: theme.colors.bear, title: "SL" },
        { price: next.takeProfit1, color: theme.colors.bull, title: "TP1" },
        { price: next.takeProfit2, color: theme.colors.bull, title: "TP2" },
      ];
      for (const s of specs) {
        if (s.price == null || !Number.isFinite(s.price)) continue;
        linesRef.current.push(
          series.createPriceLine({
            price: s.price,
            color: s.color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: s.title,
          }),
        );
      }
    }
    // SL clusters: solid lines, blue support / violet resistance (not candle colors)
    if (clusters?.length) {
      // Cap to strongest few so the chart stays readable
      const top = [...clusters]
        .sort((a, b) => {
          // prefer stronger labels later if strength embedded; keep order by kind then price
          return a.price - b.price;
        })
        .slice(0, 8);
      for (const c of top) {
        if (!Number.isFinite(c.price)) continue;
        linesRef.current.push(
          series.createPriceLine({
            price: c.price,
            color:
              c.kind === "support"
                ? theme.colors.clusterSupport
                : theme.colors.clusterResistance,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: c.label,
          }),
        );
      }
    }
  }

  // Create / destroy chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.colors.surface },
        textColor: theme.colors.muted,
        fontFamily: "var(--font-ibm-plex-sans), system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: theme.colors.border },
        horzLines: { color: theme.colors.border },
      },
      rightPriceScale: {
        borderColor: theme.colors.border,
      },
      timeScale: {
        borderColor: theme.colors.border,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: {
          color: theme.colors.muted,
          labelBackgroundColor: theme.colors.elevated,
        },
        horzLine: {
          color: theme.colors.muted,
          labelBackgroundColor: theme.colors.elevated,
        },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: theme.colors.bull,
      downColor: theme.colors.bear,
      borderUpColor: theme.colors.bull,
      borderDownColor: theme.colors.bear,
      wickUpColor: theme.colors.bull,
      wickDownColor: theme.colors.bear,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    paintPriceLines(series, levelsRef.current, clusterRef.current);

    return () => {
      linesRef.current = [];
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  // Fetch candles (mode / underlying) + periodic refresh
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const res = await fetch(
          `/api/analysis/candles?underlying=${underlying}&mode=${mode}`,
        );
        const json = (await res.json()) as CandlesResponse;
        if (cancelled) return;
        if (!json.ok) {
          setError(json.uiHint ?? json.error ?? "Candles unavailable");
          setLoading(false);
          return;
        }

        let bars = json.candles.map(toBar);
        const ltp = liveLtpRef.current;
        if (ltp != null) bars = applyLiveToLast(bars, ltp);
        barsRef.current = bars;
        seriesRef.current?.setData(bars);
        chartRef.current?.timeScale().fitContent();
        setTfLabel(json.timeframeLabel);
        setDemoMode(json.demoMode);
        setCandleSource(json.source ?? null);
        setDisplayLtp(ltp ?? bars[bars.length - 1]?.close ?? null);
        setError(null);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load candles");
          setLoading(false);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(load, REFRESH_MS);
        }
      }
    };

    setLoading(true);
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [underlying, mode]);

  // Patch forming candle with live LTP (SSE / hub)
  useEffect(() => {
    setDisplayLtp(liveLtp);
    if (liveLtp == null || !seriesRef.current || barsRef.current.length === 0) {
      return;
    }
    const next = applyLiveToLast(barsRef.current, liveLtp);
    barsRef.current = next;
    seriesRef.current.update(next[next.length - 1]!);
  }, [liveLtp]);

  // Trade-plan + SL-cluster price lines
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    paintPriceLines(series, levels, clusterLevels);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paintPriceLines is stable enough here
  }, [levels, clusterLevels]);

  return (
    <div className="flex h-full min-h-72 flex-col overflow-hidden rounded-lg border border-binance-border bg-binance-surface sm:min-h-105">
      <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
          Live chart
        </p>
        <span className="text-sm font-medium text-binance-text">{underlying}</span>
        <span className="text-xs text-binance-muted">{tfLabel}</span>
        <LiveBadge active={live && !loading && !error} />
        {displayLtp != null && (
          <span className="ml-auto font-mono text-sm tabular-nums text-binance-text">
            {displayLtp.toLocaleString("en-IN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-binance-surface/70 text-sm text-binance-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading candles…
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex items-start justify-center bg-binance-surface/80 p-4 text-sm text-binance-bear">
            <span className="inline-flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </span>
          </div>
        )}
      </div>

      <p className="border-t border-binance-border px-4 py-2 text-[11px] text-binance-muted">
        {candleSource === "yahoo"
          ? "Yahoo public OHLC · forming bar synced to live spot when within 0.5%"
          : candleSource === "angel"
            ? "Angel One OHLC · forming bar synced to live spot when within 0.5%"
            : demoMode
              ? "Public OHLC · live spot sync"
              : "Live OHLC"}
        {" · "}Entry / SL / TP dashed when synthesis is run
        {" · "}Scalp SL-clusters: blue support / violet resistance
      </p>
    </div>
  );
}
