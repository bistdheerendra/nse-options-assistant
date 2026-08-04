/**
 * SMC Stage 8 — read-only signal synthesis.
 *
 * Combines Stages 1–7 into an entry checklist + exit hint.
 * Entry BUY/SELL only when ALL confluence keys pass; otherwise NONE.
 * Checklist always lists which conditions passed/failed (no black box).
 *
 * NOT wired into §2.5 synthesizer or paper trading — standalone only.
 * Ask before any follow-up that auto-wires either.
 *
 * Heuristic / rules-based, not ML-validated — disclaimer on every signal.
 */

import type { Underlying } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import type {
  FairValueGapsResult,
  LiquidityZone,
  MarketStructureEvent,
  MarketStructureResult,
  OrderBlockZone,
  OrderBlocksResult,
  PremiumDiscountModel,
  SmcConfluenceCheck,
  SmcDirection,
  SmcEngineResult,
  SmcExitReason,
  SmcLiquidityResult,
  SmcSignal,
  SmcStructureBundle,
  SupplyDemandResult,
  SupplyDemandZone,
} from "./types";

export const SMC_DISCLAIMER =
  "Heuristic / rules-based, not ML-validated" as const;

function lastStructureInDirection(
  events: MarketStructureEvent[],
  direction: SmcDirection,
): MarketStructureEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.direction === direction) return e;
  }
  return null;
}

function freshZoneForDirection(
  orderBlocks: OrderBlockZone[],
  supplyDemand: SupplyDemandZone[],
  direction: SmcDirection,
): { ok: boolean; detail: string } {
  if (direction === "bullish") {
    const ob = orderBlocks.find(
      (z) => z.type === "bullish_ob" && z.status === "fresh",
    );
    const dem = supplyDemand.find(
      (z) => z.type === "demand" && z.status === "fresh",
    );
    if (ob) {
      return {
        ok: true,
        detail: `fresh bullish OB [${ob.low}–${ob.high}]`,
      };
    }
    if (dem) {
      return {
        ok: true,
        detail: `fresh demand [${dem.low}–${dem.high}]`,
      };
    }
    return {
      ok: false,
      detail: "no fresh bullish OB or demand zone",
    };
  }

  const ob = orderBlocks.find(
    (z) => z.type === "bearish_ob" && z.status === "fresh",
  );
  const sup = supplyDemand.find(
    (z) => z.type === "supply" && z.status === "fresh",
  );
  if (ob) {
    return {
      ok: true,
      detail: `fresh bearish OB [${ob.low}–${ob.high}]`,
    };
  }
  if (sup) {
    return {
      ok: true,
      detail: `fresh supply [${sup.low}–${sup.high}]`,
    };
  }
  return {
    ok: false,
    detail: "no fresh bearish OB or supply zone",
  };
}

/**
 * Liquidity "in the way" of the intended move:
 *   BUY (up)  → unswept buyside above spot
 *   SELL (down) → unswept sellside below spot
 */
function liquidityClear(
  zones: LiquidityZone[],
  direction: SmcDirection,
  spot: number,
): { ok: boolean; detail: string } {
  if (direction === "bullish") {
    const blocking = zones.filter(
      (z) => z.type === "buyside" && !z.swept && z.price > spot,
    );
    if (blocking.length === 0) {
      return { ok: true, detail: "no unswept buyside above spot" };
    }
    const nearest = blocking.reduce((a, b) => (a.price < b.price ? a : b));
    return {
      ok: false,
      detail: `unswept buyside @ ${nearest.price} above spot`,
    };
  }

  const blocking = zones.filter(
    (z) => z.type === "sellside" && !z.swept && z.price < spot,
  );
  if (blocking.length === 0) {
    return { ok: true, detail: "no unswept sellside below spot" };
  }
  const nearest = blocking.reduce((a, b) => (a.price > b.price ? a : b));
  return {
    ok: false,
    detail: `unswept sellside @ ${nearest.price} below spot`,
  };
}

function evaluateDirection(params: {
  direction: SmcDirection;
  events: MarketStructureEvent[];
  orderBlocks: OrderBlockZone[];
  supplyDemand: SupplyDemandZone[];
  premiumDiscount: PremiumDiscountModel | null;
  liquidity: LiquidityZone[];
  spot: number;
}): { checklist: SmcConfluenceCheck[]; allPassed: boolean } {
  const { direction } = params;
  const struct = lastStructureInDirection(params.events, direction);
  const zone = freshZoneForDirection(
    params.orderBlocks,
    params.supplyDemand,
    direction,
  );
  const pdOk =
    params.premiumDiscount != null &&
    ((direction === "bullish" &&
      params.premiumDiscount.currentZone === "discount") ||
      (direction === "bearish" &&
        params.premiumDiscount.currentZone === "premium"));
  const pdDetail = params.premiumDiscount
    ? `zone=${params.premiumDiscount.currentZone} (annotation; need ${direction === "bullish" ? "discount" : "premium"} for ${direction === "bullish" ? "BUY" : "SELL"})`
    : "premium/discount unavailable";
  const liq = liquidityClear(params.liquidity, direction, params.spot);

  const checklist: SmcConfluenceCheck[] = [
    {
      key: "structure_event",
      passed: !!struct,
      detail: struct
        ? `${struct.type} ${struct.direction} @ ${struct.price}`
        : `no BOS/CHoCH in ${direction} direction`,
    },
    {
      key: "fresh_zone",
      passed: zone.ok,
      detail: zone.detail,
    },
    {
      key: "premium_discount",
      passed: pdOk,
      detail: pdDetail,
    },
    {
      key: "liquidity_clear",
      passed: liq.ok,
      detail: liq.detail,
    },
  ];

  return {
    checklist,
    allPassed: checklist.every((c) => c.passed),
  };
}

function inferExit(params: {
  direction: SmcDirection | null;
  events: MarketStructureEvent[];
  orderBlocks: OrderBlockZone[];
  premiumDiscount: PremiumDiscountModel | null;
  liquidity: LiquidityZone[];
  spot: number;
}): { exitReason: SmcExitReason; exitDetail: string | null } {
  if (!params.direction) {
    return { exitReason: null, exitDetail: null };
  }

  const opposite: SmcDirection =
    params.direction === "bullish" ? "bearish" : "bullish";
  const last = params.events[params.events.length - 1];
  if (last && last.type === "CHoCH" && last.direction === opposite) {
    return {
      exitReason: "opposite_choch",
      exitDetail: `CHoCH ${last.direction} @ ${last.price}`,
    };
  }

  const relevantObs =
    params.direction === "bullish"
      ? params.orderBlocks.filter((z) => z.type === "bullish_ob")
      : params.orderBlocks.filter((z) => z.type === "bearish_ob");
  const invalidated = relevantObs.find((z) => z.status === "invalidated");
  if (invalidated) {
    return {
      exitReason: "ob_invalidated",
      exitDetail: `${invalidated.type} [${invalidated.low}–${invalidated.high}] invalidated`,
    };
  }
  const mitigated = relevantObs.find((z) => z.status === "mitigated");
  if (mitigated) {
    return {
      exitReason: "ob_mitigated",
      exitDetail: `${mitigated.type} mitigated @ ${mitigated.mitigationTime ?? "?"}`,
    };
  }

  if (
    params.premiumDiscount &&
    params.premiumDiscount.currentZone === "equilibrium"
  ) {
    return {
      exitReason: "equilibrium",
      exitDetail: `price at equilibrium ${params.premiumDiscount.equilibrium}`,
    };
  }

  // Next liquidity: spot has reached/crossed nearest opposing pool
  if (params.direction === "bullish") {
    const above = params.liquidity
      .filter((z) => z.type === "buyside" && z.price >= params.spot * 0.999)
      .sort((a, b) => a.price - b.price)[0];
    if (above && params.spot >= above.price) {
      return {
        exitReason: "next_liquidity",
        exitDetail: `reached buyside @ ${above.price}`,
      };
    }
  } else {
    const below = params.liquidity
      .filter((z) => z.type === "sellside" && z.price <= params.spot * 1.001)
      .sort((a, b) => b.price - a.price)[0];
    if (below && params.spot <= below.price) {
      return {
        exitReason: "next_liquidity",
        exitDetail: `reached sellside @ ${below.price}`,
      };
    }
  }

  return { exitReason: null, exitDetail: null };
}

/**
 * Synthesize Stage-8 signal from completed stage outputs.
 */
export function synthesizeSmcSignal(params: {
  underlying: Underlying;
  mode: TradingMode;
  structure: MarketStructureResult;
  orderBlocks: OrderBlocksResult;
  liquidity: SmcLiquidityResult;
  premiumDiscount: PremiumDiscountModel | null;
  supplyDemand: SupplyDemandResult;
  spot: number;
}): SmcSignal {
  const events = params.structure.events;
  const bull = evaluateDirection({
    direction: "bullish",
    events,
    orderBlocks: params.orderBlocks.zones,
    supplyDemand: params.supplyDemand.zones,
    premiumDiscount: params.premiumDiscount,
    liquidity: params.liquidity.zones,
    spot: params.spot,
  });
  const bear = evaluateDirection({
    direction: "bearish",
    events,
    orderBlocks: params.orderBlocks.zones,
    supplyDemand: params.supplyDemand.zones,
    premiumDiscount: params.premiumDiscount,
    liquidity: params.liquidity.zones,
    spot: params.spot,
  });

  let entry: SmcSignal["entry"] = "NONE";
  let direction: SmcDirection | null = null;
  let checklist: SmcConfluenceCheck[] = bull.checklist;

  if (bull.allPassed && !bear.allPassed) {
    entry = "BUY";
    direction = "bullish";
    checklist = bull.checklist;
  } else if (bear.allPassed && !bull.allPassed) {
    entry = "SELL";
    direction = "bearish";
    checklist = bear.checklist;
  } else if (bull.allPassed && bear.allPassed) {
    // Ambiguous — neither side wins; show both failed-as-conflict
    entry = "NONE";
    direction = null;
    checklist = [
      ...bull.checklist.map((c) => ({
        ...c,
        detail: `BUY side: ${c.detail}`,
      })),
    ];
  } else {
    // Prefer the side with more passes for checklist visibility
    const bullPasses = bull.checklist.filter((c) => c.passed).length;
    const bearPasses = bear.checklist.filter((c) => c.passed).length;
    checklist =
      bearPasses > bullPasses ? bear.checklist : bull.checklist;
    direction = null;
    entry = "NONE";
  }

  const { exitReason, exitDetail } = inferExit({
    direction:
      direction ??
      (params.structure.trend === "bullish" ||
      params.structure.trend === "bearish"
        ? params.structure.trend
        : null),
    events,
    orderBlocks: params.orderBlocks.zones,
    premiumDiscount: params.premiumDiscount,
    liquidity: params.liquidity.zones,
    spot: params.spot,
  });

  const signals: string[] = [
    `entry=${entry}` + (direction ? ` (${direction})` : ""),
    `checklist ${checklist.filter((c) => c.passed).length}/${checklist.length} passed`,
    exitReason
      ? `exit hint: ${exitReason} — ${exitDetail}`
      : "exit hint: none",
    SMC_DISCLAIMER,
    "SMC signal is standalone — not wired to §2.5 synthesizer or paper trading",
  ];

  return {
    underlying: params.underlying,
    mode: params.mode,
    entry,
    direction,
    checklist,
    exitReason,
    exitDetail,
    disclaimer: SMC_DISCLAIMER,
    signals,
  };
}

/**
 * Assemble full SmcEngineResult from stage outputs (pure).
 */
export function assembleSmcEngineResult(params: {
  structureBundle: SmcStructureBundle;
  orderBlocks: OrderBlocksResult;
  fairValueGaps: FairValueGapsResult;
  liquidity: SmcLiquidityResult;
  premiumDiscount: PremiumDiscountModel | null;
  supplyDemand: SupplyDemandResult;
  spot: number;
}): SmcEngineResult {
  const signal = synthesizeSmcSignal({
    underlying: params.structureBundle.underlying,
    mode: params.structureBundle.mode,
    structure: params.structureBundle.marketStructure.external,
    orderBlocks: params.orderBlocks,
    liquidity: params.liquidity,
    premiumDiscount: params.premiumDiscount,
    supplyDemand: params.supplyDemand,
    spot: params.spot,
  });

  return {
    ...params.structureBundle,
    orderBlocks: params.orderBlocks,
    fairValueGaps: params.fairValueGaps,
    liquidity: params.liquidity,
    premiumDiscount: params.premiumDiscount,
    supplyDemand: params.supplyDemand,
    signal,
    stagesComplete: [1, 2, 3, 4, 5, 6, 7, 8],
  };
}
