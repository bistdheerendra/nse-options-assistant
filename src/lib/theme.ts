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
} as const;
