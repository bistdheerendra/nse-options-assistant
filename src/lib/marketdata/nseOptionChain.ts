import { fetchPublicDashboardQuotes } from "@/lib/marketdata/publicIndices";
import type {
  OptionChainResult,
  OptionContractQuote,
  Underlying,
} from "@/lib/marketdata/angelone/types";
import { UNDERLYING_META } from "@/lib/marketdata/angelone/types";

type NseSide = {
  lastPrice?: number;
  change?: number;
  pChange?: number;
  PChange?: number;
  openInterest?: number;
  impliedVolatility?: number;
  buyPrice1?: number;
  sellPrice1?: number;
  totalTradedVolume?: number;
  identifier?: string;
  strikePrice?: number;
  expiryDate?: string;
};

type NseRow = {
  strikePrice?: number;
  expiryDates?: string;
  CE?: NseSide;
  PE?: NseSide;
};

const NSE_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

/** NSE only publishes index OC for NIFTY / BANKNIFTY (not SENSEX). */
export function isNseOptionChainUnderlying(
  underlying: Underlying,
): underlying is "NIFTY" | "BANKNIFTY" {
  return underlying === "NIFTY" || underlying === "BANKNIFTY";
}

function isoToNseExpiry(iso: string): string {
  // 2026-08-04 → 04-Aug-2026
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mon = months[Number(m[2]) - 1] ?? "Jan";
  return `${m[3]}-${mon}-${m[1]}`;
}

function nseExpiryToIso(nse: string): string {
  // 04-Aug-2026 or 04-08-2026 → 2026-08-04
  const a = nse.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (a) {
    const months: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };
    return `${a[3]}-${months[a[2]!] ?? "01"}-${a[1]}`;
  }
  const b = nse.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (b) return `${b[3]}-${b[2]}-${b[1]}`;
  return nse;
}

async function nseSessionCookie(): Promise<string> {
  const res = await fetch("https://www.nseindia.com/option-chain", {
    headers: NSE_HEADERS,
    cache: "no-store",
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.join("; ");
}

async function nseGetJson<T>(url: string, cookie: string): Promise<T> {
  const res = await fetch(url, {
    headers: { ...NSE_HEADERS, Cookie: cookie },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`NSE request failed ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

function mapSide(
  underlying: Underlying,
  optionType: "CE" | "PE",
  side: NseSide,
  strike: number,
  expiryIso: string,
  lotSize: number,
): OptionContractQuote {
  const changePct = Number(side.pChange ?? side.PChange ?? 0);
  const change = Number(side.change ?? 0);
  const id =
    side.identifier ??
    `${underlying}${expiryIso.replace(/-/g, "")}${strike}${optionType}`;
  return {
    strike,
    optionType,
    tradingsymbol: id,
    symboltoken: id,
    ltp: Number(side.lastPrice ?? 0),
    change,
    changePct,
    bid: Number(side.buyPrice1 ?? 0) || undefined,
    ask: Number(side.sellPrice1 ?? 0) || undefined,
    volume: Number(side.totalTradedVolume ?? 0) || undefined,
    oi: Number(side.openInterest ?? 0) || undefined,
    iv: Number(side.impliedVolatility ?? 0) || undefined,
    lotSize,
    expiry: expiryIso,
  };
}

/**
 * Live NSE India option chain (Call/Put LTP, OI, IV, % change).
 * Uses option-chain-v3 + contract-info (cookie session required).
 */
export async function getNseOptionChain(
  underlying: "NIFTY" | "BANKNIFTY",
  preferredExpiryIso?: string,
): Promise<OptionChainResult> {
  const cookie = await nseSessionCookie();
  const info = await nseGetJson<{ expiryDates?: string[] }>(
    `https://www.nseindia.com/api/option-chain-contract-info?symbol=${underlying}`,
    cookie,
  );
  const expiryDates = info.expiryDates ?? [];
  if (!expiryDates.length) {
    throw new Error(`NSE: no expiries for ${underlying}`);
  }

  let chosen = expiryDates[0]!;
  if (preferredExpiryIso) {
    const want = isoToNseExpiry(preferredExpiryIso);
    const hit = expiryDates.find(
      (e) => e === want || e === preferredExpiryIso || nseExpiryToIso(e) === preferredExpiryIso,
    );
    if (hit) chosen = hit;
  }

  const payload = await nseGetJson<{
    records?: {
      data?: NseRow[];
      underlyingValue?: number;
      expiryDates?: string[];
    };
  }>(
    `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${underlying}&expiry=${encodeURIComponent(chosen)}`,
    cookie,
  );

  const spot = Number(payload.records?.underlyingValue ?? 0);
  const expiryIso = nseExpiryToIso(chosen);
  const lotSize = UNDERLYING_META[underlying].lotSize;
  const step = underlying === "NIFTY" ? 50 : 100;
  const atm = Math.round(spot / step) * step;

  const rows = (payload.records?.data ?? []).filter((r) => {
    const k = Number(r.strikePrice ?? 0);
    return Math.abs(k - atm) <= step * 12;
  });

  const contracts: OptionContractQuote[] = [];
  for (const row of rows) {
    const strike = Number(row.strikePrice ?? 0);
    if (!strike) continue;
    if (row.CE) {
      contracts.push(
        mapSide(underlying, "CE", row.CE, strike, expiryIso, lotSize),
      );
    }
    if (row.PE) {
      contracts.push(
        mapSide(underlying, "PE", row.PE, strike, expiryIso, lotSize),
      );
    }
  }

  contracts.sort(
    (a, b) =>
      a.strike - b.strike || a.optionType.localeCompare(b.optionType),
  );

  let spotChange: number | undefined;
  let spotChangePct: number | undefined;
  try {
    const pub = (await fetchPublicDashboardQuotes())[underlying];
    if (pub) {
      spotChange = pub.ltp - pub.prevClose;
      spotChangePct =
        pub.prevClose !== 0 ? (spotChange / pub.prevClose) * 100 : 0;
    }
  } catch {
    // optional
  }

  return {
    underlying,
    spot,
    spotChange,
    spotChangePct,
    expiry: expiryIso,
    contracts,
    demo: false,
  };
}
