/**
 * SMC engine runner — Stages 1–8 with in-process TTL cache.
 *
 * TTL = SMC_RESULT_TTL_SEC (45) — matches SCALP_CANDLE_BUNDLE_TTL_SEC so
 * Stages 3–7 stay coherent with the candle bundle they were computed from,
 * without recomputing from scratch on every request.
 *
 * Standalone / read-only — not wired to §2.5 or paper trading.
 */

import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  type Underlying,
} from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { getMultiTimeframeCandles } from "@/lib/marketdata/scalp/multiTimeframeCandles";
import {
  analyzeSmcStructure,
  buildSmcStructureInput,
} from "./marketStructure";
import { detectOrderBlocks } from "./orderBlocks";
import { detectFairValueGaps } from "./fairValueGaps";
import { detectSmcLiquidity } from "./smcLiquidity";
import { analyzePremiumDiscount } from "./premiumDiscount";
import { detectSupplyDemand } from "./supplyDemand";
import { assembleSmcEngineResult } from "./smcSignal";
import {
  SMC_PRIMARY_TF,
  SMC_RESULT_TTL_SEC,
  SMC_SCALP_INTERNAL_TF,
  type SmcDataSource,
  type SmcEngineResult,
} from "./types";

function mapSeriesSource(
  source: "angel" | "demo" | "db_cache",
): SmcDataSource {
  return source;
}

/**
 * Run the full SMC pipeline on an already-fetched candle set (pure aside from Date).
 */
export function runSmcEngineSync(params: {
  underlying: Underlying;
  mode: TradingMode;
  externalCandles: import("@/lib/marketdata/angelone").OhlcvCandle[];
  internalCandles?: import("@/lib/marketdata/angelone").OhlcvCandle[] | null;
  source: SmcDataSource;
}): SmcEngineResult {
  const input = buildSmcStructureInput({
    underlying: params.underlying,
    mode: params.mode,
    externalCandles: params.externalCandles,
    internalCandles: params.internalCandles ?? null,
    source: params.source,
  });

  const structureBundle = analyzeSmcStructure(input);
  const extCandles = params.externalCandles;
  const swings = structureBundle.swingPoints.external.swings;
  const events = structureBundle.marketStructure.external.events;
  const tf = structureBundle.marketStructure.external.timeframe;

  const orderBlocks = detectOrderBlocks({
    candles: extCandles,
    swings,
    events,
    timeframe: tf,
    structureLevel: "external",
  });
  const fairValueGaps = detectFairValueGaps({
    candles: extCandles,
    timeframe: tf,
  });
  const liquidity = detectSmcLiquidity({
    candles: extCandles,
    swings,
    timeframe: tf,
  });
  const premiumDiscount = analyzePremiumDiscount({
    candles: extCandles,
    swings,
  });
  const supplyDemand = detectSupplyDemand({
    candles: extCandles,
    timeframe: tf,
  });

  const spot =
    extCandles.length > 0
      ? extCandles[extCandles.length - 1]!.close
      : 0;

  return assembleSmcEngineResult({
    structureBundle,
    orderBlocks,
    fairValueGaps,
    liquidity,
    premiumDiscount,
    supplyDemand,
    spot,
  });
}

/**
 * Fetch candles + run SMC with in-process TTL cache keyed by underlying+mode.
 * Cache TTL comment: 45s matches scalp MTF candle TTL (see SMC_RESULT_TTL_SEC).
 */
export async function getSmcEngineResult(
  underlying: Underlying,
  mode: TradingMode,
  opts?: { forceRefresh?: boolean },
): Promise<SmcEngineResult> {
  const cacheKey = `smc:${mode}:${underlying}`;

  const loader = async (): Promise<SmcEngineResult> => {
    if (mode === "SCALP") {
      const bundle = await getMultiTimeframeCandles(underlying, {
        forceRefresh: opts?.forceRefresh,
      });
      const external = bundle.series.FIVE_MINUTE;
      const internal = bundle.series.THREE_MINUTE;
      const source = mapSeriesSource(external.source);
      return runSmcEngineSync({
        underlying,
        mode,
        externalCandles: external.candles,
        internalCandles: internal.candles,
        source,
      });
    }

    // SWING: 1h external only; internal deferred inside analyzeSmcStructure
    const lookbackDays = 60;
    let source: SmcDataSource = isDemoMarketDataMode() ? "demo" : "angel";
    let candles: import("@/lib/marketdata/angelone").OhlcvCandle[] = [];
    try {
      candles = await getUnderlyingCandles(
        underlying,
        SMC_PRIMARY_TF.SWING,
        lookbackDays,
      );
      if (isDemoMarketDataMode()) source = "demo";
    } catch {
      source = "unavailable";
      candles = [];
    }

    return runSmcEngineSync({
      underlying,
      mode,
      externalCandles: candles,
      internalCandles: null,
      source,
    });
  };

  if (opts?.forceRefresh) {
    return loader();
  }

  // TTL = SMC_RESULT_TTL_SEC (45) — matches scalp candle bundle TTL
  return withTtlCache(cacheKey, SMC_RESULT_TTL_SEC * 1000, loader);
}

export { SMC_SCALP_INTERNAL_TF };
