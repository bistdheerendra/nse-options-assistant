/**
 * Bridge paper closes → BacktestOutcome (track-record / experimental edge).
 * Only positions with entrySnapshot.tradeIdeaId are recorded (Mark as taken /
 * scalp auto-paper). Manual chain buys stay out of the edge cohort.
 */
import { hasDatabase, prisma } from "@/lib/prisma";
import {
  CURRENT_SYNTHESIS_VERSION,
  inferSynthesisVersion,
  type SynthesisVersion,
} from "./synthesisVersion";
import { recordOutcome } from "./trackRecord";

export const TRACK_RECORD_OUTCOME_ID_KEY = "trackRecordOutcomeId";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Read tradeIdeaId from paper entrySnapshot (Mark as taken / auto-paper). */
export function tradeIdeaIdFromSnapshot(snap: unknown): string | null {
  const s = asRecord(snap);
  const id = s?.tradeIdeaId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function alreadyRecordedOutcomeId(snap: unknown): string | null {
  const s = asRecord(snap);
  const id = s?.[TRACK_RECORD_OUTCOME_ID_KEY];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Pull lane scores from TradeIdea.featureSnapshot.lanes.*.score */
export function laneScoresFromFeatureSnapshot(
  featureSnapshot: unknown,
): Record<string, number> {
  const root = asRecord(featureSnapshot);
  const lanes = asRecord(root?.lanes);
  const out: Record<string, number> = {};
  if (!lanes) return out;
  for (const key of [
    "technical",
    "optionsFlow",
    "macro",
    "sentiment",
  ] as const) {
    const lane = asRecord(lanes[key]);
    const score = lane?.score;
    if (typeof score === "number" && Number.isFinite(score)) {
      out[key] = score;
    }
  }
  return out;
}

export type RecordPaperOutcomeResult =
  | { recorded: true; outcomeId: string; tradeIdeaId: string }
  | {
      recorded: false;
      reason:
        | "not_closed"
        | "missing_pnl"
        | "no_trade_idea"
        | "already_recorded"
        | "idea_missing"
        | "error";
      detail?: string;
    };

/** Minimal closed-position shape — avoids importing paperTrading (cycle). */
export type ClosedPaperForOutcome = {
  id: string;
  underlying: string;
  mode: "SCALP" | "SWING";
  status: "OPEN" | "CLOSED" | "EXPIRED" | string;
  realizedPnl?: number | null;
  closedAt?: string | null;
  openedAt: string;
  entrySnapshot?: unknown;
};

/**
 * If this closed/expired paper row is linked to a TradeIdea, append a
 * BacktestOutcome and stamp entrySnapshot.trackRecordOutcomeId (idempotent).
 */
export async function recordOutcomeFromClosedPosition(
  pos: ClosedPaperForOutcome,
  patchSnapshot: (
    positionId: string,
    extra: Record<string, unknown>,
  ) => Promise<void>,
): Promise<RecordPaperOutcomeResult> {
  if (pos.status !== "CLOSED" && pos.status !== "EXPIRED") {
    return { recorded: false, reason: "not_closed" };
  }
  if (pos.realizedPnl == null || !Number.isFinite(pos.realizedPnl)) {
    return { recorded: false, reason: "missing_pnl" };
  }

  const existing = alreadyRecordedOutcomeId(pos.entrySnapshot);
  if (existing) {
    return { recorded: false, reason: "already_recorded" };
  }

  const tradeIdeaId = tradeIdeaIdFromSnapshot(pos.entrySnapshot);
  if (!tradeIdeaId) {
    return { recorded: false, reason: "no_trade_idea" };
  }

  try {
    let structureBranch = "UNKNOWN";
    let laneScores: Record<string, number> = {};
    let decidedAt = pos.openedAt;
    let synthesisVersion: SynthesisVersion = CURRENT_SYNTHESIS_VERSION;
    let featureSnapshot: unknown = null;

    if (hasDatabase() && prisma) {
      const idea = await prisma.tradeIdea.findUnique({
        where: { id: tradeIdeaId },
        select: {
          structureAction: true,
          featureSnapshot: true,
          createdAt: true,
          synthesisVersion: true,
        },
      });
      if (!idea) {
        return { recorded: false, reason: "idea_missing" };
      }
      structureBranch = idea.structureAction || "UNKNOWN";
      featureSnapshot = idea.featureSnapshot;
      laneScores = laneScoresFromFeatureSnapshot(idea.featureSnapshot);
      decidedAt = idea.createdAt.toISOString();
      synthesisVersion = inferSynthesisVersion({
        synthesisVersion: idea.synthesisVersion,
        featureSnapshot: idea.featureSnapshot,
        laneScores,
        decidedAt: idea.createdAt,
      });
    } else {
      // File-only mode: still record with position metadata; scores may be empty.
      structureBranch = "UNKNOWN";
      synthesisVersion = CURRENT_SYNTHESIS_VERSION;
    }

    // Win = positive realized INR P&L (flat 0 is not a win).
    const won = pos.realizedPnl > 0;
    const resolvedAt = pos.closedAt ?? new Date().toISOString();

    const outcomeId = await recordOutcome({
      id: `paper_${pos.id}`,
      underlying: pos.underlying,
      mode: pos.mode,
      structureBranch,
      laneScores,
      realizedPnl: pos.realizedPnl,
      won,
      decidedAt,
      synthesisVersion,
      tradeIdeaId,
      resolvedAt,
    });

    await patchSnapshot(pos.id, {
      [TRACK_RECORD_OUTCOME_ID_KEY]: outcomeId,
      trackRecordRecordedAt: new Date().toISOString(),
      ...(featureSnapshot != null
        ? { trackRecordStructureBranch: structureBranch }
        : {}),
    });

    return { recorded: true, outcomeId, tradeIdeaId };
  } catch (err) {
    return {
      recorded: false,
      reason: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
