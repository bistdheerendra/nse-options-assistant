import { runExpirySettlement } from "@/lib/paperTrading/settle";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Idempotent expiry settlement job (rate-aware via Angel throttle). */
export async function GET() {
  const result = await runExpirySettlement();
  return NextResponse.json({
    ok: true,
    ...result,
    note: "Settled using intrinsic value only — paper positions, no broker orders.",
  });
}

export async function POST() {
  return GET();
}
