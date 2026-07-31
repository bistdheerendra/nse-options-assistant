import type { OhlcvCandle } from "@/lib/marketdata/angelone";

/**
 * True Range: TR_t = max(high−low, |high−prevClose|, |low−prevClose|)
 * ATR_n = Wilder smooth of TR over `period` bars
 *   ATR_t = (ATR_{t−1} * (period−1) + TR_t) / period
 */
export function calcAtr(candles: OhlcvCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i]!;
  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}
