import type { Underlying } from "./types";
import { UNDERLYING_META } from "./types";

/** Indices shown on the Dashboard (superset of option underlyings). */
export type DashboardIndex = Underlying | "GIFTNIFTY";

export type DashboardIndexMeta = {
  id: DashboardIndex;
  label: string;
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
  /** False when Angel One SmartAPI has no instrument (e.g. Gift Nifty). */
  smartApiAvailable: boolean;
  /** Deep-link underlying for Analysis / Paper when applicable. */
  analysisUnderlying: Underlying | null;
};

/**
 * Gift Nifty (ex-SGX Nifty) trades on NSE IFSC and is NOT in Angel One
 * OpenAPIScripMaster (no AMXIDX / NSEIX row as of last check). Quotes are
 * demo/proxy only — UI must label them.
 */
export const DASHBOARD_INDICES: DashboardIndexMeta[] = [
  {
    id: "NIFTY",
    label: "Nifty 50",
    exchange: UNDERLYING_META.NIFTY.exchange,
    tradingsymbol: UNDERLYING_META.NIFTY.tradingsymbol,
    symboltoken: UNDERLYING_META.NIFTY.symboltoken,
    smartApiAvailable: true,
    analysisUnderlying: "NIFTY",
  },
  {
    id: "BANKNIFTY",
    label: "Bank Nifty",
    exchange: UNDERLYING_META.BANKNIFTY.exchange,
    tradingsymbol: UNDERLYING_META.BANKNIFTY.tradingsymbol,
    symboltoken: UNDERLYING_META.BANKNIFTY.symboltoken,
    smartApiAvailable: true,
    analysisUnderlying: "BANKNIFTY",
  },
  {
    id: "SENSEX",
    label: "Sensex",
    exchange: UNDERLYING_META.SENSEX.exchange,
    tradingsymbol: UNDERLYING_META.SENSEX.tradingsymbol,
    symboltoken: UNDERLYING_META.SENSEX.symboltoken,
    smartApiAvailable: true,
    analysisUnderlying: "SENSEX",
  },
  {
    id: "GIFTNIFTY",
    label: "Gift Nifty",
    exchange: "NSEIX",
    tradingsymbol: "GIFT Nifty",
    symboltoken: "",
    smartApiAvailable: false,
    analysisUnderlying: null,
  },
];
