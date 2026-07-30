import { computeTrackRecord } from "@/lib/backtest/trackRecord";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const track = await computeTrackRecord();
  return NextResponse.json(track);
}
