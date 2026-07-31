"use client";

import { useEffect, useState } from "react";

type Cohort = {
  branch: string;
  sampleSize: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  label: string;
  reportable?: boolean;
  synthesisVersion?: string;
};

type VersionBlock = {
  synthesisVersion: string;
  overall: Cohort;
  byBranch: Cohort[];
  byLaneLean: Cohort[];
  orderedSampleSize: number;
  edgeReportable: boolean;
  note: string;
};

type TrackPayload = {
  currentVersion: string;
  minSampleForEdge: number;
  current: VersionBlock;
  legacy: VersionBlock;
  methodology: string;
  audit: {
    legacySampleSize: number;
    currentSampleSize: number;
    legacyWinRatePct: number | null;
    currentWinRatePct: number | null;
  };
};

export function BacktestPanel() {
  const [data, setData] = useState<TrackPayload | null>(null);

  useEffect(() => {
    void fetch("/api/backtest")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) {
    return <p className="text-sm text-binance-muted">Loading track record…</p>;
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold text-binance-gold">Track Record</h1>
        <p className="mt-2 text-sm text-binance-muted">{data.methodology}</p>
        <p className="mt-2 inline-block rounded bg-binance-elevated px-2 py-1 text-xs text-binance-gold">
          Experimental / unvalidated · current={data.currentVersion} · min n=
          {data.minSampleForEdge} for reportable edge
        </p>
        <p className="mt-2 text-xs text-binance-muted">
          Audit: legacy n={data.audit.legacySampleSize}
          {data.audit.legacyWinRatePct != null
            ? ` (${data.audit.legacyWinRatePct}% win — not current-system edge)`
            : ""}
          {" · "}
          post-4-lane n={data.audit.currentSampleSize}
          {data.current.edgeReportable && data.audit.currentWinRatePct != null
            ? ` (${data.audit.currentWinRatePct}% win — reportable)`
            : " (insufficient sample for reportable edge)"}
        </p>
      </section>

      <VersionSection
        title="Current system (4-lane synthesis)"
        block={data.current}
        showWinRate={data.current.edgeReportable}
      />

      <VersionSection
        title="Legacy cohort (pre Stage 2.5 — Macro/Sentiment stubbed)"
        block={data.legacy}
        showWinRate
        legacy
      />
    </div>
  );
}

function VersionSection({
  title,
  block,
  showWinRate,
  legacy,
}: {
  title: string;
  block: VersionBlock;
  showWinRate: boolean;
  legacy?: boolean;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-binance-text">{title}</h2>
        <p className="mt-1 text-xs text-binance-muted">{block.note}</p>
        <p className="mt-1 text-[11px] text-binance-muted">
          version={block.synthesisVersion} · n={block.orderedSampleSize}
          {legacy ? " · excluded from analysis edge badges" : ""}
        </p>
      </div>

      <CohortCard
        title="Overall"
        cohort={block.overall}
        showWinRate={showWinRate}
      />

      <div className="space-y-2">
        <h3 className="text-sm text-binance-muted">By synthesis branch</h3>
        {block.byBranch.length === 0 ? (
          <p className="text-xs text-binance-muted">No outcomes in this cohort yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {block.byBranch.map((c) => (
              <CohortCard
                key={c.branch}
                title={c.branch}
                cohort={c}
                showWinRate={showWinRate}
              />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm text-binance-muted">By lane lean</h3>
        {block.byLaneLean.length === 0 ? (
          <p className="text-xs text-binance-muted">
            No lane-lean buckets (legacy seeds often lack Macro/Sentiment scores).
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {block.byLaneLean.map((c) => (
              <CohortCard
                key={c.branch}
                title={c.branch}
                cohort={c}
                showWinRate={showWinRate}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CohortCard({
  title,
  cohort,
  showWinRate,
}: {
  title: string;
  cohort: Cohort;
  showWinRate: boolean;
}) {
  return (
    <div className="rounded-lg bg-binance-surface p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
        {showWinRate && cohort.sampleSize > 0
          ? `${(cohort.winRate * 100).toFixed(0)}%`
          : "—"}
        <span className="ml-2 text-xs font-sans font-medium text-binance-gold">
          experimental
        </span>
      </p>
      {!showWinRate && (
        <p className="mt-1 text-xs text-binance-gold">
          Insufficient post-upgrade sample — win rate hidden for current-system
          claims
        </p>
      )}
      <p className="mt-1 text-xs text-binance-muted">
        n={cohort.sampleSize}
        {showWinRate
          ? ` · avg P&L ₹${cohort.avgPnl.toFixed(0)} · total ₹${cohort.totalPnl.toFixed(0)}`
          : ""}
      </p>
      <p className="mt-2 text-[11px] text-binance-muted">{cohort.label}</p>
    </div>
  );
}
