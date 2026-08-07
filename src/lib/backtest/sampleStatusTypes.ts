/**
 * §6 sample-status types — shared by API + UI (no server I/O).
 */

import {
  MIN_SAMPLE_FOR_EDGE_REPORT,
  SYNTHESIS_VERSION,
} from "./synthesisVersion";

export type MarketRegimeKey = "TRENDING" | "CHOPPY" | "VOLATILE";

export type ModeSampleStatus = {
  mode: "SCALP" | "SWING" | "ALL";
  resolvedCount: number;
  reportableThreshold: number;
  isReportable: boolean;
  /** Present only when ≥1 outcome has regime tagged via TradeIdea snapshot. */
  byRegime?: Record<MarketRegimeKey, number> & { unknown: number };
  /** How many of TRENDING/CHOPPY/VOLATILE have count > 0. */
  regimesCovered?: number;
  regimesTotal: 3;
};

export type SampleStatus = {
  synthesisVersion: typeof SYNTHESIS_VERSION.FOUR_LANE;
  reportableThreshold: number;
  combined: ModeSampleStatus;
  byMode: {
    SCALP: ModeSampleStatus;
    SWING: ModeSampleStatus;
  };
  /** True when any post-4-lane outcome could be joined to a regime tag. */
  regimeTagged: boolean;
  /** Informational only — does not alter insufficient-sample gating. */
  informationalOnly: true;
  note: string;
};

export { MIN_SAMPLE_FOR_EDGE_REPORT, SYNTHESIS_VERSION };
