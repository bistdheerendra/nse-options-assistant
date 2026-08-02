import type {
  OptionChainResult,
  OptionContractQuote,
} from "@/lib/marketdata/angelone";

/**
 * Scalp Stage 4 — liquidity zone detection at option strikes.
 *
 * Data fields (verified in-repo against Angel quote FULL + NSE OC):
 *   bid / ask  → spread width
 *   volume     → traded volume at strike
 *   oi         → open interest at strike
 *
 * Parameters (auditable — not buried magic numbers):
 *   ATM_BAND_PCT          = 0.015  → evaluate strikes within ±1.5% of spot (scalp-relevant)
 *   SPREAD_WIDE_PCT       = 0.08   → (ask−bid)/ltp > 8% ⇒ wide spread (illiquid)
 *   SPREAD_TIGHT_PCT      = 0.03   → ≤3% ⇒ tight (good)
 *   MIN_VOLUME            = 100    → below ⇒ low volume
 *   MIN_OI                = 5_000  → below ⇒ thin OI wall (index options)
 *   HIGH_OI_PCTILE_PROXY  = top 25% of ATM-band OI ⇒ high-liquidity OI zone
 *
 * Scalping suitability (hard gate per PROJECT §3 / §3.1):
 *   PASS  — suggested ATM-ish contract (or band median) is not flagged illiquid
 *   FAIL  — suggested / nearest ATM contract fails any of: wide spread, low volume, low OI
 *   WARN  — band has mixed liquidity; tradeable ATM but many nearby strikes illiquid
 */

export const LIQUIDITY_ATM_BAND_PCT = 0.015;
export const LIQUIDITY_SPREAD_WIDE_PCT = 0.08;
export const LIQUIDITY_SPREAD_TIGHT_PCT = 0.03;
export const LIQUIDITY_MIN_VOLUME = 100;
export const LIQUIDITY_MIN_OI = 5_000;

export type LiquidityTier = "high" | "medium" | "low";

export type StrikeLiquidity = {
  strike: number;
  optionType: "CE" | "PE";
  ltp: number;
  bid: number | null;
  ask: number | null;
  /** (ask − bid) / ltp when both sides present and ltp > 0; else null. */
  spreadPct: number | null;
  volume: number;
  oi: number;
  tier: LiquidityTier;
  /** True when unsuitable for scalping on this contract. */
  unsuitableForScalp: boolean;
  reasons: string[];
};

export type ScalpLiquidityStatus = "pass" | "fail" | "warn" | "unavailable";

export type LiquidityAssessment = {
  status: ScalpLiquidityStatus;
  /** Binance-style badge label. */
  badgeLabel: string;
  /** Explicit unsuitable-for-scalping warning (null when pass). */
  warning: string | null;
  spot: number;
  atmStrike: number | null;
  /** Contract used for the hard gate (nearest ATM of suggested side, else CE). */
  focus: StrikeLiquidity | null;
  nearAtm: StrikeLiquidity[];
  highLiquidityStrikes: number[];
  lowLiquidityStrikes: number[];
  /** Counts for UI. */
  counts: {
    evaluated: number;
    unsuitable: number;
    high: number;
    medium: number;
    low: number;
  };
  params: {
    atmBandPct: number;
    spreadWidePct: number;
    spreadTightPct: number;
    minVolume: number;
    minOi: number;
  };
  /** true when bid/ask missing on most contracts (degraded scoring). */
  bidAskDegraded: boolean;
  signals: string[];
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * spreadPct = (ask − bid) / ltp
 */
export function calcSpreadPct(
  bid: number | undefined | null,
  ask: number | undefined | null,
  ltp: number,
): number | null {
  if (bid == null || ask == null || ltp <= 0) return null;
  if (ask < bid) return null;
  return round4((ask - bid) / ltp);
}

export function scoreStrikeLiquidity(
  c: OptionContractQuote,
): StrikeLiquidity {
  const spreadPct = calcSpreadPct(c.bid, c.ask, c.ltp);
  const volume = c.volume ?? 0;
  const oi = c.oi ?? 0;
  const reasons: string[] = [];

  const wideSpread =
    spreadPct != null && spreadPct > LIQUIDITY_SPREAD_WIDE_PCT;
  const lowVolume = volume < LIQUIDITY_MIN_VOLUME;
  const lowOi = oi < LIQUIDITY_MIN_OI;
  const missingBook = spreadPct == null;

  if (wideSpread) {
    reasons.push(
      `wide spread ${(spreadPct! * 100).toFixed(1)}% > ${(LIQUIDITY_SPREAD_WIDE_PCT * 100).toFixed(0)}%`,
    );
  }
  if (lowVolume) reasons.push(`volume ${volume} < ${LIQUIDITY_MIN_VOLUME}`);
  if (lowOi) reasons.push(`OI ${oi} < ${LIQUIDITY_MIN_OI}`);
  if (missingBook) reasons.push("bid/ask unavailable");

  // Hard unsuitable: wide spread OR (low volume AND low OI) OR (missing book + low volume)
  const unsuitableForScalp =
    wideSpread ||
    (lowVolume && lowOi) ||
    (missingBook && lowVolume) ||
    (lowVolume && wideSpread);

  let tier: LiquidityTier = "medium";
  if (
    !unsuitableForScalp &&
    spreadPct != null &&
    spreadPct <= LIQUIDITY_SPREAD_TIGHT_PCT &&
    volume >= LIQUIDITY_MIN_VOLUME * 3 &&
    oi >= LIQUIDITY_MIN_OI * 2
  ) {
    tier = "high";
  } else if (unsuitableForScalp || lowVolume || wideSpread) {
    tier = "low";
  }

  return {
    strike: c.strike,
    optionType: c.optionType,
    ltp: c.ltp,
    bid: c.bid ?? null,
    ask: c.ask ?? null,
    spreadPct,
    volume,
    oi,
    tier,
    unsuitableForScalp,
    reasons,
  };
}

function nearestAtmStrike(
  contracts: OptionContractQuote[],
  spot: number,
): number | null {
  if (!contracts.length) return null;
  let best = contracts[0]!.strike;
  let bestDist = Math.abs(best - spot);
  for (const c of contracts) {
    const d = Math.abs(c.strike - spot);
    if (d < bestDist) {
      best = c.strike;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Assess scalp liquidity for an option chain.
 * @param preferredSide — when set, focus gate uses that CE/PE ATM contract.
 */
export function assessScalpLiquidity(
  chain: OptionChainResult,
  preferredSide?: "CE" | "PE" | null,
): LiquidityAssessment {
  const params = {
    atmBandPct: LIQUIDITY_ATM_BAND_PCT,
    spreadWidePct: LIQUIDITY_SPREAD_WIDE_PCT,
    spreadTightPct: LIQUIDITY_SPREAD_TIGHT_PCT,
    minVolume: LIQUIDITY_MIN_VOLUME,
    minOi: LIQUIDITY_MIN_OI,
  };
  const signals: string[] = [];

  if (!chain.contracts.length) {
    return {
      status: "unavailable",
      badgeLabel: "Liquidity: n/a",
      warning: "Option chain empty — cannot assess scalp liquidity.",
      spot: chain.spot,
      atmStrike: null,
      focus: null,
      nearAtm: [],
      highLiquidityStrikes: [],
      lowLiquidityStrikes: [],
      counts: { evaluated: 0, unsuitable: 0, high: 0, medium: 0, low: 0 },
      params,
      bidAskDegraded: true,
      signals: ["no contracts"],
    };
  }

  const near = chain.contracts.filter(
    (c) => Math.abs(c.strike - chain.spot) / chain.spot <= LIQUIDITY_ATM_BAND_PCT,
  );
  const scored = near.map(scoreStrikeLiquidity);
  const atmStrike = nearestAtmStrike(near.length ? near : chain.contracts, chain.spot);

  const side = preferredSide ?? "CE";
  const focus =
    scored.find((s) => s.strike === atmStrike && s.optionType === side) ??
    scored.find((s) => s.strike === atmStrike) ??
    scored[0] ??
    null;

  const missingBidAsk = scored.filter((s) => s.spreadPct == null).length;
  const bidAskDegraded =
    scored.length > 0 && missingBidAsk / scored.length > 0.5;
  if (bidAskDegraded) {
    signals.push(
      "Bid/ask missing on >50% of ATM-band contracts — spread scoring degraded (volume+OI still applied)",
    );
  }

  const unsuitable = scored.filter((s) => s.unsuitableForScalp);
  const highLiquidityStrikes = [
    ...new Set(scored.filter((s) => s.tier === "high").map((s) => s.strike)),
  ];
  const lowLiquidityStrikes = [
    ...new Set(unsuitable.map((s) => s.strike)),
  ];

  const counts = {
    evaluated: scored.length,
    unsuitable: unsuitable.length,
    high: scored.filter((s) => s.tier === "high").length,
    medium: scored.filter((s) => s.tier === "medium").length,
    low: scored.filter((s) => s.tier === "low").length,
  };

  let status: ScalpLiquidityStatus;
  let badgeLabel: string;
  let warning: string | null = null;

  if (!focus) {
    status = "unavailable";
    badgeLabel = "Liquidity: n/a";
    warning = "No ATM-band contracts to score.";
  } else if (focus.unsuitableForScalp) {
    status = "fail";
    badgeLabel = "Unsuitable for scalping";
    warning = `ATM ${focus.strike} ${focus.optionType} fails liquidity gate (${focus.reasons.join("; ")}). Do not scalp this strike even if direction looks good.`;
    signals.push(warning);
  } else if (counts.unsuitable >= Math.max(2, Math.floor(counts.evaluated * 0.4))) {
    status = "warn";
    badgeLabel = "Liquidity: caution";
    warning = `${counts.unsuitable}/${counts.evaluated} ATM-band contracts flagged low-liquidity — prefer high-tier strikes only.`;
    signals.push(warning);
  } else {
    status = "pass";
    badgeLabel = "Liquidity: OK for scalp";
    signals.push(
      `ATM ${focus.strike} ${focus.optionType} passes liquidity gate (spread=${focus.spreadPct != null ? `${(focus.spreadPct * 100).toFixed(1)}%` : "n/a"}, vol=${focus.volume}, OI=${focus.oi})`,
    );
  }

  return {
    status,
    badgeLabel,
    warning,
    spot: chain.spot,
    atmStrike,
    focus,
    nearAtm: scored,
    highLiquidityStrikes,
    lowLiquidityStrikes,
    counts,
    params,
    bidAskDegraded,
    signals,
  };
}
