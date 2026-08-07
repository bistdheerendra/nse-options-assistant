import { computeSampleStatus } from "@/lib/backtest/trackRecord";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/backtest/sample-status
 * §6 readiness indicator — post-4-lane resolved outcome counts.
 * Informational only; does not change insufficient-sample gating.
 */
export async function GET() {
  const sampleStatus = await computeSampleStatus();
  return NextResponse.json(sampleStatus);
}
