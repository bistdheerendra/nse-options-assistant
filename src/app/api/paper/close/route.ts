import {
  closePaperTrade,
  closePositionsOnTpSl,
  getOrCreateAccount,
  portfolioSummary,
} from "@/lib/paperTrading/account";
import type { CloseReason } from "@/lib/paperTrading/pnl";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json();

  // Batch TP/SL check: { marks: { [tradingSymbol]: ltp } }
  if (body.marks && typeof body.marks === "object") {
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.marks as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) marks[k] = n;
    }
    const result = await closePositionsOnTpSl(marks);
    const account = await getOrCreateAccount();
    return NextResponse.json({
      account,
      summary: portfolioSummary(account, marks),
      closed: result.closed,
      note:
        result.closed.length > 0
          ? `Auto-closed ${result.closed.length} position(s) on TP/SL (paper only).`
          : "No TP/SL hits.",
    });
  }

  const reasonRaw = String(body.closeReason ?? "MANUAL").toUpperCase();
  const closeReason: CloseReason =
    reasonRaw === "TP" || reasonRaw === "SL" || reasonRaw === "EXPIRED"
      ? reasonRaw
      : "MANUAL";

  const account = await closePaperTrade({
    positionId: String(body.positionId),
    exitPremium: Number(body.exitPremium),
    closeReason,
  });
  return NextResponse.json({
    account,
    summary: portfolioSummary(account, {}),
    note: "Paper close only — no broker order.",
  });
}
