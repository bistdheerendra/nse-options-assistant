import { angelPost, isDemoMarketDataMode } from "./auth";
import { mockCandles } from "./mock";
import type { CandleInterval, OhlcvCandle, Underlying } from "./types";
import { UNDERLYING_META } from "./types";

function formatAngelDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function getHistoricalCandles(params: {
  exchange: string;
  symboltoken: string;
  interval: CandleInterval;
  from: Date;
  to: Date;
  underlyingHint?: Underlying;
}): Promise<OhlcvCandle[]> {
  if (isDemoMarketDataMode()) {
    const u = params.underlyingHint ?? "NIFTY";
    return mockCandles(u, params.interval);
  }

  const raw = await angelPost<Array<[string, number, number, number, number, number]>>(
    "/rest/secure/angelbroking/historical/v1/getCandleData",
    {
      exchange: params.exchange,
      symboltoken: params.symboltoken,
      interval: params.interval,
      fromdate: formatAngelDate(params.from),
      todate: formatAngelDate(params.to),
    },
  );

  return (raw ?? []).map((row) => ({
    time: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] ?? 0),
  }));
}

export async function getUnderlyingCandles(
  underlying: Underlying,
  interval: CandleInterval,
  lookbackDays = 30,
): Promise<OhlcvCandle[]> {
  const meta = UNDERLYING_META[underlying];
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return getHistoricalCandles({
    exchange: meta.exchange,
    symboltoken: meta.symboltoken,
    interval,
    from,
    to,
    underlyingHint: underlying,
  });
}
