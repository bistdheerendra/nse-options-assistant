import type { Config } from "tailwindcss";

/**
 * Binance-style palette — keep in sync with src/lib/theme.ts and globals.css.
 * Prefer theme tokens / CSS variables in components; never hardcode these hex values.
 */
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        binance: {
          bg: "#0B0E11",
          surface: "#181A20",
          elevated: "#1E2329",
          gold: "#F0B90B",
          bull: "#0ECB81",
          bear: "#F6465D",
          muted: "#848E9C",
          text: "#FFFFFF",
          border: "#2B3139",
        },
      },
    },
  },
  plugins: [],
};

export default config;
