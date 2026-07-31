import { fetchEconomicCalendar } from "@/lib/marketdata/economicCalendar";
import { fetchMacroMarketQuotes } from "@/lib/marketdata/macroMarkets";
import { fetchMarketNews } from "@/lib/marketdata/marketNews";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const QUOTE_TTL_MS = 12_000;
const CALENDAR_TTL_MS = 15 * 60_000;
const NEWS_TTL_MS = 5 * 60_000;

export async function GET() {
  try {
    const [quotes, calendar, news] = await Promise.all([
      withTtlCache("macro:quotes", QUOTE_TTL_MS, fetchMacroMarketQuotes),
      withTtlCache("macro:calendar", CALENDAR_TTL_MS, fetchEconomicCalendar),
      withTtlCache("macro:news", NEWS_TTL_MS, () => fetchMarketNews(12)),
    ]);

    return NextResponse.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      quotes,
      calendar,
      news,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
        uiHint: "macro market data unavailable",
      },
      { status: 503 },
    );
  }
}
