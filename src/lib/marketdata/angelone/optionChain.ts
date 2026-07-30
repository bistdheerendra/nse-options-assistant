import { cacheGet, cacheSet } from "@/lib/redis";
import { isDemoMarketDataMode } from "./auth";
import { angelPost } from "./auth";
import { mockOptionChain } from "./mock";
import { getUnderlyingLtp } from "./quotes";
import type { OptionChainResult, OptionContractQuote, Underlying } from "./types";
import { UNDERLYING_META } from "./types";
import { angelThrottle } from "./throttle";

type ScripRow = {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
};

let scripCache: ScripRow[] | null = null;
let scripFetchedAt = 0;

async function loadScripMaster(): Promise<ScripRow[]> {
  const cached = await cacheGet<ScripRow[]>("angel:scrip-master");
  if (cached?.length) return cached;
  if (scripCache && Date.now() - scripFetchedAt < 6 * 60 * 60 * 1000) {
    return scripCache;
  }

  const url =
    "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to download scrip master: ${res.status}`);
  }
  const data = (await res.json()) as ScripRow[];
  scripCache = data;
  scripFetchedAt = Date.now();
  await cacheSet("angel:scrip-master", data, 6 * 60 * 60);
  return data;
}

function parseExpiryToIso(expiry: string): string {
  // Angel dump uses formats like "25JAN2024" or "08FEB2024"
  const m = expiry.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return expiry;
  const months: Record<string, string> = {
    JAN: "01",
    FEB: "02",
    MAR: "03",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AUG: "08",
    SEP: "09",
    OCT: "10",
    NOV: "11",
    DEC: "12",
  };
  return `${m[3]}-${months[m[2]!] ?? "01"}-${m[1]}`;
}

function pickNearestExpiry(rows: ScripRow[], preferred?: string): string {
  const expiries = [...new Set(rows.map((r) => r.expiry))].filter(Boolean);
  if (preferred) {
    const hit = expiries.find(
      (e) => parseExpiryToIso(e) === preferred || e === preferred,
    );
    if (hit) return hit;
  }
  const today = new Date().toISOString().slice(0, 10);
  const sorted = expiries
    .map((e) => ({ e, iso: parseExpiryToIso(e) }))
    .filter((x) => x.iso >= today)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  return sorted[0]?.e ?? expiries[0]!;
}

async function quoteFull(
  exchange: string,
  tokens: string[],
): Promise<
  Array<{
    symbolToken: string;
    tradingSymbol?: string;
    ltp: number;
    bidPrice?: number;
    askPrice?: number;
    tradeVolume?: number;
    opnInterest?: number;
    // IV may appear under varying keys depending on feed mode
    impliedVolatility?: number;
    iv?: number;
  }>
> {
  // Batch tokens (Angel quote API accepts multiple per exchange)
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += 50) {
    chunks.push(tokens.slice(i, i + 50));
  }
  const out: Array<{
    symbolToken: string;
    tradingSymbol?: string;
    ltp: number;
    bidPrice?: number;
    askPrice?: number;
    tradeVolume?: number;
    opnInterest?: number;
    impliedVolatility?: number;
    iv?: number;
  }> = [];

  for (const chunk of chunks) {
    const data = await angelThrottle.schedule(() =>
      angelPost<{
        fetched?: Array<Record<string, unknown>>;
      }>("/rest/secure/angelbroking/market/v1/quote", {
        mode: "FULL",
        exchangeTokens: { [exchange]: chunk },
      }),
    );
    for (const row of data?.fetched ?? []) {
      out.push({
        symbolToken: String(row.symbolToken ?? row.symboltoken ?? ""),
        tradingSymbol: String(row.tradingSymbol ?? row.tradingsymbol ?? ""),
        ltp: Number(row.ltp ?? 0),
        bidPrice: Number(row.bidPrice ?? row.bestBid ?? 0) || undefined,
        askPrice: Number(row.askPrice ?? row.bestAsk ?? 0) || undefined,
        tradeVolume: Number(row.tradeVolume ?? row.volume ?? 0) || undefined,
        opnInterest: Number(row.opnInterest ?? row.oi ?? 0) || undefined,
        impliedVolatility:
          Number(row.impliedVolatility ?? row.iv ?? 0) || undefined,
        iv: Number(row.iv ?? row.impliedVolatility ?? 0) || undefined,
      });
    }
  }
  return out;
}

/**
 * Full option chain for an underlying + expiry.
 * Angel One has no dedicated chain endpoint — we filter OpenAPIScripMaster
 * then enrich with market/v1/quote FULL (LTP, OI, IV when available).
 */
export async function getOptionChain(
  underlying: Underlying,
  expiry?: string,
): Promise<OptionChainResult> {
  if (isDemoMarketDataMode()) {
    return mockOptionChain(underlying, expiry);
  }

  const meta = UNDERLYING_META[underlying];
  const spotQuote = await getUnderlyingLtp(underlying);
  const scrips = await loadScripMaster();

  const name = underlying === "SENSEX" ? "SENSEX" : underlying;
  const optionRows = scrips.filter(
    (r) =>
      r.exch_seg === meta.optionExchange &&
      (r.name === name || r.symbol.startsWith(name)) &&
      (r.instrumenttype === "OPTIDX" ||
        r.instrumenttype === "OPTSTK" ||
        r.symbol.includes("CE") ||
        r.symbol.includes("PE")),
  );

  const chosenExpiry = pickNearestExpiry(optionRows, expiry);
  const expiryRows = optionRows.filter((r) => r.expiry === chosenExpiry);

  // Focus near ATM (±10 strikes) to stay within throttle budget
  const stepGuess =
    underlying === "NIFTY" ? 50 : underlying === "BANKNIFTY" ? 100 : 100;
  const atm = Math.round(spotQuote.ltp / stepGuess) * stepGuess;
  const near = expiryRows.filter((r) => {
    const strike = Number(r.strike) / 100; // Angel stores strike * 100
    return Math.abs(strike - atm) <= stepGuess * 10;
  });

  const tokens = near.map((r) => r.token);
  const quotes = await quoteFull(meta.optionExchange, tokens);
  const byToken = new Map(quotes.map((q) => [q.symbolToken, q]));

  const contracts: OptionContractQuote[] = near.map((r) => {
    const strike = Number(r.strike) / 100;
    const q = byToken.get(r.token);
    const optionType: "CE" | "PE" = r.symbol.endsWith("CE") ? "CE" : "PE";
    return {
      strike,
      optionType,
      tradingsymbol: r.symbol,
      symboltoken: r.token,
      ltp: q?.ltp ?? 0,
      bid: q?.bidPrice,
      ask: q?.askPrice,
      volume: q?.tradeVolume,
      oi: q?.opnInterest,
      iv: q?.impliedVolatility ?? q?.iv,
      lotSize: Number(r.lotsize) || meta.lotSize,
      expiry: parseExpiryToIso(chosenExpiry),
    };
  });

  return {
    underlying,
    spot: spotQuote.ltp,
    expiry: parseExpiryToIso(chosenExpiry),
    contracts,
  };
}
