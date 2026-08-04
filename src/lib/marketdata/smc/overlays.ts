/**
 * Pure SMC overlay level builder (no React).
 * Colors from theme.smc* — distinct from SL-cluster blue/violet.
 */

import { theme } from "@/lib/theme";
import type { SmcEngineResult } from "./types";

export type SmcOverlayLevel = {
  price: number;
  color: string;
  title: string;
  style: "solid" | "dashed";
};

export function buildSmcOverlayLevels(
  result: SmcEngineResult,
  opts?: { maxLevels?: number },
): SmcOverlayLevel[] {
  const max = opts?.maxLevels ?? 12;
  const levels: SmcOverlayLevel[] = [];

  for (const z of result.liquidity.zones) {
    if (z.swept) continue;
    levels.push({
      price: z.price,
      color:
        z.type === "buyside"
          ? theme.colors.smcBuysideLiq
          : theme.colors.smcSellsideLiq,
      title: z.type === "buyside" ? "SMC BSL" : "SMC SSL",
      style: "solid",
    });
  }

  for (const z of result.orderBlocks.zones) {
    if (z.status === "invalidated") continue;
    const mid = (z.high + z.low) / 2;
    const bullish =
      z.type === "bullish_ob" ||
      z.type === "bullish_breaker" ||
      z.type === "bullish_rejection";
    levels.push({
      price: mid,
      color: bullish
        ? theme.colors.smcOrderBlockBull
        : theme.colors.smcOrderBlockBear,
      title: bullish ? "SMC OB+" : "SMC OB−",
      style: "dashed",
    });
  }

  const unfilledFvg = result.fairValueGaps.gaps
    .filter((g) => g.kind === "fvg" && !g.filled)
    .slice(-3);
  for (const g of unfilledFvg) {
    levels.push({
      price: (g.top + g.bottom) / 2,
      color: theme.colors.smcFvg,
      title: `SMC FVG ${g.type === "bullish" ? "↑" : "↓"}`,
      style: "dashed",
    });
  }

  const last = result.marketStructure.external.lastEvent;
  if (last) {
    levels.push({
      price: last.price,
      color:
        last.type === "BOS" ? theme.colors.smcBos : theme.colors.smcChoch,
      title: `SMC ${last.type}`,
      style: "dashed",
    });
  }

  if (result.premiumDiscount) {
    levels.push({
      price: result.premiumDiscount.equilibrium,
      color: theme.colors.smcEquilibrium,
      title: "SMC EQ",
      style: "solid",
    });
  }

  return levels.slice(0, max);
}
