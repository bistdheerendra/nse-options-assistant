import type { Underlying } from "@/lib/marketdata/angelone";
import {
  getCachedMacroQuotes,
  type MacroQuote,
} from "@/lib/marketdata/macroMarkets";
import { clampScore, type LaneResult, type TradingMode } from "./types";

export type { MacroQuote };

/**
 * Tunable v1 component weights (sum = 1.0).
 * Heuristic only — not a validated statistical edge. Easy to retune later.
 *
 * indiaVix:   risk-off gauge (rising / elevated VIX → bearish lean)
 * usdInr:     INR weakness historically associated with FII outflow pressure (heuristic, not gospel)
 * giftNifty:  pre-market premium/discount cue vs previous close
 * usOvernight: gap-risk from Dow / Nasdaq / S&P overnight close
 * crude:      rising oil historically inverse for Indian equities sentiment
 * dxy:        secondary FII-flow / EM headwind proxy
 */
export const MACRO_COMPONENT_WEIGHTS = {
  indiaVix: 0.28,
  usdInr: 0.18,
  giftNifty: 0.22,
  usOvernight: 0.18,
  crude: 0.08,
  dxy: 0.06,
} as const;

export type MacroComponentKey = keyof typeof MACRO_COMPONENT_WEIGHTS;

function byId(quotes: MacroQuote[], id: string): MacroQuote | undefined {
  return quotes.find((q) => q.id === id);
}

/**
 * Map a percent move into roughly [-1, 1] with soft saturation.
 * softCapPct ≈ the move that maps near ±0.76 (tanh(1)).
 */
function pctToUnit(changePct: number, softCapPct: number): number {
  // unit = tanh(changePct / softCapPct)
  return Math.tanh(changePct / softCapPct);
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export type MacroScoreInput = {
  quotes: MacroQuote[];
  mode?: TradingMode;
};

export type MacroScoreBreakdown = {
  components: Partial<Record<MacroComponentKey, number>>;
  weightsUsed: Partial<Record<MacroComponentKey, number>>;
};

/**
 * Pure scoring from already-fetched macro quotes (unit-testable, no I/O).
 * Missing quotes simply omit that component; weights of present components are re-normalized.
 */
export function scoreMacroQuotes(input: MacroScoreInput): LaneResult & {
  breakdown: MacroScoreBreakdown;
} {
  const { quotes } = input;
  const signals: string[] = [];
  const components: Partial<Record<MacroComponentKey, number>> = {};
  const rawIndicators: Record<string, unknown> = {
    heuristic: true,
    label: "experimental / rules-based macro lean — not a validated edge",
  };

  if (!quotes.length) {
    return {
      score: 0,
      signals: ["macro data unavailable"],
      rawIndicators: { ...rawIndicators, unavailable: true },
      breakdown: { components: {}, weightsUsed: {} },
    };
  }

  // --- India VIX: rising / elevated → risk-off (bearish) ---
  const vix = byId(quotes, "INDIAVIX");
  if (vix) {
    rawIndicators.indiaVix = {
      price: vix.price,
      changePct: vix.changePct,
      source: vix.source,
    };
    // Trend: +changePct → negative score. Soft-cap ~3% daily move.
    const trend = -pctToUnit(vix.changePct, 3);
    // Level: VIX > 20 risk-off, < 12 risk-on; mid band neutral.
    // levelScore = clamp((neutralMid - vix) / span) with mid≈16, span≈8 → ≈[-1,1]
    const level = clampScore((16 - vix.price) / 8);
    const vixScore = clampScore(0.65 * trend + 0.35 * level);
    components.indiaVix = vixScore;
    if (vix.changePct >= 3) {
      signals.push(`India VIX up ${fmtPct(vix.changePct)} — risk-off`);
    } else if (vix.changePct <= -3) {
      signals.push(`India VIX down ${fmtPct(vix.changePct)} — risk-on`);
    } else if (vix.price >= 20) {
      signals.push(`India VIX elevated at ${vix.price.toFixed(1)} — caution`);
    } else if (vix.price <= 12) {
      signals.push(`India VIX low at ${vix.price.toFixed(1)} — complacent / risk-on`);
    } else {
      signals.push(
        `India VIX ${vix.price.toFixed(1)} (${fmtPct(vix.changePct)}) — mixed`,
      );
    }
  }

  // --- USD/INR: rising (INR weaker) → historically bearish FII-flow pressure ---
  // Heuristic only — many regimes break this link; do not treat as gospel.
  const usdinr = byId(quotes, "USDINR");
  if (usdinr) {
    rawIndicators.usdInr = {
      price: usdinr.price,
      changePct: usdinr.changePct,
      source: usdinr.source,
    };
    // Soft-cap ~0.4% FX day-move is already meaningful for INR.
    components.usdInr = -pctToUnit(usdinr.changePct, 0.4);
    if (usdinr.changePct >= 0.15) {
      signals.push(
        `USD/INR up ${fmtPct(usdinr.changePct)} — INR weak / FII outflow pressure (heuristic)`,
      );
    } else if (usdinr.changePct <= -0.15) {
      signals.push(
        `USD/INR down ${fmtPct(usdinr.changePct)} — INR firm (heuristic tailwind)`,
      );
    }
  }

  // --- Gift Nifty premium/discount vs previous close ---
  const gift = byId(quotes, "GIFTNIFTY");
  if (gift) {
    rawIndicators.giftNifty = {
      price: gift.price,
      changePct: gift.changePct,
      source: gift.source,
      note: gift.note,
    };
    // Soft-cap ~0.6% pre-market cue.
    components.giftNifty = pctToUnit(gift.changePct, 0.6);
    if (gift.changePct >= 0.2) {
      signals.push(
        `Gift Nifty premium ${fmtPct(gift.changePct)} — bullish pre-open cue`,
      );
    } else if (gift.changePct <= -0.2) {
      signals.push(
        `Gift Nifty discount ${fmtPct(gift.changePct)} — bearish pre-open cue`,
      );
    } else {
      signals.push(`Gift Nifty flat ${fmtPct(gift.changePct)}`);
    }
  }

  // --- Overnight US close (avg of Dow / Nasdaq / S&P) ---
  const usIds = ["DJI", "IXIC", "GSPC"] as const;
  const usQuotes = usIds
    .map((id) => byId(quotes, id))
    .filter((q): q is MacroQuote => Boolean(q));
  if (usQuotes.length > 0) {
    const avgPct =
      usQuotes.reduce((s, q) => s + q.changePct, 0) / usQuotes.length;
    rawIndicators.usOvernight = {
      avgChangePct: avgPct,
      members: usQuotes.map((q) => ({
        id: q.id,
        changePct: q.changePct,
      })),
    };
    // Soft-cap ~1.0% US overnight move.
    components.usOvernight = pctToUnit(avgPct, 1);
    if (avgPct >= 0.4) {
      signals.push(
        `US overnight avg ${fmtPct(avgPct)} — positive gap-risk for India`,
      );
    } else if (avgPct <= -0.4) {
      signals.push(
        `US overnight avg ${fmtPct(avgPct)} — negative gap-risk for India`,
      );
    }
  }

  // --- Crude (WTI/Brent avg): rising oil → historically inverse for India ---
  const crudeQuotes = (["CL", "BZ"] as const)
    .map((id) => byId(quotes, id))
    .filter((q): q is MacroQuote => Boolean(q));
  if (crudeQuotes.length > 0) {
    const avgPct =
      crudeQuotes.reduce((s, q) => s + q.changePct, 0) / crudeQuotes.length;
    rawIndicators.crude = {
      avgChangePct: avgPct,
      members: crudeQuotes.map((q) => ({
        id: q.id,
        changePct: q.changePct,
      })),
    };
    // Inverse: +crude → bearish. Soft-cap ~2%.
    components.crude = -pctToUnit(avgPct, 2);
    if (avgPct >= 1) {
      signals.push(
        `Crude up ${fmtPct(avgPct)} — historically headwind for Indian equities`,
      );
    } else if (avgPct <= -1) {
      signals.push(
        `Crude down ${fmtPct(avgPct)} — historically supportive for Indian equities`,
      );
    }
  }

  // --- DXY: stronger dollar → secondary EM / FII headwind ---
  const dxy = byId(quotes, "DXY");
  if (dxy) {
    rawIndicators.dxy = {
      price: dxy.price,
      changePct: dxy.changePct,
      source: dxy.source,
    };
    components.dxy = -pctToUnit(dxy.changePct, 0.5);
    if (dxy.changePct >= 0.25) {
      signals.push(`DXY up ${fmtPct(dxy.changePct)} — stronger USD / EM headwind`);
    } else if (dxy.changePct <= -0.25) {
      signals.push(`DXY down ${fmtPct(dxy.changePct)} — softer USD / EM support`);
    }
  }

  const presentKeys = (
    Object.keys(components) as MacroComponentKey[]
  ).filter((k) => components[k] != null);

  if (presentKeys.length === 0) {
    return {
      score: 0,
      signals: ["macro data unavailable"],
      rawIndicators: { ...rawIndicators, unavailable: true },
      breakdown: { components: {}, weightsUsed: {} },
    };
  }

  // Re-normalize weights over present components so missing feeds don't bias to 0.
  let weightSum = 0;
  for (const k of presentKeys) weightSum += MACRO_COMPONENT_WEIGHTS[k];
  const weightsUsed: Partial<Record<MacroComponentKey, number>> = {};
  let combined = 0;
  for (const k of presentKeys) {
    const w = MACRO_COMPONENT_WEIGHTS[k] / weightSum;
    weightsUsed[k] = w;
    combined += w * (components[k] as number);
  }

  // Scalp: slightly dampen overnight / FX vs Gift+VIX (still same weight table, damp factor).
  // Swing keeps full combined as-is.
  let score = clampScore(combined);
  if (input.mode === "SCALP") {
    const giftVix =
      ((components.giftNifty ?? 0) * (weightsUsed.giftNifty ?? 0) +
        (components.indiaVix ?? 0) * (weightsUsed.indiaVix ?? 0)) /
      Math.max(
        (weightsUsed.giftNifty ?? 0) + (weightsUsed.indiaVix ?? 0),
        1e-9,
      );
    // score = 0.6 * combined + 0.4 * gift/vix lean
    score = clampScore(0.6 * combined + 0.4 * giftVix);
  }

  rawIndicators.components = components;
  rawIndicators.weightsUsed = weightsUsed;
  rawIndicators.combinedBeforeClamp = combined;

  if (signals.length === 0) {
    signals.push("Macro inputs mixed / near flat — no strong lean");
  }

  return {
    score,
    signals,
    rawIndicators,
    breakdown: { components, weightsUsed },
  };
}

/**
 * Live Macro lane — Stage 2.5a.
 * Reuses dashboard `getCachedMacroQuotes` (Yahoo / NSE VIX / Gift). Degrades to
 * score 0 + "macro data unavailable" on fetch failure — never throws.
 */
export async function runMacroLane(params: {
  underlying: Underlying;
  mode?: TradingMode;
}): Promise<LaneResult> {
  try {
    const quotes = await getCachedMacroQuotes();
    const { breakdown: _b, ...result } = scoreMacroQuotes({
      quotes,
      mode: params.mode,
    });
    return {
      ...result,
      rawIndicators: {
        ...result.rawIndicators,
        underlying: params.underlying,
        mode: params.mode ?? "SWING",
      },
    };
  } catch {
    return {
      score: 0,
      signals: ["macro data unavailable"],
      rawIndicators: {
        unavailable: true,
        heuristic: true,
        underlying: params.underlying,
        mode: params.mode ?? "SWING",
      },
    };
  }
}
