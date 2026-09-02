import { getOptionChainLtps } from "@/lib/marketdata/angelone/optionChain";
import { isDemoMarketDataMode } from "@/lib/marketdata/angelone/auth";
import { getLtp, quoteOptionLtps } from "@/lib/marketdata/angelone/quotes";
import type { Underlying } from "@/lib/marketdata/angelone/types";
import { UNDERLYING_META } from "@/lib/marketdata/angelone/types";
import {
  matchChainContract,
  positionMarkKeys,
  type PositionMarkRef,
} from "./positionMarkLookup";

function isUnderlying(u: string): u is Underlying {
  return u === "NIFTY" || u === "BANKNIFTY" || u === "SENSEX";
}

function optionExchangeFor(underlying: string): "NFO" | "BFO" {
  if (underlying in UNDERLYING_META) {
    return UNDERLYING_META[underlying as Underlying].optionExchange;
  }
  return underlying === "SENSEX" ? "BFO" : "NFO";
}

function isAngelToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function writeMarks(
  marks: Record<string, number>,
  p: PositionMarkRef,
  ltp: number,
) {
  for (const key of positionMarkKeys(p)) marks[key] = ltp;
}

/**
 * Live LTP for every OPEN paper row, any underlying / expiry.
 * Paper chain stores NSE identifiers (not Angel numeric tokens), so we
 * re-fetch that expiry's chain and match strike + type.
 */
let marksInflight: Promise<Record<string, number>> | null = null;

export async function fetchPositionMarks(
  positions: Array<PositionMarkRef & { status?: string }>,
): Promise<Record<string, number>> {
  if (marksInflight) return marksInflight;
  marksInflight = loadPositionMarks(positions).finally(() => {
    marksInflight = null;
  });
  return marksInflight;
}

async function loadPositionMarks(
  positions: Array<PositionMarkRef & { status?: string }>,
): Promise<Record<string, number>> {
  const open = positions.filter((p) => !p.status || p.status === "OPEN");
  if (!open.length) return {};

  const groups = new Map<string, typeof open>();
  for (const p of open) {
    const key = `${p.underlying}:${p.expiry ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const marks: Record<string, number> = {};
  const unmatched: typeof open = [];

  for (const rows of groups.values()) {
    const underlying = rows[0]?.underlying;
    if (!underlying || !isUnderlying(underlying)) {
      unmatched.push(...rows);
      continue;
    }
    try {
      const chain = await getOptionChainLtps(underlying, rows[0]?.expiry, {
        includeStrikes: rows.map((r) => r.strike),
      });
      for (const p of rows) {
        const c = matchChainContract(p, chain.contracts);
        if (c && Number.isFinite(c.ltp) && c.ltp > 0) {
          writeMarks(marks, p, c.ltp);
        } else {
          unmatched.push(p);
        }
      }
    } catch {
      unmatched.push(...rows);
    }
  }

  const angelRows = unmatched.filter(
    (p) => p.symbolToken && isAngelToken(String(p.symbolToken)),
  );
  if (!angelRows.length) return marks;

  if (isDemoMarketDataMode()) return marks;

  const tokensByExchange: Record<string, Set<string>> = {};
  for (const p of angelRows) {
    const exch = optionExchangeFor(p.underlying);
    (tokensByExchange[exch] ??= new Set()).add(String(p.symbolToken));
  }
  try {
    const quotes = await quoteOptionLtps(
      Object.fromEntries(
        Object.entries(tokensByExchange).map(([exch, set]) => [exch, [...set]]),
      ),
    );
    const ltpByToken = new Map(quotes.map((q) => [q.symbolToken, q.ltp]));
    for (const p of angelRows) {
      const ltp = ltpByToken.get(String(p.symbolToken));
      if (ltp != null && ltp > 0) writeMarks(marks, p, ltp);
    }
  } catch {
    for (const p of angelRows) {
      try {
        const q = await getLtp({
          exchange: optionExchangeFor(p.underlying),
          tradingsymbol: p.tradingSymbol ?? "",
          symboltoken: String(p.symbolToken),
        });
        if (Number.isFinite(q.ltp) && q.ltp > 0) writeMarks(marks, p, q.ltp);
      } catch {
        // leave unmarked
      }
    }
  }

  return marks;
}
