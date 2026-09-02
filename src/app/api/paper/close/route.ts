import { closePaperTrade, closePositionsOnTpSl } from "@/lib/paperTrading/account";
import type { CloseReason } from "@/lib/paperTrading/pnl";
import { paperTiming } from "@/lib/paperTrading/timing";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tReq = Date.now();
  const body = await req.json();
  paperTiming("api/paper/close POST.parseBody", tReq);

  // Batch TP/SL check: { marks: { [tradingSymbol]: ltp } }
  if (body.marks && typeof body.marks === "object") {
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.marks as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) marks[k] = n;
    }
    const result = await closePositionsOnTpSl(marks);
    paperTiming("api/paper/close POST.tpSl", tReq, `closed=${result.closed.length}`);
    return NextResponse.json({
      closed: result.closed,
      cashBalance: result.cashBalance,
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

  const tClose = Date.now();
  const result = await closePaperTrade({
    positionId: String(body.positionId),
    exitPremium: Number(body.exitPremium),
    closeReason,
  });
  paperTiming("api/paper/close POST.closePaperTrade", tClose);
  paperTiming("api/paper/close POST.total", tReq);
  return NextResponse.json({
    position: result.position,
    cashBalance: result.cashBalance,
    accountId: result.accountId,
    executedAt: result.position.closedAt,
    note: "Paper close only — no broker order.",
  });
}
