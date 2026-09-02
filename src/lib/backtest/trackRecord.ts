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
import type {
  MarketRegimeKey,
  ModeSampleStatus,
  SampleStatus,
} from "./sampleStatusTypes";

export type { MarketRegimeKey, ModeSampleStatus, SampleStatus } from "./sampleStatusTypes";

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
  /** Optional link to TradeIdea for regime enrichment (may be null). */
  tradeIdeaId?: string | null;
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
  tradeIdeaId?: string | null;
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
    tradeIdeaId: r.tradeIdeaId ?? null,
  };
}

function emptyRegimeCounts(): Record<MarketRegimeKey, number> & {
  unknown: number;
} {
  return { TRENDING: 0, CHOPPY: 0, VOLATILE: 0, unknown: 0 };
}

/** Pull regime labels from linked TradeIdea.featureSnapshot when present. */
async function regimesForOutcomes(
  rows: Outcome[],
): Promise<Map<string, MarketRegimeKey>> {
  const map = new Map<string, MarketRegimeKey>();
  if (!hasDatabase() || !prisma) return map;

  const ideaIds = [
    ...new Set(
      rows
        .map((r) => r.tradeIdeaId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (ideaIds.length === 0) return map;

  try {
    const ideas = await prisma.tradeIdea.findMany({
      where: { id: { in: ideaIds } },
      select: { id: true, featureSnapshot: true },
    });
    for (const idea of ideas) {
      const snap =
        idea.featureSnapshot != null &&
        typeof idea.featureSnapshot === "object" &&
        !Array.isArray(idea.featureSnapshot)
          ? (idea.featureSnapshot as Record<string, unknown>)
          : null;
      const regimeObj =
        snap?.regime != null &&
        typeof snap.regime === "object" &&
        !Array.isArray(snap.regime)
          ? (snap.regime as Record<string, unknown>)
          : null;
      const label = regimeObj?.regime;
      if (
        label === "TRENDING" ||
        label === "CHOPPY" ||
        label === "VOLATILE"
      ) {
        map.set(idea.id, label);
      }
    }
  } catch {
    // Schema / DB lag — regime enrichment is optional
  }
  return map;
}

function modeSampleStatus(
  rows: Outcome[],
  mode: "SCALP" | "SWING" | "ALL",
  regimeByIdeaId: Map<string, MarketRegimeKey>,
  includeRegime: boolean,
): ModeSampleStatus {
  const resolvedCount = rows.length;
  const base: ModeSampleStatus = {
    mode,
    resolvedCount,
    reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
    isReportable: resolvedCount >= MIN_SAMPLE_FOR_EDGE_REPORT,
    regimesTotal: 3,
  };

  if (!includeRegime) return base;

  const byRegime = emptyRegimeCounts();
  for (const row of rows) {
    const key =
      row.tradeIdeaId != null
        ? regimeByIdeaId.get(row.tradeIdeaId)
        : undefined;
    if (key) byRegime[key] += 1;
    else byRegime.unknown += 1;
  }
  const regimesCovered = (
    ["TRENDING", "CHOPPY", "VOLATILE"] as MarketRegimeKey[]
  ).filter((r) => byRegime[r] > 0).length;

  return { ...base, byRegime, regimesCovered };
}

function buildSampleStatus(
  fourLane: Outcome[],
  regimeByIdeaId: Map<string, MarketRegimeKey>,
  regimeTagged: boolean,
): SampleStatus {
  return {
    synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
    reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
    combined: modeSampleStatus(fourLane, "ALL", regimeByIdeaId, regimeTagged),
    byMode: {
      SCALP: modeSampleStatus(
        fourLane.filter((r) => r.mode === "SCALP"),
        "SCALP",
        regimeByIdeaId,
        regimeTagged,
      ),
      SWING: modeSampleStatus(
        fourLane.filter((r) => r.mode === "SWING"),
        "SWING",
        regimeByIdeaId,
        regimeTagged,
      ),
    },
    regimeTagged,
    informationalOnly: true,
    note:
      "Informational §6 sample-size readiness only. Counts BacktestOutcome rows " +
      `tagged ${SYNTHESIS_VERSION.FOUR_LANE} (resolved by definition). ` +
      "Does not change the existing insufficient-sample gate.",
  };
}

/**
 * §6 readiness counter — post-4-lane resolved BacktestOutcome counts.
 * Read-only / informational; does not change insufficient-sample gating.
 * BacktestOutcome rows are resolved by definition (won + realizedPnl set).
 */
export async function computeSampleStatus(): Promise<SampleStatus> {
  await tagTradeIdeaSynthesisVersions();
  const rows = await ensureSeed();
  const fourLane = rows.filter(
    (r) => r.synthesisVersion === SYNTHESIS_VERSION.FOUR_LANE,
  );
  const regimeByIdeaId = await regimesForOutcomes(fourLane);
  return buildSampleStatus(fourLane, regimeByIdeaId, regimeByIdeaId.size > 0);
}

/** Persist inferred synthesisVersion onto untagged DB / file rows (additive, idempotent). */
async function tagUntaggedOutcomes(rows: Outcome[]): Promise<void> {
  if (hasDatabase() && prisma) {
    const untagged = rows.filter((r) => r.synthesisVersion);
    const byVersion = new Map<SynthesisVersion, string[]>();
    for (const row of untagged) {
      // Only rows that still need a DB stamp (caller already inferred in memory)
      const list = byVersion.get(row.synthesisVersion) ?? [];
      list.push(row.id);
      byVersion.set(row.synthesisVersion, list);
    }
    for (const [version, ids] of byVersion) {
      // Chunk IN lists; updateMany returns count only (no row egress).
      const chunkSize = 100;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        try {
          await prisma.backtestOutcome.updateMany({
            where: { id: { in: chunk }, synthesisVersion: null },
            data: { synthesisVersion: version },
          });
        } catch {
          // Column may not exist yet before db push — ignore
        }
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
      take: 200,
    });
    scanned = ideas.length;
    const byVersion = new Map<SynthesisVersion, string[]>();
    for (const idea of ideas) {
      const version = inferSynthesisVersion({
        featureSnapshot: idea.featureSnapshot,
        decidedAt: idea.createdAt,
      });
      const list = byVersion.get(version) ?? [];
      list.push(idea.id);
      byVersion.set(version, list);
    }
    for (const [version, ids] of byVersion) {
      await prisma.tradeIdea.updateMany({
        where: { id: { in: ids }, synthesisVersion: null },
        data: { synthesisVersion: version },
      });
      tagged += ids.length;
    }
  } catch {
    // Schema not pushed yet
  }
  return { scanned, tagged };
}

/** Cap track-record reads — prevents unbounded SELECT * as the table grows. */
const BACKTEST_OUTCOME_TAKE = 5_000;

/** Seed a few demo outcomes in time order if empty — labeled experimental + legacy. */
async function ensureSeed(): Promise<Outcome[]> {
  let rows: Outcome[] = [];

  if (hasDatabase() && prisma) {
    try {
      const dbRows = await prisma.backtestOutcome.findMany({
        orderBy: { decidedAt: "asc" },
        take: BACKTEST_OUTCOME_TAKE,
        select: {
          id: true,
          underlying: true,
          mode: true,
          structureBranch: true,
          laneScores: true,
          realizedPnl: true,
          won: true,
          decidedAt: true,
          resolvedAt: true,
          synthesisVersion: true,
          tradeIdeaId: true,
        },
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
    tradeIdeaId?: string | null;
    resolvedAt?: string;
  },
): Promise<string> {
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
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
    synthesisVersion,
    tradeIdeaId: input.tradeIdeaId ?? null,
  };

  if (hasDatabase() && prisma) {
    // Idempotent when caller passes a stable id (e.g. paper_${positionId})
    const existing = await prisma.backtestOutcome.findUnique({
      where: { id: row.id },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await prisma.backtestOutcome.create({
      data: {
        id: row.id,
        underlying: row.underlying,
        mode: row.mode as "SCALP" | "SWING",
        structureBranch: row.structureBranch,
        laneScores: row.laneScores as Prisma.InputJsonValue,
        realizedPnl: row.realizedPnl,
        won: row.won,
        decidedAt: new Date(row.decidedAt),
        resolvedAt: new Date(row.resolvedAt),
        synthesisVersion: row.synthesisVersion,
        tradeIdeaId: row.tradeIdeaId ?? undefined,
      },
    });
    return created.id;
  }
  const rows = await loadFileOutcomes();
  if (rows.some((r) => r.id === row.id)) return row.id;
  rows.push(row);
  rows.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  await saveFileOutcomes(rows);
  return row.id;
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
  /** §6 readiness — same counts as insufficient-sample gate; informational only */
  sampleStatus: SampleStatus;
}> {
  // Best-effort tag of TradeIdeas (idempotent); does not affect settlement cron
  await tagTradeIdeaSynthesisVersions();

  const rows = await ensureSeed();
  const current = buildVersionBlock(rows, SYNTHESIS_VERSION.FOUR_LANE);
  const legacy = buildVersionBlock(rows, SYNTHESIS_VERSION.LEGACY_2LANE);

  // Headline metrics = current cohort only (never mix with legacy)
  const headline = current;

  const fourLane = rows.filter(
    (r) => r.synthesisVersion === SYNTHESIS_VERSION.FOUR_LANE,
  );
  const regimeByIdeaId = await regimesForOutcomes(fourLane);
  const sampleStatus = buildSampleStatus(
    fourLane,
    regimeByIdeaId,
    regimeByIdeaId.size > 0,
  );

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
    sampleStatus,
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
