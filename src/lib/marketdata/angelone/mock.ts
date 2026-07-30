import type { CandleInterval, OhlcvCandle, Underlying } from "./types";
import { UNDERLYING_META } from "./types";

function seeded(n: number): number {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

/** Deterministic demo series so lanes/UI work without Angel One credentials. */
export function mockCandles(
  underlying: Underlying,
  interval: CandleInterval,
  count = 220,
): OhlcvCandle[] {
  const base =
    underlying === "NIFTY" ? 24500 : underlying === "BANKNIFTY" ? 52000 : 80500;
  const stepMin =
    interval === "ONE_MINUTE"
      ? 1
      : interval === "THREE_MINUTE"
        ? 3
        : interval === "FIVE_MINUTE"
          ? 5
          : interval === "FIFTEEN_MINUTE"
            ? 15
            : interval === "ONE_HOUR"
              ? 60
              : 1440;
  const now = Date.now();
  const candles: OhlcvCandle[] = [];
  let price = base;
  for (let i = count; i >= 0; i--) {
    const t = new Date(now - i * stepMin * 60_000);
    const drift = (seeded(i + base) - 0.48) * (base * 0.0015);
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + Math.abs(drift) * 0.4;
    const low = Math.min(open, close) - Math.abs(drift) * 0.4;
    candles.push({
      time: t.toISOString().slice(0, 16).replace("T", " "),
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume: Math.floor(50_000 + seeded(i * 3) * 200_000),
    });
    price = close;
  }
  return candles;
}

export function mockLtp(underlying: Underlying) {
  const meta = UNDERLYING_META[underlying];
  const candles = mockCandles(underlying, "FIVE_MINUTE", 5);
  const last = candles[candles.length - 1]!;
  return {
    exchange: meta.exchange,
    tradingsymbol: meta.tradingsymbol,
    symboltoken: meta.symboltoken,
    ltp: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    close: last.close,
    demo: true as const,
  };
}

export function mockOptionChain(underlying: Underlying, expiry?: string) {
  const spot = mockLtp(underlying).ltp;
  const meta = UNDERLYING_META[underlying];
  const step = underlying === "NIFTY" ? 50 : underlying === "BANKNIFTY" ? 100 : 100;
  const atm = Math.round(spot / step) * step;
  const exp =
    expiry ??
    nextThursdayIso();
  const contracts = [];
  for (let i = -8; i <= 8; i++) {
    const strike = atm + i * step;
    const moneyness = (strike - spot) / spot;
    for (const optionType of ["CE", "PE"] as const) {
      const intrinsic =
        optionType === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
      const timeValue = spot * 0.01 * (1 - Math.abs(moneyness) * 8);
      const ltp = Math.max(0.05, intrinsic + Math.max(5, timeValue));
      const iv = 12 + Math.abs(moneyness) * 80 + (optionType === "PE" ? 1.5 : 0);
      const oi = Math.floor(100_000 + Math.abs(i) * 40_000 + seeded(strike) * 80_000);
      contracts.push({
        strike,
        optionType,
        tradingsymbol: `${underlying}${exp.replace(/-/g, "")}${strike}${optionType}`,
        symboltoken: String(100000 + strike + (optionType === "CE" ? 1 : 2)),
        ltp: round2(ltp),
        bid: round2(ltp * 0.98),
        ask: round2(ltp * 1.02),
        volume: Math.floor(oi * 0.05),
        oi,
        iv: round2(iv),
        lotSize: meta.lotSize,
        expiry: exp,
      });
    }
  }
  return { underlying, spot, expiry: exp, contracts, demo: true as const };
}

function nextThursdayIso(): string {
  const d = new Date();
  const day = d.getDay();
  const add = (4 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
