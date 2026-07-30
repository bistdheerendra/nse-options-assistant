"use client";

import { useEffect, useState } from "react";

type Cohort = {
  branch: string;
  sampleSize: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  label: string;
};

export function BacktestPanel() {
  const [data, setData] = useState<{
    overall: Cohort;
    byBranch: Cohort[];
    byLaneLean: Cohort[];
    orderedSampleSize: number;
    methodology: string;
  } | null>(null);

  useEffect(() => {
    void fetch("/api/backtest")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) {
    return <p className="text-sm text-binance-muted">Loading track record…</p>;
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold text-binance-gold">Track Record</h1>
        <p className="mt-2 text-sm text-binance-muted">{data.methodology}</p>
        <p className="mt-2 inline-block rounded bg-binance-elevated px-2 py-1 text-xs text-binance-gold">
          Experimental / unvalidated · n={data.orderedSampleSize}
        </p>
      </section>

      <CohortCard title="Overall" cohort={data.overall} />

      <div className="space-y-2">
        <h2 className="text-sm text-binance-muted">By synthesis branch</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {data.byBranch.map((c) => (
            <CohortCard key={c.branch} title={c.branch} cohort={c} />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm text-binance-muted">By technical lane lean</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {data.byLaneLean.map((c) => (
            <CohortCard key={c.branch} title={c.branch} cohort={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

function CohortCard({ title, cohort }: { title: string; cohort: Cohort }) {
  return (
    <div className="rounded-lg bg-binance-surface p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-2 font-mono text-2xl">
        {(cohort.winRate * 100).toFixed(0)}%
        <span className="ml-2 text-xs font-sans text-binance-gold">experimental</span>
      </p>
      <p className="mt-1 text-xs text-binance-muted">
        n={cohort.sampleSize} · avg P&L ₹{cohort.avgPnl.toFixed(0)} · total ₹
        {cohort.totalPnl.toFixed(0)}
      </p>
      <p className="mt-2 text-[11px] text-binance-muted">{cohort.label}</p>
    </div>
  );
}
