import { cacheGet, cacheSet } from "@/lib/redis";
import { getUnderlyingLtp } from "./quotes";
import {
  EXCHANGE_BSE_FO,
  EXCHANGE_NSE_FO,
} from "./websocketFeed";
import type { Underlying } from "./types";
import { UNDERLYING_META } from "./types";

type ScripRow = {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
};

export type AtmOptionTokenRow = {
  token: string;
  strike: number;
  optionType: "CE" | "PE";
  tradingsymbol: string;
  lotSize: number;
  expiry: string;
};

export type AtmOptionTokenSet = {
  underlying: Underlying;
  exchangeType: number;
  spot: number;
  expiry: string;
  /** Angel strike step used for ATM band. */
  step: number;
  rows: AtmOptionTokenRow[];
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

function strikeStep(underlying: Underlying): number {
  return underlying === "NIFTY" ? 50 : underlying === "BANKNIFTY" ? 100 : 100;
}

/**
 * Resolve Angel symbolTokens for ATM ±`band` strikes (CE+PE) for WS subscribe.
 * Default band 10 ≈ 42 tokens — well under SmartAPI session caps.
 */
export async function resolveAtmOptionTokens(
  underlying: Underlying,
  opts?: { expiry?: string; band?: number },
): Promise<AtmOptionTokenSet> {
  const band = opts?.band ?? 10;
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

  const chosenExpiry = pickNearestExpiry(optionRows, opts?.expiry);
  const expiryRows = optionRows.filter((r) => r.expiry === chosenExpiry);
  const step = strikeStep(underlying);
  const atm = Math.round(spotQuote.ltp / step) * step;

  const near = expiryRows.filter((r) => {
    const strike = Number(r.strike) / 100; // Angel stores strike * 100
    return Math.abs(strike - atm) <= step * band;
  });

  const rows: AtmOptionTokenRow[] = near.map((r) => {
    const strike = Number(r.strike) / 100;
    const optionType: "CE" | "PE" = r.symbol.endsWith("CE") ? "CE" : "PE";
    return {
      token: r.token,
      strike,
      optionType,
      tradingsymbol: r.symbol,
      lotSize: Number(r.lotsize) || meta.lotSize,
      expiry: parseExpiryToIso(chosenExpiry),
    };
  });

  return {
    underlying,
    exchangeType:
      meta.optionExchange === "BFO" ? EXCHANGE_BSE_FO : EXCHANGE_NSE_FO,
    spot: spotQuote.ltp,
    expiry: parseExpiryToIso(chosenExpiry),
    step,
    rows,
  };
}
