import type { DashboardIndex } from "@/lib/marketdata/angelone/dashboardIndices";
import { fetchGiftNiftyQuote } from "@/lib/marketdata/giftNifty";
import { withTtlCache } from "@/lib/marketdata/ttlCache";

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

/** Coalesce concurrent hub ticks / SSE clients (~1s cadence). */
const LTP_TTL_MS = 750;
/** Candles change slowly — avoid Yahoo chart hammering. */
const CANDLE_TTL_MS = 45_000;

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

async function fetchYahooChart(symbol: string): Promise<{
  ltp: number;
  prevClose: number;
  candles: PublicIndexQuote["candles"];
} | null> {
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
    ltp,
    prevClose,
    candles: candles.slice(-24),
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

type NseSpotMap = Partial<
  Record<"NIFTY" | "BANKNIFTY" | "SENSEX", { ltp: number; prevClose: number }>
>;

function matchNseRow(
  row: NseIndexRow,
  id: "NIFTY" | "BANKNIFTY" | "SENSEX",
): boolean {
  const sym = (row.indexSymbol ?? "").toUpperCase();
  const name = (row.index ?? "").toUpperCase();
  if (id === "NIFTY") {
    return sym === "NIFTY 50" || name === "NIFTY 50";
  }
  if (id === "BANKNIFTY") {
    return (
      sym === "NIFTY BANK" ||
      name === "NIFTY BANK" ||
      sym === "BANKNIFTY" ||
      name === "NIFTY BANK"
    );
  }
  return (
    sym === "SENSEX" ||
    name === "SENSEX" ||
    sym === "BSE SENSEX" ||
    name === "BSE SENSEX"
  );
}

/** One NSE allIndices pull for Nifty / Bank Nifty / Sensex spot. */
async function fetchNseSpotMap(): Promise<NseSpotMap> {
  try {
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return {};
    const json = (await res.json()) as { data?: NseIndexRow[] };
    const out: NseSpotMap = {};
    for (const id of ["NIFTY", "BANKNIFTY", "SENSEX"] as const) {
      const row = (json.data ?? []).find((r) => matchNseRow(r, id));
      if (row?.last != null && Number.isFinite(Number(row.last))) {
        out[id] = {
          ltp: Number(row.last),
          prevClose: Number(row.previousClose ?? row.last),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Live public index quotes for the Dashboard.
 * Angel One SmartAPI remains primary for option chains / lanes; Dashboard
 * uses NSE spot (+ Yahoo candles) so LTP shows even in MARKETDATA_DEMO_MODE.
 */
export async function fetchPublicDashboardQuotes(): Promise<
  Partial<Record<DashboardIndex, PublicIndexQuote>>
> {
  const out: Partial<Record<DashboardIndex, PublicIndexQuote>> = {};

  const nseSpots = await withTtlCache(
    "dash:nse-spots",
    LTP_TTL_MS,
    fetchNseSpotMap,
  );

  const indexIds = Object.keys(YAHOO_SYMBOL) as Array<keyof typeof YAHOO_SYMBOL>;

  const [indexRows, gift] = await Promise.all([
    Promise.all(
      indexIds.map(async (id) => {
        const nse = nseSpots[id];
        if (nse) {
          // Spot from NSE (fast); Yahoo chart only for sparkline, longer TTL
          const yahoo = await withTtlCache(
            `dash:yahoo-candles:${id}`,
            CANDLE_TTL_MS,
            () => fetchYahooChart(YAHOO_SYMBOL[id]),
          );
          return {
            id,
            quote: {
              id,
              ltp: nse.ltp,
              prevClose: nse.prevClose,
              candles: yahoo?.candles ?? [],
              source: "NSE India",
              note: null,
            } satisfies PublicIndexQuote,
          };
        }
        // NSE miss — Yahoo LTP at short TTL so cards still feel live
        const yahoo = await withTtlCache(
          `dash:yahoo-ltp:${id}`,
          LTP_TTL_MS,
          () => fetchYahooChart(YAHOO_SYMBOL[id]),
        );
        if (!yahoo) return { id, quote: null };
        return {
          id,
          quote: {
            id,
            ltp: yahoo.ltp,
            prevClose: yahoo.prevClose,
            candles: yahoo.candles,
            source: "Yahoo Finance",
            note: null,
          } satisfies PublicIndexQuote,
        };
      }),
    ),
    withTtlCache("dash:gift-nifty", LTP_TTL_MS, fetchGiftNiftyQuote),
  ]);

  for (const row of indexRows) {
    if (row.quote) out[row.id] = row.quote;
  }

  // Gift Nifty — live NSE IX via giftcitynifty free API; Nifty proxy fallback
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
