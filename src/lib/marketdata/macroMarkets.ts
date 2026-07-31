import { fetchGiftNiftyQuote } from "./giftNifty";
import { withTtlCache } from "./ttlCache";
import { fetchYahooQuotesBatched } from "./yahooQuote";

export type MacroQuote = {
  id: string;
  label: string;
  group: "gift" | "vix" | "us" | "asia" | "commodities" | "fx";
  country: string | null;
  price: number;
  change: number;
  changePct: number;
  currency: string | null;
  source: string;
  note: string | null;
};

/** Shared TTL for dashboard + Macro lane — avoid double-hitting free upstreams. */
export const MACRO_QUOTES_TTL_MS = 12_000;
export const MACRO_QUOTES_CACHE_KEY = "macro:quotes";

type Spec = {
  id: string;
  label: string;
  group: MacroQuote["group"];
  yahoo: string;
  country?: string;
  note?: string;
};

const SPECS: Spec[] = [
  { id: "INDIAVIX", label: "India VIX", group: "vix", yahoo: "^INDIAVIX", country: "India" },
  { id: "VIX", label: "US VIX", group: "vix", yahoo: "^VIX", country: "US" },
  { id: "DJI", label: "Dow Jones", group: "us", yahoo: "^DJI", country: "US" },
  { id: "IXIC", label: "Nasdaq", group: "us", yahoo: "^IXIC", country: "US" },
  { id: "GSPC", label: "S&P 500", group: "us", yahoo: "^GSPC", country: "US" },
  { id: "N225", label: "Nikkei 225", group: "asia", yahoo: "^N225", country: "Japan" },
  { id: "HSI", label: "Hang Seng", group: "asia", yahoo: "^HSI", country: "Hong Kong" },
  { id: "SSEC", label: "Shanghai Comp", group: "asia", yahoo: "000001.SS", country: "China" },
  { id: "KS11", label: "KOSPI", group: "asia", yahoo: "^KS11", country: "South Korea" },
  { id: "STI", label: "Straits Times", group: "asia", yahoo: "^STI", country: "Singapore" },
  { id: "CL", label: "WTI Crude", group: "commodities", yahoo: "CL=F", country: "US" },
  { id: "BZ", label: "Brent Crude", group: "commodities", yahoo: "BZ=F", country: "Global" },
  { id: "DXY", label: "Dollar Index (DXY)", group: "fx", yahoo: "DX-Y.NYB", country: "US" },
  { id: "USDINR", label: "USD / INR", group: "fx", yahoo: "INR=X", country: "India" },
];

async function fetchNseIndiaVix(): Promise<MacroQuote | null> {
  try {
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.nseindia.com/",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{
        index?: string;
        indexSymbol?: string;
        last?: number;
        previousClose?: number;
        percentChange?: number;
      }>;
    };
    const row = (json.data ?? []).find(
      (r) => r.indexSymbol === "INDIA VIX" || r.index === "INDIA VIX",
    );
    if (!row?.last) return null;
    const price = Number(row.last);
    const prev = Number(row.previousClose ?? price);
    const change = price - prev;
    const changePct =
      row.percentChange != null
        ? Number(row.percentChange)
        : prev !== 0
          ? (change / prev) * 100
          : 0;
    return {
      id: "INDIAVIX",
      label: "India VIX",
      group: "vix",
      country: "India",
      price,
      change,
      changePct,
      currency: "INR",
      source: "NSE India",
      note: null,
    };
  } catch {
    return null;
  }
}

/**
 * Global / macro quotes for Dashboard via free Yahoo chart + NSE VIX fallback.
 */
export async function fetchMacroMarketQuotes(): Promise<MacroQuote[]> {
  const [yahooMap, gift, nseVix] = await Promise.all([
    fetchYahooQuotesBatched(
      [...new Set(["^NSEI", ...SPECS.map((s) => s.yahoo)])],
      4,
    ),
    fetchGiftNiftyQuote(),
    fetchNseIndiaVix(),
  ]);

  const quotes: MacroQuote[] = [];

  if (gift) {
    quotes.push({
      id: "GIFTNIFTY",
      label: "Gift Nifty",
      group: "gift",
      country: "India",
      price: gift.ltp,
      change: gift.change,
      changePct: gift.changePct,
      currency: "INR",
      source: gift.source,
      note: gift.note,
    });
  } else {
    const niftyProxy = yahooMap.get("^NSEI");
    if (niftyProxy) {
      quotes.push({
        id: "GIFTNIFTY",
        label: "Gift Nifty",
        group: "gift",
        country: "India",
        price: niftyProxy.price,
        change: niftyProxy.change,
        changePct: niftyProxy.changePct,
        currency: niftyProxy.currency,
        source: "Nifty proxy",
        note: "Gift Nifty live feed unavailable — showing Nifty 50 as labeled proxy.",
      });
    }
  }

  for (const spec of SPECS) {
    const y = yahooMap.get(spec.yahoo);
    if (!y) continue;
    quotes.push({
      id: spec.id,
      label: spec.label,
      group: spec.group,
      country: spec.country ?? null,
      price: y.price,
      change: y.change,
      changePct: y.changePct,
      currency: y.currency,
      source: "Yahoo Finance",
      note: spec.note ?? null,
    });
  }

  if (nseVix) {
    const idx = quotes.findIndex((q) => q.id === "INDIAVIX");
    if (idx >= 0) quotes[idx] = nseVix;
    else quotes.push(nseVix);
  }

  return quotes;
}

/**
 * Single source of truth for macro quotes used by `/api/dashboard/macro` and the Macro lane.
 * In-process TTL coalesce so scalp/synthesis re-runs do not hammer Yahoo / NSE / Gift.
 */
export function getCachedMacroQuotes(): Promise<MacroQuote[]> {
  return withTtlCache(
    MACRO_QUOTES_CACHE_KEY,
    MACRO_QUOTES_TTL_MS,
    fetchMacroMarketQuotes,
  );
}
