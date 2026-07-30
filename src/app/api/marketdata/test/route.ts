import {
  getHistoricalCandles,
  getLiveQuotes,
  getOptionChain,
  getUnderlyingCandles,
  isDemoMarketDataMode,
  isMarketDataUnavailable,
  UNDERLYING_META,
  type Underlying,
} from "@/lib/marketdata/angelone";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const underlying: Underlying = "NIFTY";
  const meta = UNDERLYING_META[underlying];

  try {
    const quotes = await getLiveQuotes({ underlyings: ["NIFTY", "BANKNIFTY", "SENSEX"] });
    const candles = await getUnderlyingCandles(underlying, "FIFTEEN_MINUTE", 5);
    const to = new Date();
    const from = new Date(to.getTime() - 2 * 24 * 60 * 60 * 1000);
    const rawCandles = await getHistoricalCandles({
      exchange: meta.exchange,
      symboltoken: meta.symboltoken,
      interval: "ONE_HOUR",
      from,
      to,
      underlyingHint: underlying,
    });
    const chain = await getOptionChain(underlying);

    return NextResponse.json({
      ok: true,
      demoMode: isDemoMarketDataMode(),
      note: isDemoMarketDataMode()
        ? "MARKETDATA_DEMO_MODE or missing Angel One credentials — results are labeled mocks."
        : "Live Angel One SmartAPI responses.",
      quotes,
      candlesPreview: candles.slice(-5),
      historicalPreview: rawCandles.slice(-5),
      optionChain: {
        underlying: chain.underlying,
        spot: chain.spot,
        expiry: chain.expiry,
        contractCount: chain.contracts.length,
        sample: chain.contracts.slice(0, 8),
        demo: chain.demo ?? false,
      },
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
