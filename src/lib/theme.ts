/**
 * Binance-style theme tokens.
 * Components must import from here (or use Tailwind `binance-*` / CSS vars) —
 * never hardcode these hex values inline.
 */
export const theme = {
  colors: {
    background: "#0B0E11",
    surface: "#181A20",
    elevated: "#1E2329",
    gold: "#F0B90B",
    bull: "#0ECB81",
    bear: "#F6465D",
    muted: "#848E9C",
    text: "#FFFFFF",
    border: "#2B3139",
    /** Stage 5 SL-cluster support — blue, distinct from bull candle green */
    clusterSupport: "#60A5FA",
    /** Stage 5 SL-cluster resistance — violet, distinct from bear candle red */
    clusterResistance: "#C084FC",
    /**
     * SMC overlay tokens — Binance-adjacent, deliberately NOT cluster blue/violet
     * and not raw bull/bear candle greens/reds (reviewable in Stage 8).
     */
    smcBuysideLiq: "#22D3EE", // cyan — buyside liquidity
    smcSellsideLiq: "#FB923C", // orange — sellside liquidity
    smcOrderBlockBull: "#2DD4BF", // teal — bullish OB / demand
    smcOrderBlockBear: "#E879F9", // fuchsia — bearish OB / supply (≠ cluster violet)
    smcFvg: "#38BDF8", // sky — FVG / imbalance
    smcBos: "#EAB308", // yellow — BOS marker
    smcChoch: "#F472B6", // pink — CHoCH marker
    smcEquilibrium: "#94A3B8", // slate — 50% equilibrium
  },
} as const;

export type ThemeColors = typeof theme.colors;

/** CSS variable names mirrored in globals.css @theme */
export const cssVars = {
  background: "--color-binance-bg",
  surface: "--color-binance-surface",
  elevated: "--color-binance-elevated",
  gold: "--color-binance-gold",
  bull: "--color-binance-bull",
  bear: "--color-binance-bear",
  muted: "--color-binance-muted",
  text: "--color-binance-text",
  border: "--color-binance-border",
  clusterSupport: "--color-binance-cluster-support",
  clusterResistance: "--color-binance-cluster-resistance",
  smcBuysideLiq: "--color-binance-smc-buyside",
  smcSellsideLiq: "--color-binance-smc-sellside",
  smcOrderBlockBull: "--color-binance-smc-ob-bull",
  smcOrderBlockBear: "--color-binance-smc-ob-bear",
  smcFvg: "--color-binance-smc-fvg",
  smcBos: "--color-binance-smc-bos",
  smcChoch: "--color-binance-smc-choch",
  smcEquilibrium: "--color-binance-smc-eq",
} as const;
