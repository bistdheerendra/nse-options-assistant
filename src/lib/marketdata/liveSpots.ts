import type { DashboardIndex } from "@/lib/marketdata/angelone/dashboardIndices";
import { fetchGiftNiftyQuote } from "@/lib/marketdata/giftNifty";

export type LiveSpot = {
  id: DashboardIndex;
  ltp: number;
  prevClose: number;
  source: string;
};

type NseIndexRow = {
  index?: string;
  indexSymbol?: string;
  last?: number;
  previousClose?: number;
};

function matchNseRow(
  row: NseIndexRow,
  id: "NIFTY" | "BANKNIFTY" | "SENSEX",
): boolean {
  const sym = (row.indexSymbol ?? "").toUpperCase();
  const name = (row.index ?? "").toUpperCase();
  if (id === "NIFTY") return sym === "NIFTY 50" || name === "NIFTY 50";
  if (id === "BANKNIFTY") {
    return (
      sym === "NIFTY BANK" ||
      name === "NIFTY BANK" ||
      sym === "BANKNIFTY"
    );
  }
  return (
    sym === "SENSEX" ||
    name === "SENSEX" ||
    sym === "BSE SENSEX" ||
    name === "BSE SENSEX"
  );
}

/** Uncached NSE allIndices — intended for the live hub only. */
async function fetchNseSpotsUncached(): Promise<
  Partial<Record<"NIFTY" | "BANKNIFTY" | "SENSEX", LiveSpot>>
> {
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
    const out: Partial<Record<"NIFTY" | "BANKNIFTY" | "SENSEX", LiveSpot>> = {};
    for (const id of ["NIFTY", "BANKNIFTY", "SENSEX"] as const) {
      const row = (json.data ?? []).find((r) => matchNseRow(r, id));
      if (row?.last != null && Number.isFinite(Number(row.last))) {
        out[id] = {
          id,
          ltp: Number(row.last),
          prevClose: Number(row.previousClose ?? row.last),
          source: "NSE India",
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Lightweight live spots for SSE hub — no Yahoo candles, no TTL cache.
 * Gift + NSE in parallel so the hub can tick sub-second.
 */
export async function fetchLiveSpots(): Promise<Partial<Record<DashboardIndex, LiveSpot>>> {
  const [nse, gift] = await Promise.all([
    fetchNseSpotsUncached(),
    fetchGiftNiftyQuote(),
  ]);

  const out: Partial<Record<DashboardIndex, LiveSpot>> = { ...nse };

  if (gift) {
    out.GIFTNIFTY = {
      id: "GIFTNIFTY",
      ltp: gift.ltp,
      prevClose: gift.prevClose,
      source: gift.source,
    };
  } else if (out.NIFTY) {
    out.GIFTNIFTY = {
      id: "GIFTNIFTY",
      ltp: out.NIFTY.ltp,
      prevClose: out.NIFTY.prevClose,
      source: "Nifty proxy",
    };
  }

  return out;
}
