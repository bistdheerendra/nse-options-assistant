import type { Underlying } from "@/lib/marketdata/angelone";
import { getIndexHeatmap } from "@/lib/marketdata/indexHeatmap";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UNDERLYINGS = new Set<Underlying>(["NIFTY", "BANKNIFTY", "SENSEX"]);

/**
 * GET /api/analysis/heatmap?underlying=NIFTY
 * Major constituent day-% heatmap for Analysis (Yahoo free chart quotes).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ??
    "NIFTY") as Underlying;

  if (!UNDERLYINGS.has(underlying)) {
    return NextResponse.json(
      { ok: false, error: "underlying must be NIFTY | BANKNIFTY | SENSEX" },
      { status: 400 },
    );
  }

  try {
    const data = await getIndexHeatmap(underlying);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "heatmap failed",
        uiHint: "heatmap unavailable",
      },
      { status: 503 },
    );
  }
}
