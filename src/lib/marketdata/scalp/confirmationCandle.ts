import type { OhlcvCandle } from "@/lib/marketdata/angelone";
import type { ScalpTimeframe } from "./types";
import type { TimeframePriceAction } from "./priceAction";
import type { VolumeConfirmation } from "./volume";

/**
 * Scalp Stage 7 — confirmation candle (entry trigger gate).
 *
 * Deliberate lag-for-safety: a Stage 2–6 directional lean must NOT become an
 * actionable alert until the **next closed candle** confirms.
 *
 * Default rule (configurable via CONFIRMATION_RULE / env overrides):
 *   triggerTimeframe = FIVE_MINUTE  (primary scalp chart TF)
 *   requireCloseBeyondTrigger = true
 *     Bullish: confirm candle close > max(pattern high, prior close)
 *              where pattern high = signal candle high (engulfing/hammer body top proxy)
 *     Bearish: confirm candle close < min(pattern low, prior close)
 *   requireRisingVolume = true
 *     confirm.volume > signal.volume
 *   status:
 *     pending   — signal present on bar[-2], waiting for bar[-1] to close confirm
 *     confirmed — bar[-1] closed beyond trigger on rising volume
 *     failed    — bar[-1] closed without meeting rule
 *     none      — no directional signal to confirm
 *
 * IMPORTANT: "confirmed" only means the candle-rule passed — it is NOT a
 * validated statistical edge. UI must keep the heuristic / experimental label.
 */

export type ConfirmationRuleConfig = {
  /** Which TF's last two closed bars drive the gate. */
  triggerTimeframe: ScalpTimeframe;
  requireCloseBeyondTrigger: boolean;
  requireRisingVolume: boolean;
  /** Optional: min body/range on confirm candle (0 = off). */
  minConfirmBodyRatio: number;
};

/** Defaults — overridable via env (see loadConfirmationRuleConfig). */
export const DEFAULT_CONFIRMATION_RULE: ConfirmationRuleConfig = {
  triggerTimeframe: "FIVE_MINUTE",
  requireCloseBeyondTrigger: true,
  requireRisingVolume: true,
  minConfirmBodyRatio: 0,
};

export function loadConfirmationRuleConfig(
  overrides?: Partial<ConfirmationRuleConfig>,
): ConfirmationRuleConfig {
  const envTf = process.env.SCALP_CONFIRM_TIMEFRAME as ScalpTimeframe | undefined;
  const base: ConfirmationRuleConfig = {
    ...DEFAULT_CONFIRMATION_RULE,
    triggerTimeframe:
      envTf === "ONE_MINUTE" ||
      envTf === "THREE_MINUTE" ||
      envTf === "FIVE_MINUTE" ||
      envTf === "FIFTEEN_MINUTE"
        ? envTf
        : DEFAULT_CONFIRMATION_RULE.triggerTimeframe,
    requireCloseBeyondTrigger:
      process.env.SCALP_CONFIRM_CLOSE_BEYOND === "false"
        ? false
        : DEFAULT_CONFIRMATION_RULE.requireCloseBeyondTrigger,
    requireRisingVolume:
      process.env.SCALP_CONFIRM_RISING_VOLUME === "false"
        ? false
        : DEFAULT_CONFIRMATION_RULE.requireRisingVolume,
    minConfirmBodyRatio: Number.isFinite(
      Number(process.env.SCALP_CONFIRM_MIN_BODY_RATIO),
    )
      ? Number(process.env.SCALP_CONFIRM_MIN_BODY_RATIO)
      : DEFAULT_CONFIRMATION_RULE.minConfirmBodyRatio,
  };
  return { ...base, ...overrides };
}

export type ConfirmationStatus = "pending" | "confirmed" | "failed" | "none";

export type ConfirmationCandleResult = {
  status: ConfirmationStatus;
  rule: ConfirmationRuleConfig;
  direction: "bullish" | "bearish" | null;
  triggerLevel: number | null;
  signalBar: {
    time: string;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
  confirmBar: {
    time: string;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
  /** Why confirmed / failed / pending — auditable. */
  reason: string;
  /** Heuristic only — never imply backtested reliability. */
  reliabilityNote: string;
};

const RELIABILITY_NOTE =
  "Confirmation-candle rule is a lag-for-safety heuristic — not a validated edge. 'Confirmed' means the rule passed, not that the setup has proven expectancy.";

function signalDirection(
  pa: TimeframePriceAction | undefined,
  vol: VolumeConfirmation | undefined,
): "bullish" | "bearish" | null {
  if (!pa) return null;
  // Weak volume disqualify → no actionable signal to confirm
  if (vol?.role === "disqualify") return null;

  const bullPattern =
    pa.primaryPattern === "bullish_engulfing" ||
    pa.primaryPattern === "hammer";
  const bearPattern =
    pa.primaryPattern === "bearish_engulfing" ||
    pa.primaryPattern === "shooting_star";

  if (bullPattern && pa.structureBias !== "bearish") return "bullish";
  if (bearPattern && pa.structureBias !== "bullish") return "bearish";

  if (pa.structureBias === "bullish" && pa.candleDirection === 1) return "bullish";
  if (pa.structureBias === "bearish" && pa.candleDirection === -1) return "bearish";
  return null;
}

/**
 * Evaluate confirmation using the last two **closed** bars of `candles`.
 * Convention: candles[n-1] = most recent closed (confirm candidate),
 *             candles[n-2] = signal bar.
 * Callers should pass series that exclude a still-forming live bar when possible.
 */
export function evaluateConfirmationCandle(params: {
  candles: OhlcvCandle[];
  priceAction?: TimeframePriceAction;
  volumeConfirmation?: VolumeConfirmation;
  rule?: Partial<ConfirmationRuleConfig>;
}): ConfirmationCandleResult {
  const rule = loadConfirmationRuleConfig(params.rule);
  const direction = signalDirection(
    params.priceAction,
    params.volumeConfirmation,
  );

  if (!direction) {
    return {
      status: "none",
      rule,
      direction: null,
      triggerLevel: null,
      signalBar: null,
      confirmBar: null,
      reason: "No directional scalp signal to confirm on trigger timeframe",
      reliabilityNote: RELIABILITY_NOTE,
    };
  }

  if (params.candles.length < 2) {
    return {
      status: "pending",
      rule,
      direction,
      triggerLevel: null,
      signalBar: null,
      confirmBar: null,
      reason: "Insufficient closed candles — waiting for signal + confirm bars",
      reliabilityNote: RELIABILITY_NOTE,
    };
  }

  const signal = params.candles[params.candles.length - 2]!;
  const confirm = params.candles[params.candles.length - 1]!;

  // Bullish trigger = signal bar high; bearish = signal bar low
  const triggerLevel = direction === "bullish" ? signal.high : signal.low;

  const signalBar = {
    time: signal.time,
    high: signal.high,
    low: signal.low,
    close: signal.close,
    volume: signal.volume,
  };
  const confirmBar = {
    time: confirm.time,
    high: confirm.high,
    low: confirm.low,
    close: confirm.close,
    volume: confirm.volume,
  };

  const beyond =
    direction === "bullish"
      ? confirm.close > triggerLevel
      : confirm.close < triggerLevel;
  const risingVol = confirm.volume > signal.volume;
  const bodyRatio =
    Math.abs(confirm.close - confirm.open) /
    Math.max(confirm.high - confirm.low, 1e-9);
  const bodyOk = bodyRatio >= rule.minConfirmBodyRatio;

  const closeOk = !rule.requireCloseBeyondTrigger || beyond;
  const volOk = !rule.requireRisingVolume || risingVol;

  if (closeOk && volOk && bodyOk) {
    return {
      status: "confirmed",
      rule,
      direction,
      triggerLevel,
      signalBar,
      confirmBar,
      reason:
        `Confirm bar closed ${direction === "bullish" ? "above" : "below"} trigger ${triggerLevel}` +
        (rule.requireRisingVolume ? " on rising volume" : "") +
        " — rule pass (heuristic only)",
      reliabilityNote: RELIABILITY_NOTE,
    };
  }

  // If the confirm bar exists but failed conditions → failed (not still pending)
  const failBits: string[] = [];
  if (rule.requireCloseBeyondTrigger && !beyond) {
    failBits.push(
      `close ${confirm.close} did not breach trigger ${triggerLevel}`,
    );
  }
  if (rule.requireRisingVolume && !risingVol) {
    failBits.push(
      `volume ${confirm.volume} ≤ signal volume ${signal.volume}`,
    );
  }
  if (!bodyOk) {
    failBits.push(
      `body/range ${bodyRatio.toFixed(2)} < min ${rule.minConfirmBodyRatio}`,
    );
  }

  return {
    status: "failed",
    rule,
    direction,
    triggerLevel,
    signalBar,
    confirmBar,
    reason: `Confirmation failed: ${failBits.join("; ")}`,
    reliabilityNote: RELIABILITY_NOTE,
  };
}
