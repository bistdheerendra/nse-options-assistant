"use client";

import { LiquidityStatusBadge } from "@/components/LiquidityStatusBadge";
import { AlertTriangle, Clock, ShieldCheck } from "lucide-react";

export type ScalpSignalCardProps = {
  card: {
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
  };
};

function tfShort(tf: string): string {
  return tf
    .replace("ONE_MINUTE", "1m")
    .replace("THREE_MINUTE", "3m")
    .replace("FIVE_MINUTE", "5m")
    .replace("FIFTEEN_MINUTE", "15m");
}

function fmt(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

/**
 * Binance-theme scalp signal card — Stages 2–7 in one place.
 * "Confirmed" never implies validated edge (see reliability note).
 */
export function ScalpSignalCard({ card }: ScalpSignalCardProps) {
  const confColor =
    card.confirmation.status === "confirmed"
      ? "border-binance-gold/40 text-binance-gold"
      : card.confirmation.status === "failed"
        ? "border-binance-bear/40 text-binance-bear"
        : "border-binance-border text-binance-muted";

  return (
    <div className="rounded-lg border border-binance-border bg-binance-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-binance-border px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-binance-muted">
          Scalp signal
        </p>
        <LiquidityStatusBadge
          status={card.liquidityStatus}
          label={card.liquidityBadge}
        />
        <span
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-semibold ${confColor}`}
          title={card.confirmation.reliabilityNote}
        >
          {card.confirmation.status === "confirmed" ? (
            <ShieldCheck className="h-3 w-3" />
          ) : (
            <Clock className="h-3 w-3" />
          )}
          Confirm: {card.confirmation.status}
        </span>
        {card.actionable ? (
          <span className="rounded border border-binance-gold/50 bg-binance-gold/10 px-2 py-0.5 text-xs font-semibold text-binance-gold">
            Rule stack cleared (heuristic)
          </span>
        ) : (
          <span className="rounded border border-binance-border px-2 py-0.5 text-xs text-binance-muted">
            Not actionable
          </span>
        )}
      </div>

      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="TF confluence">
          {card.timeframeConfluence.dominant ? (
            <span
              className={
                card.timeframeConfluence.dominant === "bullish"
                  ? "text-binance-bull"
                  : "text-binance-bear"
              }
            >
              {card.timeframeConfluence.dominant} (
              {(card.timeframeConfluence.dominant === "bullish"
                ? card.timeframeConfluence.bullish
                : card.timeframeConfluence.bearish
              )
                .map(tfShort)
                .join(", ")}
              )
            </span>
          ) : (
            <span className="text-binance-muted">no clear majority</span>
          )}
        </Field>

        <Field label="Pattern">
          {card.primaryPattern
            ? `${card.primaryPattern.replaceAll("_", " ")}${
                card.patternTimeframe
                  ? ` · ${tfShort(card.patternTimeframe)}`
                  : ""
              }`
            : "—"}
        </Field>

        <Field label="Volume">
          <span
            className={
              card.volumeConfirmation === "confirm"
                ? "text-binance-bull"
                : card.volumeConfirmation === "disqualify"
                  ? "text-binance-bear"
                  : "text-binance-muted"
            }
          >
            {card.volumeConfirmation}
          </span>
        </Field>

        <Field label="Nearest support">
          <span className="text-[color:var(--color-binance-cluster-support)]">
            {fmt(card.stopLossClusters.nearestSupport)}
          </span>
        </Field>

        <Field label="Nearest resistance">
          <span className="text-[color:var(--color-binance-cluster-resistance)]">
            {fmt(card.stopLossClusters.nearestResistance)}
          </span>
        </Field>

        <Field label="OI velocity">
          <span
            className={
              card.oiVelocity.notable
                ? "text-binance-gold"
                : "text-binance-muted"
            }
          >
            {card.oiVelocity.reading}
          </span>
        </Field>
      </div>

      <div className="space-y-2 border-t border-binance-border px-4 py-3 text-xs text-binance-muted">
        <p>{card.confirmation.reason}</p>
        <p className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-binance-gold" />
          <span>{card.actionableNote}</span>
        </p>
        <p className="text-[10px] leading-relaxed opacity-80">
          {card.confirmation.reliabilityNote}
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-binance-muted">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-medium text-binance-text">{children}</p>
    </div>
  );
}
