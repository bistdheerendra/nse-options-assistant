import type { OptionChainResult } from "@/lib/marketdata/angelone";

/**
 * Scalp Stage 6 — OI velocity (change over minutes), plus shared OI wall helper
 * reused by Stage 5 stop-loss clusters.
 *
 * Static wall (snapshot): highest PE OI ≤ spot → support; highest CE OI ≥ spot → resistance
 *   (same heuristic as Options Flow §2.2).
 *
 * Velocity (scalp-relevant):
 *   Store prior OI snapshot keyed by underlying+expiry+strike+side.
 *   velocity = (oiNow − oiPrev) / elapsedMinutes
 *   Lookback window target: OI_VELOCITY_TARGET_MINUTES (default 5).
 *   Until a prior snapshot exists, velocity is null and status = "warming_up"
 *   (never invent a fake velocity).
 */

export const OI_VELOCITY_TARGET_MINUTES = 5;
/** |velocity| ≥ this many OI contracts per minute near ATM ⇒ notable buildup. */
export const OI_VELOCITY_NOTABLE_PER_MIN = 2_000;

export type OiWallLevels = {
  support: number | null;
  resistance: number | null;
  supportOi: number;
  resistanceOi: number;
  notes: string[];
};

/**
 * Snapshot OI walls — PE buildup below spot = support; CE above = resistance.
 */
export function oiBuildupLevels(chain: OptionChainResult): OiWallLevels {
  const notes: string[] = [];
  let support: number | null = null;
  let resistance: number | null = null;
  let supportOi = 0;
  let resistanceOi = 0;

  for (const c of chain.contracts) {
    const oi = c.oi ?? 0;
    if (c.optionType === "PE" && c.strike <= chain.spot && oi > supportOi) {
      supportOi = oi;
      support = c.strike;
    }
    if (c.optionType === "CE" && c.strike >= chain.spot && oi > resistanceOi) {
      resistanceOi = oi;
      resistance = c.strike;
    }
  }
  if (support != null) notes.push(`PE OI wall support ≈ ${support} (OI=${supportOi})`);
  if (resistance != null) {
    notes.push(`CE OI wall resistance ≈ ${resistance} (OI=${resistanceOi})`);
  }
  return { support, resistance, supportOi, resistanceOi, notes };
}

export type OiStrikeSnapshot = {
  strike: number;
  optionType: "CE" | "PE";
  oi: number;
};

export type OiChainSnapshot = {
  underlying: string;
  expiry: string;
  spot: number;
  capturedAt: number; // epoch ms
  strikes: OiStrikeSnapshot[];
};

type VelocityReading = {
  strike: number;
  optionType: "CE" | "PE";
  oiNow: number;
  oiPrev: number;
  /** (oiNow − oiPrev) / elapsedMinutes */
  velocityPerMin: number;
  elapsedMinutes: number;
};

export type OiVelocityResult = {
  status: "ready" | "warming_up" | "unavailable";
  targetMinutes: number;
  elapsedMinutes: number | null;
  /** Near-ATM CE velocity sum (positive = call OI rising). */
  callVelocityPerMin: number | null;
  /** Near-ATM PE velocity sum (positive = put OI rising). */
  putVelocityPerMin: number | null;
  /** call − put near ATM (positive → call buildup dominance). */
  netVelocityPerMin: number | null;
  notable: boolean;
  walls: OiWallLevels;
  readings: VelocityReading[];
  signals: string[];
};

const ATM_BAND = 0.015;

/** In-process prior snapshots (per underlying). Process-local — fine for single-instance. */
const priorByUnderlying = new Map<string, OiChainSnapshot>();

export function captureOiSnapshot(chain: OptionChainResult): OiChainSnapshot {
  return {
    underlying: chain.underlying,
    expiry: chain.expiry,
    spot: chain.spot,
    capturedAt: Date.now(),
    strikes: chain.contracts.map((c) => ({
      strike: c.strike,
      optionType: c.optionType,
      oi: c.oi ?? 0,
    })),
  };
}

function nearAtm(
  strike: number,
  spot: number,
): boolean {
  return Math.abs(strike - spot) / spot <= ATM_BAND;
}

/**
 * Compute OI change velocity vs the last stored snapshot for this underlying.
 * Updates the store with the current snapshot after computing (sliding baseline).
 *
 * If prior is missing or elapsed < 30s → warming_up (no fabricated velocity).
 */
export function computeOiVelocity(
  chain: OptionChainResult,
  opts?: { targetMinutes?: number; notablePerMin?: number },
): OiVelocityResult {
  const targetMinutes = opts?.targetMinutes ?? OI_VELOCITY_TARGET_MINUTES;
  const notablePerMin = opts?.notablePerMin ?? OI_VELOCITY_NOTABLE_PER_MIN;
  const walls = oiBuildupLevels(chain);
  const signals: string[] = [...walls.notes];
  const current = captureOiSnapshot(chain);
  const key = `${chain.underlying}:${chain.expiry}`;
  const prior = priorByUnderlying.get(key);

  // Always refresh store after read so next call has a baseline.
  const commit = () => priorByUnderlying.set(key, current);

  if (!prior || prior.expiry !== chain.expiry) {
    commit();
    signals.push(
      `OI velocity warming up — need ~${targetMinutes}m between snapshots (no prior for ${key})`,
    );
    return {
      status: "warming_up",
      targetMinutes,
      elapsedMinutes: null,
      callVelocityPerMin: null,
      putVelocityPerMin: null,
      netVelocityPerMin: null,
      notable: false,
      walls,
      readings: [],
      signals,
    };
  }

  const elapsedMs = current.capturedAt - prior.capturedAt;
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes < 0.5) {
    // Too fresh — keep prior baseline, don't overwrite with near-identical stamp
    signals.push("OI velocity warming up — elapsed < 30s since prior snapshot");
    return {
      status: "warming_up",
      targetMinutes,
      elapsedMinutes: Math.round(elapsedMinutes * 100) / 100,
      callVelocityPerMin: null,
      putVelocityPerMin: null,
      netVelocityPerMin: null,
      notable: false,
      walls,
      readings: [],
      signals,
    };
  }

  const prevMap = new Map(
    prior.strikes.map((s) => [`${s.strike}:${s.optionType}`, s.oi]),
  );
  const readings: VelocityReading[] = [];
  let callVel = 0;
  let putVel = 0;

  for (const s of current.strikes) {
    if (!nearAtm(s.strike, chain.spot)) continue;
    const prevOi = prevMap.get(`${s.strike}:${s.optionType}`);
    if (prevOi == null) continue;
    // velocity = ΔOI / elapsedMinutes
    const velocityPerMin = (s.oi - prevOi) / elapsedMinutes;
    readings.push({
      strike: s.strike,
      optionType: s.optionType,
      oiNow: s.oi,
      oiPrev: prevOi,
      velocityPerMin,
      elapsedMinutes,
    });
    if (s.optionType === "CE") callVel += velocityPerMin;
    else putVel += velocityPerMin;
  }

  commit();

  const net = callVel - putVel;
  const notable = Math.abs(net) >= notablePerMin;
  signals.push(
    `OI velocity (${elapsedMinutes.toFixed(1)}m): CE ${callVel.toFixed(0)}/min, PE ${putVel.toFixed(0)}/min, net ${net.toFixed(0)}/min` +
      (notable ? " — notable" : ""),
  );

  return {
    status: "ready",
    targetMinutes,
    elapsedMinutes: Math.round(elapsedMinutes * 100) / 100,
    callVelocityPerMin: Math.round(callVel),
    putVelocityPerMin: Math.round(putVel),
    netVelocityPerMin: Math.round(net),
    notable,
    walls,
    readings,
    signals,
  };
}

/** Test helper — clear in-process OI baselines. */
export function clearOiVelocityStore(): void {
  priorByUnderlying.clear();
}
