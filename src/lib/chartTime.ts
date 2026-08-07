import type { UTCTimestamp } from "lightweight-charts";

/**
 * lightweight-charts treats every unix second as a UTC wall-clock label
 * (no native timezone). NSE session times are Asia/Kolkata (IST, UTC+5:30,
 * no DST) — shift so axis / crosshair show IST.
 *
 * chartTime = trueUtcUnix + IST_OFFSET_SEC
 * @see https://tradingview.github.io/lightweight-charts/docs/time-zones
 */
export const IST_OFFSET_SEC = 5 * 3600 + 30 * 60; // 19_800

/** True UTC unix seconds → chart time that renders as IST wall-clock. */
export function toIstChartTime(utcUnixSec: number): UTCTimestamp {
  return (utcUnixSec + IST_OFFSET_SEC) as UTCTimestamp;
}
