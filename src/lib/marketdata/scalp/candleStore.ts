import { hasDatabase, prisma } from "@/lib/prisma";
import type { OhlcvCandle, Underlying } from "@/lib/marketdata/angelone";
import type { ScalpTimeframe } from "./types";

/** Forming + recently closed bars that can still revise OHLCV after insert. */
const TIP_BARS = 5;

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

type ParsedCandle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Persist candles with minimal Postgres egress.
 *
 * - Historical bars: createMany + skipDuplicates (response is a count only —
 *   no RETURNING * payloads).
 * - Tip bars (last TIP_BARS): upsert with select:{ id } so forming OHLCV can
 *   revise without shipping full rows back to the app.
 *
 * Idempotent on (underlying, interval, time). No-ops when DATABASE_URL unset.
 */
export async function upsertMarketCandles(params: {
  underlying: Underlying;
  interval: ScalpTimeframe;
  candles: OhlcvCandle[];
  source: "angel" | "demo";
}): Promise<number> {
  if (!hasDatabase() || !prisma || params.candles.length === 0) return 0;

  const parsed: ParsedCandle[] = params.candles.map((c) => ({
    time: parseCandleTime(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const tipStart = Math.max(0, parsed.length - TIP_BARS);
  const historical = parsed.slice(0, tipStart);
  const tip = parsed.slice(tipStart);

  let written = 0;
  const chunkSize = 100;

  for (let i = 0; i < historical.length; i += chunkSize) {
    const chunk = historical.slice(i, i + chunkSize);
    const result = await prisma.marketCandle.createMany({
      data: chunk.map((c) => ({
        underlying: params.underlying,
        interval: params.interval,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: params.source,
      })),
      skipDuplicates: true,
    });
    written += result.count;
  }

  for (const c of tip) {
    await prisma.marketCandle.upsert({
      where: {
        underlying_interval_time: {
          underlying: params.underlying,
          interval: params.interval,
          time: c.time,
        },
      },
      create: {
        underlying: params.underlying,
        interval: params.interval,
        time: c.time,
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
      // Egress: never RETURNING full OHLCV rows on every tip write.
      select: { id: true },
    });
    written += 1;
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
    // OHLCV only — skip id/source/fetchedAt on the wire.
    select: {
      time: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  return rows.reverse().map(toOhlcv);
}
