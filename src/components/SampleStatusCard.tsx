"use client";

import type { ModeSampleStatus, SampleStatus } from "@/lib/backtest/sampleStatusTypes";
import { useEffect, useState } from "react";

function progressPct(count: number, threshold: number): number {
  if (threshold <= 0) return 0;
  return Math.min(100, Math.round((count / threshold) * 100));
}

function statusLine(s: ModeSampleStatus): string {
  const { resolvedCount, reportableThreshold, isReportable } = s;
  if (isReportable) {
    const regimeBit =
      s.regimesCovered != null
        ? ` (multi-regime: ${s.regimesCovered}/${s.regimesTotal} regimes covered)`
        : "";
    return `${resolvedCount} / ${reportableThreshold} — reportable${regimeBit}`;
  }
  return `${resolvedCount} / ${reportableThreshold} resolved trades — edge metrics not yet reportable`;
}

function ProgressBar({
  count,
  threshold,
  reportable,
}: {
  count: number;
  threshold: number;
  reportable: boolean;
}) {
  const pct = progressPct(count, threshold);
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-binance-elevated"
      role="progressbar"
      aria-valuenow={count}
      aria-valuemin={0}
      aria-valuemax={threshold}
      aria-label="Resolved trades toward reportable sample"
    >
      <div
        className={`h-full rounded-full transition-[width] ${
          reportable ? "bg-binance-bull" : "bg-binance-gold"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ModeRow({ label, status }: { label: string; status: ModeSampleStatus }) {
  return (
    <div className="rounded-md bg-binance-elevated/60 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-binance-muted">{label}</span>
        <span className="text-xs tabular-nums text-binance-text">
          {status.resolvedCount}/{status.reportableThreshold}
          {status.isReportable ? (
            <span className="ml-1 text-binance-bull">reportable</span>
          ) : (
            <span className="ml-1 text-binance-gold">building</span>
          )}
        </span>
      </div>
      <ProgressBar
        count={status.resolvedCount}
        threshold={status.reportableThreshold}
        reportable={status.isReportable}
      />
    </div>
  );
}

/** Full card for Track Record / Backtest page. */
export function SampleStatusCard({ data }: { data: SampleStatus }) {
  const combined = data.combined;
  return (
    <section
      className="rounded-lg border border-binance-border bg-binance-surface p-4"
      aria-label="Section 6 sample-size readiness"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-binance-text">
            §6 sample readiness
          </h2>
          <p className="mt-0.5 text-[11px] text-binance-muted">
            Post-4-lane cohort ({data.synthesisVersion}) · informational only
          </p>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
            combined.isReportable
              ? "bg-binance-bull/15 text-binance-bull"
              : "bg-binance-gold/15 text-binance-gold"
          }`}
        >
          {combined.isReportable ? "Reportable" : "Not yet reportable"}
        </span>
      </div>

      <p className="mt-3 text-sm text-binance-text">{statusLine(combined)}</p>
      <ProgressBar
        count={combined.resolvedCount}
        threshold={combined.reportableThreshold}
        reportable={combined.isReportable}
      />

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ModeRow label="SCALP" status={data.byMode.SCALP} />
        <ModeRow label="SWING" status={data.byMode.SWING} />
      </div>

      {data.regimeTagged && combined.byRegime && (
        <p className="mt-3 text-[11px] text-binance-muted">
          Regime tags (via TradeIdea): TRENDING {combined.byRegime.TRENDING} ·
          CHOPPY {combined.byRegime.CHOPPY} · VOLATILE{" "}
          {combined.byRegime.VOLATILE}
          {combined.byRegime.unknown > 0
            ? ` · untagged ${combined.byRegime.unknown}`
            : ""}
        </p>
      )}

      <p className="mt-2 text-[11px] text-binance-muted">{data.note}</p>
    </section>
  );
}

/** Compact badge for Analysis page near experimental-edge. */
export function SampleStatusBadge() {
  const [data, setData] = useState<SampleStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/backtest/sample-status")
      .then(async (r) => {
        if (!r.ok) return;
        const json = (await r.json()) as SampleStatus;
        if (!cancelled && json?.combined) setData(json);
      })
      .catch(() => {
        /* non-blocking badge */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  const c = data.combined;
  const label = c.isReportable
    ? `${c.resolvedCount}/${c.reportableThreshold} reportable` +
      (c.regimesCovered != null
        ? ` · ${c.regimesCovered}/${c.regimesTotal} regimes`
        : "")
    : `${c.resolvedCount}/${c.reportableThreshold} resolved — not reportable`;

  return (
    <span
      className={`rounded border px-2 py-0.5 text-xs ${
        c.isReportable
          ? "border-binance-bull/40 text-binance-bull"
          : "border-binance-gold/40 text-binance-gold"
      }`}
      title={data.note}
    >
      Sample: {label}
    </span>
  );
}
