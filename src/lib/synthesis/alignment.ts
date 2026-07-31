import type { DirectionalVerdict } from "./directional";

export type LaneAlignment = {
  alignedCount: number;
  activeCount: number;
  totalLanes: number;
  /** e.g. "2/2 active lanes aligned (2 stubs neutral)" */
  label: string;
  stubCount: number;
  perLane: Record<string, "aligned" | "against" | "neutral" | "stub">;
};

const SCORE_EPS = 0.1;

/**
 * Count how many non-stub lanes agree with directional verdict.
 * Stub lanes (score≈0 + stub flag) are excluded from the denominator.
 */
export function computeLaneAlignment(
  verdict: DirectionalVerdict,
  lanes: Record<string, { score: number; rawIndicators?: Record<string, unknown> }>,
): LaneAlignment {
  const perLane: LaneAlignment["perLane"] = {};
  let alignedCount = 0;
  let activeCount = 0;
  let stubCount = 0;

  for (const [name, lane] of Object.entries(lanes)) {
    const isStub = Boolean(lane.rawIndicators?.stub);
    if (isStub || Math.abs(lane.score) < SCORE_EPS) {
      if (isStub) {
        stubCount += 1;
        perLane[name] = "stub";
      } else {
        perLane[name] = "neutral";
      }
      continue;
    }

    activeCount += 1;
    const lean: "bull" | "bear" = lane.score > 0 ? "bull" : "bear";
    if (verdict === "NEUTRAL") {
      perLane[name] = "neutral";
      continue;
    }
    const wantsBull = verdict === "BULLISH";
    if ((wantsBull && lean === "bull") || (!wantsBull && lean === "bear")) {
      alignedCount += 1;
      perLane[name] = "aligned";
    } else {
      perLane[name] = "against";
    }
  }

  const totalLanes = Object.keys(lanes).length;
  const denom = activeCount || 0;
  const label =
    verdict === "NEUTRAL"
      ? `Neutral — ${activeCount} active / ${totalLanes} lanes`
      : denom === 0
        ? `0 active lanes (${stubCount} stubs) — alignment N/A`
        : `${alignedCount}/${denom} lanes aligned${stubCount ? ` (${stubCount} stubs excluded)` : ""}`;

  return {
    alignedCount,
    activeCount: denom,
    totalLanes,
    label,
    stubCount,
    perLane,
  };
}
