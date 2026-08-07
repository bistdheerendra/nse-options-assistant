/**
 * Cohort separation tests for synthesis-version tagging.
 * Run: npm run test:backtest
 */
import {
  edgeFromTrackRecord,
  inferSynthesisVersion,
  partitionBySynthesisVersion,
  SYNTHESIS_VERSION,
  MIN_SAMPLE_FOR_EDGE_REPORT,
} from "../src/lib/backtest/trackRecord";
import { FOUR_LANE_ERA_START } from "../src/lib/backtest/synthesisVersion";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function testInfer() {
  console.log("=== inferSynthesisVersion ===");

  assert(
    inferSynthesisVersion({
      laneScores: { technical: 0.4, optionsFlow: 0.2 },
      decidedAt: "2026-01-10T10:00:00.000Z",
    }) === SYNTHESIS_VERSION.LEGACY_2LANE,
    "seed-shaped scores → legacy",
  );

  assert(
    inferSynthesisVersion({
      featureSnapshot: {
        lanes: {
          macro: { score: 0, rawIndicators: { stub: true } },
          sentiment: { score: 0, rawIndicators: { stub: true } },
        },
      },
    }) === SYNTHESIS_VERSION.LEGACY_2LANE,
    "stub flags → legacy",
  );

  assert(
    inferSynthesisVersion({
      featureSnapshot: {
        lanes: {
          macro: { score: 0.2, rawIndicators: { heuristic: true } },
          sentiment: { score: -0.1, rawIndicators: { heuristic: true } },
        },
      },
    }) === SYNTHESIS_VERSION.FOUR_LANE,
    "heuristic live lanes → 4-lane",
  );

  assert(
    inferSynthesisVersion({
      synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
      laneScores: { technical: 0.1 },
    }) === SYNTHESIS_VERSION.FOUR_LANE,
    "explicit version wins",
  );

  assert(
    inferSynthesisVersion({
      laneScores: { technical: 0.1, optionsFlow: 0, macro: 0, sentiment: 0 },
      decidedAt: new Date(FOUR_LANE_ERA_START.getTime() - 60_000).toISOString(),
    }) === SYNTHESIS_VERSION.LEGACY_2LANE,
    "pre-era with zero macro/sentiment keys still legacy by cutoff",
  );

  console.log("infer assertions passed.\n");
}

function testPartitionNoLeak() {
  console.log("=== partitionBySynthesisVersion (no legacy leak) ===");

  const rows = [
    {
      id: "l1",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "BUY_CE",
      laneScores: { technical: 0.4, optionsFlow: 0.2 },
      realizedPnl: 1000,
      won: true,
      decidedAt: "2026-01-10T10:00:00.000Z",
      resolvedAt: "2026-01-12T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "l2",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "BUY_CE",
      laneScores: { technical: 0.3, optionsFlow: 0.1 },
      realizedPnl: -500,
      won: false,
      decidedAt: "2026-02-03T10:00:00.000Z",
      resolvedAt: "2026-02-05T10:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
    },
    {
      id: "c1",
      underlying: "NIFTY",
      mode: "SWING",
      structureBranch: "BUY_CE",
      laneScores: {
        technical: 0.2,
        optionsFlow: 0.1,
        macro: 0.3,
        sentiment: 0.2,
      },
      realizedPnl: 800,
      won: true,
      decidedAt: "2026-07-31T12:00:00.000Z",
      resolvedAt: "2026-08-01T12:00:00.000Z",
      synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
    },
  ] as const;

  const { legacy, current } = partitionBySynthesisVersion([...rows]);
  assert(legacy.length === 2, `expected 2 legacy, got ${legacy.length}`);
  assert(current.length === 1, `expected 1 current, got ${current.length}`);
  assert(
    !current.some((r) => r.synthesisVersion === SYNTHESIS_VERSION.LEGACY_2LANE),
    "legacy must not appear in current partition",
  );
  assert(
    !legacy.some((r) => r.synthesisVersion === SYNTHESIS_VERSION.FOUR_LANE),
    "current must not appear in legacy partition",
  );

  // Simulated track record edge: with n=1 current, win rate must be null
  const fakeTrack = {
    currentVersion: SYNTHESIS_VERSION.FOUR_LANE,
    minSampleForEdge: MIN_SAMPLE_FOR_EDGE_REPORT,
    current: {
      synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
      overall: {
        branch: "ALL",
        sampleSize: 1,
        winRate: 1,
        avgPnl: 800,
        totalPnl: 800,
        experimental: true as const,
        label: "…",
        reportable: false,
        synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
      },
      byBranch: [
        {
          branch: "BUY_CE",
          sampleSize: 1,
          winRate: 1,
          avgPnl: 800,
          totalPnl: 800,
          experimental: true as const,
          label: "…",
          reportable: false,
          synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
        },
      ],
      byLaneLean: [],
      orderedSampleSize: 1,
      edgeReportable: false,
      note: "…",
    },
    legacy: {
      synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
      overall: {
        branch: "ALL",
        sampleSize: 2,
        winRate: 0.5,
        avgPnl: 250,
        totalPnl: 500,
        experimental: true as const,
        label: "…",
        reportable: false,
        synthesisVersion: SYNTHESIS_VERSION.LEGACY_2LANE,
      },
      byBranch: [],
      byLaneLean: [],
      orderedSampleSize: 2,
      edgeReportable: false,
      note: "…",
    },
    overall: {
      branch: "ALL",
      sampleSize: 1,
      winRate: 1,
      avgPnl: 800,
      totalPnl: 800,
      experimental: true as const,
      label: "…",
      reportable: false,
      synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
    },
    byBranch: [],
    byLaneLean: [],
    orderedSampleSize: 1,
    methodology: "…",
    audit: {
      legacySampleSize: 2,
      currentSampleSize: 1,
      legacyWinRatePct: 50,
      currentWinRatePct: 100,
    },
    sampleStatus: {
      synthesisVersion: SYNTHESIS_VERSION.FOUR_LANE,
      reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
      combined: {
        mode: "ALL" as const,
        resolvedCount: 1,
        reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
        isReportable: false,
        regimesTotal: 3 as const,
      },
      byMode: {
        SCALP: {
          mode: "SCALP" as const,
          resolvedCount: 0,
          reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
          isReportable: false,
          regimesTotal: 3 as const,
        },
        SWING: {
          mode: "SWING" as const,
          resolvedCount: 1,
          reportableThreshold: MIN_SAMPLE_FOR_EDGE_REPORT,
          isReportable: false,
          regimesTotal: 3 as const,
        },
      },
      regimeTagged: false,
      informationalOnly: true as const,
      note: "…",
    },
  };

  const edge = edgeFromTrackRecord(
    fakeTrack as Parameters<typeof edgeFromTrackRecord>[0],
    "BUY_CE",
  );
  assert(edge.winRatePct === null, "insufficient current sample must hide win rate");
  assert(edge.insufficientSample === true, "must flag insufficientSample");
  assert(edge.sampleSize === 1, "sampleSize is post-4-lane only");
  assert(edge.legacySampleSize === 2, "legacy size reported separately");
  assert(
    !/%\s*experimental/.test(String(edge.winRatePct)),
    "must not encode a legacy win % as current",
  );
  assert(
    /legacy/i.test(edge.label) || /insufficient/i.test(edge.label),
    "label must explain insufficient / legacy exclusion",
  );

  console.log("partition / edge assertions passed.\n");
  console.log(
    `Before/after audit (fixture): legacy n=2 (~50% win) vs post-4-lane n=1 (too small to report as current edge).`,
  );
}

function main() {
  testInfer();
  testPartitionNoLeak();
  console.log("All backtest cohort tests passed.");
}

main();
