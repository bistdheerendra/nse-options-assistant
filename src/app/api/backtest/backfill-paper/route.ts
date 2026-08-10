import { backfillPaperTrackOutcomes } from "@/lib/paperTrading/account";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/backtest/backfill-paper
 * Idempotent: CLOSED/EXPIRED paper rows with tradeIdeaId → BacktestOutcome.
 */
export async function POST() {
  try {
    const result = await backfillPaperTrackOutcomes();
    return NextResponse.json({
      ...result,
      note:
        "Only Mark-as-taken / auto-paper closes (tradeIdeaId) are recorded. " +
        "Manual chain buys stay out of the post-4-lane edge cohort.",
    });
  } catch (err) {
    console.error("[api/backtest/backfill-paper]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Backfill failed",
      },
      { status: 500 },
    );
  }
}
