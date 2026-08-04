/**
 * Angel One Option Greeks API — Delta/Gamma/Theta/Vega/IV per strike.
 *
 * POST /rest/secure/angelbroking/marketData/v1/optionGreek
 * Body: { name, expirydate: "25JAN2024" } — one call returns ALL strikes for
 * that underlying+expiry. Values arrive as strings; parseFloat.
 *
 * Constraints (Angel docs / forum):
 * - Live contracts only (no expired series)
 * - Unreliable outside market hours → errorcode AB9019 "No Data Available"
 * - May diverge from other providers (Sensibull etc.) — treat as approx.
 *
 * Never throws to callers: returns null on failure / AB9019 / demo.
 */

import {
  angelPost,
  isDemoMarketDataMode,
} from "@/lib/marketdata/angelone/auth";
import { isMarketDataUnavailable } from "@/lib/marketdata/angelone/errors";
import type { OptionChainResult } from "@/lib/marketdata/angelone/types";
import { withTtlCache } from "@/lib/marketdata/ttlCache";

/** Greeks move slower than LTP — coalesce with option-chain REST-ish cadence. */
const GREEKS_TTL_MS = 18_000;

const GREEKS_PATH =
  "/rest/secure/angelbroking/marketData/v1/optionGreek";

export type OptionGreekRow = {
  strike: number;
  optionType: "CE" | "PE";
  /** Signed delta from Angel (PE typically negative). */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatility: number | null;
  tradeVolume: number | null;
};

/** O(1) lookup: `${strike}:${optionType}` → row */
export type OptionGreeksLookup = Map<string, OptionGreekRow>;

type AngelGreekRaw = {
  name?: string;
  expiry?: string;
  strikePrice?: string | number;
  optionType?: string;
  delta?: string | number;
  gamma?: string | number;
  theta?: string | number;
  vega?: string | number;
  impliedVolatility?: string | number;
  tradeVolume?: string | number;
};

export function greeksLookupKey(
  strike: number,
  optionType: "CE" | "PE",
): string {
  return `${strike}:${optionType}`;
}

/** ISO `2024-01-25` or already-Angel `25JAN2024` → Angel expirydate. */
export function toAngelExpirydate(expiry: string): string {
  const angel = expiry.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (angel) return `${angel[1]}${angel[2]}${angel[3]}`;

  const iso = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return expiry.toUpperCase();
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const mon = months[Number(iso[2]) - 1] ?? "JAN";
  return `${iso[3]}${mon}${iso[1]}`;
}

function parseNum(v: string | number | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function parseOptionType(raw: string | undefined): "CE" | "PE" | null {
  const t = (raw ?? "").toUpperCase();
  if (t === "CE" || t === "CALL") return "CE";
  if (t === "PE" || t === "PUT") return "PE";
  return null;
}

function buildLookup(rows: AngelGreekRaw[]): OptionGreeksLookup {
  const map: OptionGreeksLookup = new Map();
  for (const row of rows) {
    const optionType = parseOptionType(row.optionType);
    const strike = parseNum(row.strikePrice);
    if (!optionType || strike == null) continue;
    const parsed: OptionGreekRow = {
      strike,
      optionType,
      delta: parseNum(row.delta),
      gamma: parseNum(row.gamma),
      theta: parseNum(row.theta),
      vega: parseNum(row.vega),
      impliedVolatility: parseNum(row.impliedVolatility),
      tradeVolume: parseNum(row.tradeVolume),
    };
    map.set(greeksLookupKey(strike, optionType), parsed);
  }
  return map;
}

/**
 * Fetch Angel option Greeks for one underlying + expiry.
 * Returns a Map keyed by strike+optionType, or null when unavailable
 * (demo, AB9019 off-hours, auth/down, empty).
 * Failures are TTL-cached as null so off-hours does not hammer Angel.
 */
export async function fetchOptionGreeks(
  underlying: string,
  expiry: string,
): Promise<OptionGreeksLookup | null> {
  if (isDemoMarketDataMode()) return null;

  const name = underlying.toUpperCase();
  const expirydate = toAngelExpirydate(expiry);
  const cacheKey = `option-greeks:${name}:${expirydate}`;

  return withTtlCache(cacheKey, GREEKS_TTL_MS, async () => {
    try {
      // angelPost already runs through angelThrottle + session auth
      const data = await angelPost<AngelGreekRaw[] | null>(GREEKS_PATH, {
        name,
        expirydate,
      });
      if (!Array.isArray(data) || data.length === 0) return null;
      const lookup = buildLookup(data);
      return lookup.size > 0 ? lookup : null;
    } catch (err) {
      // AB9019 "No Data Available" (off-hours / no live series) is expected
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        isMarketDataUnavailable(err) && /AB9019|No Data Available/i.test(msg)
          ? "AB9019"
          : isMarketDataUnavailable(err)
            ? err.code
            : "UNKNOWN";
      console.warn(
        `[optionGreeks] unavailable for ${name} ${expirydate}: ${code} ${msg}`,
      );
      return null;
    }
  });
}

/**
 * Attach Angel delta onto chain contracts (merge by strike+optionType).
 * Does not replace LTP/OI/IV from NSE or Angel quote FULL.
 */
export async function attachOptionGreeks(
  chain: OptionChainResult,
): Promise<OptionChainResult> {
  if (chain.demo || isDemoMarketDataMode()) {
    return { ...chain, greeksStatus: "skipped" };
  }

  const lookup = await fetchOptionGreeks(chain.underlying, chain.expiry);
  if (!lookup) {
    return { ...chain, greeksStatus: "unavailable" };
  }

  const contracts = chain.contracts.map((c) => {
    const g = lookup.get(greeksLookupKey(c.strike, c.optionType));
    if (!g || g.delta == null) return c;
    return { ...c, delta: g.delta };
  });

  return {
    ...chain,
    contracts,
    greeksStatus: "ok",
  };
}

/** Convenience: lookup delta from a prior fetch (null when missing). */
export function deltaFromLookup(
  lookup: OptionGreeksLookup | null,
  strike: number,
  optionType: "CE" | "PE",
): number | null {
  if (!lookup) return null;
  const d = lookup.get(greeksLookupKey(strike, optionType))?.delta;
  return d != null && Number.isFinite(d) ? d : null;
}
