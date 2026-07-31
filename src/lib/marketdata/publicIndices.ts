import type { DashboardIndex } from "@/lib/marketdata/angelone/dashboardIndices";
import { fetchGiftNiftyQuote } from "@/lib/marketdata/giftNifty";

export type PublicIndexQuote = {
  id: DashboardIndex;
  ltp: number;
  prevClose: number;
  candles: Array<{ open: number; high: number; low: number; close: number }>;
  source: string;
  note: string | null;
};

const YAHOO_SYMBOL: Record<Exclude<DashboardIndex, "GIFTNIFTY">, string> = {
  NIFTY: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  SENSEX: "^BSESN",
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }> | null;
    error?: { description?: string };
  };
};

async function fetchYahooChart(symbol: string): Promise<PublicIndexQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
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
  if (!result?.meta?.regularMarketPrice) return null;

  const ltp = Number(result.meta.regularMarketPrice);
  const prevClose = Number(
    result.meta.chartPreviousClose ?? result.meta.previousClose ?? ltp,
  );
  const q = result.indicators?.quote?.[0];
  const candles: PublicIndexQuote["candles"] = [];
  if (q?.open && q.high && q.low && q.close) {
    for (let i = 0; i < q.close.length; i++) {
      const open = q.open[i];
      const high = q.high[i];
      const low = q.low[i];
      const close = q.close[i];
      if (
        open == null ||
        high == null ||
        low == null ||
        close == null ||
        !Number.isFinite(open) ||
        !Number.isFinite(close)
      ) {
        continue;
      }
      candles.push({ open, high, low, close });
    }
  }

  return {
    id: "NIFTY", // overwritten by caller
    ltp,
    prevClose,
    candles: candles.slice(-24),
    source: "Yahoo Finance",
    note: null,
  };
}

type NseIndexRow = {
  index?: string;
  indexSymbol?: string;
  last?: number;
  previousClose?: number;
  variation?: number;
  percentChange?: number;
};

/** NSE public allIndices — good for Nifty / Bank Nifty when Yahoo is down. */
async function fetchNseSpot(
  id: "NIFTY" | "BANKNIFTY",
): Promise<{ ltp: number; prevClose: number } | null> {
  try {
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: NseIndexRow[] };
    const want =
      id === "NIFTY"
        ? (r: NseIndexRow) =>
            r.indexSymbol === "NIFTY 50" || r.index === "NIFTY 50"
        : (r: NseIndexRow) =>
            r.indexSymbol === "NIFTY BANK" || r.index === "NIFTY BANK";
    const row = (json.data ?? []).find(want);
    if (!row?.last) return null;
    return {
      ltp: Number(row.last),
      prevClose: Number(row.previousClose ?? row.last),
    };
  } catch {
    return null;
  }
}

/**
 * Live public index quotes for the Dashboard.
 * Angel One SmartAPI remains primary for option chains / lanes; Dashboard
 * uses Yahoo (+ NSE spot fallback) so LTP shows even in MARKETDATA_DEMO_MODE.
 */
export async function fetchPublicDashboardQuotes(): Promise<
  Partial<Record<DashboardIndex, PublicIndexQuote>>
> {
  const out: Partial<Record<DashboardIndex, PublicIndexQuote>> = {};

  await Promise.all(
    (Object.keys(YAHOO_SYMBOL) as Array<keyof typeof YAHOO_SYMBOL>).map(
      async (id) => {
        const yahoo = await fetchYahooChart(YAHOO_SYMBOL[id]);
        if (yahoo) {
          out[id] = { ...yahoo, id };
          return;
        }
        if (id === "NIFTY" || id === "BANKNIFTY") {
          const nse = await fetchNseSpot(id);
          if (nse) {
            out[id] = {
              id,
              ltp: nse.ltp,
              prevClose: nse.prevClose,
              candles: [],
              source: "NSE India",
              note: null,
            };
          }
        }
      },
    ),
  );

  // Gift Nifty — live NSE IX via giftcitynifty free API; Nifty proxy fallback
  const gift = await fetchGiftNiftyQuote();
  if (gift) {
    out.GIFTNIFTY = {
      id: "GIFTNIFTY",
      ltp: gift.ltp,
      prevClose: gift.prevClose,
      candles: gift.candles,
      source: gift.source,
      note: gift.note,
    };
  } else {
    const nifty = out.NIFTY;
    if (nifty) {
      out.GIFTNIFTY = {
        id: "GIFTNIFTY",
        ltp: nifty.ltp,
        prevClose: nifty.prevClose,
        candles: nifty.candles,
        source: "Nifty proxy",
        note: "Gift Nifty live feed unavailable — showing Nifty 50 as labeled proxy.",
      };
    }
  }

  return out;
}
