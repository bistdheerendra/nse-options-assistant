import type { Underlying } from "@/lib/marketdata/angelone";
import { withTtlCache } from "@/lib/marketdata/ttlCache";

export type TimedOhlcv = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const YAHOO_SYMBOL: Record<Underlying, string> = {
  NIFTY: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }> | null;
  };
};

function yahooParams(mode: "SCALP" | "SWING"): {
  interval: string;
  range: string;
} {
  // Scalp chart = intraday 5m; Swing = hourly lookback
  if (mode === "SCALP") return { interval: "5m", range: "5d" };
  return { interval: "60m", range: "3mo" };
}

async function fetchYahooTimedCandles(
  underlying: Underlying,
  mode: "SCALP" | "SWING",
): Promise<TimedOhlcv[] | null> {
  const symbol = YAHOO_SYMBOL[underlying];
  const { interval, range } = yahooParams(mode);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!ts?.length || !q?.close) return null;

  const out: TimedOhlcv[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close[i];
    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    out.push({
      time: ts[i]!,
      open,
      high,
      low,
      close,
      volume: Number(q.volume?.[i] ?? 0),
    });
  }

  // Cap series length for chart clarity
  const maxBars = mode === "SCALP" ? 180 : 240;
  return out.slice(-maxBars);
}

/**
 * Public (Yahoo) timed OHLC for analysis chart — matches live NSE spot closely.
 * Prefer this over Angel mock candles so the forming-bar LTP patch does not spike.
 */
export async function getPublicAnalysisCandles(
  underlying: Underlying,
  mode: "SCALP" | "SWING",
): Promise<TimedOhlcv[] | null> {
  const { interval, range } = yahooParams(mode);
  return withTtlCache(
    `analysis-yahoo:${underlying}:${interval}:${range}`,
    20_000,
    () => fetchYahooTimedCandles(underlying, mode),
  );
}
