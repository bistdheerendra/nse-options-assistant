"use client";

import { AnalysisLiveChart } from "@/components/AnalysisLiveChart";
import { ModeToggle } from "@/components/ModeToggle";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

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

  const { cards, live } = useDashboardLiveStream();
  const liveLtp = useMemo(() => {
    const card = cards.find((c) => c.id === underlying);
    return card && Number.isFinite(card.ltp) ? card.ltp : null;
  }, [cards, underlying]);

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
          // Premium SL hint from plan when buy; else server defaults (1:2 R on premium)
          stopLoss: c.premiumStopHint ?? undefined,
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

      {error && (
        <div className="flex items-start gap-2 rounded border border-binance-bear/40 bg-binance-elevated px-3 py-2 text-sm text-binance-bear">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
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
                {data.tradePlan.suggestedContract?.premiumStopHint != null && (
                  <p className="text-xs text-binance-muted">
                    Premium soft-stop hint ≈ ₹
                    {fmt(data.tradePlan.suggestedContract.premiumStopHint)}{" "}
                    (−40% of entry premium on buys).
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
            />
          </div>

          {(data.scalpLiquidityWarning || data.swingThetaWarning) && (
            <div className="rounded-lg border border-binance-gold/30 bg-binance-elevated p-3 text-sm text-binance-gold">
              {data.scalpLiquidityWarning || data.swingThetaWarning}
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
                <ul className="mt-2 space-y-1 text-xs text-binance-muted">
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
