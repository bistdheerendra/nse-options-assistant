import { getOrCreateAccount } from "@/lib/paperTrading/account";
import { fetchPositionMarks } from "@/lib/paperTrading/fetchPositionMarks";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Coalesce paper-panel polls so Angel isn't hammered per open row. */
const MARKS_TTL_MS = 2_000;

export async function GET() {
  try {
    const account = await getOrCreateAccount();
    const open = account.positions.filter((p) => p.status === "OPEN");
    const marks = open.length
      ? await withTtlCache("paper-position-marks", MARKS_TTL_MS, () =>
          fetchPositionMarks(open),
        )
      : {};
    return NextResponse.json({
      marks,
      fetchedAt: new Date().toISOString(),
      cacheTtlMs: MARKS_TTL_MS,
    });
  } catch (err) {
    console.error("[api/paper/marks GET]", err);
    return NextResponse.json(
      {
        marks: {},
        error: err instanceof Error ? err.message : "Position marks unavailable",
        uiHint: "market data unavailable",
      },
      { status: 503 },
    );
  }
}
