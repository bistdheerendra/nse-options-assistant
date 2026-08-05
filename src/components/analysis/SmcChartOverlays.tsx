"use client";

/**
 * SMC chart overlay legend — theme.smc* tokens only.
 * Level builder lives in smc/overlays.ts (imported by API + chart).
 */

import { theme } from "@/lib/theme";
export {
  buildSmcOverlayLevels,
  type SmcOverlayLevel,
} from "@/lib/marketdata/smc/overlays";

const LEGEND: { key: string; color: string; label: string }[] = [
  { key: "bsl", color: theme.colors.smcBuysideLiq, label: "Buyside liq" },
  { key: "ssl", color: theme.colors.smcSellsideLiq, label: "Sellside liq" },
  { key: "ob+", color: theme.colors.smcOrderBlockBull, label: "OB / demand" },
  { key: "ob-", color: theme.colors.smcOrderBlockBear, label: "OB / supply" },
  { key: "fvg", color: theme.colors.smcFvg, label: "FVG" },
  { key: "bos", color: theme.colors.smcBos, label: "BOS" },
  { key: "choch", color: theme.colors.smcChoch, label: "CHoCH" },
  { key: "eq", color: theme.colors.smcEquilibrium, label: "Equilibrium" },
];

type Props = {
  /**
   * When true (default for signal card), no outer border — sits in the
   * right column of SmcSignalCard. Standalone card keeps its own chrome.
   */
  embedded?: boolean;
};

export function SmcChartOverlaysLegend({ embedded = false }: Props) {
  const body = (
    <>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-binance-muted">
        SMC overlays (heuristic)
      </p>
      <div
        className={
          embedded
            ? "grid grid-cols-2 gap-x-3 gap-y-2"
            : "flex flex-wrap gap-x-3 gap-y-2"
        }
      >
        {LEGEND.map((item) => (
          <span
            key={item.key}
            className="inline-flex items-center gap-2 text-[11px] text-binance-muted"
          >
            <span
              className="inline-block h-2.5 w-5 shrink-0 rounded-sm ring-1 ring-binance-border/60"
              style={{ backgroundColor: item.color }}
              aria-hidden
            />
            {item.label}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-binance-muted/80">
        Distinct from SL-cluster blue/violet. Heuristic / rules-based, not
        ML-validated. Not wired to §2.5.
      </p>
    </>
  );

  if (embedded) {
    return <div className="min-w-0">{body}</div>;
  }

  return (
    <div className="rounded-lg border border-binance-border bg-binance-surface px-3 py-2">
      {body}
    </div>
  );
}
