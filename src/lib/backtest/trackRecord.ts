import { hasDatabase, prisma } from "@/lib/prisma";
import { promises as fs } from "fs";
import path from "path";
import type { Prisma } from "@prisma/client";
import {
  CURRENT_SYNTHESIS_VERSION,
  MIN_SAMPLE_FOR_EDGE_REPORT,
  SYNTHESIS_VERSION,
  cohortLabelFor,
  inferSynthesisVersion,
  type SynthesisVersion,
} from "./synthesisVersion";

export type CohortMetrics = {
  branch: string;
  sampleSize: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  experimental: true;
  label: string;
  /** Whether winRate is safe to present as a current-system edge number */
  reportable: boolean;
  synthesisVersion: SynthesisVersion | "mixed" | "none";
};

export type VersionCohortBlock = {
  synthesisVersion: SynthesisVersion;
  overall: CohortMetrics;
  byBranch: CohortMetrics[];
  byLaneLean: CohortMetrics[];
  orderedSampleSize: number;
  edgeReportable: boolean;
  note: string;
};

type Outcome = {
  id: string;
  underlying: string;
  mode: string;
  structureBranch: string;
  laneScores: Record<string, number>;
  realizedPnl: number;
  won: boolean;
  decidedAt: string;
  resolvedAt: string;
  synthesisVersion: SynthesisVersion;
};

const FILE = path.join(process.cwd(), ".data", "backtest-outcomes.json");

async function loadFileOutcomes(): Promise<Outcome[]> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as Array<
      Omit<Outcome, "synthesisVersion"> & { synthesisVersion?: string | null }
    >;
    return raw.map((r) => ({
      ...r,
      synthesisVersion: inferSynthesisVersion({
        synthesisVersion: r.synthesisVersion,
        laneScores: r.laneScores,
        decidedAt: r.decidedAt,
      }),
    }));
  } catch {
    return [];
  }
}

async function saveFileOutcomes(rows: Outcome[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rows, null, 2), "utf8");
}

function mapDbRow(r: {
  id: string;
  underlying: string;
  mode: string;
  structureBranch: string;
  laneScores: unknown;
  realizedPnl: number;
  won: boolean;
  decidedAt: Date;
  resolvedAt: Date;
  synthesisVersion: string | null;
}): Outcome {
  const laneScores = (r.laneScores ?? {}) as Record<string, number>;
  return {
    id: r.id,
    underlying: r.underlying,
    mode: r.mode,
    structureBranch: r.structureBranch,
    laneScores,
    realizedPnl: r.realizedPnl,
    won: r.won,
    decidedAt: r.decidedAt.toISOString(),
    resolvedAt: r.resolvedAt.toISOString(),
    synthesisVersion: inferSynthesisVersion({
      synthesisVersion: r.synthesisVersion,
      laneScores,
      decidedAt: r.decidedAt,
    }),
  };
}

/** Persist inferred synthesisVersion onto untagged DB / file rows (additive, idempotent). */
async function tagUntaggedOutcomes(rows: Outcome[]): Promise<void> {
  if (hasDatabase() && prisma) {
    for (const row of rows) {
      try {
        await prisma.backtestOutcome.updateMany({
          where: { id: row.id, synthesisVersion: null },
          data: { synthesisVersion: row.synthesisVersion },
        });
      } catch {
        // Column may not exist yet before db push — ignore; in-memory still tagged
      }
    }
    return;
  }
  await saveFileOutcomes(rows);
}

/** Tag TradeIdea rows missing synthesisVersion from featureSnapshot / createdAt. */
export async function tagTradeIdeaSynthesisVersions(): Promise<{
  scanned: number;
  tagged: number;
}> {
  if (!hasDatabase() || !prisma) return { scanned: 0, tagged: 0 };
  let scanned = 0;
  let tagged = 0;
  try {
    const ideas = await prisma.tradeIdea.findMany({
      where: { synthesisVersion: null },
      select: { id: true, featureSnapshot: true, createdAt: true },
    });
    scanned = ideas.length;
    for (const idea of ideas) {
      const version = inferSynthesisVersion({
        featureSnapshot: idea.featureSnapshot,
        decidedAt: idea.createdAt,
      });
      await prisma.tradeIdea.update({
        where: { id: idea.id },
        data: { synthesisVersion: version },
      });
      tagged += 1;
    }
  } catch {
    // Schema not pushed yet
  }
  return { scanned, tagged };
}

/** Seed a few demo outcomes in time order if empty — labeled experimental + legacy. */
async function ensureSeed(): Promise<Outcome[]> {
  let rows: Outcome[] = [];

  if (hasDatabase() && prisma) {
    try {
      const dbRows = await prisma.backtestOutcome.findMany({
        orderBy: { decidedAt: "asc" },
      });
      rows = dbRows.map(mapDbRow);
    } catch {
      rows = await loadFileOutcomes();
    }
  } else {
    rows = await loadFileOutcomes();
  }

  if (rows.length) {
    await tagUntaggedOutcomes(rows);
    // Time-ordered only — never shuffle
    rows.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    return rows;
  }

  const seed: Outcome[] = [
    {
      id: "seed1",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "BUY_CE",
      laneScores: { technical: 0.4, optionsFlow: 0.2 },
      realizedPnl: 4200,
      won: true,
      decidedAt: "2026-01-10T10:00:00.000Z",
      resolvedAt: "2026-01-12T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "seed2",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "BUY_CE",
      laneScores: { technical: 0.3, optionsFlow: 0.1 },
      realizedPnl: -1800,
      won: false,
      decidedAt: "2026-02-03T10:00:00.000Z",
      resolvedAt: "2026-02-05T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "seed3",
      underlying: "NIFTY",
      mode: "SCALP",
      structureBranch: "SELL_PE",
      laneScores: { technical: 0.2, optionsFlow: 0.35 },
      realizedPnl: 950,
      won: true,
      decidedAt: "2026-03-01T10:00:00.000Z",
      resolvedAt: "2026-03-01T14:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "seed4",
      underlying: "BANKNIFTY",
      mode: "SWING",
      structureBranch: "BUY_PE",
      laneScores: { technical: -0.4, optionsFlow: -0.1 },
      realizedPnl: 3100,
      won: true,
      decidedAt: "2026-04-15T10:00:00.000Z",
      resolvedAt: "2026-04-18T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "seed5",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "SELL_CE",
      laneScores: { technical: -0.25, optionsFlow: 0.2 },
      realizedPnl: -5200,
      won: false,
      decidedAt: "2026-05-20T10:00:00.000Z",
      resolvedAt: "2026-05-22T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
  ];

  // Time-ordered only — never shuffle for train/test
  seed.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));

  if (hasDatabase() && prisma) {
    try {
      for (const s of seed) {
        await prisma.backtestOutcome.create({
          data: {
            underlying: s.underlying,
            mode: s.mode as "SCALP" | "SWING",
            structureBranch: s.structureBranch,
            laneScores: s.laneScores as Prisma.InputJsonValue,
            realizedPnl: s.realizedPnl,
            won: s.won,
            decidedAt: new Date(s.decidedAt),
            resolvedAt: new Date(s.resolvedAt),
            synthesisVersion: s.synthesisVersion,
          },
        });
      }
      return ensureSeed();
    } catch {
      // Fall through to file seed if DB schema lagging
    }
  }

  await saveFileOutcomes(seed);
  return seed;
}

export async function recordOutcome(
  input: Omit<Outcome, "id" | "resolvedAt" | "synthesisVersion"> & {
    id?: string;
    synthesisVersion?: SynthesisVersion;
  },
) {
  const synthesisVersion =
    input.synthesisVersion ??
    inferSynthesisVersion({
      laneScores: input.laneScores,
      decidedAt: input.decidedAt,
    });

  const row: Outcome = {
    id: input.id ?? `out_${Date.now()}`,
    underlying: input.underlying,
    mode: input.mode,
    structureBranch: input.structureBranch,
    laneScores: input.laneScores,
    realizedPnl: input.realizedPnl,
    won: input.won,
    decidedAt: input.decidedAt,
    resolvedAt: new Date().toISOString(),
    synthesisVersion,
  };

  if (hasDatabase() && prisma) {
    await prisma.backtestOutcome.create({
      data: {
        underlying: row.underlying,
        mode: row.mode as "SCALP" | "SWING",
        structureBranch: row.structureBranch,
        laneScores: row.laneScores as Prisma.InputJsonValue,
        realizedPnl: row.realizedPnl,
        won: row.won,
        decidedAt: new Date(row.decidedAt),
        synthesisVersion: row.synthesisVersion,
      },
    });
    return;
  }
  const rows = await loadFileOutcomes();
  rows.push(row);
  rows.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  await saveFileOutcomes(rows);
}

function metricsFor(
  rows: Outcome[],
  branch: string,
  version: SynthesisVersion | "mixed" | "none",
): CohortMetrics {
  const sampleSize = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const totalPnl = rows.reduce((a, b) => a + b.realizedPnl, 0);
  const versionForLabel: SynthesisVersion =
    version === SYNTHESIS_VERSION.FOUR_LANE
      ? SYNTHESIS_VERSION.FOUR_LANE
      : SYNTHESIS_VERSION.LEGACY_2LANE;
  const reportable =
    version === SYNTHESIS_VERSION.FOUR_LANE &&
    sampleSize >= MIN_SAMPLE_FOR_EDGE_REPORT;

  return {
    branch,
    sampleSize,
    winRate: sampleSize ? wins / sampleSize : 0,
    avgPnl: sampleSize ? totalPnl / sampleSize : 0,
    totalPnl,
    experimental: true,
    label: cohortLabelFor(versionForLabel, sampleSize),
    reportable,
    synthesisVersion: version,
  };
}

function laneLeanCohorts(rows: Outcome[], version: SynthesisVersion): CohortMetrics[] {
  const lanes = ["technical", "optionsFlow", "macro", "sentiment"] as const;
  const out: CohortMetrics[] = [];
  for (const lane of lanes) {
    const bull = rows.filter((r) => (r.laneScores[lane] ?? 0) > 0);
    const bear = rows.filter((r) => (r.laneScores[lane] ?? 0) < 0);
    // Skip empty lean buckets for lanes absent from legacy scores
    if (bull.length) out.push(metricsFor(bull, `${lane}_score>0`, version));
    if (bear.length) out.push(metricsFor(bear, `${lane}_score<0`, version));
  }
  return out;
}

function buildVersionBlock(
  rows: Outcome[],
  version: SynthesisVersion,
): VersionCohortBlock {
  const filtered = rows.filter((r) => r.synthesisVersion === version);
  // Already time-ordered subset
  filtered.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));

  const overall = metricsFor(filtered, "ALL", version);
  const branches = [...new Set(filtered.map((r) => r.structureBranch))];
  const byBranch = branches.map((b) =>
    metricsFor(
      filtered.filter((r) => r.structureBranch === b),
      b,
      version,
    ),
  );
  const byLaneLean = laneLeanCohorts(filtered, version);
  const edgeReportable = filtered.length >= MIN_SAMPLE_FOR_EDGE_REPORT;

  const note =
    version === SYNTHESIS_VERSION.LEGACY_2LANE
      ? "Legacy 2-lane-effective cohort (Macro+Sentiment stubbed). Excluded from current-system edge badges."
      : edgeReportable
        ? "Post-4-lane cohort — used for current-system experimental edge when sample is adequate."
        : `Post-4-lane cohort accumulating (n=${filtered.length}; need ≥${MIN_SAMPLE_FOR_EDGE_REPORT} for reportable edge).`;

  return {
    synthesisVersion: version,
    overall,
    byBranch,
    byLaneLean,
    orderedSampleSize: filtered.length,
    edgeReportable,
    note,
  };
}

/**
 * Time-ordered walk-forward style summary.
 * Cohorts are partitioned by synthesisVersion — legacy never leaks into current metrics.
 * We never shuffle outcomes into random train/test splits.
 */
export async function computeTrackRecord(): Promise<{
  currentVersion: SynthesisVersion;
  minSampleForEdge: number;
  current: VersionCohortBlock;
  legacy: VersionCohortBlock;
  /** @deprecated Prefer `current` — kept for older UI; mirrors current overall when reportable, else empty reportable=false */
  overall: CohortMetrics;
  byBranch: CohortMetrics[];
  byLaneLean: CohortMetrics[];
  orderedSampleSize: number;
  methodology: string;
  audit: {
    legacySampleSize: number;
    currentSampleSize: number;
    legacyWinRatePct: number | null;
    currentWinRatePct: number | null;
  };
}> {
  // Best-effort tag of TradeIdeas (idempotent); does not affect settlement cron
  await tagTradeIdeaSynthesisVersions();

  const rows = await ensureSeed();
  const current = buildVersionBlock(rows, SYNTHESIS_VERSION.FOUR_LANE);
  const legacy = buildVersionBlock(rows, SYNTHESIS_VERSION.LEGACY_2LANE);

  // Headline metrics = current cohort only (never mix with legacy)
  const headline = current;

  return {
    currentVersion: CURRENT_SYNTHESIS_VERSION,
    minSampleForEdge: MIN_SAMPLE_FOR_EDGE_REPORT,
    current,
    legacy,
    overall: headline.overall,
    byBranch: headline.byBranch,
    byLaneLean: headline.byLaneLean,
    orderedSampleSize: headline.orderedSampleSize,
    methodology:
      "Time-ordered validation only (no shuffled train/test). " +
      "Cohorts split by synthesisVersion: legacy lanes-v1-2lane-effective (pre Stage 2.5 stubbed Macro/Sentiment) " +
      "vs current lanes-v2-4lane. Current-system edge badges use post-4-lane only. " +
      "Evidence gate before any real-money automation discussion — automation remains out of scope.",
    audit: {
      legacySampleSize: legacy.orderedSampleSize,
      currentSampleSize: current.orderedSampleSize,
      legacyWinRatePct: legacy.orderedSampleSize
        ? Math.round(legacy.overall.winRate * 100)
        : null,
      currentWinRatePct: current.orderedSampleSize
        ? Math.round(current.overall.winRate * 100)
        : null,
    },
  };
}

/**
 * Edge badge input for analysis UI — post-4-lane cohort only.
 * Returns null winRate when sample is insufficient (does not fall back to legacy %).
 */
export function edgeFromTrackRecord(
  track: Awaited<ReturnType<typeof computeTrackRecord>>,
  branch: string,
): {
  winRatePct: number | null;
  sampleSize: number;
  branch: string;
  label: string;
  experimental: true;
  synthesisVersion: SynthesisVersion;
  insufficientSample: boolean;
  legacySampleSize: number;
} {
  const block = track.current;
  const cohort =
    block.byBranch.find((b) => b.branch === branch) ??
    (branch === "NO_TRADE" ? null : block.overall);

  const sampleSize = cohort?.sampleSize ?? 0;
  const insufficientSample = sampleSize < MIN_SAMPLE_FOR_EDGE_REPORT;

  if (!cohort || sampleSize === 0) {
    return {
      winRatePct: null,
      sampleSize: 0,
      branch,
      label:
        `Insufficient post-upgrade sample yet (n=0 post-4-lane; legacy heuristic-lane n=${track.legacy.orderedSampleSize} excluded). ` +
        "Experimental / unvalidated.",
      experimental: true,
      synthesisVersion: CURRENT_SYNTHESIS_VERSION,
      insufficientSample: true,
      legacySampleSize: track.legacy.orderedSampleSize,
    };
  }

  if (insufficientSample) {
    return {
      winRatePct: null,
      sampleSize,
      branch: cohort.branch,
      label:
        `Insufficient post-upgrade sample yet (n=${sampleSize} post-4-lane; need ≥${MIN_SAMPLE_FOR_EDGE_REPORT}). ` +
        `Legacy heuristic-lane data n=${track.legacy.orderedSampleSize} is shown separately on Track Record — not used as current edge. ` +
        "Experimental / unvalidated.",
      experimental: true,
      synthesisVersion: CURRENT_SYNTHESIS_VERSION,
      insufficientSample: true,
      legacySampleSize: track.legacy.orderedSampleSize,
    };
  }

  return {
    winRatePct: Math.round(cohort.winRate * 100),
    sampleSize,
    branch: cohort.branch,
    label: cohort.label,
    experimental: true,
    synthesisVersion: CURRENT_SYNTHESIS_VERSION,
    insufficientSample: false,
    legacySampleSize: track.legacy.orderedSampleSize,
  };
}

/** Pure helper for tests — split rows without I/O. */
export function partitionBySynthesisVersion(rows: Outcome[]): {
  legacy: Outcome[];
  current: Outcome[];
} {
  return {
    legacy: rows.filter(
      (r) => r.synthesisVersion === SYNTHESIS_VERSION.LEGACY_2LANE,
    ),
    current: rows.filter(
      (r) => r.synthesisVersion === SYNTHESIS_VERSION.FOUR_LANE,
    ),
  };
}

export {
  CURRENT_SYNTHESIS_VERSION,
  MIN_SAMPLE_FOR_EDGE_REPORT,
  SYNTHESIS_VERSION,
  inferSynthesisVersion,
};
