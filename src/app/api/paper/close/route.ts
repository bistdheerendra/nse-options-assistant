import { closePaperTrade, portfolioSummary } from "@/lib/paperTrading/account";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();
  const account = await closePaperTrade({
    positionId: String(body.positionId),
    exitPremium: Number(body.exitPremium),
  });
  return NextResponse.json({
    account,
    summary: portfolioSummary(account, {}),
    note: "Paper close only — no broker order.",
  });
}
