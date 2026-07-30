"use client";

import { ModeToggle } from "@/components/ModeToggle";
import { motion } from "framer-motion";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

function parseUnderlying(raw: string | null): Underlying {
  if (raw === "BANKNIFTY" || raw === "SENSEX" || raw === "NIFTY") return raw;
  return "NIFTY";
}

type SynthesisPayload = {
  underlying: string;
  mode: string;
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
};

export function AnalysisPanel() {
  const searchParams = useSearchParams();
  const [underlying, setUnderlying] = useState<Underlying>(() =>
    parseUnderlying(searchParams.get("underlying")),
  );
  const [mode, setMode] = useState<"SCALP" | "SWING">("SWING");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SynthesisPayload | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
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

  const verdictColor =
    data?.directional.verdict === "BULLISH"
      ? "text-binance-bull"
      : data?.directional.verdict === "BEARISH"
        ? "text-binance-bear"
        : "text-binance-muted";

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-binance-gold">
          NSE Options Assistant
        </h1>
        <p className="max-w-2xl text-sm text-binance-muted">
          Independent lanes → IV-aware structure. Heuristic only — not a validated edge.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value as Underlying)}
          className="rounded border border-binance-border bg-binance-elevated px-3 py-2 text-sm"
        >
          <option value="NIFTY">Nifty 50</option>
          <option value="BANKNIFTY">BANKNIFTY</option>
          <option value="SENSEX">SENSEX</option>
        </select>
        <ModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded bg-binance-gold px-4 py-2 text-sm font-semibold text-binance-bg disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
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
          <div className="rounded-lg bg-binance-surface p-4">
            <p className="text-xs uppercase tracking-wide text-binance-muted">Directional</p>
            <p className={`text-3xl font-bold ${verdictColor}`}>{data.directional.verdict}</p>
            <p className="mt-1 text-sm text-binance-muted">
              Combined score {data.directional.combinedScore.toFixed(3)} · DTE{" "}
              {data.daysToExpiry?.toFixed(1) ?? "—"}
            </p>
            <p className="mt-3 text-xs text-binance-muted">{data.confidenceLabel}</p>
          </div>

          <div className="rounded-lg bg-binance-surface p-4">
            <p className="text-xs uppercase tracking-wide text-binance-muted">Structure branch</p>
            <p className="text-xl font-semibold text-binance-gold">{data.structure.branch}</p>
            <p className="mt-2 text-sm">{data.structure.reasoning}</p>
            {data.structure.isSellWrite && data.structure.riskWarning && (
              <p className="mt-3 flex gap-2 text-sm text-binance-bear">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {data.structure.riskWarning}
              </p>
            )}
            {!data.structure.isSellWrite && data.structure.riskWarning && (
              <p className="mt-3 text-sm text-binance-muted">{data.structure.riskWarning}</p>
            )}
          </div>

          {(data.scalpLiquidityWarning || data.swingThetaWarning) && (
            <div className="rounded-lg border border-binance-gold/30 bg-binance-elevated p-3 text-sm text-binance-gold">
              {data.scalpLiquidityWarning || data.swingThetaWarning}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(data.lanes).map(([name, lane]) => (
              <div key={name} className="rounded-lg bg-binance-surface p-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-medium capitalize">{name}</p>
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
                  {lane.signals.slice(0, 4).map((s) => (
                    <li key={s}>· {s}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="text-xs text-binance-muted">
            {data.persisted
              ? `Persisted trade idea ${data.tradeIdeaId}`
              : "Trade idea not persisted (no DATABASE_URL) — snapshot available in this response only."}
          </p>
        </motion.div>
      )}
    </div>
  );
}
