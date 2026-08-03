import type { Underlying } from "@/lib/marketdata/angelone";
import { driversForUnderlying } from "@/lib/marketdata/indexDrivers";
import { fetchLiveSpots } from "@/lib/marketdata/liveSpots";
import { fetchYahooSimpleQuote, fetchYahooQuotesBatched } from "@/lib/marketdata/yahooQuote";
import { withTtlCache } from "@/lib/marketdata/ttlCache";

export type HeatmapCell = {
  ticker: string;
  name: string;
  weightPct: number;
  ltp: number | null;
  changePct: number | null;
  /**
   * Estimated index points contributed today:
   * pts = weightPct × changePct × indexLevel / 10_000
   * (uses approx weights — labeled est., not NSE official).
   */
  pointsEst: number | null;
};

export type IndexHeatmapResult = {
  underlying: Underlying;
  indexLevel: number | null;
  indexPrevClose: number | null;
  cells: HeatmapCell[];
  fetchedAt: string;
  source: string;
  note: string;
  /** Sum of estimated contribution points across shown drivers. */
  netPointsEst: number | null;
};

/**
 * Estimated contribution points to the index level.
 * pts = (w/100) * (Δ%/100) * Index = w * Δ% * Index / 10000
 */
export function estimateContributionPoints(
  weightPct: number,
  changePct: number,
  indexLevel: number,
): number {
  return (weightPct * changePct * indexLevel) / 10_000;
}

async function resolveIndexLevel(
  underlying: Underlying,
): Promise<{ level: number | null; prevClose: number | null; source: string }> {
  const spots = await fetchLiveSpots();
  const spot = spots[underlying];
  if (spot?.ltp != null && Number.isFinite(spot.ltp)) {
    return {
      level: spot.ltp,
      prevClose: spot.prevClose,
      source: spot.source,
    };
  }

  const yahooSym =
    underlying === "NIFTY"
      ? "^NSEI"
      : underlying === "BANKNIFTY"
        ? "^NSEBANK"
        : "^BSESN";
  const y = await fetchYahooSimpleQuote(yahooSym);
  if (y) {
    return { level: y.price, prevClose: y.prevClose, source: "Yahoo" };
  }
  return { level: null, prevClose: null, source: "none" };
}

/**
 * Fetch driver quotes and build heatmap with estimated index-point contributions.
 */
export async function getIndexHeatmap(
  underlying: Underlying,
): Promise<IndexHeatmapResult> {
  const drivers = driversForUnderlying(underlying);
  const symbols = drivers.map((d) => d.yahoo);

  const [quotes, indexMeta] = await Promise.all([
    withTtlCache(`heatmap:${underlying}`, 20_000, () =>
      fetchYahooQuotesBatched(symbols, 4),
    ),
    withTtlCache(`heatmap-index:${underlying}`, 15_000, () =>
      resolveIndexLevel(underlying),
    ),
  ]);

  const indexLevel = indexMeta.level;

  const cells: HeatmapCell[] = drivers.map((d) => {
    const q = quotes.get(d.yahoo);
    const changePct = q ? q.changePct : null;
    const pointsEst =
      changePct != null && indexLevel != null
        ? estimateContributionPoints(d.weightPct, changePct, indexLevel)
        : null;
    return {
      ticker: d.ticker,
      name: d.name,
      weightPct: d.weightPct,
      ltp: q?.price ?? null,
      changePct,
      pointsEst:
        pointsEst != null ? Math.round(pointsEst * 100) / 100 : null,
    };
  });

  // Biggest absolute point movers first (who moved the index most today)
  cells.sort((a, b) => {
    const ap = Math.abs(a.pointsEst ?? 0);
    const bp = Math.abs(b.pointsEst ?? 0);
    if (bp !== ap) return bp - ap;
    return b.weightPct - a.weightPct;
  });

  const pts = cells
    .map((c) => c.pointsEst)
    .filter((x): x is number => x != null);
  const netPointsEst =
    pts.length > 0
      ? Math.round(pts.reduce((a, b) => a + b, 0) * 100) / 100
      : null;

  return {
    underlying,
    indexLevel,
    indexPrevClose: indexMeta.prevClose,
    cells,
    fetchedAt: new Date().toISOString(),
    source: `stocks:yahoo · index:${indexMeta.source}`,
    note:
      "Est. points = weight% × day% × index / 10000. Weights are approximate (not live NSE free-float) — close to contribution, not exchange-official.",
    netPointsEst,
  };
}
