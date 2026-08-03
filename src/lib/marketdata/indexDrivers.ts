import type { Underlying } from "@/lib/marketdata/angelone";

/**
 * Major index drivers for Analysis heatmap.
 * Weights are approximate index contribution % (static heuristic — not live free-float).
 * Yahoo symbols: NSE `.NS`, BSE Sensex names `.BO` where NSE listing differs.
 */

export type IndexDriverSpec = {
  symbol: string;
  /** Display ticker */
  ticker: string;
  name: string;
  /** Approx weight % in the index (sums ~70–85% of heavy movers, not 100). */
  weightPct: number;
  yahoo: string;
};

/** Nifty 50 — highest-weight names that typically move the index. */
export const NIFTY_DRIVERS: IndexDriverSpec[] = [
  { symbol: "RELIANCE", ticker: "RELIANCE", name: "Reliance", weightPct: 9.0, yahoo: "RELIANCE.NS" },
  { symbol: "HDFCBANK", ticker: "HDFCBANK", name: "HDFC Bank", weightPct: 8.2, yahoo: "HDFCBANK.NS" },
  { symbol: "ICICIBANK", ticker: "ICICIBANK", name: "ICICI Bank", weightPct: 7.5, yahoo: "ICICIBANK.NS" },
  { symbol: "INFY", ticker: "INFY", name: "Infosys", weightPct: 6.2, yahoo: "INFY.NS" },
  { symbol: "ITC", ticker: "ITC", name: "ITC", weightPct: 4.2, yahoo: "ITC.NS" },
  { symbol: "TCS", ticker: "TCS", name: "TCS", weightPct: 4.0, yahoo: "TCS.NS" },
  { symbol: "LT", ticker: "LT", name: "L&T", weightPct: 3.8, yahoo: "LT.NS" },
  { symbol: "SBIN", ticker: "SBIN", name: "SBI", weightPct: 3.2, yahoo: "SBIN.NS" },
  { symbol: "BHARTIARTL", ticker: "BHARTIARTL", name: "Bharti Airtel", weightPct: 3.5, yahoo: "BHARTIARTL.NS" },
  { symbol: "AXISBANK", ticker: "AXISBANK", name: "Axis Bank", weightPct: 3.0, yahoo: "AXISBANK.NS" },
  { symbol: "KOTAKBANK", ticker: "KOTAKBANK", name: "Kotak Bank", weightPct: 2.8, yahoo: "KOTAKBANK.NS" },
  { symbol: "BAJFINANCE", ticker: "BAJFINANCE", name: "Bajaj Finance", weightPct: 2.5, yahoo: "BAJFINANCE.NS" },
  { symbol: "HINDUNILVR", ticker: "HINDUNILVR", name: "HUL", weightPct: 2.3, yahoo: "HINDUNILVR.NS" },
  { symbol: "M&M", ticker: "M&M", name: "M&M", weightPct: 2.2, yahoo: "M&M.NS" },
  { symbol: "SUNPHARMA", ticker: "SUNPHARMA", name: "Sun Pharma", weightPct: 1.9, yahoo: "SUNPHARMA.NS" },
  { symbol: "TITAN", ticker: "TITAN", name: "Titan", weightPct: 1.6, yahoo: "TITAN.NS" },
];

/** Bank Nifty — bank heavyweights (weights sum ~100 of index). */
export const BANKNIFTY_DRIVERS: IndexDriverSpec[] = [
  { symbol: "HDFCBANK", ticker: "HDFCBANK", name: "HDFC Bank", weightPct: 28.0, yahoo: "HDFCBANK.NS" },
  { symbol: "ICICIBANK", ticker: "ICICIBANK", name: "ICICI Bank", weightPct: 23.0, yahoo: "ICICIBANK.NS" },
  { symbol: "AXISBANK", ticker: "AXISBANK", name: "Axis Bank", weightPct: 11.5, yahoo: "AXISBANK.NS" },
  { symbol: "SBIN", ticker: "SBIN", name: "SBI", weightPct: 11.0, yahoo: "SBIN.NS" },
  { symbol: "KOTAKBANK", ticker: "KOTAKBANK", name: "Kotak Bank", weightPct: 10.5, yahoo: "KOTAKBANK.NS" },
  { symbol: "INDUSINDBK", ticker: "INDUSINDBK", name: "IndusInd", weightPct: 5.0, yahoo: "INDUSINDBK.NS" },
  { symbol: "BANKBARODA", ticker: "BANKBARODA", name: "BoB", weightPct: 3.2, yahoo: "BANKBARODA.NS" },
  { symbol: "FEDERALBNK", ticker: "FEDERALBNK", name: "Federal", weightPct: 2.5, yahoo: "FEDERALBNK.NS" },
  { symbol: "IDFCFIRSTB", ticker: "IDFCFIRSTB", name: "IDFC First", weightPct: 2.3, yahoo: "IDFCFIRSTB.NS" },
  { symbol: "PNB", ticker: "PNB", name: "PNB", weightPct: 2.0, yahoo: "PNB.NS" },
  { symbol: "AUBANK", ticker: "AUBANK", name: "AU Bank", weightPct: 1.5, yahoo: "AUBANK.NS" },
  { symbol: "BANDHANBNK", ticker: "BANDHANBNK", name: "Bandhan", weightPct: 1.2, yahoo: "BANDHANBNK.NS" },
];

/** Sensex 30 — top movers by weight. */
export const SENSEX_DRIVERS: IndexDriverSpec[] = [
  { symbol: "RELIANCE", ticker: "RELIANCE", name: "Reliance", weightPct: 10.5, yahoo: "RELIANCE.NS" },
  { symbol: "HDFCBANK", ticker: "HDFCBANK", name: "HDFC Bank", weightPct: 9.5, yahoo: "HDFCBANK.NS" },
  { symbol: "ICICIBANK", ticker: "ICICIBANK", name: "ICICI Bank", weightPct: 8.0, yahoo: "ICICIBANK.NS" },
  { symbol: "INFY", ticker: "INFY", name: "Infosys", weightPct: 6.5, yahoo: "INFY.NS" },
  { symbol: "TCS", ticker: "TCS", name: "TCS", weightPct: 4.5, yahoo: "TCS.NS" },
  { symbol: "ITC", ticker: "ITC", name: "ITC", weightPct: 4.2, yahoo: "ITC.NS" },
  { symbol: "LT", ticker: "LT", name: "L&T", weightPct: 4.0, yahoo: "LT.NS" },
  { symbol: "BHARTIARTL", ticker: "BHARTIARTL", name: "Bharti", weightPct: 3.8, yahoo: "BHARTIARTL.NS" },
  { symbol: "SBIN", ticker: "SBIN", name: "SBI", weightPct: 3.5, yahoo: "SBIN.NS" },
  { symbol: "AXISBANK", ticker: "AXISBANK", name: "Axis Bank", weightPct: 3.2, yahoo: "AXISBANK.NS" },
  { symbol: "KOTAKBANK", ticker: "KOTAKBANK", name: "Kotak", weightPct: 2.8, yahoo: "KOTAKBANK.NS" },
  { symbol: "HINDUNILVR", ticker: "HINDUNILVR", name: "HUL", weightPct: 2.6, yahoo: "HINDUNILVR.NS" },
  { symbol: "BAJFINANCE", ticker: "BAJFINANCE", name: "Bajaj Fin", weightPct: 2.4, yahoo: "BAJFINANCE.NS" },
  { symbol: "M&M", ticker: "M&M", name: "M&M", weightPct: 2.2, yahoo: "M&M.NS" },
  { symbol: "TITAN", ticker: "TITAN", name: "Titan", weightPct: 1.8, yahoo: "TITAN.NS" },
  { symbol: "ASIANPAINT", ticker: "ASIANPAINT", name: "Asian Paints", weightPct: 1.6, yahoo: "ASIANPAINT.NS" },
];

export function driversForUnderlying(underlying: Underlying): IndexDriverSpec[] {
  if (underlying === "BANKNIFTY") return BANKNIFTY_DRIVERS;
  if (underlying === "SENSEX") return SENSEX_DRIVERS;
  return NIFTY_DRIVERS;
}
