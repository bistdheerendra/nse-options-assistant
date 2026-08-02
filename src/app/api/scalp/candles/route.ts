import { NextResponse } from "next/server";
import {
  analyzeMultiTimeframePriceAction,
  analyzeMultiTimeframeVolume,
  getMultiTimeframeCandles,
  isScalpTimeframe,
  type ScalpTimeframe,
} from "@/lib/marketdata/scalp";
import type { Underlying } from "@/lib/marketdata/angelone";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

/**
 * GET /api/scalp/candles?underlying=NIFTY[&interval=…][&priceAction=1][&volume=1]
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get("underlying") ?? "NIFTY").toUpperCase();
  const intervalParam = searchParams.get("interval");
  const withPriceAction =
    searchParams.get("priceAction") === "1" ||
    searchParams.get("priceAction") === "true";
  const withVolume =
    searchParams.get("volume") === "1" || searchParams.get("volume") === "true";

  if (!UNDERLYINGS.includes(underlying as Underlying)) {
    return NextResponse.json(
      {
        ok: false,
        error: `underlying must be one of ${UNDERLYINGS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (intervalParam && !isScalpTimeframe(intervalParam)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "interval must be ONE_MINUTE | THREE_MINUTE | FIVE_MINUTE | FIFTEEN_MINUTE",
      },
      { status: 400 },
    );
  }

  try {
    const bundle = await getMultiTimeframeCandles(underlying as Underlying);
    const priceAction =
      withPriceAction || withVolume
        ? analyzeMultiTimeframePriceAction({
            underlying: bundle.underlying,
            series: bundle.series,
          })
        : undefined;
    const volume = withVolume
      ? analyzeMultiTimeframeVolume({
          underlying: bundle.underlying,
          series: bundle.series,
          priceAction: priceAction?.byTimeframe,
        })
      : undefined;

    if (intervalParam) {
      const tf = intervalParam as ScalpTimeframe;
      const series = bundle.series[tf];
      return NextResponse.json({
        ok: true,
        underlying: bundle.underlying,
        interval: tf,
        lookbackDays: series.lookbackDays,
        source: series.source,
        candleCount: series.candles.length,
        candles: series.candles,
        degraded: bundle.degraded,
        degradeReasons: bundle.degradeReasons,
        fetchedAt: series.fetchedAt,
        priceAction: withPriceAction
          ? priceAction?.byTimeframe[tf]
          : undefined,
        volume: volume
          ? {
              analysis: volume.byTimeframe[tf],
              confirmation: volume.confirmations[tf],
            }
          : undefined,
      });
    }

    const summary = Object.fromEntries(
      Object.entries(bundle.series).map(([k, v]) => [
        k,
        {
          lookbackDays: v.lookbackDays,
          source: v.source,
          candleCount: v.candles.length,
          lastClose: v.candles[v.candles.length - 1]?.close ?? null,
          fetchedAt: v.fetchedAt,
        },
      ]),
    );

    return NextResponse.json({
      ok: true,
      underlying: bundle.underlying,
      degraded: bundle.degraded,
      degradeReasons: bundle.degradeReasons,
      fetchedAt: bundle.fetchedAt,
      timeframes: summary,
      series: bundle.series,
      priceAction: withPriceAction ? priceAction : undefined,
      volume,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "scalp candles failed",
        uiHint: "market data unavailable",
      },
      { status: 503 },
    );
  }
}
