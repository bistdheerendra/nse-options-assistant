import { fetchEconomicCalendar } from "@/lib/marketdata/economicCalendar";
import { getCachedMacroQuotes } from "@/lib/marketdata/macroMarkets";
import { getCachedMarketNews } from "@/lib/marketdata/marketNews";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CALENDAR_TTL_MS = 15 * 60_000;

export async function GET() {
  try {
    const [quotes, calendar, news] = await Promise.all([
      getCachedMacroQuotes(),
      withTtlCache("macro:calendar", CALENDAR_TTL_MS, fetchEconomicCalendar),
      getCachedMarketNews(12),
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
