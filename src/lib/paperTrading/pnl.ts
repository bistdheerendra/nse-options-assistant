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

export type CloseReason = "MANUAL" | "TP" | "SL" | "EXPIRED";

/**
 * Fallback premium TP/SL when option delta is unavailable (not derived from
 * Analysis verdict-card spot levels).
 * BUY: SL = 0.6·entry (≈40% premium loss); risk = 0.4·entry; TP = entry + 2·risk = 1.8·entry
 * SELL: SL = 1.4·entry (≈40% adverse); risk = 0.4·entry; TP = entry − 2·risk = 0.2·entry
 */
export function defaultPremiumTpSl(
  action: TradeAction,
  entryPremium: number,
): { stopLoss: number; takeProfit: number } {
  const entry = Math.max(0, entryPremium);
  if (action === "BUY") {
    const stopLoss = Number((entry * 0.6).toFixed(2));
    const risk = entry - stopLoss; // 0.4·entry
    const takeProfit = Number((entry + 2 * risk).toFixed(2)); // 1.8·entry
    return { stopLoss, takeProfit };
  }
  const stopLoss = Number((entry * 1.4).toFixed(2));
  const risk = stopLoss - entry; // 0.4·entry
  const takeProfit = Number(Math.max(0, entry - 2 * risk).toFixed(2)); // 0.2·entry
  return { stopLoss, takeProfit };
}

/** How premium SL/TP were derived — persisted on entrySnapshot for audit/UI. */
export type PremiumSlTpSource = "delta" | "multiplier_fallback";

export type SpotLevelsForPremiumSlTp = {
  entrySpotAtSignal: number;
  stopLossSpot: number;
  tp1Spot: number;
  tp2Spot?: number | null;
  /** Option delta from Angel /optionGreek if available; omit when unknown. */
  delta?: number | null;
};

export type PremiumSlTpResult = {
  stopLoss: number;
  takeProfit: number;
  /** Secondary TP from tp2Spot when delta-derived; else null. */
  takeProfit2: number | null;
  source: PremiumSlTpSource;
  entrySpotAtSignal: number | null;
  stopLossSpot: number | null;
  tp1Spot: number | null;
  tp2Spot: number | null;
  delta: number | null;
};

/**
 * Project option premium at a spot level via linear delta approximation.
 * projectedPremium(spotLevel) = entryPremium + delta * (spotLevel − entrySpotAtSignal)
 * Clamp to ≥ 0 (premium can't go negative). Valid only for small spot moves.
 */
export function projectedPremiumAtSpot(params: {
  entryPremium: number;
  entrySpotAtSignal: number;
  spotLevel: number;
  delta: number;
}): number {
  // projectedPremium = entryPremium + delta * (spotLevel − entrySpotAtSignal); clamp ≥ 0
  const raw =
    params.entryPremium +
    params.delta * (params.spotLevel - params.entrySpotAtSignal);
  return Number(Math.max(0, raw).toFixed(2));
}

/**
 * Premium SL/TP from the SAME spot Entry/SL/TP1 the user saw on the Analysis
 * verdict card. Prefer delta-linear projection; else 0.6/1.8 multiplier fallback.
 */
export function resolvePremiumTpSl(params: {
  action: TradeAction;
  entryPremium: number;
  spots?: SpotLevelsForPremiumSlTp | null;
}): PremiumSlTpResult {
  const spots = params.spots;
  const hasSpots =
    spots != null &&
    Number.isFinite(spots.entrySpotAtSignal) &&
    Number.isFinite(spots.stopLossSpot) &&
    Number.isFinite(spots.tp1Spot);

  const delta =
    spots?.delta != null && Number.isFinite(spots.delta) ? spots.delta : null;

  if (hasSpots && delta != null) {
    // stopLoss  = entryPremium + delta * (stopLossSpot − entrySpotAtSignal)
    // takeProfit = entryPremium + delta * (tp1Spot − entrySpotAtSignal)   // TP1 primary
    // takeProfit2 = entryPremium + delta * (tp2Spot − entrySpotAtSignal)  // optional
    const stopLoss = projectedPremiumAtSpot({
      entryPremium: params.entryPremium,
      entrySpotAtSignal: spots!.entrySpotAtSignal,
      spotLevel: spots!.stopLossSpot,
      delta,
    });
    const takeProfit = projectedPremiumAtSpot({
      entryPremium: params.entryPremium,
      entrySpotAtSignal: spots!.entrySpotAtSignal,
      spotLevel: spots!.tp1Spot,
      delta,
    });
    const takeProfit2 =
      spots!.tp2Spot != null && Number.isFinite(spots!.tp2Spot)
        ? projectedPremiumAtSpot({
            entryPremium: params.entryPremium,
            entrySpotAtSignal: spots!.entrySpotAtSignal,
            spotLevel: spots!.tp2Spot,
            delta,
          })
        : null;
    return {
      stopLoss,
      takeProfit,
      takeProfit2,
      source: "delta",
      entrySpotAtSignal: spots!.entrySpotAtSignal,
      stopLossSpot: spots!.stopLossSpot,
      tp1Spot: spots!.tp1Spot,
      tp2Spot: spots!.tp2Spot ?? null,
      delta,
    };
  }

  if (hasSpots && delta == null) {
    console.warn(
      "[paper] premium SL/TP using multiplier fallback — no option delta available",
    );
  }

  const fallback = defaultPremiumTpSl(params.action, params.entryPremium);
  return {
    ...fallback,
    takeProfit2: null,
    source: "multiplier_fallback",
    entrySpotAtSignal: hasSpots ? spots!.entrySpotAtSignal : null,
    stopLossSpot: hasSpots ? spots!.stopLossSpot : null,
    tp1Spot: hasSpots ? spots!.tp1Spot : null,
    tp2Spot: hasSpots ? (spots!.tp2Spot ?? null) : null,
    delta: null,
  };
}

/** Which exit level (if any) the live mark has hit. */
export function premiumExitHit(params: {
  action: TradeAction;
  markPremium: number;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
}): "TP" | "SL" | null {
  const { action, markPremium, stopLoss, takeProfit } = params;
  if (action === "BUY") {
    // Long: profit when premium rises to TP; stop when premium falls to SL
    if (takeProfit != null && markPremium >= takeProfit) return "TP";
    if (stopLoss != null && markPremium <= stopLoss) return "SL";
    return null;
  }
  // Short: profit when premium falls to TP; stop when premium rises to SL
  if (takeProfit != null && markPremium <= takeProfit) return "TP";
  if (stopLoss != null && markPremium >= stopLoss) return "SL";
  return null;
}
