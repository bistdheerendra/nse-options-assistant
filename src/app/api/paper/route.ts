import {
  getOrCreateAccount,
  openPaperTrade,
  portfolioSummary,
} from "@/lib/paperTrading/account";
import { fetchPositionMarks } from "@/lib/paperTrading/fetchPositionMarks";
import { theoreticalMaxLossSell } from "@/lib/paperTrading/pnl";
import { paperTiming } from "@/lib/paperTrading/timing";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const tReq = Date.now();
  try {
    const account = await getOrCreateAccount();
    paperTiming(
      "api/paper GET.getOrCreateAccount",
      tReq,
      `positions=${account.positions.length}`,
    );
    let marks: Record<string, number> = {};
    const open = account.positions.filter((p) => p.status === "OPEN");
    if (open.length) {
      try {
        marks = await withTtlCache("paper-position-marks", 2_000, () =>
          fetchPositionMarks(open),
        );
      } catch (err) {
        console.warn(
          "[api/paper GET] position marks unavailable",
          err instanceof Error ? err.message : err,
        );
      }
    }
    const summary = portfolioSummary(account, marks);
    paperTiming("api/paper GET.total", tReq);
    return NextResponse.json({ account, summary, marks });
  } catch (err) {
    console.error("[api/paper GET]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Paper account unavailable",
        uiHint: "paper account unavailable — retry shortly",
      },
      { status: 503 },
    );
  }
}

export async function POST(req: Request) {
  const tReq = Date.now();
  try {
    const body = await req.json();
    paperTiming("api/paper POST.parseBody", tReq);
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

    const stopLoss =
      body.stopLoss != null && Number.isFinite(Number(body.stopLoss))
        ? Number(body.stopLoss)
        : undefined;
    const takeProfit =
      body.takeProfit != null && Number.isFinite(Number(body.takeProfit))
        ? Number(body.takeProfit)
        : undefined;

    const entrySpotAtSignal =
      body.entrySpotAtSignal != null &&
      Number.isFinite(Number(body.entrySpotAtSignal))
        ? Number(body.entrySpotAtSignal)
        : undefined;
    const stopLossSpot =
      body.stopLossSpot != null && Number.isFinite(Number(body.stopLossSpot))
        ? Number(body.stopLossSpot)
        : undefined;
    const tp1Spot =
      body.tp1Spot != null && Number.isFinite(Number(body.tp1Spot))
        ? Number(body.tp1Spot)
        : undefined;
    const tp2Spot =
      body.tp2Spot != null && Number.isFinite(Number(body.tp2Spot))
        ? Number(body.tp2Spot)
        : undefined;
    const delta =
      body.delta != null && Number.isFinite(Number(body.delta))
        ? Number(body.delta)
        : undefined;

    const spotLevels =
      entrySpotAtSignal != null && stopLossSpot != null && tp1Spot != null
        ? {
            entrySpotAtSignal,
            stopLossSpot,
            tp1Spot,
            tp2Spot: tp2Spot ?? null,
            delta: delta ?? null,
          }
        : null;

    const tOpen = Date.now();
    const result = await openPaperTrade({
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
      entrySnapshot: {
        risk,
        ...(body.tradeIdeaId ? { tradeIdeaId: body.tradeIdeaId } : {}),
        ...(body.premiumSource ? { premiumSource: body.premiumSource } : {}),
        ...(body.premiumCapturedAt
          ? { premiumCapturedAt: body.premiumCapturedAt }
          : {}),
      },
      stopLoss,
      takeProfit,
      spotLevels,
    });

    paperTiming("api/paper POST.openPaperTrade", tOpen);
    paperTiming("api/paper POST.total", tReq);
    return NextResponse.json({
      position: result.position,
      cashBalance: result.cashBalance,
      accountId: result.accountId,
      risk,
      executedAt: result.position.openedAt,
      note: "Paper trade only — no Angel One order was placed.",
    });
  } catch (err) {
    console.error("[api/paper POST]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Paper trade failed",
        uiHint: "paper trade failed — check inputs or retry",
      },
      { status: 500 },
    );
  }
}
