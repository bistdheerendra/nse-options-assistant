import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  isMarketDataUnavailable,
  type CandleInterval,
  type Underlying,
} from "@/lib/marketdata/angelone";
import { getPublicAnalysisCandles } from "@/lib/marketdata/analysisCandles";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UNDERLYINGS = new Set<Underlying>(["NIFTY", "BANKNIFTY", "SENSEX"]);

/** Angel times are IST wall-clock without TZ → unix seconds. */
function angelTimeToUnixSec(time: string): number {
  const normalized = time.includes("T") ? time : time.replace(" ", "T");
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const ms = Date.parse(hasTz ? normalized : `${normalized}+05:30`);
  return Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000);
}

function intervalForMode(mode: string): {
  interval: CandleInterval;
  lookbackDays: number;
  label: string;
} {
  if (mode === "SCALP") {
    return { interval: "FIVE_MINUTE", lookbackDays: 5, label: "5m" };
  }
  return { interval: "ONE_HOUR", lookbackDays: 60, label: "1h" };
}

function dedupeSort(
  bars: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
) {
  return bars
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1]!.time);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ??
    "NIFTY") as Underlying;
  const modeParam = url.searchParams.get("mode") ?? "SCALP";

  if (!UNDERLYINGS.has(underlying)) {
    return NextResponse.json(
      { ok: false, error: "underlying must be NIFTY | BANKNIFTY | SENSEX" },
      { status: 400 },
    );
  }
  if (modeParam !== "SCALP" && modeParam !== "SWING") {
    return NextResponse.json(
      { ok: false, error: "mode must be SCALP | SWING" },
      { status: 400 },
    );
  }
  const mode = modeParam;
  const { interval, lookbackDays, label } = intervalForMode(mode);
  const demoMode = isDemoMarketDataMode();

  try {
    // Prefer Yahoo timed bars so chart OHLC aligns with dashboard live spot.
    // Angel mock + live NSE LTP was painting a fake crash on the last candle.
    const publicBars = await getPublicAnalysisCandles(underlying, mode);
    if (publicBars && publicBars.length >= 8) {
      return NextResponse.json({
        ok: true,
        underlying,
        mode,
        interval,
        timeframeLabel: label,
        demoMode,
        source: "yahoo",
        fetchedAt: new Date().toISOString(),
        candles: dedupeSort(publicBars),
      });
    }

    // Live Angel path (or Yahoo down) — skip Angel mocks in demo (wrong price level).
    if (demoMode) {
      return NextResponse.json(
        {
          ok: false,
          error: "Public candle feed unavailable",
          uiHint: "market data unavailable",
        },
        { status: 503 },
      );
    }

    const candles = await withTtlCache(
      `analysis-angel:${underlying}:${interval}`,
      15_000,
      () => getUnderlyingCandles(underlying, interval, lookbackDays),
    );

    const bars = dedupeSort(
      candles.map((c) => ({
        time: angelTimeToUnixSec(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );

    return NextResponse.json({
      ok: true,
      underlying,
      mode,
      interval,
      timeframeLabel: label,
      demoMode: false,
      source: "angel",
      fetchedAt: new Date().toISOString(),
      candles: bars,
    });
  } catch (err) {
    if (isMarketDataUnavailable(err)) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          code: err.code,
          uiHint: "market data unavailable",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
