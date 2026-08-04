import type { OptionsFlowExtras } from "../lanes/optionsFlow";
import type { DirectionalVerdict } from "./directional";

export type StructureResult = {
  branch:
    | "BUY_CE"
    | "SELL_PE"
    | "BUY_PE"
    | "SELL_CE"
    | "NO_TRADE";
  action: "BUY" | "SELL" | "NONE";
  optionType: "CE" | "PE" | null;
  isSellWrite: boolean;
  reasoning: string;
  /** Explicit risk copy for sell/write */
  riskWarning: string | null;
};

function ivIsLowOrFalling(extras: OptionsFlowExtras): boolean {
  return extras.ivLevel === "low" || extras.ivTrend === "falling";
}

function ivIsHighOrRising(extras: OptionsFlowExtras): boolean {
  return extras.ivLevel === "high" || extras.ivTrend === "rising";
}

/**
 * Structure branching per docs/PROJECT.md §2.5
 * Bullish: IV-aware Buy CE vs Sell PE.
 * Bearish: always Buy PE (Sell CE path disabled by product preference).
 */
export function synthesizeStructure(
  verdict: DirectionalVerdict,
  extras: OptionsFlowExtras,
): StructureResult {
  if (verdict === "NEUTRAL") {
    return {
      branch: "NO_TRADE",
      action: "NONE",
      optionType: null,
      isSellWrite: false,
      reasoning: "Directional verdict NEUTRAL — no structure branch fired.",
      riskWarning: null,
    };
  }

  if (verdict === "BULLISH" && ivIsLowOrFalling(extras)) {
    return {
      branch: "BUY_CE",
      action: "BUY",
      optionType: "CE",
      isSellWrite: false,
      reasoning: `Bullish + low/falling IV (level=${extras.ivLevel}, trend=${extras.ivTrend}) → Buy CE. Long premium benefits if IV stays contained while price rises.`,
      riskWarning: "Buy risk: max loss capped at premium paid × lotSize × lots.",
    };
  }

  if (verdict === "BULLISH" && ivIsHighOrRising(extras)) {
    return {
      branch: "SELL_PE",
      action: "SELL",
      optionType: "PE",
      isSellWrite: true,
      reasoning: `Bullish + high/rising IV → consider Sell PE (credit). Elevated IV inflates put premium; bullish view expects put to decay.`,
      riskWarning:
        "SELL/WRITE RISK: Put writing can lose a large amount if the underlying falls — loss ≈ (strike - exit intrinsic path) and is large though bounded by strike × lotSize × lots. Never understate this.",
    };
  }

  // Bearish → always Buy PE (never Sell CE). High/rising IV still buys the put;
  // premium is richer but max loss stays capped at debit paid.
  if (verdict === "BEARISH") {
    const ivNote = ivIsHighOrRising(extras)
      ? `IV is ${extras.ivLevel}/${extras.ivTrend} — put premium is rich; size smaller.`
      : `IV ${extras.ivLevel}/${extras.ivTrend} favours long premium.`;
    return {
      branch: "BUY_PE",
      action: "BUY",
      optionType: "PE",
      isSellWrite: false,
      reasoning: `Bearish → Buy PE. ${ivNote}`,
      riskWarning: "Buy risk: max loss capped at premium paid × lotSize × lots.",
    };
  }

  return {
    branch: "NO_TRADE",
    action: "NONE",
    optionType: null,
    isSellWrite: false,
    reasoning: `No clear IV branch for verdict=${verdict} with IV level=${extras.ivLevel}/trend=${extras.ivTrend}.`,
    riskWarning: null,
  };
}
