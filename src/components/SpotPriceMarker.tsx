"use client";

import { theme } from "@/lib/theme";

type Props = {
  spot: number;
  change: number;
  changePct: number;
};

/** Groww-style ATM spot pill with full-width divider across the option chain. */
export function SpotPriceMarker({ spot, change, changePct }: Props) {
  const up = change >= 0;
  const changeColor = up ? theme.colors.bull : theme.colors.bear;

  return (
    <div
      className="relative flex h-0 items-center justify-center"
      aria-label={`Spot ${spot}`}
    >
      <div
        className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2"
        style={{ backgroundColor: theme.colors.border }}
      />
      <div
        className="relative z-10 flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-medium shadow-md"
        style={{
          backgroundColor: theme.colors.elevated,
          color: theme.colors.text,
          border: `1px solid ${theme.colors.border}`,
        }}
      >
        <span className="tabular-nums font-semibold">
          {spot.toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
        <span aria-hidden style={{ color: theme.colors.muted }}>
          |
        </span>
        <span className="tabular-nums" style={{ color: changeColor }}>
          {up ? "" : "−"}
          {Math.abs(change).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{" "}
          ({up ? "" : "−"}
          {Math.abs(changePct).toFixed(2)}%)
        </span>
      </div>
    </div>
  );
}
