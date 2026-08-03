import { getOptionChain, type Underlying } from "@/lib/marketdata/angelone";
import { withTtlCache } from "@/lib/marketdata/ttlCache";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Coalesce aggressive client polls so NSE/Angel aren't hammered. */
const CHAIN_TTL_MS = 1_500;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const underlying = (url.searchParams.get("underlying") ??
    "NIFTY") as Underlying;
  const expiry = url.searchParams.get("expiry") ?? undefined;
  try {
    const chain = await withTtlCache(
      `paper-chain:${underlying}:${expiry ?? "nearest"}`,
      CHAIN_TTL_MS,
      () => getOptionChain(underlying, expiry),
    );
    return NextResponse.json({
      ...chain,
      polledAt: new Date().toISOString(),
      cacheTtlMs: CHAIN_TTL_MS,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Option chain unavailable",
        uiHint: "market data unavailable",
      },
      { status: 503 },
    );
  }
}
