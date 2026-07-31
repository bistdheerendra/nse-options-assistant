import type { OptionChainResult, OptionContractQuote } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import type { DirectionalVerdict } from "./directional";
import type { StructureResult } from "./structure";

export type TradePlan = {
  /** Underlying spot used as directional reference entry */
  entry: number;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  /** Reward:risk on TP1 — riskReward = |entry − TP1| / |entry − SL| */
  riskReward: number | null;
  atr: number | null;
  atrMultiple: number;
  timeframeLabel: string;
  sideLabel: "LONG" | "SHORT" | "FLAT";
  summary: string;
  /** Suggested ATM-ish contract for paper "Mark as taken" */
  suggestedContract: {
    strike: number;
    optionType: "CE" | "PE";
    expiry: string;
    lotSize: number;
    entryPremium: number;
    tradingsymbol: string;
    symboltoken: string;
    /** Buy: premium stop ≈ 40% loss. Sell: soft alert only. */
    premiumStopHint: number | null;
  } | null;
};

function atrMultipleForMode(mode: TradingMode): number {
  // Scalp tighter stops; swing wider — ATR risk caps
  return mode === "SCALP" ? 1.25 : 2.25;
}

function pickAtm(
  chain: OptionChainResult,
  optionType: "CE" | "PE",
): OptionContractQuote | null {
  const pool = chain.contracts.filter((c) => c.optionType === optionType);
  if (!pool.length) return null;
  return pool.reduce((best, c) =>
    Math.abs(c.strike - chain.spot) < Math.abs(best.strike - chain.spot) ? c : best,
  );
}

/**
 * Spot-referenced trade plan from ATR.
 * Options: spot SL/TP = invalidation / targets; premium is separate for paper entry.
 *
 * Bullish (BUY_CE / SELL_PE):
 *   SL = entry − k·ATR (capped by swingLow when available)
 *   risk = entry − SL
 *   TP1 = entry + 2·risk; TP2 = entry + 3·risk
 * Bearish (BUY_PE / SELL_CE): mirrored above spot.
 */
export function buildTradePlan(params: {
  spot: number;
  atr: number | null;
  mode: TradingMode;
  verdict: DirectionalVerdict;
  structure: StructureResult;
  chain: OptionChainResult;
  swingHigh?: number | null;
  swingLow?: number | null;
  laneNotes?: string[];
}): TradePlan {
  const { spot, atr, mode, verdict, structure, chain } = params;
  const k = atrMultipleForMode(mode);
  const timeframeLabel = mode === "SCALP" ? "5m" : "1h";

  const sideLabel: TradePlan["sideLabel"] =
    structure.branch === "NO_TRADE" || verdict === "NEUTRAL"
      ? "FLAT"
      : structure.branch === "BUY_CE" || structure.branch === "SELL_PE"
        ? "LONG"
        : "SHORT";

  let stopLoss: number | null = null;
  let takeProfit1: number | null = null;
  let takeProfit2: number | null = null;
  let riskReward: number | null = null;

  if (atr != null && atr > 0 && sideLabel !== "FLAT") {
    if (sideLabel === "LONG") {
      // SL = spot − k·ATR; optionally tighten to swingLow if closer but still below spot
      let sl = spot - k * atr;
      if (params.swingLow != null && params.swingLow < spot && params.swingLow > sl) {
        sl = params.swingLow;
      }
      const risk = spot - sl; // risk = entry − SL
      if (risk > 0) {
        stopLoss = sl;
        takeProfit1 = spot + 2 * risk; // TP1 at 1:2 R
        takeProfit2 = spot + 3 * risk; // TP2 at 1:3 R
        riskReward = (takeProfit1 - spot) / risk; // = 2.0
      }
    } else {
      let sl = spot + k * atr;
      if (params.swingHigh != null && params.swingHigh > spot && params.swingHigh < sl) {
        sl = params.swingHigh;
      }
      const risk = sl - spot;
      if (risk > 0) {
        stopLoss = sl;
        takeProfit1 = spot - 2 * risk;
        takeProfit2 = spot - 3 * risk;
        riskReward = (spot - takeProfit1) / risk;
      }
    }
  }

  let suggestedContract: TradePlan["suggestedContract"] = null;
  if (structure.optionType && structure.action !== "NONE") {
    const c = pickAtm(chain, structure.optionType);
    if (c && c.ltp > 0) {
      // Buy premium stop hint: max loss path ≈ 40% of premium paid
      const premiumStopHint =
        structure.action === "BUY" ? Number((c.ltp * 0.6).toFixed(2)) : null;
      suggestedContract = {
        strike: c.strike,
        optionType: c.optionType,
        expiry: c.expiry,
        lotSize: c.lotSize,
        entryPremium: c.ltp,
        tradingsymbol: c.tradingsymbol,
        symboltoken: c.symboltoken,
        premiumStopHint,
      };
    }
  }

  const parts: string[] = [];
  if (structure.branch !== "NO_TRADE") {
    parts.push(`${structure.branch.replace("_", " ")} bias.`);
  }
  if (params.laneNotes?.length) {
    parts.push(params.laneNotes.slice(0, 2).join(" "));
  } else {
    parts.push(structure.reasoning.split(".")[0] + ".");
  }
  if (atr != null) {
    parts.push(`Stop capped by ${k}×ATR (${atr.toFixed(1)}).`);
  } else {
    parts.push("ATR unavailable — levels omitted.");
  }

  return {
    entry: spot,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskReward,
    atr,
    atrMultiple: k,
    timeframeLabel,
    sideLabel,
    summary: parts.join(" "),
    suggestedContract,
  };
}
