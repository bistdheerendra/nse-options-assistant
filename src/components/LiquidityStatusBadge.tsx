"use client";

import { AlertTriangle, CheckCircle2, Droplets } from "lucide-react";

export type LiquidityBadgeStatus = "pass" | "fail" | "warn" | "unavailable";

type Props = {
  status: LiquidityBadgeStatus;
  label: string;
  /** Optional detail shown as title tooltip. */
  detail?: string | null;
};

/**
 * Binance-theme liquidity badge for Scalping Mode (Stage 4).
 * Fail = hard "unsuitable for scalping" — not just a muted number.
 */
export function LiquidityStatusBadge({ status, label, detail }: Props) {
  const styles: Record<LiquidityBadgeStatus, string> = {
    pass: "border-binance-bull/50 bg-binance-bull/10 text-binance-bull",
    fail: "border-binance-bear/60 bg-binance-bear/15 text-binance-bear",
    warn: "border-binance-gold/50 bg-binance-gold/10 text-binance-gold",
    unavailable: "border-binance-border bg-binance-elevated text-binance-muted",
  };

  const Icon =
    status === "pass"
      ? CheckCircle2
      : status === "fail" || status === "warn"
        ? AlertTriangle
        : Droplets;

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold ${styles[status]}`}
      title={detail ?? label}
      role="status"
      aria-label={label}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
