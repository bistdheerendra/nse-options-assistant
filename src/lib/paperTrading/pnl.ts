export type OptionSide = "CE" | "PE";
export type TradeAction = "BUY" | "SELL";

/**
 * Options paper P&L helpers.
 *
 * Buy (long premium):
 *   PnL = (exitPremium - entryPremium) * lotSize * lots
 *   Max loss = entryPremium * lotSize * lots  (premium paid)
 *
 * Sell / write (short premium):
 *   PnL = (entryPremium - exitPremium) * lotSize * lots
 *   CE: theoretically uncapped if underlying rallies
 *   PE: large loss bounded by strike * lotSize * lots (spot → 0)
 */

export function buyPnl(params: {
  entryPremium: number;
  exitPremium: number;
  lotSize: number;
  lots: number;
}): number {
  // PnL_buy = (exit - entry) * lotSize * lots
  return (params.exitPremium - params.entryPremium) * params.lotSize * params.lots;
}

export function sellPnl(params: {
  entryPremium: number;
  exitPremium: number;
  lotSize: number;
  lots: number;
}): number {
  // PnL_sell = (entry - exit) * lotSize * lots
  return (params.entryPremium - params.exitPremium) * params.lotSize * params.lots;
}

export function maxLossBuy(params: {
  entryPremium: number;
  lotSize: number;
  lots: number;
}): number {
  // Max loss (long) = premium paid = entry * lotSize * lots
  return params.entryPremium * params.lotSize * params.lots;
}

export function theoreticalMaxLossSell(params: {
  action: TradeAction;
  optionType: OptionSide;
  strike: number;
  entryPremium: number;
  lotSize: number;
  lots: number;
}): { label: string; amount: number | null } {
  if (params.action !== "SELL") {
    return {
      label: "Buy max loss = premium paid",
      amount: maxLossBuy(params),
    };
  }
  if (params.optionType === "CE") {
    return {
      label: "Sell CE — theoretically UNCAPPED loss",
      amount: null,
    };
  }
  // Sell PE worst case (spot → 0): loss ≈ (strike - entryPremium) * lotSize * lots
  // (writer receives premium, pays intrinsic up to strike)
  const amount =
    (params.strike - params.entryPremium) * params.lotSize * params.lots;
  return {
    label: "Sell PE — large loss bounded by strike (spot→0)",
    amount,
  };
}

/** Intrinsic at expiry: CE max(0, spot-strike); PE max(0, strike-spot) */
export function intrinsicValue(
  optionType: OptionSide,
  spot: number,
  strike: number,
): number {
  return optionType === "CE"
    ? Math.max(0, spot - strike)
    : Math.max(0, strike - spot);
}

export function settlePnl(params: {
  action: TradeAction;
  optionType: OptionSide;
  entryPremium: number;
  spot: number;
  strike: number;
  lotSize: number;
  lots: number;
}): { exitPremium: number; realizedPnl: number } {
  const exitPremium = intrinsicValue(params.optionType, params.spot, params.strike);
  const realizedPnl =
    params.action === "BUY"
      ? buyPnl({ ...params, exitPremium })
      : sellPnl({ ...params, exitPremium });
  return { exitPremium, realizedPnl };
}

export function unrealizedPnl(params: {
  action: TradeAction;
  entryPremium: number;
  markPremium: number;
  lotSize: number;
  lots: number;
}): number {
  return params.action === "BUY"
    ? buyPnl({
        entryPremium: params.entryPremium,
        exitPremium: params.markPremium,
        lotSize: params.lotSize,
        lots: params.lots,
      })
    : sellPnl({
        entryPremium: params.entryPremium,
        exitPremium: params.markPremium,
        lotSize: params.lotSize,
        lots: params.lots,
      });
}
