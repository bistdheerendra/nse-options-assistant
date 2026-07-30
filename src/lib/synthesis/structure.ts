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
 * IV-aware structure branching per docs/PROJECT.md §2.5
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

  if (verdict === "BEARISH" && ivIsLowOrFalling(extras)) {
    return {
      branch: "BUY_PE",
      action: "BUY",
      optionType: "PE",
      isSellWrite: false,
      reasoning: `Bearish + low/falling IV → Buy PE. Long puts for downside with defined premium risk.`,
      riskWarning: "Buy risk: max loss capped at premium paid × lotSize × lots.",
    };
  }

  if (verdict === "BEARISH" && ivIsHighOrRising(extras)) {
    return {
      branch: "SELL_CE",
      action: "SELL",
      optionType: "CE",
      isSellWrite: true,
      reasoning: `Bearish + high/rising IV → consider Sell CE (credit). Elevated call premium; bearish view expects calls to decay.`,
      riskWarning:
        "SELL/WRITE RISK: Call writing has theoretically UNCAPPED loss if the underlying rallies. Do not treat this like a capped debit buy.",
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
