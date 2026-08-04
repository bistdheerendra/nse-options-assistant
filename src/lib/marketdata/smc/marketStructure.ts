/**
 * SMC Stage 2 — market structure: trend, BOS, CHoCH (internal / external).
 *
 * Objective structural facts (close beyond a confirmed swing):
 *   - BOS   = close beyond last swing WITH the prevailing trend
 *   - CHoCH = close beyond last swing AGAINST the prevailing trend
 *             (first reversal sign)
 *
 * Trend from swing sequence only:
 *   HH + HL → bullish · LH + LL → bearish · else ranging
 * (eps = STRUCTURE_EPS_PCT so index micro-noise does not flip).
 *
 * Downstream trade inference (Stage 8) still carries the heuristic disclaimer.
 * BOS/CHoCH themselves are labeled as structural facts, not trade signals.
 *
 * Swing internal gap (option a): Swing mode ships external-only;
 * internalStructure.status = "deferred" until a dedicated Swing 15m feed exists.
 * Do not invent internal structure or silently reuse Scalp 15m here.
 *
 * Consumes SwingPoint[] from Stage 1 — never re-detects swings.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import { detectSmcSwingPoints } from "./swingPoints";
import {
  SMC_PRIMARY_TF,
  SMC_SCALP_INTERNAL_TF,
  STRUCTURE_EPS_PCT,
  SWING_LOOKBACK,
  type MarketStructureEvent,
  type MarketStructureResult,
  type SmcDataSource,
  type SmcDirection,
  type SmcEngineInput,
  type SmcStructureBundle,
  type SmcStructureLevel,
  type SmcTimeframe,
  type SmcTrendDirection,
  type SwingPoint,
  type SwingPointsResult,
} from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify trend from the last two swing highs and last two swing lows.
 * HH+HL → bullish; LH+LL → bearish; else ranging.
 */
export function classifySmcTrend(
  highs: SwingPoint[],
  lows: SwingPoint[],
): SmcTrendDirection {
  if (highs.length < 2 || lows.length < 2) return "ranging";

  const h1 = highs[highs.length - 2]!.price;
  const h2 = highs[highs.length - 1]!.price;
  const l1 = lows[lows.length - 2]!.price;
  const l2 = lows[lows.length - 1]!.price;

  // eps = maxPrice × STRUCTURE_EPS_PCT (0.02%)
  const eps = Math.max(h1, h2, l1, l2) * STRUCTURE_EPS_PCT;
  const higherHigh = h2 > h1 + eps;
  const lowerHigh = h2 < h1 - eps;
  const higherLow = l2 > l1 + eps;
  const lowerLow = l2 < l1 - eps;

  if (higherHigh && higherLow) return "bullish";
  if (lowerHigh && lowerLow) return "bearish";
  return "ranging";
}

function deferredInternal(
  timeframe: SmcTimeframe = "FIFTEEN_MINUTE",
): MarketStructureResult {
  return {
    timeframe,
    structureLevel: "internal",
    trend: "ranging",
    events: [],
    lastEvent: null,
    signals: [
      "Swing internal structure deferred — no dedicated lower-TF feed yet (option a)",
    ],
    status: "deferred",
    statusNote:
      "Swing ships external-structure-only until a dedicated Swing 15m feed is added as a follow-up stage.",
  };
}

function insufficientResult(
  timeframe: SmcTimeframe,
  structureLevel: SmcStructureLevel,
  note: string,
): MarketStructureResult {
  return {
    timeframe,
    structureLevel,
    trend: "ranging",
    events: [],
    lastEvent: null,
    signals: [note],
    status: "insufficient",
    statusNote: note,
  };
}

/**
 * Walk candle closes against Stage-1 swings to emit BOS / CHoCH events.
 *
 * A swing is "confirmed" only once `lookback` bars have printed after it
 * (same lag as the fractal detector). Each swing level is broken at most once.
 */
export function analyzeMarketStructure(params: {
  candles: OhlcvCandle[];
  swings: SwingPoint[];
  timeframe: SmcTimeframe;
  structureLevel: SmcStructureLevel;
  lookback?: number;
}): MarketStructureResult {
  const lookback = params.lookback ?? SWING_LOOKBACK;
  const { candles, swings, timeframe, structureLevel } = params;
  const signals: string[] = [];
  const events: MarketStructureEvent[] = [];

  if (candles.length < lookback * 2 + 1) {
    return insufficientResult(
      timeframe,
      structureLevel,
      `insufficient candles for market structure (need ≥${lookback * 2 + 1})`,
    );
  }

  const broken = new Set<string>(); // `${type}:${index}`
  let trend: SmcTrendDirection = "ranging";

  // Start once the first fractal can exist.
  for (let i = lookback * 2; i < candles.length; i++) {
    // Swings confirmed by bar i: fractal needs `lookback` bars after the pivot.
    const confirmed = swings.filter((s) => s.index + lookback <= i);
    const cHighs = confirmed.filter((s) => s.type === "high");
    const cLows = confirmed.filter((s) => s.type === "low");

    trend = classifySmcTrend(cHighs, cLows);
    if (trend === "ranging") continue;

    const lastHigh = cHighs[cHighs.length - 1];
    const lastLow = cLows[cLows.length - 1];
    if (!lastHigh || !lastLow) continue;

    const close = candles[i]!.close;
    const time = candles[i]!.time;

    const tryBreak = (
      swing: SwingPoint,
      eventType: "BOS" | "CHoCH",
      direction: SmcDirection,
    ) => {
      const key = `${swing.type}:${swing.index}`;
      if (broken.has(key)) return;
      // Break must occur on a bar after the swing pivot.
      if (i <= swing.index) return;

      const beyond =
        swing.type === "high" ? close > swing.price : close < swing.price;
      if (!beyond) return;

      broken.add(key);
      events.push({
        type: eventType,
        direction,
        time,
        price: round2(close),
        brokenSwing: swing,
        structureLevel,
        confirmIndex: i,
      });
    };

    if (trend === "bullish") {
      // WITH trend: close above last swing high → BOS bullish
      tryBreak(lastHigh, "BOS", "bullish");
      // AGAINST trend: close below last swing low → CHoCH bearish
      tryBreak(lastLow, "CHoCH", "bearish");
    } else {
      // bearish: WITH → below last low; AGAINST → above last high
      tryBreak(lastLow, "BOS", "bearish");
      tryBreak(lastHigh, "CHoCH", "bullish");
    }
  }

  // Final trend from all swings (not mid-walk snapshot).
  const allHighs = swings.filter((s) => s.type === "high");
  const allLows = swings.filter((s) => s.type === "low");
  trend = classifySmcTrend(allHighs, allLows);

  signals.push(`trend: ${trend} (${structureLevel} / ${timeframe})`);
  signals.push(
    `events: ${events.filter((e) => e.type === "BOS").length} BOS, ${events.filter((e) => e.type === "CHoCH").length} CHoCH`,
  );
  const lastEvent = events.length > 0 ? events[events.length - 1]! : null;
  if (lastEvent) {
    signals.push(
      `last ${lastEvent.type} ${lastEvent.direction} @ ${lastEvent.price} (broke ${lastEvent.brokenSwing.type} ${lastEvent.brokenSwing.price})`,
    );
  } else {
    signals.push("no BOS/CHoCH events on this series");
  }

  // Label: BOS/CHoCH are structural facts; trade inference stays heuristic downstream.
  signals.push(
    "BOS/CHoCH = objective close-beyond-swing facts; not trade signals (heuristic disclaimer applies downstream)",
  );

  return {
    timeframe,
    structureLevel,
    trend,
    events,
    lastEvent,
    signals,
    status: "ok",
  };
}

function runLevel(params: {
  candles: OhlcvCandle[];
  timeframe: SmcTimeframe;
  structureLevel: SmcStructureLevel;
  lookback?: number;
}): { swings: SwingPointsResult; structure: MarketStructureResult } {
  const swings = detectSmcSwingPoints(
    params.candles,
    params.timeframe,
    params.lookback,
  );
  const structure = analyzeMarketStructure({
    candles: params.candles,
    swings: swings.swings,
    timeframe: params.timeframe,
    structureLevel: params.structureLevel,
    lookback: params.lookback,
  });
  return { swings, structure };
}

/**
 * Stages 1–2 orchestrator: external always; internal per mode/gap rules.
 *
 * SCALP: external=5m, internal=3m when candles provided.
 * SWING: external=1h, internal=deferred (option a) — ignore any internal candles.
 */
export function analyzeSmcStructure(
  input: SmcEngineInput,
  opts?: { lookback?: number },
): SmcStructureBundle {
  const lookback = opts?.lookback ?? SWING_LOOKBACK;
  const degradeReasons: string[] = [];
  let degraded = false;

  if (input.source === "demo" || input.source === "db_cache") {
    degraded = true;
    degradeReasons.push(`candle source: ${input.source}`);
  }
  if (input.source === "unavailable") {
    degraded = true;
    degradeReasons.push("market data unavailable");
  }

  const externalTf = input.externalTimeframe ?? SMC_PRIMARY_TF[input.mode];
  const external = runLevel({
    candles: input.externalCandles,
    timeframe: externalTf,
    structureLevel: "external",
    lookback,
  });

  let internalSwings: SwingPointsResult | null = null;
  let internalStructure: MarketStructureResult | null = null;

  if (input.mode === "SWING") {
    // Option (a): external-only for Swing; do not consume opportunistic lower TF.
    // Deferred is intentional — not a market-data degrade.
    internalStructure = deferredInternal("FIFTEEN_MINUTE");
    internalSwings = null;
  } else if (input.internalCandles && input.internalTimeframe) {
    const internal = runLevel({
      candles: input.internalCandles,
      timeframe: input.internalTimeframe,
      structureLevel: "internal",
      lookback,
    });
    internalSwings = internal.swings;
    internalStructure = internal.structure;
  } else {
    const tf = input.internalTimeframe ?? SMC_SCALP_INTERNAL_TF;
    internalStructure = insufficientResult(
      tf,
      "internal",
      "Scalp internal candles not provided",
    );
    internalSwings = null;
  }

  return {
    underlying: input.underlying,
    mode: input.mode,
    fetchedAt: new Date().toISOString(),
    source: input.source,
    degraded: degraded || degradeReasons.length > 0,
    degradeReasons,
    swingPoints: {
      external: external.swings,
      internal: internalSwings,
    },
    marketStructure: {
      external: external.structure,
      internal: internalStructure,
    },
    stagesComplete: [1, 2],
  };
}

/** Convenience builder for common mode → TF mapping. */
export function buildSmcStructureInput(params: {
  underlying: SmcEngineInput["underlying"];
  mode: TradingMode;
  externalCandles: OhlcvCandle[];
  internalCandles?: OhlcvCandle[] | null;
  source: SmcDataSource;
}): SmcEngineInput {
  return {
    underlying: params.underlying,
    mode: params.mode,
    externalCandles: params.externalCandles,
    externalTimeframe: SMC_PRIMARY_TF[params.mode],
    internalCandles:
      params.mode === "SWING" ? null : (params.internalCandles ?? null),
    internalTimeframe:
      params.mode === "SWING" ? null : SMC_SCALP_INTERNAL_TF,
    source: params.source,
  };
}
