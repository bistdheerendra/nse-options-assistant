import {
  getUnderlyingCandles,
  isDemoMarketDataMode,
  isMarketDataUnavailable,
  type Underlying,
} from "@/lib/marketdata/angelone";
import {
  chartTfSpec,
  getPublicAnalysisCandles,
  isScalpChartTf,
  type ScalpChartTf,
} from "@/lib/marketdata/analysisCandles";
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

/**
 * GET /api/analysis/candles?underlying=NIFTY&mode=SCALP&tf=5m
 * Scalp tf: 3m | 5m | 15m (default 5m). Swing ignores tf → 1h.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ??
    "NIFTY") as Underlying;
  const modeParam = url.searchParams.get("mode") ?? "SCALP";
  const tfParam = url.searchParams.get("tf") ?? "5m";

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
  const scalpTf: ScalpChartTf =
    mode === "SCALP" && isScalpChartTf(tfParam) ? tfParam : "5m";
  const spec = chartTfSpec(mode, scalpTf);
  const demoMode = isDemoMarketDataMode();

  try {
    // Prefer Yahoo timed bars so chart OHLC aligns with dashboard live spot.
    const publicBars = await getPublicAnalysisCandles(
      underlying,
      mode,
      scalpTf,
    );
    if (publicBars && publicBars.length >= 8) {
      return NextResponse.json({
        ok: true,
        underlying,
        mode,
        tf: mode === "SCALP" ? scalpTf : "1h",
        interval: spec.angelInterval,
        timeframeLabel: spec.label,
        demoMode,
        source: "yahoo",
        fetchedAt: new Date().toISOString(),
        candles: dedupeSort(publicBars),
      });
    }

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
      `analysis-angel:${underlying}:${spec.angelInterval}`,
      15_000,
      () =>
        getUnderlyingCandles(
          underlying,
          spec.angelInterval,
          spec.lookbackDays,
        ),
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
    ).slice(-spec.maxBars);

    return NextResponse.json({
      ok: true,
      underlying,
      mode,
      tf: mode === "SCALP" ? scalpTf : "1h",
      interval: spec.angelInterval,
      timeframeLabel: spec.label,
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
