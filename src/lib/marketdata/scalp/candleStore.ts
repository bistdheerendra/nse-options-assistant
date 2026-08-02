import { hasDatabase, prisma } from "@/lib/prisma";
import type { OhlcvCandle, Underlying } from "@/lib/marketdata/angelone";
import type { ScalpTimeframe } from "./types";

function parseCandleTime(time: string): Date {
  // Angel: "2023-09-06T11:15:00+05:30" or mock "2023-09-06 11:15"
  const normalized = time.includes("T") ? time : time.replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid candle time: ${time}`);
  }
  return d;
}

function toOhlcv(row: {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): OhlcvCandle {
  return {
    time: row.time.toISOString(),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}

/**
 * Upsert a batch of candles. Idempotent on (underlying, interval, time).
 * No-ops when DATABASE_URL is unset (demo / local without Postgres).
 */
export async function upsertMarketCandles(params: {
  underlying: Underlying;
  interval: ScalpTimeframe;
  candles: OhlcvCandle[];
  source: "angel" | "demo";
}): Promise<number> {
  if (!hasDatabase() || !prisma || params.candles.length === 0) return 0;

  let written = 0;
  // Chunk to avoid oversized transactions on 1m lookbacks.
  const chunkSize = 100;
  for (let i = 0; i < params.candles.length; i += chunkSize) {
    const chunk = params.candles.slice(i, i + chunkSize);
    await prisma.$transaction(
      chunk.map((c) => {
        const time = parseCandleTime(c.time);
        return prisma!.marketCandle.upsert({
          where: {
            underlying_interval_time: {
              underlying: params.underlying,
              interval: params.interval,
              time,
            },
          },
          create: {
            underlying: params.underlying,
            interval: params.interval,
            time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            source: params.source,
          },
          update: {
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            source: params.source,
            fetchedAt: new Date(),
          },
        });
      }),
    );
    written += chunk.length;
  }
  return written;
}

/**
 * Read latest stored candles for one timeframe (newest last).
 * Returns [] when DB unavailable or empty.
 */
export async function readStoredCandles(
  underlying: Underlying,
  interval: ScalpTimeframe,
  limit = 500,
): Promise<OhlcvCandle[]> {
  if (!hasDatabase() || !prisma) return [];

  const rows = await prisma.marketCandle.findMany({
    where: { underlying, interval },
    orderBy: { time: "desc" },
    take: limit,
  });

  return rows.reverse().map(toOhlcv);
}
