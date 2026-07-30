import { isMarketDataUnavailable } from "@/lib/marketdata/angelone";
import type { Underlying } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import { runSynthesis } from "@/lib/synthesis";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ?? "NIFTY") as Underlying;
  const mode = (url.searchParams.get("mode") ?? "SWING") as TradingMode;

  if (!["NIFTY", "BANKNIFTY", "SENSEX"].includes(underlying)) {
    return NextResponse.json({ error: "Invalid underlying" }, { status: 400 });
  }
  if (!["SCALP", "SWING"].includes(mode)) {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  try {
    const result = await runSynthesis({ underlying, mode, persist: true });
    return NextResponse.json(result);
  } catch (err) {
    if (isMarketDataUnavailable(err)) {
      return NextResponse.json(
        { error: err.message, code: err.code, uiHint: "market data unavailable" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    underlying?: Underlying;
    mode?: TradingMode;
    expiry?: string;
  };
  return GET(
    new Request(
      `${new URL(req.url).origin}/api/synthesis?underlying=${body.underlying ?? "NIFTY"}&mode=${body.mode ?? "SWING"}`,
    ),
  );
}
