/**
 * Daily FII / DII cash-market net buy/sell (₹ Crore).
 * Primary: NSE public JSON. Fallback: free Mr Chartist mirror (NSE-sourced).
 */

import { withTtlCache } from "./ttlCache";

export type FiiDiiSnapshot = {
  date: string;
  fiiBuy: number;
  fiiSell: number;
  fiiNet: number;
  diiBuy: number;
  diiSell: number;
  diiNet: number;
  source: string;
  note: string | null;
};

/** Daily institutional flow updates slowly — 15 min TTL is plenty. */
export const FII_DII_TTL_MS = 15 * 60_000;
export const FII_DII_CACHE_KEY = "sentiment:fii-dii";

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type NseRow = {
  category?: string;
  date?: string;
  buyValue?: string;
  sellValue?: string;
  netValue?: string;
};

async function fetchFromNse(): Promise<FiiDiiSnapshot | null> {
  try {
    const res = await fetch("https://www.nseindia.com/api/fiidiiTradeReact", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.nseindia.com/reports/fii-dii",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as NseRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const fii = rows.find((r) => /fii/i.test(r.category ?? ""));
    const dii = rows.find((r) => /dii/i.test(r.category ?? ""));
    const fiiNet = num(fii?.netValue);
    const diiNet = num(dii?.netValue);
    if (fiiNet == null || diiNet == null) return null;

    return {
      date: fii?.date ?? dii?.date ?? "unknown",
      fiiBuy: num(fii?.buyValue) ?? 0,
      fiiSell: num(fii?.sellValue) ?? 0,
      fiiNet,
      diiBuy: num(dii?.buyValue) ?? 0,
      diiSell: num(dii?.sellValue) ?? 0,
      diiNet,
      source: "NSE India fiidiiTradeReact",
      note: "Provisional cash-market figures; subject to custodial confirmation.",
    };
  } catch {
    return null;
  }
}

type MrChartistPayload = {
  date?: string;
  fii_buy?: number;
  fii_sell?: number;
  fii_net?: number;
  dii_buy?: number;
  dii_sell?: number;
  dii_net?: number;
  _source?: string;
};

async function fetchFromMrChartist(): Promise<FiiDiiSnapshot | null> {
  try {
    const res = await fetch("https://fii-diidata.mrchartist.com/api/data", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as MrChartistPayload;
    const fiiNet = num(json.fii_net);
    const diiNet = num(json.dii_net);
    if (fiiNet == null || diiNet == null) return null;

    return {
      date: json.date ?? "unknown",
      fiiBuy: num(json.fii_buy) ?? 0,
      fiiSell: num(json.fii_sell) ?? 0,
      fiiNet,
      diiBuy: num(json.dii_buy) ?? 0,
      diiSell: num(json.dii_sell) ?? 0,
      diiNet,
      source: "Mr Chartist FII/DII mirror (NSE-sourced)",
      note: "Free unofficial mirror of NSE cash FII/DII; polite rate limits.",
    };
  } catch {
    return null;
  }
}

/**
 * Latest daily FII/DII cash net (₹ Cr). NSE first, Mr Chartist fallback.
 */
export async function fetchFiiDiiSnapshot(): Promise<FiiDiiSnapshot | null> {
  const nse = await fetchFromNse();
  if (nse) return nse;
  return fetchFromMrChartist();
}

export function getCachedFiiDiiSnapshot(): Promise<FiiDiiSnapshot | null> {
  return withTtlCache(FII_DII_CACHE_KEY, FII_DII_TTL_MS, fetchFiiDiiSnapshot);
}
