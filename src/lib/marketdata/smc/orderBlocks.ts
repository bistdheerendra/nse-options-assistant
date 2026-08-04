/**
 * SMC Stage 3 — Order Blocks, Breaker, Mitigation, Rejection Blocks.
 *
 * Consumes Stage-1 SwingPoint[] and Stage-2 MarketStructureEvent[] —
 * never re-detects swings or BOS/CHoCH.
 *
 * Rules:
 *   OB = last opposite-color candle before the displacement that caused
 *        a BOS/CHoCH (bullish event → last bearish candle; bearish → last bullish).
 *   Mitigation = price re-enters OB range without closing through it
 *                (status → mitigated + mitigationTime).
 *   Breaker = OB fully invalidated (close through the zone) → original
 *             marked invalidated; new opposite-polarity breaker zone tracked.
 *   Rejection Block = at a Stage-1 swing, wick ≥ REJECTION_WICK_RATIO (2×) body;
 *             no BOS required; lowerConfidence: true.
 *
 * Heuristic / rules-based — not ML-validated.
 */

import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import {
  REJECTION_WICK_RATIO,
  type MarketStructureEvent,
  type OrderBlockKind,
  type OrderBlockZone,
  type OrderBlocksResult,
  type SmcStructureLevel,
  type SmcTimeframe,
  type SwingPoint,
} from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function body(c: OhlcvCandle): number {
  return Math.abs(c.close - c.open);
}

function isBearishCandle(c: OhlcvCandle): boolean {
  return c.close < c.open;
}

function isBullishCandle(c: OhlcvCandle): boolean {
  return c.close > c.open;
}

/** Demand-like zones: bullish OB / bullish breaker / bullish rejection. */
function isDemandKind(type: OrderBlockKind): boolean {
  return (
    type === "bullish_ob" ||
    type === "bullish_breaker" ||
    type === "bullish_rejection"
  );
}

function eventToObKind(
  direction: MarketStructureEvent["direction"],
): "bullish_ob" | "bearish_ob" {
  return direction === "bullish" ? "bullish_ob" : "bearish_ob";
}

function oppositeBreaker(
  kind: "bullish_ob" | "bearish_ob" | "bullish_rejection" | "bearish_rejection",
): "bullish_breaker" | "bearish_breaker" {
  // Invalidated demand → bearish breaker; invalidated supply → bullish breaker.
  if (kind === "bullish_ob" || kind === "bullish_rejection") {
    return "bearish_breaker";
  }
  return "bullish_breaker";
}

/**
 * Last opposite-color candle before the BOS/CHoCH confirm bar,
 * searching back toward (and including) the broken swing index.
 */
export function findOrderBlockOriginIndex(
  candles: OhlcvCandle[],
  event: MarketStructureEvent,
): number | null {
  const wantBearish = event.direction === "bullish";
  const floor = Math.max(0, event.brokenSwing.index);
  for (let i = event.confirmIndex - 1; i >= floor; i--) {
    const c = candles[i]!;
    if (wantBearish && isBearishCandle(c)) return i;
    if (!wantBearish && isBullishCandle(c)) return i;
  }
  // Soft expand: a few bars before the broken swing if impulse started earlier.
  const softFloor = Math.max(0, floor - 5);
  for (let i = floor - 1; i >= softFloor; i--) {
    const c = candles[i]!;
    if (wantBearish && isBearishCandle(c)) return i;
    if (!wantBearish && isBullishCandle(c)) return i;
  }
  return null;
}

function zoneFromCandle(
  candle: OhlcvCandle,
  index: number,
  type: OrderBlockKind,
  structureLevel: SmcStructureLevel,
  causedByEvent: MarketStructureEvent["type"] | null,
  lowerConfidence: boolean,
): OrderBlockZone {
  return {
    type,
    high: round2(candle.high),
    low: round2(candle.low),
    originCandleTime: candle.time,
    originCandleIndex: index,
    status: "fresh",
    lowerConfidence,
    causedByEvent,
    structureLevel,
  };
}

/**
 * Rejection blocks at Stage-1 swings (no BOS required).
 * Swing high + upper wick ≥ 2× body → bearish_rejection.
 * Swing low + lower wick ≥ 2× body → bullish_rejection.
 */
export function detectRejectionBlocks(
  candles: OhlcvCandle[],
  swings: SwingPoint[],
  structureLevel: SmcStructureLevel,
): OrderBlockZone[] {
  const zones: OrderBlockZone[] = [];
  for (const swing of swings) {
    const candle = candles[swing.index];
    if (!candle) continue;
    const b = body(candle);
    // Flat body: treat as tiny so pure-wick bars still qualify.
    const bodySize = b < 1e-9 ? 1e-9 : b;

    if (swing.type === "high") {
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      // upperWick ≥ REJECTION_WICK_RATIO × body
      if (upperWick >= REJECTION_WICK_RATIO * bodySize) {
        zones.push(
          zoneFromCandle(
            candle,
            swing.index,
            "bearish_rejection",
            structureLevel,
            null,
            true,
          ),
        );
      }
    } else {
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      if (lowerWick >= REJECTION_WICK_RATIO * bodySize) {
        zones.push(
          zoneFromCandle(
            candle,
            swing.index,
            "bullish_rejection",
            structureLevel,
            null,
            true,
          ),
        );
      }
    }
  }
  return zones;
}

/**
 * Walk bars after each zone origin to apply mitigation / invalidation.
 * On invalidation: mark zone invalidated and spawn opposite-polarity breaker
 * tracked only from the invalidation bar forward (not from OB origin).
 */
export function applyMitigationAndBreakers(
  candles: OhlcvCandle[],
  zones: OrderBlockZone[],
): OrderBlockZone[] {
  const out: OrderBlockZone[] = zones.map((z) => ({ ...z }));
  const breakers: { zone: OrderBlockZone; trackFrom: number }[] = [];

  for (const zone of out) {
    for (let i = zone.originCandleIndex + 1; i < candles.length; i++) {
      if (zone.status === "invalidated") break;
      const bar = candles[i]!;
      const overlaps = bar.low <= zone.high && bar.high >= zone.low;

      if (isDemandKind(zone.type)) {
        if (bar.close < zone.low) {
          zone.status = "invalidated";
          if (
            zone.type === "bullish_ob" ||
            zone.type === "bullish_rejection"
          ) {
            breakers.push({
              trackFrom: i,
              zone: {
                type: oppositeBreaker(zone.type),
                high: zone.high,
                low: zone.low,
                originCandleTime: zone.originCandleTime,
                originCandleIndex: zone.originCandleIndex,
                status: "fresh",
                lowerConfidence: zone.lowerConfidence,
                causedByEvent: zone.causedByEvent,
                structureLevel: zone.structureLevel,
              },
            });
          }
          break;
        }
        if (overlaps && bar.close >= zone.low && zone.status === "fresh") {
          zone.status = "mitigated";
          zone.mitigationTime = bar.time;
        }
      } else {
        if (bar.close > zone.high) {
          zone.status = "invalidated";
          if (
            zone.type === "bearish_ob" ||
            zone.type === "bearish_rejection"
          ) {
            breakers.push({
              trackFrom: i,
              zone: {
                type: oppositeBreaker(zone.type),
                high: zone.high,
                low: zone.low,
                originCandleTime: zone.originCandleTime,
                originCandleIndex: zone.originCandleIndex,
                status: "fresh",
                lowerConfidence: zone.lowerConfidence,
                causedByEvent: zone.causedByEvent,
                structureLevel: zone.structureLevel,
              },
            });
          }
          break;
        }
        if (overlaps && bar.close <= zone.high && zone.status === "fresh") {
          zone.status = "mitigated";
          zone.mitigationTime = bar.time;
        }
      }
    }
  }

  // Breakers: track from invalidation bar forward only.
  for (const { zone: br, trackFrom } of breakers) {
    for (let i = trackFrom + 1; i < candles.length; i++) {
      if (br.status === "invalidated") break;
      const bar = candles[i]!;
      const overlaps = bar.low <= br.high && bar.high >= br.low;
      if (isDemandKind(br.type)) {
        if (bar.close < br.low) {
          br.status = "invalidated";
          break;
        }
        if (overlaps && bar.close >= br.low && br.status === "fresh") {
          br.status = "mitigated";
          br.mitigationTime = bar.time;
        }
      } else {
        if (bar.close > br.high) {
          br.status = "invalidated";
          break;
        }
        if (overlaps && bar.close <= br.high && br.status === "fresh") {
          br.status = "mitigated";
          br.mitigationTime = bar.time;
        }
      }
    }
  }

  return [...out, ...breakers.map((b) => b.zone)];
}

/**
 * Detect order blocks from structure events + rejection blocks from swings.
 */
export function detectOrderBlocks(params: {
  candles: OhlcvCandle[];
  swings: SwingPoint[];
  events: MarketStructureEvent[];
  timeframe: SmcTimeframe;
  structureLevel: SmcStructureLevel;
}): OrderBlocksResult {
  const { candles, swings, events, timeframe, structureLevel } = params;
  const signals: string[] = [];
  const raw: OrderBlockZone[] = [];

  if (candles.length === 0) {
    return {
      timeframe,
      zones: [],
      signals: ["no candles for order-block detection"],
    };
  }

  // Structure-driven OBs
  for (const event of events) {
    const idx = findOrderBlockOriginIndex(candles, event);
    if (idx === null) {
      signals.push(
        `no opposite-color OB candle for ${event.type} ${event.direction} @ ${event.time}`,
      );
      continue;
    }
    const kind = eventToObKind(event.direction);
    raw.push(
      zoneFromCandle(
        candles[idx]!,
        idx,
        kind,
        structureLevel,
        event.type,
        false,
      ),
    );
  }

  // Rejection blocks at swings (lower confidence)
  const rejections = detectRejectionBlocks(candles, swings, structureLevel);
  raw.push(...rejections);

  // Dedup identical origin+type (e.g. OB and rejection on same bar)
  const seen = new Set<string>();
  const deduped: OrderBlockZone[] = [];
  for (const z of raw) {
    const key = `${z.type}:${z.originCandleIndex}:${z.high}:${z.low}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(z);
  }

  const zones = applyMitigationAndBreakers(candles, deduped);

  const fresh = zones.filter((z) => z.status === "fresh").length;
  const mitigated = zones.filter((z) => z.status === "mitigated").length;
  const invalidated = zones.filter((z) => z.status === "invalidated").length;
  const breakers = zones.filter((z) => z.type.includes("breaker")).length;
  const rejection = zones.filter((z) => z.type.includes("rejection")).length;

  signals.push(
    `OB zones: ${zones.length} (fresh=${fresh}, mitigated=${mitigated}, invalidated=${invalidated}, breakers=${breakers}, rejections=${rejection})`,
  );
  signals.push(
    `rejection wick rule: wick ≥ ${REJECTION_WICK_RATIO}× body at Stage-1 swing (lowerConfidence)`,
  );
  signals.push(
    "Order blocks heuristic / rules-based — not ML-validated",
  );

  return { timeframe, zones, signals };
}
