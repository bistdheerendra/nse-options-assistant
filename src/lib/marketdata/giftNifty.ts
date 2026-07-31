/**
 * Live Gift Nifty (NSE IX) via free public mirror:
 * https://live.giftcitynifty.com/api/gift-nifty
 * (aggregates NiftyTrader / NSE IX — no API key)
 */

export type GiftNiftyQuote = {
  ltp: number;
  prevClose: number;
  change: number;
  changePct: number;
  open: number | null;
  high: number | null;
  low: number | null;
  candles: Array<{ open: number; high: number; low: number; close: number }>;
  source: string;
  note: string | null;
  timestamp: string | null;
};

type GiftApiResponse = {
  success?: boolean;
  symbol?: string;
  lastPrice?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  change?: number;
  changePercent?: number;
  chartData?: number[];
  timestamp?: string;
};

/** Build mini OHLC bars from 5m close series for dashboard sparkline. */
function closesToCandles(
  closes: number[],
): Array<{ open: number; high: number; low: number; close: number }> {
  const out: Array<{ open: number; high: number; low: number; close: number }> =
    [];
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    if (!Number.isFinite(close)) continue;
    const open = i > 0 && Number.isFinite(closes[i - 1]) ? closes[i - 1]! : close;
    out.push({
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    });
  }
  return out.slice(-24);
}

export async function fetchGiftNiftyQuote(): Promise<GiftNiftyQuote | null> {
  try {
    const res = await fetch("https://live.giftcitynifty.com/api/gift-nifty", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
        Accept: "application/json",
        Referer: "https://live.giftcitynifty.com/",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as GiftApiResponse;
    const ltp = Number(json.lastPrice);
    if (!json.success || !Number.isFinite(ltp)) return null;

    const prevClose = Number(json.close);
    const prev = Number.isFinite(prevClose) ? prevClose : ltp;
    // Prefer vendor change fields; else derive: change = ltp - prevClose
    const change =
      json.change != null && Number.isFinite(Number(json.change))
        ? Number(json.change)
        : ltp - prev;
    const changePct =
      json.changePercent != null && Number.isFinite(Number(json.changePercent))
        ? Number(json.changePercent)
        : prev !== 0
          ? (change / prev) * 100
          : 0;

    const chartCloses = (json.chartData ?? []).filter((n) =>
      Number.isFinite(n),
    );

    return {
      ltp,
      prevClose: prev,
      change,
      changePct,
      open: Number.isFinite(Number(json.open)) ? Number(json.open) : null,
      high: Number.isFinite(Number(json.high)) ? Number(json.high) : null,
      low: Number.isFinite(Number(json.low)) ? Number(json.low) : null,
      candles: closesToCandles(chartCloses),
      source: "Gift City Nifty (NSE IX)",
      note: null,
      timestamp: json.timestamp ?? null,
    };
  } catch {
    return null;
  }
}
