/**
 * SMC Engine — Smart Money Concepts (standalone, read-only).
 * NOT wired into §2.5 synthesizer or paper trading in this pass.
 *
 * Stages shipped: 1–8 (complete read-only pipeline).
 */

export * from "./types";
export { detectSmcSwingPoints } from "./swingPoints";
export {
  analyzeMarketStructure,
  analyzeSmcStructure,
  buildSmcStructureInput,
  classifySmcTrend,
} from "./marketStructure";
export {
  applyMitigationAndBreakers,
  detectOrderBlocks,
  detectRejectionBlocks,
  findOrderBlockOriginIndex,
} from "./orderBlocks";
export {
  atrAtIndex,
  detectFairValueGaps,
  detectFairValueGapsOnly,
  detectSingleCandleImbalances,
  isDisplacementCandle,
  measureGapFill,
  rollingAvgVolumeAt,
  FVG_ATR_PERIOD,
} from "./fairValueGaps";
export {
  clusterEqualSwings,
  detectSmcLiquidity,
  detectSweep,
} from "./smcLiquidity";
export {
  analyzePremiumDiscount,
  classifyPremiumDiscountZone,
  findLastMajorLeg,
  EQUILIBRIUM_BAND_PCT,
} from "./premiumDiscount";
export {
  applySupplyDemandStatus,
  detectSupplyDemand,
  findBaseBeforeDisplacement,
  isBaseCandle,
  SD_BASE_MAX_CANDLES,
  SD_BASE_BODY_RATIO,
  SD_BASE_RANGE_ATR_MULT,
} from "./supplyDemand";
export {
  assembleSmcEngineResult,
  synthesizeSmcSignal,
  SMC_DISCLAIMER,
} from "./smcSignal";
export { getSmcEngineResult, runSmcEngineSync } from "./engine";
export { buildSmcOverlayLevels, type SmcOverlayLevel } from "./overlays";
