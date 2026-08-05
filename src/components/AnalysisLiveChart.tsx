"use client";

import { ChartAiLoader } from "@/components/ChartAiLoader";
import { LiveBadge } from "@/components/LiveBadge";
import {
  SCALP_CHART_TFS,
  type ScalpChartTf,
} from "@/lib/marketdata/analysisCandles";
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
  type LogicalRange,
  type UTCTimestamp,
} from "lightweight-charts";
import { AlertTriangle, Maximize2, Minimize2 } from "lucide-react";
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
  /**
   * Optional SMC overlay horizontals (Stage 8) — theme.smc* colors only.
   * Does not alter SL-cluster blue/violet rendering.
   */
  smcLevels?: Array<{
    price: number;
    color: string;
    title: string;
    style: "solid" | "dashed";
  }> | null;
  /** Multi-chart page: shorter panel, no trade-plan footer copy. */
  compact?: boolean;
};

const REFRESH_MS = 30_000;
/** Reject live patch if LTP is far from last close (wrong series / stale mock). */
const MAX_LIVE_GAP_PCT = 0.005; // 0.5%

const OVERLAY_STORAGE_KEY = "nse-chart-overlays";

/** Which price-line layers to draw — independent toggles (Clean = all off). */
type OverlayVisibility = {
  smc: boolean;
  /** Entry / SL / TP1 / TP2 from §2.5 synthesis */
  verdict: boolean;
  /** Scalp Stage 5 SL-cluster S/R — kept with verdict to avoid a 4th chip */
  clusters: boolean;
};

/** Default: Verdict on (Entry/SL/TP), SMC off — avoids the mixed-overlay mess. */
const DEFAULT_OVERLAYS: OverlayVisibility = {
  smc: false,
  verdict: true,
  clusters: false,
};

function readOverlayVisibility(): OverlayVisibility {
  try {
    const raw = sessionStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OVERLAYS };
    const parsed = JSON.parse(raw) as Partial<OverlayVisibility>;
    return {
      smc: Boolean(parsed.smc),
      verdict: parsed.verdict !== false,
      clusters: Boolean(parsed.clusters),
    };
  } catch {
    return { ...DEFAULT_OVERLAYS };
  }
}

function writeOverlayVisibility(state: OverlayVisibility) {
  try {
    sessionStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode / quota — ignore
  }
}

type ChartViewState = {
  logical: { from: number; to: number };
  price: { from: number; to: number } | null;
  autoScale: boolean;
};

function chartViewKey(
  underlying: Underlying,
  mode: "SCALP" | "SWING",
  tf: string,
): string {
  return `nse-chart-view:${underlying}:${mode}:${tf}`;
}

function readChartView(key: string): ChartViewState | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChartViewState;
    if (
      !parsed?.logical ||
      !Number.isFinite(parsed.logical.from) ||
      !Number.isFinite(parsed.logical.to)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeChartView(key: string, state: ChartViewState) {
  try {
    sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // private mode / quota — ignore
  }
}

function clearChartView(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Reject saved Y-zoom that belongs to a different index (e.g. Nifty ~24k on Bank Nifty ~57k). */
function savedPriceMatchesBars(
  price: { from: number; to: number } | null | undefined,
  bars: CandlestickData[],
): boolean {
  if (!price || bars.length === 0) return true; // no locked Y → ok
  if (
    !Number.isFinite(price.from) ||
    !Number.isFinite(price.to) ||
    price.to <= price.from
  ) {
    return false;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  // Must overlap data extent
  if (price.to < lo || price.from > hi) return false;
  const dataMid = (lo + hi) / 2;
  const viewMid = (price.from + price.to) / 2;
  const basis = Math.abs(dataMid) || 1;
  // Nifty vs Bank Nifty mids differ by ~50%+ — reject anything >8% off
  return Math.abs(viewMid - dataMid) / basis <= 0.08;
}

function resetChartViewToData(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
) {
  series.priceScale().setAutoScale(true);
  chart.timeScale().fitContent();
}

function captureChartView(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
): ChartViewState | null {
  const logical = chart.timeScale().getVisibleLogicalRange();
  if (!logical) return null;
  const ps = series.priceScale();
  return {
    logical: { from: logical.from, to: logical.to },
    price: ps.getVisibleRange(),
    autoScale: ps.options().autoScale,
  };
}

function applyChartView(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  state: ChartViewState,
) {
  chart.timeScale().setVisibleLogicalRange(state.logical as LogicalRange);
  const ps = series.priceScale();
  if (!state.autoScale && state.price) {
    ps.setAutoScale(false);
    ps.setVisibleRange(state.price);
  } else {
    ps.setAutoScale(true);
  }
}

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
  smcLevels,
  compact = false,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [candleSource, setCandleSource] = useState<"yahoo" | "angel" | null>(
    null,
  );
  const [scalpTf, setScalpTf] = useState<ScalpChartTf>("5m");
  const [tfLabel, setTfLabel] = useState(mode === "SCALP" ? "5m" : "1h");
  const [displayLtp, setDisplayLtp] = useState<number | null>(liveLtp);
  const [overlays, setOverlays] = useState<OverlayVisibility>(DEFAULT_OVERLAYS);
  const [fullscreen, setFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const barsRef = useRef<CandlestickData[]>([]);
  const liveLtpRef = useRef(liveLtp);
  const levelsRef = useRef(levels);
  const clusterRef = useRef(clusterLevels);
  const smcRef = useRef(smcLevels);
  const overlaysRef = useRef(overlays);
  /** True after first successful candle paint for current underlying/mode/tf. */
  const viewInitializedRef = useRef(false);
  /** Skip session writes while we programmatically restore zoom. */
  const applyingViewRef = useRef(false);
  const viewKeyRef = useRef("");
  liveLtpRef.current = liveLtp;
  levelsRef.current = levels;
  clusterRef.current = clusterLevels;
  smcRef.current = smcLevels;
  overlaysRef.current = overlays;

  // Hydrate overlay prefs after mount (sessionStorage is client-only)
  useEffect(() => {
    setOverlays(readOverlayVisibility());
  }, []);

  // Esc closes fullscreen; lock body scroll while open
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  const activeTf = mode === "SCALP" ? scalpTf : "1h";
  viewKeyRef.current = chartViewKey(underlying, mode, activeTf);

  const isClean = !overlays.smc && !overlays.verdict;

  function setOverlayState(next: OverlayVisibility) {
    setOverlays(next);
    writeOverlayVisibility(next);
  }

  function selectClean() {
    setOverlayState({ smc: false, verdict: false, clusters: false });
  }

  function toggleSmc() {
    setOverlayState({
      ...overlays,
      smc: !overlays.smc,
    });
  }

  function toggleVerdict() {
    const next = !overlays.verdict;
    setOverlayState({
      ...overlays,
      verdict: next,
      // Verdict chip = Entry / SL / TP only (clusters off — were mixing with SMC)
      clusters: false,
    });
  }

  // Reset default TF when switching Scalp ↔ Swing
  useEffect(() => {
    if (mode === "SWING") setTfLabel("1h");
    else setTfLabel(scalpTf);
  }, [mode, scalpTf]);

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
    smc?: Props["smcLevels"],
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
      // Cap nearest few so Verdict layer stays readable next to Entry/SL/TP
      const top = [...clusters]
        .sort((a, b) => a.price - b.price)
        .slice(0, 4);
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
    // SMC overlays (Stage 8): theme.smc* only — separate from SL-cluster colors
    if (smc?.length) {
      for (const s of smc.slice(0, 12)) {
        if (!Number.isFinite(s.price)) continue;
        linesRef.current.push(
          series.createPriceLine({
            price: s.price,
            color: s.color,
            lineWidth: 1,
            lineStyle:
              s.style === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
            axisLabelVisible: true,
            title: s.title,
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
    const o = overlaysRef.current;
    paintPriceLines(
      series,
      o.verdict ? levelsRef.current : null,
      o.clusters ? clusterRef.current : null,
      o.smc ? smcRef.current : null,
    );

    const persistView = () => {
      if (applyingViewRef.current || !viewInitializedRef.current) return;
      const state = captureChartView(chart, series);
      if (!state) return;
      writeChartView(viewKeyRef.current, state);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(persistView);
    el.addEventListener("pointerup", persistView);
    el.addEventListener("wheel", persistView, { passive: true });

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(persistView);
      el.removeEventListener("pointerup", persistView);
      el.removeEventListener("wheel", persistView);
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
    // New series key → allow restore / fitContent once, then preserve view
    viewInitializedRef.current = false;
    const seriesKey = chartViewKey(
      underlying,
      mode,
      mode === "SCALP" ? scalpTf : "1h",
    );
    viewKeyRef.current = seriesKey;

    const load = async () => {
      try {
        const tfQs =
          mode === "SCALP" ? `&tf=${encodeURIComponent(scalpTf)}` : "";
        const res = await fetch(
          `/api/analysis/candles?underlying=${underlying}&mode=${mode}${tfQs}`,
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

        const chart = chartRef.current;
        const series = seriesRef.current;
        // Keep zoom / pan / Y-stretch across live refreshes — never fitContent again
        const priorView =
          viewInitializedRef.current && chart && series
            ? captureChartView(chart, series)
            : null;

        barsRef.current = bars;
        series?.setData(bars);

        if (chart && series) {
          applyingViewRef.current = true;
          try {
            if (priorView && savedPriceMatchesBars(priorView.price, bars)) {
              applyChartView(chart, series, priorView);
            } else {
              const saved = readChartView(seriesKey);
              if (
                saved &&
                savedPriceMatchesBars(saved.price, bars)
              ) {
                applyChartView(chart, series, saved);
              } else {
                if (saved) clearChartView(seriesKey);
                resetChartViewToData(chart, series);
              }
              viewInitializedRef.current = true;
            }
          } finally {
            // Defer so library range-change events from setVisible* settle first
            requestAnimationFrame(() => {
              applyingViewRef.current = false;
            });
          }
        }

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
  }, [underlying, mode, scalpTf]);

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

  // Trade-plan + SL-cluster + SMC overlay price lines (respect visibility toggles)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    paintPriceLines(
      series,
      overlays.verdict ? levels : null,
      overlays.clusters ? clusterLevels : null,
      overlays.smc ? smcLevels : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paintPriceLines is stable enough here
  }, [levels, clusterLevels, smcLevels, overlays]);

  return (
    <>
      {fullscreen && (
        <div
          className={`w-full ${
            compact ? "min-h-120 sm:min-h-140" : "min-h-112 sm:min-h-105"
          }`}
          aria-hidden
        />
      )}
      {fullscreen && (
        <button
          type="button"
          aria-label="Close fullscreen chart"
          className="fixed inset-0 z-[60] cursor-default bg-binance-bg/80"
          onClick={() => setFullscreen(false)}
        />
      )}
      <div
        className={
          fullscreen
            ? "fixed inset-2 z-[70] flex flex-col overflow-hidden rounded-lg border border-binance-border bg-binance-surface shadow-2xl sm:inset-4"
            : `flex h-full flex-col overflow-hidden rounded-lg border border-binance-border bg-binance-surface ${
                compact ? "min-h-120 sm:min-h-140" : "min-h-112 sm:min-h-105"
              }`
        }
        role={fullscreen ? "dialog" : undefined}
        aria-modal={fullscreen || undefined}
        aria-label={
          fullscreen ? `${underlying} live chart fullscreen` : undefined
        }
      >
      <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-3 py-2.5 sm:px-4 sm:py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
          Live chart
        </p>
        <span className="text-sm font-medium text-binance-text">{underlying}</span>
        {mode === "SCALP" ? (
          <div
            className="inline-flex rounded-md bg-binance-elevated p-0.5"
            role="group"
            aria-label="Chart timeframe"
          >
            {SCALP_CHART_TFS.map((tf) => {
              const active = scalpTf === tf;
              return (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setScalpTf(tf)}
                  className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-binance-gold text-binance-bg"
                      : "text-binance-muted hover:text-binance-text"
                  }`}
                >
                  {tf}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-binance-muted">{tfLabel}</span>
        )}
        <div
          className="inline-flex rounded-md bg-binance-elevated p-0.5"
          role="group"
          aria-label="Chart overlays"
        >
          {(
            [
              {
                id: "clean" as const,
                label: "Clean",
                active: isClean,
                onClick: selectClean,
                title: "Candles only — hide all overlay lines",
              },
              {
                id: "smc" as const,
                label: "SMC",
                active: overlays.smc,
                onClick: toggleSmc,
                title: "Smart Money Concepts levels (OB / BSL / SSL / FVG)",
              },
              {
                id: "verdict" as const,
                label: "Verdict",
                active: overlays.verdict,
                onClick: toggleVerdict,
                title: "Synthesis Entry / SL / TP levels",
              },
            ] as const
          ).map((btn) => (
            <button
              key={btn.id}
              type="button"
              onClick={btn.onClick}
              title={btn.title}
              aria-pressed={btn.active}
              className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
                btn.active
                  ? "bg-binance-gold text-binance-bg"
                  : "text-binance-muted hover:text-binance-text"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <LiveBadge active={live && !loading && !error} />
        <div className="ml-auto flex items-center gap-2">
          {displayLtp != null && (
            <span className="font-mono text-sm tabular-nums text-binance-text">
              {displayLtp.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          )}
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen chart"}
            aria-label={fullscreen ? "Exit fullscreen chart" : "Open chart fullscreen"}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-binance-muted transition-colors hover:bg-binance-elevated hover:text-binance-gold"
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {loading && (
          <ChartAiLoader label={underlying} compact={compact && !fullscreen} />
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

      {(!compact || fullscreen) && (
        <p className="border-t border-binance-border px-4 py-2 text-[11px] text-binance-muted">
          {candleSource === "yahoo"
            ? "Yahoo public OHLC · forming bar synced to live spot when within 0.5%"
            : candleSource === "angel"
              ? "Angel One OHLC · forming bar synced to live spot when within 0.5%"
              : demoMode
                ? "Public OHLC · live spot sync"
                : "Live OHLC"}
          {" · "}
          {mode === "SCALP" ? "3m / 5m / 15m · " : "1h · "}
          Overlays: Clean / SMC / Verdict (SMC + Verdict can both be on)
          {fullscreen ? " · Esc to exit fullscreen" : ""}
        </p>
      )}
    </div>
    </>
  );
}
