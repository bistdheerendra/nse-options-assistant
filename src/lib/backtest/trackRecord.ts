import { hasDatabase, prisma } from "@/lib/prisma";
import { promises as fs } from "fs";
import path from "path";
import type { Prisma } from "@prisma/client";

export type CohortMetrics = {
  branch: string;
  sampleSize: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  experimental: true;
  label: string;
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
};

const FILE = path.join(process.cwd(), ".data", "backtest-outcomes.json");

async function loadFileOutcomes(): Promise<Outcome[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Outcome[];
  } catch {
    return [];
  }
}

async function saveFileOutcomes(rows: Outcome[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rows, null, 2), "utf8");
}

/** Seed a few demo outcomes in time order if empty — labeled experimental. */
async function ensureSeed(): Promise<Outcome[]> {
  let rows = hasDatabase() && prisma
    ? (
        await prisma.backtestOutcome.findMany({ orderBy: { decidedAt: "asc" } })
      ).map((r) => ({
        id: r.id,
        underlying: r.underlying,
        mode: r.mode,
        structureBranch: r.structureBranch,
        laneScores: r.laneScores as Record<string, number>,
        realizedPnl: r.realizedPnl,
        won: r.won,
        decidedAt: r.decidedAt.toISOString(),
        resolvedAt: r.resolvedAt.toISOString(),
      }))
    : await loadFileOutcomes();

  if (rows.length) return rows;

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
    },
  ];

  // Time-ordered only — never shuffle for train/test
  seed.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));

  if (hasDatabase() && prisma) {
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
        },
      });
    }
    return ensureSeed();
  }

  await saveFileOutcomes(seed);
  return seed;
}

export async function recordOutcome(input: Omit<Outcome, "id" | "resolvedAt"> & { id?: string }) {
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
      },
    });
    return;
  }
  const rows = await loadFileOutcomes();
  rows.push(row);
  rows.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  await saveFileOutcomes(rows);
}

function metricsFor(rows: Outcome[], branch: string): CohortMetrics {
  const sampleSize = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const totalPnl = rows.reduce((a, b) => a + b.realizedPnl, 0);
  return {
    branch,
    sampleSize,
    winRate: sampleSize ? wins / sampleSize : 0,
    avgPnl: sampleSize ? totalPnl / sampleSize : 0,
    totalPnl,
    experimental: true,
    label:
      "Experimental / unvalidated — sample is small and may be regime-narrow. Not an edge claim.",
  };
}

/**
 * Time-ordered walk-forward style summary.
 * We never shuffle outcomes into random train/test splits.
 */
export async function computeTrackRecord(): Promise<{
  overall: CohortMetrics;
  byBranch: CohortMetrics[];
  byLaneLean: CohortMetrics[];
  orderedSampleSize: number;
  methodology: string;
}> {
  const rows = await ensureSeed();
  // Already time-ordered
  const overall = metricsFor(rows, "ALL");
  const branches = [...new Set(rows.map((r) => r.structureBranch))];
  const byBranch = branches.map((b) =>
    metricsFor(
      rows.filter((r) => r.structureBranch === b),
      b,
    ),
  );

  const techBull = rows.filter((r) => (r.laneScores.technical ?? 0) > 0);
  const techBear = rows.filter((r) => (r.laneScores.technical ?? 0) < 0);
  const byLaneLean = [
    metricsFor(techBull, "technical_score>0"),
    metricsFor(techBear, "technical_score<0"),
  ];

  return {
    overall,
    byBranch,
    byLaneLean,
    orderedSampleSize: rows.length,
    methodology:
      "Time-ordered validation only (no shuffled train/test). Evidence gate before any real-money automation discussion — automation remains out of scope.",
  };
}
