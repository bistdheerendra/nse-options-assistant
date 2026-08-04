import type { OhlcvCandle, Underlying } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";

// ─── Constants (tunable; stages import these, never magic numbers) ───────────

/** Fractal half-window. Distinct from priceAction/stopLossClusters lookback=3. */
export const SWING_LOOKBACK = 2;

/**
 * HH/HL classification epsilon — 0.02% of price (same spirit as scalp
 * priceAction structure eps) so index micro-noise does not flip trend.
 */
export const STRUCTURE_EPS_PCT = 0.0002;

/** Equal highs/lows merge band — same 0.05% as CLUSTER_MERGE_TOLERANCE_PCT. */
export const EQUAL_LEVEL_TOLERANCE = 0.0005;

/** Wick ≥ this × body at a swing → Rejection Block (lower confidence). */
export const REJECTION_WICK_RATIO = 2;

/** Displacement body ≥ this × ATR(14). */
export const DISPLACEMENT_ATR_MULT = 1.5;

/** Single-candle imbalance: body ≥ this fraction of (high−low). */
export const IMBALANCE_BODY_RATIO = 0.7;

/** Bars after a liquidity wick-through within which close-back confirms a sweep. */
export const SWEEP_CONFIRM_BARS = 2;

/**
 * In-process SMC result TTL (seconds).
 * Matches SCALP_CANDLE_BUNDLE_TTL_SEC (45) so Stages 3–7 stay coherent with
 * the candle bundle they were computed from, without recomputing every request.
 */
export const SMC_RESULT_TTL_SEC = 45;

// ─── Timeframes / mode mapping ───────────────────────────────────────────────

/** TFs SMC may run on. Scalp primary=5m; Swing primary=1h; internal TBD. */
export type SmcTimeframe =
  | "THREE_MINUTE"
  | "FIVE_MINUTE"
  | "FIFTEEN_MINUTE"
  | "ONE_HOUR";

export type SmcStructureLevel = "internal" | "external";

export type SmcTrendDirection = "bullish" | "bearish" | "ranging";

export type SmcDirection = "bullish" | "bearish";

/** Degrade labels — never silent fabrication. */
export type SmcDataSource = "angel" | "demo" | "db_cache" | "unavailable";

export const SMC_PRIMARY_TF: Record<TradingMode, SmcTimeframe> = {
  SCALP: "FIVE_MINUTE",
  SWING: "ONE_HOUR",
};

/** Scalp internal TF (below external 5m). Swing has no feed yet — deferred. */
export const SMC_SCALP_INTERNAL_TF: SmcTimeframe = "THREE_MINUTE";

// ─── Stage 1 — Swing points ──────────────────────────────────────────────────

export type SwingPointType = "high" | "low";

export type SwingPoint = {
  index: number;
  /** ISO string — matches OhlcvCandle.time */
  time: string;
  price: number;
  type: SwingPointType;
  timeframe: SmcTimeframe;
};

export type SwingPointsResult = {
  timeframe: SmcTimeframe;
  lookback: number;
  swings: SwingPoint[];
  signals: string[];
};

// ─── Stage 2 — Market structure ──────────────────────────────────────────────

export type MarketStructureEventType = "BOS" | "CHoCH";

export type MarketStructureEvent = {
  type: MarketStructureEventType;
  direction: SmcDirection;
  time: string;
  price: number;
  brokenSwing: SwingPoint;
  structureLevel: SmcStructureLevel;
  /** Candle index whose close confirmed the break. */
  confirmIndex: number;
};

export type MarketStructureResult = {
  timeframe: SmcTimeframe;
  structureLevel: SmcStructureLevel;
  trend: SmcTrendDirection;
  events: MarketStructureEvent[];
  /** Most recent event, if any. */
  lastEvent: MarketStructureEvent | null;
  signals: string[];
  /**
   * When Swing internal is deferred (gap unresolved), status explains why
   * rather than inventing lower-TF structure.
   */
  status: "ok" | "deferred" | "insufficient";
  statusNote?: string;
};

// ─── Stage 3 — Order blocks / breaker / rejection ────────────────────────────

export type OrderBlockKind =
  | "bullish_ob"
  | "bearish_ob"
  | "bullish_breaker"
  | "bearish_breaker"
  | "bullish_rejection"
  | "bearish_rejection";

export type OrderBlockStatus = "fresh" | "mitigated" | "invalidated";

export type OrderBlockZone = {
  type: OrderBlockKind;
  high: number;
  low: number;
  originCandleTime: string;
  originCandleIndex: number;
  status: OrderBlockStatus;
  mitigationTime?: string;
  /** True for rejection blocks (wick rule, no BOS required). */
  lowerConfidence: boolean;
  /** Structure event that created this OB (null for rejection-only). */
  causedByEvent: MarketStructureEventType | null;
  structureLevel: SmcStructureLevel;
};

export type OrderBlocksResult = {
  timeframe: SmcTimeframe;
  zones: OrderBlockZone[];
  signals: string[];
};

// ─── Stage 4 — FVG / displacement / imbalance ────────────────────────────────

/**
 * FVG = strict 3-candle gap (subset).
 * Imbalance = looser volume-confirmed superset (3-candle OR body-ratio + vol).
 * Do not conflate in UI: surface kind explicitly.
 */
export type GapKind = "fvg" | "imbalance";

export type FairValueGap = {
  kind: GapKind;
  type: SmcDirection;
  top: number;
  bottom: number;
  time: string;
  originIndex: number;
  filled: boolean;
  /** 0..1 of gap range consumed by subsequent price. */
  fillPercent: number;
  displacementCandle: boolean;
  /** True when body ≥ DISPLACEMENT_ATR_MULT × ATR(14) at origin. */
  displacementAtrMult?: number;
};

export type FairValueGapsResult = {
  timeframe: SmcTimeframe;
  gaps: FairValueGap[];
  signals: string[];
};

// ─── Stage 5 — SMC liquidity (≠ scalp/liquidity.ts bid-ask gate) ─────────────

export type SmcLiquiditySide = "buyside" | "sellside";

export type LiquidityZone = {
  type: SmcLiquiditySide;
  price: number;
  sourceSwings: SwingPoint[];
  equalLevel: boolean;
  swept: boolean;
  sweepTime?: string;
};

export type SmcLiquidityResult = {
  timeframe: SmcTimeframe;
  zones: LiquidityZone[];
  signals: string[];
};

// ─── Stage 6 — Premium / discount ────────────────────────────────────────────

export type PremiumDiscountZone = "premium" | "discount" | "equilibrium";

export type PremiumDiscountModel = {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  currentZone: PremiumDiscountZone;
  currentPrice: number;
  legStart: SwingPoint;
  legEnd: SwingPoint;
  /**
   * Context/annotation only — never flips a trade decision alone
   * (same spirit as "Lanes disagree" badge).
   */
  annotationOnly: true;
  signals: string[];
};

// ─── Stage 7 — Supply / demand (distinct from Order Blocks) ──────────────────

export type SupplyDemandKind = "demand" | "supply";
export type SupplyDemandStatus = "fresh" | "tested" | "broken";

export type SupplyDemandZone = {
  type: SupplyDemandKind;
  high: number;
  low: number;
  baseStart: string;
  baseEnd: string;
  baseStartIndex: number;
  baseEndIndex: number;
  status: SupplyDemandStatus;
  testTime?: string;
};

export type SupplyDemandResult = {
  timeframe: SmcTimeframe;
  zones: SupplyDemandZone[];
  signals: string[];
};

// ─── Stage 8 — Read-only synthesis (NOT wired to §2.5 / paper) ───────────────

export type SmcEntrySide = "BUY" | "SELL" | "NONE";

export type SmcConfluenceKey =
  | "structure_event"
  | "fresh_zone"
  | "premium_discount"
  | "liquidity_clear";

export type SmcConfluenceCheck = {
  key: SmcConfluenceKey;
  passed: boolean;
  detail: string;
};

export type SmcExitReason =
  | "opposite_choch"
  | "ob_mitigated"
  | "ob_invalidated"
  | "next_liquidity"
  | "equilibrium"
  | null;

export type SmcSignal = {
  underlying: Underlying;
  mode: TradingMode;
  entry: SmcEntrySide;
  direction: SmcDirection | null;
  checklist: SmcConfluenceCheck[];
  exitReason: SmcExitReason;
  exitDetail: string | null;
  /**
   * Mandatory UI copy — heuristic / rules-based, not ML-validated.
   * Every card/overlay must surface this (or equivalent).
   */
  disclaimer: "Heuristic / rules-based, not ML-validated";
  signals: string[];
};

// ─── Stages 1–2 bundle + future full engine payload ──────────────────────────

export type SmcEngineInput = {
  underlying: Underlying;
  mode: TradingMode;
  externalCandles: OhlcvCandle[];
  externalTimeframe: SmcTimeframe;
  /**
   * Internal (lower TF) candles. Null when deferred / unavailable
   * (Swing option a — deferred until dedicated 15m feed).
   */
  internalCandles: OhlcvCandle[] | null;
  internalTimeframe: SmcTimeframe | null;
  source: SmcDataSource;
};

/** Stages 1–2 output only — later stages append in follow-up passes. */
export type SmcStructureBundle = {
  underlying: Underlying;
  mode: TradingMode;
  fetchedAt: string;
  source: SmcDataSource;
  degraded: boolean;
  degradeReasons: string[];
  swingPoints: {
    external: SwingPointsResult;
    internal: SwingPointsResult | null;
  };
  marketStructure: {
    external: MarketStructureResult;
    internal: MarketStructureResult | null;
  };
  stagesComplete: number[];
};

export type SmcEngineResult = SmcStructureBundle & {
  orderBlocks: OrderBlocksResult;
  fairValueGaps: FairValueGapsResult;
  liquidity: SmcLiquidityResult;
  premiumDiscount: PremiumDiscountModel | null;
  supplyDemand: SupplyDemandResult;
  signal: SmcSignal;
};

/** Theme token keys for SMC overlays — distinct from clusterSupport/Resistance. */
export type SmcOverlayTokenKey =
  | "smcBuysideLiq"
  | "smcSellsideLiq"
  | "smcOrderBlockBull"
  | "smcOrderBlockBear"
  | "smcFvg"
  | "smcBos"
  | "smcChoch"
  | "smcEquilibrium";
