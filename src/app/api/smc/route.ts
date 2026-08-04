import { NextResponse } from "next/server";
import type { Underlying } from "@/lib/marketdata/angelone";
import type { TradingMode } from "@/lib/lanes/types";
import { getSmcEngineResult } from "@/lib/marketdata/smc";
import { buildSmcOverlayLevels } from "@/lib/marketdata/smc/overlays";

const UNDERLYINGS: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

/**
 * GET /api/smc?underlying=NIFTY&mode=SCALP|SWING
 *
 * Standalone SMC Stages 1–8. Not wired to §2.5 synthesizer or paper trading.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get("underlying") ?? "NIFTY").toUpperCase();
  const modeParam = (searchParams.get("mode") ?? "SCALP").toUpperCase();

  if (!UNDERLYINGS.includes(underlying as Underlying)) {
    return NextResponse.json(
      {
        ok: false,
        error: `underlying must be one of ${UNDERLYINGS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (modeParam !== "SCALP" && modeParam !== "SWING") {
    return NextResponse.json(
      { ok: false, error: "mode must be SCALP or SWING" },
      { status: 400 },
    );
  }

  const mode = modeParam as TradingMode;

  try {
    const result = await getSmcEngineResult(underlying as Underlying, mode);
    const overlayLevels = buildSmcOverlayLevels(result);

    return NextResponse.json({
      ok: true,
      underlying: result.underlying,
      mode: result.mode,
      source: result.source,
      degraded: result.degraded,
      degradeReasons: result.degradeReasons,
      fetchedAt: result.fetchedAt,
      stagesComplete: result.stagesComplete,
      signal: result.signal,
      marketStructure: {
        external: {
          trend: result.marketStructure.external.trend,
          status: result.marketStructure.external.status,
          lastEvent: result.marketStructure.external.lastEvent,
          eventCount: result.marketStructure.external.events.length,
          signals: result.marketStructure.external.signals,
        },
        internal: result.marketStructure.internal
          ? {
              status: result.marketStructure.internal.status,
              statusNote: result.marketStructure.internal.statusNote,
              trend: result.marketStructure.internal.trend,
            }
          : null,
      },
      swingCounts: {
        external: result.swingPoints.external.swings.length,
        internal: result.swingPoints.internal?.swings.length ?? null,
      },
      orderBlocks: {
        count: result.orderBlocks.zones.length,
        fresh: result.orderBlocks.zones.filter((z) => z.status === "fresh")
          .length,
        signals: result.orderBlocks.signals,
      },
      fairValueGaps: {
        fvg: result.fairValueGaps.gaps.filter((g) => g.kind === "fvg").length,
        imbalance: result.fairValueGaps.gaps.filter(
          (g) => g.kind === "imbalance",
        ).length,
        unfilled: result.fairValueGaps.gaps.filter((g) => !g.filled).length,
        signals: result.fairValueGaps.signals,
      },
      liquidity: {
        count: result.liquidity.zones.length,
        swept: result.liquidity.zones.filter((z) => z.swept).length,
        signals: result.liquidity.signals,
      },
      premiumDiscount: result.premiumDiscount
        ? {
            currentZone: result.premiumDiscount.currentZone,
            equilibrium: result.premiumDiscount.equilibrium,
            rangeLow: result.premiumDiscount.rangeLow,
            rangeHigh: result.premiumDiscount.rangeHigh,
            annotationOnly: result.premiumDiscount.annotationOnly,
            signals: result.premiumDiscount.signals,
          }
        : null,
      supplyDemand: {
        count: result.supplyDemand.zones.length,
        fresh: result.supplyDemand.zones.filter((z) => z.status === "fresh")
          .length,
        signals: result.supplyDemand.signals,
      },
      overlayLevels,
      disclaimer: result.signal.disclaimer,
      note: "SMC is standalone/read-only — not wired into §2.5 synthesizer or paper trading",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "SMC engine failed",
        uiHint: "market data unavailable",
      },
      { status: 503 },
    );
  }
}
