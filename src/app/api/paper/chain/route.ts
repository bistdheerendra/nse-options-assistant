import { getOptionChain, type Underlying } from "@/lib/marketdata/angelone";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ?? "NIFTY") as Underlying;
  try {
    const chain = await getOptionChain(
      underlying,
      url.searchParams.get("expiry") ?? undefined,
    );
    return NextResponse.json(chain);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Option chain unavailable",
        uiHint: "market data unavailable",
      },
      { status: 503 },
    );
  }
}
