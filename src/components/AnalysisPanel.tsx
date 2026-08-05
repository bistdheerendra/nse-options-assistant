"use client";

import { AnalysisLiveChart } from "@/components/AnalysisLiveChart";
import { SmcSignalCard } from "@/components/analysis/SmcSignalCard";
import { ChartAiLoader } from "@/components/ChartAiLoader";
import { IndexDriversHeatmap } from "@/components/IndexDriversHeatmap";
import { LiquidityStatusBadge } from "@/components/LiquidityStatusBadge";
import { ModeToggle } from "@/components/ModeToggle";
import { ScalpSignalCard } from "@/components/ScalpSignalCard";
import type { SmcSignal } from "@/lib/marketdata/smc";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import { useScalpCandlesLiveStream } from "@/hooks/useScalpCandlesLiveStream";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

const AUTO_PAPER_LS_KEY = "nse:scalpAutoPaper";
const AUTO_PAPER_ACK_LS_KEY = "nse:scalpAutoPaperAckSell";
/** Poll interval when auto-paper toggle is ON (Scalp mode only). */
const AUTO_PAPER_POLL_MS = 60_000;
/** SCALP NEUTRAL badge: Technical vs OF opposite signs and |Δ| above this. */
const LANES_DISAGREE_SCORE_GAP = 0.4;

function parseUnderlying(raw: string | null): Underlying {
  if (raw === "BANKNIFTY" || raw === "SENSEX" || raw === "NIFTY") return raw;
  return "NIFTY";
}

type SynthesisPayload = {
  underlying: string;
  mode: string;
  spot: number;
  expiry: string;
  directional: {
    verdict: string;
    combinedScore: number;
    notes: string[];
    components: Record<string, number>;
  };
  structure: {
    branch: string;
    action: string;
    optionType: string | null;
    isSellWrite: boolean;
    reasoning: string;
    riskWarning: string | null;
  };
  lanes: Record<string, { score: number; signals: string[] }>;
  confidenceLabel: string;
  scalpLiquidityWarning: string | null;
  scalpLiquidity: {
    status: "pass" | "fail" | "warn" | "unavailable";
    badgeLabel: string;
    warning: string | null;
    counts: {
      evaluated: number;
      unsuitable: number;
      high: number;
      medium: number;
      low: number;
    };
    focus: {
      strike: number;
      optionType: "CE" | "PE";
      spreadPct: number | null;
      volume: number;
      oi: number;
    } | null;
  } | null;
  stopLossClusters: {
    levels: Array<{
      price: number;
      kind: "support" | "resistance";
      label: string;
      strength: number;
    }>;
    support: Array<{ price: number; label: string; strength: number }>;
    resistance: Array<{ price: number; label: string; strength: number }>;
  } | null;
  oiVelocity: {
    status: "ready" | "warming_up" | "unavailable";
    netVelocityPerMin: number | null;
    callVelocityPerMin: number | null;
    putVelocityPerMin: number | null;
    notable: boolean;
    signals: string[];
  } | null;
  scalpSignal: {
    timeframeConfluence: {
      bullish: string[];
      bearish: string[];
      ranging: string[];
      dominant: "bullish" | "bearish" | null;
    };
    primaryPattern: string | null;
    patternTimeframe: string | null;
    volumeConfirmation: string;
    liquidityStatus: "pass" | "fail" | "warn" | "unavailable";
    liquidityBadge: string;
    stopLossClusters: {
      nearestSupport: number | null;
      nearestResistance: number | null;
    };
    oiVelocity: {
      status: string;
      netPerMin: number | null;
      notable: boolean;
      reading: string;
    };
    confirmation: {
      status: string;
      direction: string | null;
      reason: string;
      reliabilityNote: string;
    };
    actionable: boolean;
    actionableNote: string;
  } | null;
  swingThetaWarning: string | null;
  daysToExpiry: number | null;
  tradeIdeaId: string | null;
  persisted: boolean;
  regime: {
    regime: string;
    atr: number | null;
    atrPct: number | null;
    note: string;
  };
  alignment: {
    alignedCount: number;
    activeCount: number;
    label: string;
  };
  tradePlan: {
    entry: number;
    stopLoss: number | null;
    takeProfit1: number | null;
    takeProfit2: number | null;
    riskReward: number | null;
    timeframeLabel: string;
    sideLabel: "LONG" | "SHORT" | "FLAT";
    summary: string;
    suggestedContract: {
      strike: number;
      optionType: "CE" | "PE";
      expiry: string;
      lotSize: number;
      entryPremium: number;
      tradingsymbol: string;
      symboltoken: string;
      premiumStopHint: number | null;
      delta: number | null;
    } | null;
  };
  experimentalEdge: {
    winRatePct: number | null;
    sampleSize: number;
    label: string;
    experimental: true;
    insufficientSample?: boolean;
    legacySampleSize?: number;
  };
  /** SCALP 5m + SWING 1h post-synthesis gate */
  priceSlopeGate: {
    slopePct: number;
    slopeDirection: "up" | "down" | "flat";
    slopeStrong: boolean;
    lookbackBars: number;
    timeframe: string;
    strongThresholdPct?: number;
    computable: boolean;
    applied: boolean;
    conflictReason: "price_slope_opposes_verdict" | null;
    preGateVerdict: string | null;
    preGateStructureBranch: string | null;
  } | null;
};

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function AnalysisPanel() {
  const searchParams = useSearchParams();
  const [underlying, setUnderlying] = useState<Underlying>(() =>
    parseUnderlying(searchParams.get("underlying")),
  );
  const [mode, setMode] = useState<"SCALP" | "SWING">("SCALP");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SynthesisPayload | null>(null);
  const [ackSell, setAckSell] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markMsg, setMarkMsg] = useState<string | null>(null);
  const [markOk, setMarkOk] = useState(false);
  const [autoPaper, setAutoPaper] = useState(false);
  const [autoAckSell, setAutoAckSell] = useState(false);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [smcSignal, setSmcSignal] = useState<SmcSignal | null>(null);
  const [smcMeta, setSmcMeta] = useState<{
    trend?: string;
    zone?: string;
    degraded?: boolean;
  } | null>(null);
  const [smcLevels, setSmcLevels] = useState<
    Array<{
      price: number;
      color: string;
      title: string;
      style: "solid" | "dashed";
    }> | null
  >(null);
  const autoInFlight = useRef(false);

  // Restore opt-in auto-paper prefs (default OFF)
  useEffect(() => {
    try {
      setAutoPaper(localStorage.getItem(AUTO_PAPER_LS_KEY) === "true");
      setAutoAckSell(localStorage.getItem(AUTO_PAPER_ACK_LS_KEY) === "true");
    } catch {
      // ignore
    }
  }, []);

  const persistAutoPaper = useCallback((on: boolean) => {
    setAutoPaper(on);
    try {
      localStorage.setItem(AUTO_PAPER_LS_KEY, on ? "true" : "false");
    } catch {
      // ignore
    }
  }, []);

  const persistAutoAckSell = useCallback((on: boolean) => {
    setAutoAckSell(on);
    try {
      localStorage.setItem(AUTO_PAPER_ACK_LS_KEY, on ? "true" : "false");
    } catch {
      // ignore
    }
  }, []);

  const runAutoPaper = useCallback(async () => {
    if (autoInFlight.current) return;
    autoInFlight.current = true;
    setAutoRunning(true);
    try {
      const res = await fetch("/api/cron/scalp-auto-paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          underlying,
          acknowledgeSellRisk: autoAckSell,
        }),
      });
      const json = (await res.json()) as {
        openedCount?: number;
        items?: Array<{
          underlying: string;
          opened: boolean;
          detail: string;
          skipped?: string;
        }>;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Auto paper failed");

      const item = json.items?.find((i) => i.underlying === underlying);
      const opened = json.openedCount ?? 0;
      if (opened > 0 && item?.opened) {
        setMarkOk(true);
        setMarkMsg(item.detail);
        setAutoStatus(`Auto paper opened: ${item.detail}`);
      } else {
        setAutoStatus(
          item
            ? `Auto check: ${item.detail}`
            : `Auto check done — opened ${opened}`,
        );
      }
    } catch (e) {
      setAutoStatus(e instanceof Error ? e.message : "Auto paper error");
    } finally {
      autoInFlight.current = false;
      setAutoRunning(false);
    }
  }, [underlying, autoAckSell]);

  // Poll while auto-paper ON + Scalp mode (paper only)
  useEffect(() => {
    if (!autoPaper || mode !== "SCALP") return;
    void runAutoPaper();
    const id = setInterval(() => {
      void runAutoPaper();
    }, AUTO_PAPER_POLL_MS);
    return () => clearInterval(id);
  }, [autoPaper, mode, runAutoPaper]);

  const { cards, live } = useDashboardLiveStream();
  const liveLtp = useMemo(() => {
    const card = cards.find((c) => c.id === underlying);
    return card && Number.isFinite(card.ltp) ? card.ltp : null;
  }, [cards, underlying]);

  // Scalp MTF candles: SSE push with REST poll fallback (delivery only).
  const scalpMtf = useScalpCandlesLiveStream(underlying, mode === "SCALP");

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMarkMsg(null);
    setAckSell(false);
    setMarkOk(false);
    try {
      const res = await fetch(
        `/api/synthesis?underlying=${underlying}&mode=${mode}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.uiHint ?? json.error ?? "Request failed");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [underlying, mode]);

  // Soft-refresh synthesis when MTF content hash changes (skip first seed frame).
  const scalpMtfHashRef = useRef<string | null>(null);
  useEffect(() => {
    scalpMtfHashRef.current = null;
  }, [underlying]);
  useEffect(() => {
    if (mode !== "SCALP" || !scalpMtf.contentHash) return;
    if (scalpMtfHashRef.current === scalpMtf.contentHash) return;
    const prev = scalpMtfHashRef.current;
    scalpMtfHashRef.current = scalpMtf.contentHash;
    if (prev != null) void run();
  }, [mode, scalpMtf.contentHash, run]);

  // Standalone SMC fetch — not part of §2.5 synthesis
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/smc?underlying=${underlying}&mode=${mode}`,
        );
        const json = (await res.json()) as {
          ok: boolean;
          signal?: SmcSignal;
          degraded?: boolean;
          marketStructure?: { external?: { trend?: string } };
          premiumDiscount?: { currentZone?: string } | null;
          overlayLevels?: Array<{
            price: number;
            color: string;
            title: string;
            style: "solid" | "dashed";
          }>;
        };
        if (cancelled || !json.ok || !json.signal) {
          if (!cancelled) {
            setSmcSignal(null);
            setSmcMeta(null);
            setSmcLevels(null);
          }
          return;
        }
        setSmcSignal(json.signal);
        setSmcMeta({
          trend: json.marketStructure?.external?.trend,
          zone: json.premiumDiscount?.currentZone,
          degraded: json.degraded,
        });
        setSmcLevels(json.overlayLevels ?? null);
      } catch {
        if (!cancelled) {
          setSmcSignal(null);
          setSmcMeta(null);
          setSmcLevels(null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [underlying, mode]);

  const markAsTaken = useCallback(async () => {
    if (!data?.tradePlan.suggestedContract || !data.structure.action) return;
    const c = data.tradePlan.suggestedContract;
    if (data.structure.isSellWrite && !ackSell) {
      setMarkOk(false);
      setMarkMsg("Acknowledge sell/write risk before marking as taken.");
      return;
    }
    setMarking(true);
    setMarkMsg(null);
    try {
      const res = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          underlying: data.underlying,
          strike: c.strike,
          optionType: c.optionType,
          expiry: c.expiry,
          action: data.structure.action,
          lotSize: c.lotSize,
          lots: 1,
          entryPremium: c.entryPremium,
          mode: data.mode,
          symbolToken: c.symboltoken,
          tradingSymbol: c.tradingsymbol,
          acknowledgeSellRisk: ackSell,
          tradeIdeaId: data.tradeIdeaId,
          // Same spot levels as the verdict card (Entry / SL / TP1 / TP2)
          entrySpotAtSignal: data.tradePlan.entry,
          stopLossSpot: data.tradePlan.stopLoss ?? undefined,
          tp1Spot: data.tradePlan.takeProfit1 ?? undefined,
          tp2Spot: data.tradePlan.takeProfit2 ?? undefined,
          // Angel Greeks delta when chain merge succeeded; else multiplier fallback
          delta: c.delta ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Paper open failed");
      setMarkOk(true);
      setMarkMsg(
        `Paper ${data.structure.action} ${c.optionType} ${fmt(c.strike, 0)} @ ₹${fmt(c.entryPremium)} opened (paper only).`,
      );
    } catch (e) {
      setMarkOk(false);
      setMarkMsg(e instanceof Error ? e.message : "Failed to mark");
    } finally {
      setMarking(false);
    }
  }, [data, ackSell]);

  const side = data?.tradePlan.sideLabel ?? "FLAT";
  const sideColor =
    side === "LONG"
      ? "bg-binance-bull/15 text-binance-bull border-binance-bull/40"
      : side === "SHORT"
        ? "bg-binance-bear/15 text-binance-bear border-binance-bear/40"
        : "bg-binance-elevated text-binance-muted border-binance-border";

  // SCALP only: bare NEUTRAL can hide Tech vs OF conflict — surface context, not a trade.
  const lanesDisagreeTechVsFlow = useMemo(() => {
    if (!data || data.mode !== "SCALP") return false;
    if (
      data.directional.verdict !== "NEUTRAL" &&
      data.structure.branch !== "NO_TRADE"
    ) {
      return false;
    }
    const tech =
      data.directional.components.technical ?? data.lanes.technical?.score;
    const flow =
      data.directional.components.optionsFlow ?? data.lanes.optionsFlow?.score;
    if (typeof tech !== "number" || typeof flow !== "number") return false;
    const opposite =
      (tech > 0 && flow < 0) || (tech < 0 && flow > 0);
    return opposite && Math.abs(tech - flow) > LANES_DISAGREE_SCORE_GAP;
  }, [data]);

  const canMark =
    Boolean(data?.tradePlan.suggestedContract) &&
    data?.structure.action !== "NONE" &&
    (!data?.structure.isSellWrite || ackSell);

  const chartLevels = data
    ? {
        entry: data.tradePlan.entry,
        stopLoss: data.tradePlan.stopLoss,
        takeProfit1: data.tradePlan.takeProfit1,
        takeProfit2: data.tradePlan.takeProfit2,
      }
    : null;

  const clusterLevels =
    data?.mode === "SCALP" && data.stopLossClusters
      ? data.stopLossClusters.levels
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 8)
          .map((l) => ({
            price: l.price,
            kind: l.kind,
            label: l.label,
          }))
      : null;

  return (
    <div className="space-y-4 sm:space-y-6">
      <section className="space-y-2 sm:space-y-3">
        <h1 className="text-xl font-semibold tracking-tight text-binance-gold sm:text-2xl">
          Analysis
        </h1>
        <p className="max-w-2xl text-xs text-binance-muted sm:text-sm">
          Lanes → IV-aware structure → ATR trade plan. Heuristic only — not a
          validated edge.
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <select
            value={underlying}
            onChange={(e) => setUnderlying(e.target.value as Underlying)}
            className="min-w-0 flex-1 rounded border border-binance-border bg-binance-elevated px-3 py-2.5 text-sm sm:flex-none"
          >
            <option value="NIFTY">Nifty 50</option>
            <option value="BANKNIFTY">BANKNIFTY</option>
            <option value="SENSEX">SENSEX</option>
          </select>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="inline-flex w-full items-center justify-center gap-2 rounded bg-binance-gold px-4 py-2.5 text-sm font-semibold text-binance-bg disabled:opacity-60 sm:w-auto"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Run synthesis
        </button>
      </div>

      {mode === "SCALP" && (
        <div className="flex flex-col gap-2 rounded-lg border border-binance-border bg-binance-elevated/60 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-binance-text">
            <input
              type="checkbox"
              checked={autoPaper}
              onChange={(e) => persistAutoPaper(e.target.checked)}
              className="accent-binance-gold"
            />
            <span className="font-medium">Auto paper on actionable scalp</span>
            <span className="text-xs text-binance-muted">(off by default · ~60s)</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-binance-muted">
            <input
              type="checkbox"
              checked={autoAckSell}
              onChange={(e) => persistAutoAckSell(e.target.checked)}
              disabled={!autoPaper}
              className="accent-binance-gold"
            />
            Allow auto Sell/write (uncapped/large risk · paper only)
          </label>
          {autoPaper && (
            <span className="inline-flex items-center gap-1.5 text-xs text-binance-muted">
              {autoRunning ? (
                <Loader2 className="h-3 w-3 animate-spin text-binance-gold" />
              ) : (
                <CheckCircle2 className="h-3 w-3 text-binance-gold" />
              )}
              {autoStatus ?? "Watching for Rule stack cleared…"}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded border border-binance-bear/40 bg-binance-elevated px-3 py-2 text-sm text-binance-bear">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <IndexDriversHeatmap underlying={underlying} />

      {loading && (
        <ChartAiLoader
          label={`${underlying} synthesis`}
          variant="synthesis"
          overlay={false}
        />
      )}

      {data && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* 50% verdict · 50% live chart */}
          <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
            <div className="overflow-hidden rounded-lg border border-binance-border bg-binance-surface">
              <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
                  Synthesized verdict
                </p>
                <span className="text-sm font-medium text-binance-text">
                  {data.underlying}
                </span>
                <span className="text-xs text-binance-muted">
                  {data.tradePlan.timeframeLabel}
                </span>
                <span
                  className={`rounded border px-2 py-0.5 text-xs font-bold ${sideColor}`}
                >
                  {side}
                </span>
                {lanesDisagreeTechVsFlow && (
                  <span
                    className="inline-flex items-center gap-1 rounded border border-binance-gold/50 bg-binance-gold/10 px-2 py-0.5 text-xs text-binance-gold"
                    title="Technical and Options Flow scores disagree with opposite signs and |Δ| > 0.4. Verdict stays NEUTRAL / NO_TRADE — context only."
                  >
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Lanes disagree — Technical vs Options Flow
                  </span>
                )}
                {data.priceSlopeGate?.applied && (
                  <span
                    className="inline-flex max-w-full flex-wrap items-center gap-1 rounded border border-binance-bear/50 bg-binance-bear/10 px-2 py-0.5 text-xs text-binance-bear"
                    title={
                      data.priceSlopeGate.conflictReason
                        ? `conflictReason=${data.priceSlopeGate.conflictReason}. Lane scores unchanged — final verdict downgraded to NEUTRAL / NO_TRADE.`
                        : "Price momentum conflicts with lane verdict"
                    }
                  >
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Verdict downgraded — price momentum conflicts (
                    {data.priceSlopeGate.slopeDirection}{" "}
                    {Math.abs(data.priceSlopeGate.slopePct).toFixed(2)}% /{" "}
                    {data.priceSlopeGate.lookbackBars} bars)
                    {data.priceSlopeGate.preGateVerdict && (
                      <span className="font-normal text-binance-muted">
                        · lanes said {data.priceSlopeGate.preGateVerdict}
                        {data.priceSlopeGate.preGateStructureBranch
                          ? ` → ${data.priceSlopeGate.preGateStructureBranch.replaceAll("_", " ")}`
                          : ""}
                      </span>
                    )}
                  </span>
                )}
                <span
                  className="rounded border border-binance-border px-2 py-0.5 text-xs text-binance-muted"
                  title={data.experimentalEdge.label}
                >
                  {data.experimentalEdge.winRatePct != null
                    ? `Edge: ${data.experimentalEdge.winRatePct}% experimental`
                    : data.experimentalEdge.insufficientSample
                      ? "Edge: insufficient post-4-lane sample"
                      : "Edge: n/a experimental"}
                  {data.experimentalEdge.sampleSize > 0
                    ? ` (n=${data.experimentalEdge.sampleSize})`
                    : data.experimentalEdge.legacySampleSize
                      ? ` (legacy n=${data.experimentalEdge.legacySampleSize} excluded)`
                      : ""}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                    data.regime.regime === "CHOPPY" ||
                    data.regime.regime === "VOLATILE"
                      ? "border-binance-gold/50 text-binance-gold"
                      : "border-binance-border text-binance-muted"
                  }`}
                >
                  {(data.regime.regime === "CHOPPY" ||
                    data.regime.regime === "VOLATILE") && (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  {data.regime.regime}
                </span>
                <span className="ml-auto text-xs text-binance-muted">
                  {data.alignment.label}
                </span>
                {data.mode === "SCALP" && data.scalpLiquidity && (
                  <LiquidityStatusBadge
                    status={data.scalpLiquidity.status}
                    label={data.scalpLiquidity.badgeLabel}
                    detail={
                      data.scalpLiquidity.focus
                        ? `ATM ${data.scalpLiquidity.focus.strike} ${data.scalpLiquidity.focus.optionType} · spread=${
                            data.scalpLiquidity.focus.spreadPct != null
                              ? `${(data.scalpLiquidity.focus.spreadPct * 100).toFixed(1)}%`
                              : "n/a"
                          } · vol=${data.scalpLiquidity.focus.volume} · OI=${data.scalpLiquidity.focus.oi}`
                        : data.scalpLiquidity.warning
                    }
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 lg:grid-cols-4">
                <Level
                  label="Entry (spot)"
                  value={fmt(data.tradePlan.entry)}
                  tone="bull"
                />
                <Level
                  label="Stop loss"
                  value={fmt(data.tradePlan.stopLoss)}
                  tone="bear"
                />
                <Level
                  label="TP 1"
                  value={fmt(data.tradePlan.takeProfit1)}
                  tone="bull"
                />
                <Level
                  label="TP 2"
                  value={fmt(data.tradePlan.takeProfit2)}
                  tone="bull"
                />
              </div>

              <div className="space-y-3 border-t border-binance-border px-4 py-4">
                <div className="flex flex-wrap items-baseline gap-3">
                  <p className="text-sm text-binance-muted">
                    Risk:Reward{" "}
                    <span className="font-semibold text-binance-text">
                      {data.tradePlan.riskReward != null
                        ? `1:${data.tradePlan.riskReward.toFixed(1)}`
                        : "—"}
                    </span>
                  </p>
                  <p className="text-sm font-medium text-binance-gold">
                    {data.structure.branch.replaceAll("_", " ")}
                    {data.tradePlan.suggestedContract
                      ? ` · ${fmt(data.tradePlan.suggestedContract.strike, 0)} ${data.tradePlan.suggestedContract.optionType} @ ₹${fmt(data.tradePlan.suggestedContract.entryPremium)}`
                      : ""}
                  </p>
                </div>
                <p className="text-sm text-binance-muted">
                  {data.tradePlan.summary}
                </p>
                {data.structure.isSellWrite && data.structure.riskWarning && (
                  <p className="flex gap-2 text-sm text-binance-bear">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {data.structure.riskWarning}
                  </p>
                )}
                {!data.structure.isSellWrite && data.structure.riskWarning && (
                  <p className="text-sm text-binance-muted">
                    {data.structure.riskWarning}
                  </p>
                )}
                {data.tradePlan.suggestedContract &&
                  data.tradePlan.stopLoss != null &&
                  data.tradePlan.takeProfit1 != null && (
                  <p className="text-xs text-binance-muted">
                    Paper SL/TP use these spot levels (Entry / SL / TP1). Premium
                    targets are delta-projected when Greeks are available;
                    otherwise a static multiplier labeled{" "}
                    <span className="text-binance-text">est. — no delta</span>.
                  </p>
                )}
                {data.tradePlan.suggestedContract?.premiumStopHint != null &&
                  (data.tradePlan.stopLoss == null ||
                    data.tradePlan.takeProfit1 == null) && (
                  <p className="text-xs text-binance-muted">
                    Premium soft-stop hint ≈ ₹
                    {fmt(data.tradePlan.suggestedContract.premiumStopHint)}{" "}
                    (−40% of entry premium on buys; spot ATR levels unavailable).
                  </p>
                )}

                {data.structure.isSellWrite && (
                  <label className="flex items-start gap-2 text-xs text-binance-muted">
                    <input
                      type="checkbox"
                      checked={ackSell}
                      onChange={(e) => setAckSell(e.target.checked)}
                      className="mt-0.5"
                    />
                    I acknowledge sell/write risk is uncapped or large (paper
                    only).
                  </label>
                )}

                <button
                  type="button"
                  disabled={!canMark || marking}
                  onClick={markAsTaken}
                  className="rounded bg-binance-elevated px-4 py-2 text-sm font-semibold text-binance-text ring-1 ring-binance-border hover:ring-binance-gold disabled:opacity-50"
                >
                  {marking ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Opening…
                    </span>
                  ) : (
                    "Mark as taken"
                  )}
                </button>
                {markMsg && (
                  <p
                    className={`flex items-start gap-2 text-sm ${
                      markOk ? "text-binance-bull" : "text-binance-bear"
                    }`}
                  >
                    {markOk ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    {markMsg}
                  </p>
                )}
              </div>
            </div>

            <AnalysisLiveChart
              underlying={underlying}
              mode={mode}
              liveLtp={liveLtp}
              live={live}
              levels={chartLevels}
              clusterLevels={clusterLevels}
              smcLevels={smcLevels}
            />
          </div>

          {smcSignal && (
            <SmcSignalCard signal={smcSignal} meta={smcMeta ?? undefined} />
          )}

          {data.mode === "SCALP" && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-binance-muted">
              <span
                className={
                  scalpMtf.live
                    ? "inline-flex items-center gap-1 font-medium text-binance-bull"
                    : scalpMtf.polling
                      ? "inline-flex items-center gap-1 font-medium text-binance-gold"
                      : "inline-flex items-center gap-1"
                }
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    scalpMtf.live
                      ? "animate-pulse bg-binance-bull"
                      : scalpMtf.polling
                        ? "bg-binance-gold"
                        : "bg-binance-muted"
                  }`}
                />
                {scalpMtf.live
                  ? "MTF LIVE"
                  : scalpMtf.polling
                    ? "MTF poll fallback"
                    : "MTF idle"}
              </span>
              {scalpMtf.degraded && (
                <span className="text-binance-gold">degraded</span>
              )}
              {scalpMtf.fetchedAt && (
                <span>
                  candles{" "}
                  {new Date(scalpMtf.fetchedAt).toLocaleTimeString("en-IN")}
                </span>
              )}
              {scalpMtf.error && !scalpMtf.bundle && (
                <span className="text-binance-bear">{scalpMtf.error}</span>
              )}
            </div>
          )}

          {data.mode === "SCALP" && data.scalpSignal && (
            <ScalpSignalCard card={data.scalpSignal} />
          )}

          {data.mode === "SCALP" &&
            data.scalpLiquidity &&
            data.scalpLiquidity.status === "fail" && (
              <div className="flex items-start gap-2 rounded-lg border border-binance-bear/50 bg-binance-bear/10 p-3 text-sm text-binance-bear">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-semibold">Unsuitable for scalping</p>
                  <p className="mt-1 text-binance-bear/90">
                    {data.scalpLiquidity.warning ?? data.scalpLiquidityWarning}
                  </p>
                </div>
              </div>
            )}

          {data.mode === "SCALP" &&
            data.scalpLiquidity &&
            data.scalpLiquidity.status === "warn" && (
              <div className="rounded-lg border border-binance-gold/30 bg-binance-elevated p-3 text-sm text-binance-gold">
                {data.scalpLiquidity.warning ?? data.scalpLiquidityWarning}
              </div>
            )}

          {data.swingThetaWarning && (
            <div className="rounded-lg border border-binance-gold/30 bg-binance-elevated p-3 text-sm text-binance-gold">
              {data.swingThetaWarning}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(data.lanes).map(([name, lane]) => (
              <div key={name} className="rounded-lg bg-binance-surface p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium capitalize">
                    {name}
                    {name === "macro" || name === "sentiment" ? (
                      <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-binance-muted">
                        heuristic
                      </span>
                    ) : null}
                  </p>
                  <p
                    className={`font-mono text-sm ${
                      lane.score > 0
                        ? "text-binance-bull"
                        : lane.score < 0
                          ? "text-binance-bear"
                          : "text-binance-muted"
                    }`}
                  >
                    {lane.score.toFixed(2)}
                  </p>
                </div>
                <ul className="mt-2 space-y-1 font-jetbrains text-xs text-binance-muted">
                  {lane.signals
                    .slice(0, name === "macro" || name === "sentiment" ? 6 : 4)
                    .map((s) => (
                      <li key={s}>· {s}</li>
                    ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="text-xs text-binance-muted">
            {data.confidenceLabel} · DTE{" "}
            {data.daysToExpiry?.toFixed(1) ?? "—"} ·{" "}
            {data.persisted
              ? `Persisted trade idea ${data.tradeIdeaId}`
              : "Trade idea not persisted (no DATABASE_URL)."}
          </p>
        </motion.div>
      )}
    </div>
  );
}

function Level({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "bull" | "bear";
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-binance-muted">
        {label}
      </p>
      <p
        className={`mt-1 text-base font-semibold tabular-nums sm:text-lg ${
          tone === "bull" ? "text-binance-bull" : "text-binance-bear"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
