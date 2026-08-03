import type { CandleInterval, Underlying } from "@/lib/marketdata/angelone";
import { withTtlCache } from "@/lib/marketdata/ttlCache";

export type TimedOhlcv = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Scalp analysis chart timeframes (UI pills). */
export type ScalpChartTf = "3m" | "5m" | "15m";

export const SCALP_CHART_TFS: ScalpChartTf[] = ["3m", "5m", "15m"];

export function isScalpChartTf(v: string): v is ScalpChartTf {
  return (SCALP_CHART_TFS as string[]).includes(v);
}

export type AnalysisChartTfSpec = {
  label: string;
  angelInterval: CandleInterval;
  lookbackDays: number;
  /** Yahoo interval string, or null if Yahoo has no native TF (e.g. 3m). */
  yahooInterval: string | null;
  yahooRange: string;
  maxBars: number;
};

export const SCALP_CHART_TF_SPEC: Record<ScalpChartTf, AnalysisChartTfSpec> = {
  // Yahoo has no native 3m — Angel THREE_MINUTE, else 1m resampled → 3m
  "3m": {
    label: "3m",
    angelInterval: "THREE_MINUTE",
    lookbackDays: 5,
    yahooInterval: null,
    yahooRange: "5d",
    maxBars: 180,
  },
  "5m": {
    label: "5m",
    angelInterval: "FIVE_MINUTE",
    lookbackDays: 5,
    yahooInterval: "5m",
    yahooRange: "5d",
    maxBars: 180,
  },
  "15m": {
    label: "15m",
    angelInterval: "FIFTEEN_MINUTE",
    lookbackDays: 10,
    yahooInterval: "15m",
    yahooRange: "1mo",
    maxBars: 200,
  },
};

const SWING_SPEC: AnalysisChartTfSpec = {
  label: "1h",
  angelInterval: "ONE_HOUR",
  lookbackDays: 60,
  yahooInterval: "60m",
  yahooRange: "3mo",
  maxBars: 240,
};

export function chartTfSpec(
  mode: "SCALP" | "SWING",
  scalpTf: ScalpChartTf = "5m",
): AnalysisChartTfSpec {
  if (mode === "SWING") return SWING_SPEC;
  return SCALP_CHART_TF_SPEC[scalpTf];
}

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

async function fetchYahooRaw(
  underlying: Underlying,
  interval: string,
  range: string,
): Promise<TimedOhlcv[] | null> {
  const symbol = YAHOO_SYMBOL[underlying];
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
  return out;
}

/**
 * Aggregate 1m bars into N-minute OHLC (used when Yahoo lacks native 3m).
 * Bucket start = floor(unixSec / (periodMin*60)) * periodMin*60
 */
export function aggregateTimedBars(
  bars: TimedOhlcv[],
  periodMin: number,
): TimedOhlcv[] {
  if (periodMin <= 1 || bars.length === 0) return bars;
  const bucketSec = periodMin * 60;
  const map = new Map<number, TimedOhlcv>();
  const order: number[] = [];

  for (const b of bars) {
    const key = Math.floor(b.time / bucketSec) * bucketSec;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...b, time: key });
      order.push(key);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return order.map((k) => map.get(k)!);
}

/**
 * Public (Yahoo) timed OHLC for analysis chart — matches live NSE spot closely.
 * For 3m: Yahoo has no native interval → fetch 1m and aggregate to 3m (labeled source still yahoo).
 */
export async function getPublicAnalysisCandles(
  underlying: Underlying,
  mode: "SCALP" | "SWING",
  scalpTf: ScalpChartTf = "5m",
): Promise<TimedOhlcv[] | null> {
  const spec = chartTfSpec(mode, scalpTf);

  if (spec.yahooInterval) {
    return withTtlCache(
      `analysis-yahoo:${underlying}:${spec.yahooInterval}:${spec.yahooRange}`,
      20_000,
      async () => {
        const raw = await fetchYahooRaw(
          underlying,
          spec.yahooInterval!,
          spec.yahooRange,
        );
        if (!raw) return null;
        return raw.slice(-spec.maxBars);
      },
    );
  }

  // 3m path: aggregate Yahoo 1m → 3m
  return withTtlCache(
    `analysis-yahoo:${underlying}:1m-agg-3m:5d`,
    20_000,
    async () => {
      const raw1m = await fetchYahooRaw(underlying, "1m", "5d");
      if (!raw1m || raw1m.length < 8) return null;
      return aggregateTimedBars(raw1m, 3).slice(-spec.maxBars);
    },
  );
}
