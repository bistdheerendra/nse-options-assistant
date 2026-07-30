import { getDashboardQuotes, isMarketDataUnavailable } from "@/lib/marketdata/angelone";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDashboardQuotes();
    return NextResponse.json({ ok: true, ...data });
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
