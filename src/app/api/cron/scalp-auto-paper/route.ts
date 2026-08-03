import { runScalpAutoPaper } from "@/lib/paperTrading/scalpAutoPaper";
import type { Underlying } from "@/lib/marketdata/angelone";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

/**
 * Paper-only auto open when scalp rule stack clears.
 * GET/POST /api/cron/scalp-auto-paper?underlying=NIFTY (optional)
 * Body/query: acknowledgeSellRisk=true for SELL/write autos.
 *
 * Never places Angel One orders.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  let acknowledgeSellRisk =
    url.searchParams.get("acknowledgeSellRisk") === "true" ||
    url.searchParams.get("ackSell") === "true";
  let underlyingParam = url.searchParams.get("underlying");

  if (req.method === "POST") {
    try {
      const body = (await req.json()) as {
        acknowledgeSellRisk?: boolean;
        underlying?: string;
        underlyings?: string[];
      };
      if (body.acknowledgeSellRisk) acknowledgeSellRisk = true;
      if (body.underlying) underlyingParam = body.underlying;
      if (body.underlyings?.length) {
        const list = body.underlyings.filter((u): u is Underlying =>
          UNDERLYINGS.includes(u as Underlying),
        );
        const result = await runScalpAutoPaper({
          underlyings: list.length ? list : undefined,
          acknowledgeSellRisk,
        });
        return NextResponse.json(result);
      }
    } catch {
      // empty body ok for cron POST
    }
  }

  const underlyings =
    underlyingParam && UNDERLYINGS.includes(underlyingParam as Underlying)
      ? [underlyingParam as Underlying]
      : undefined;

  const result = await runScalpAutoPaper({
    underlyings,
    acknowledgeSellRisk,
  });

  return NextResponse.json(result);
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
