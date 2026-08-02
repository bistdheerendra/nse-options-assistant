import {
  getOptionChain,
  type OptionChainResult,
  type Underlying,
} from "@/lib/marketdata/angelone";
import { assessScalpLiquidity } from "@/lib/marketdata/scalp/liquidity";
import { clampScore, type LaneResult, type TradingMode } from "./types";

function calcPcr(chain: OptionChainResult): { overall: number; ntm: number } {
  // PCR = total Put OI / total Call OI
  let putOi = 0;
  let callOi = 0;
  let putNtm = 0;
  let callNtm = 0;
  const spot = chain.spot;
  for (const c of chain.contracts) {
    const oi = c.oi ?? 0;
    if (c.optionType === "PE") putOi += oi;
    else callOi += oi;
    // Near-the-money: within ~1% of spot
    if (Math.abs(c.strike - spot) / spot <= 0.01) {
      if (c.optionType === "PE") putNtm += oi;
      else callNtm += oi;
    }
  }
  return {
    overall: callOi === 0 ? 1 : putOi / callOi,
    ntm: callNtm === 0 ? 1 : putNtm / callNtm,
  };
}

function calcMaxPain(chain: OptionChainResult): number {
  // Max Pain: choose expiry spot K minimizing total option intrinsic * OI
  // pain(K) = Σ_CE max(0, K - strike) * OI_CE + Σ_PE max(0, strike - K) * OI_PE
  const strikes = [...new Set(chain.contracts.map((c) => c.strike))].sort(
    (a, b) => a - b,
  );
  let bestStrike = strikes[0] ?? chain.spot;
  let bestPain = Number.POSITIVE_INFINITY;
  for (const expirySpot of strikes) {
    let pain = 0;
    for (const c of chain.contracts) {
      const oi = c.oi ?? 0;
      if (c.optionType === "CE") {
        pain += Math.max(0, expirySpot - c.strike) * oi;
      } else {
        pain += Math.max(0, c.strike - expirySpot) * oi;
      }
    }
    if (pain < bestPain) {
      bestPain = pain;
      bestStrike = expirySpot;
    }
  }
  return bestStrike;
}

function avgIv(chain: OptionChainResult): number {
  const ivs = chain.contracts.map((c) => c.iv).filter((x): x is number => x != null && x > 0);
  if (!ivs.length) return 15;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

function oiBuildupSignals(chain: OptionChainResult): {
  support: number | null;
  resistance: number | null;
  notes: string[];
} {
  // Rising OI + price behavior inference from live snapshot:
  // Highest PE OI near/below spot → support; highest CE OI near/above spot → resistance
  const notes: string[] = [];
  let support: number | null = null;
  let resistance: number | null = null;
  let maxPe = 0;
  let maxCe = 0;
  for (const c of chain.contracts) {
    const oi = c.oi ?? 0;
    if (c.optionType === "PE" && c.strike <= chain.spot && oi > maxPe) {
      maxPe = oi;
      support = c.strike;
    }
    if (c.optionType === "CE" && c.strike >= chain.spot && oi > maxCe) {
      maxCe = oi;
      resistance = c.strike;
    }
  }
  if (support != null) notes.push(`PE OI buildup support ≈ ${support}`);
  if (resistance != null) notes.push(`CE OI buildup resistance ≈ ${resistance}`);
  return { support, resistance, notes };
}

export type OptionsFlowExtras = {
  ivLevel: "low" | "mid" | "high";
  ivTrend: "falling" | "flat" | "rising";
  avgIv: number;
  pcr: { overall: number; ntm: number };
  maxPain: number;
  lowLiquidityStrikes: number[];
};

export async function runOptionsFlowLane(params: {
  underlying: Underlying;
  expiry?: string;
  mode?: TradingMode;
  chain?: OptionChainResult;
}): Promise<LaneResult & { extras: OptionsFlowExtras }> {
  const mode = params.mode ?? "SWING";
  const chain = params.chain ?? (await getOptionChain(params.underlying, params.expiry));
  const pcr = calcPcr(chain);
  const maxPain = calcMaxPain(chain);
  const iv = avgIv(chain);
  const buildup = oiBuildupSignals(chain);

  // IV regime thresholds (heuristic for index options; not calibrated)
  const ivLevel: OptionsFlowExtras["ivLevel"] =
    iv < 14 ? "low" : iv > 20 ? "high" : "mid";

  // TODO(TimescaleDB): proper IV time-series store. Proxy: compare ATM IV vs mean of wings.
  const atm = chain.contracts
    .filter((c) => Math.abs(c.strike - chain.spot) / chain.spot < 0.005)
    .map((c) => c.iv ?? iv);
  const atmIv = atm.length ? atm.reduce((a, b) => a + b, 0) / atm.length : iv;
  const ivTrend: OptionsFlowExtras["ivTrend"] =
    atmIv > iv * 1.05 ? "rising" : atmIv < iv * 0.95 ? "falling" : "flat";

  const signals: string[] = [
    ...buildup.notes,
    `PCR overall=${pcr.overall.toFixed(2)}, NTM=${pcr.ntm.toFixed(2)}`,
    `Max Pain ≈ ${maxPain}`,
    `Avg IV=${iv.toFixed(1)} (${ivLevel}, trend ${ivTrend})`,
  ];

  let score = 0;
  // PCR > 1 → more put OI → often contrarian bullish for indices; < 0.7 bearish lean
  if (pcr.overall > 1.1) {
    score += 0.25;
    signals.push("Elevated PCR — contrarian bullish lean");
  } else if (pcr.overall < 0.7) {
    score -= 0.25;
    signals.push("Low PCR — contrarian bearish lean");
  }

  if (maxPain > chain.spot * 1.002) {
    score += 0.15;
    signals.push("Max pain above spot — mild upward magnet");
  } else if (maxPain < chain.spot * 0.998) {
    score -= 0.15;
    signals.push("Max pain below spot — mild downward magnet");
  }

  // Scalp: liquidity gate (Stage 4) + call/put volume skew near ATM
  const lowLiquidityStrikes: number[] = [];
  if (mode === "SCALP") {
    const liq = assessScalpLiquidity(chain);
    lowLiquidityStrikes.push(...liq.lowLiquidityStrikes);
    if (liq.warning) signals.push(liq.warning);
    else signals.push(...liq.signals.slice(0, 1));

    // Momentum from call vs put volume near money
    let callVol = 0;
    let putVol = 0;
    for (const c of chain.contracts) {
      if (Math.abs(c.strike - chain.spot) / chain.spot > 0.015) continue;
      if (c.optionType === "CE") callVol += c.volume ?? 0;
      else putVol += c.volume ?? 0;
    }
    const flow = (callVol - putVol) / Math.max(1, callVol + putVol);
    score += flow * 0.35;
    signals.push(`Scalp call/put volume skew=${flow.toFixed(2)}`);
  }

  return {
    score: clampScore(score),
    signals,
    rawIndicators: {
      mode,
      spot: chain.spot,
      expiry: chain.expiry,
      pcr,
      maxPain,
      avgIv: iv,
      atmIv,
      ivLevel,
      ivTrend,
      support: buildup.support,
      resistance: buildup.resistance,
      lowLiquidityStrikes: [...new Set(lowLiquidityStrikes)],
      demo: chain.demo ?? false,
      contractCount: chain.contracts.length,
    },
    extras: {
      ivLevel,
      ivTrend,
      avgIv: iv,
      pcr,
      maxPain,
      lowLiquidityStrikes: [...new Set(lowLiquidityStrikes)],
    },
  };
}
