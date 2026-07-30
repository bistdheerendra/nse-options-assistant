import {
  getOrCreateAccount,
  openPaperTrade,
  portfolioSummary,
} from "@/lib/paperTrading/account";
import { theoreticalMaxLossSell } from "@/lib/paperTrading/pnl";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = await getOrCreateAccount();
  const summary = portfolioSummary(account, {});
  return NextResponse.json({ account, summary });
}

export async function POST(req: Request) {
  const body = await req.json();
  const action = body.action as "BUY" | "SELL";
  const optionType = body.optionType as "CE" | "PE";

  const risk = theoreticalMaxLossSell({
    action,
    optionType,
    strike: Number(body.strike),
    entryPremium: Number(body.entryPremium),
    lotSize: Number(body.lotSize),
    lots: Number(body.lots),
  });

  if (action === "SELL" && !body.acknowledgeSellRisk) {
    return NextResponse.json(
      {
        error: "Sell/write requires acknowledgeSellRisk=true",
        risk,
      },
      { status: 400 },
    );
  }

  const account = await openPaperTrade({
    underlying: String(body.underlying),
    strike: Number(body.strike),
    optionType,
    expiry: String(body.expiry),
    action,
    lotSize: Number(body.lotSize),
    lots: Number(body.lots),
    entryPremium: Number(body.entryPremium),
    mode: body.mode === "SCALP" ? "SCALP" : "SWING",
    symbolToken: body.symbolToken,
    tradingSymbol: body.tradingSymbol,
    entrySnapshot: { risk },
  });

  return NextResponse.json({
    account,
    summary: portfolioSummary(account, {}),
    risk,
    note: "Paper trade only — no Angel One order was placed.",
  });
}
