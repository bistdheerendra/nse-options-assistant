import { computeTrackRecord } from "../src/lib/backtest/trackRecord";

async function main() {
  const t = await computeTrackRecord();
  console.log(
    JSON.stringify(
      {
        audit: t.audit,
        currentNote: t.current.note,
        legacyNote: t.legacy.note,
        legacyOverall: {
          n: t.legacy.overall.sampleSize,
          winPct: Math.round(t.legacy.overall.winRate * 100),
        },
        currentOverall: {
          n: t.current.overall.sampleSize,
          winPct: Math.round(t.current.overall.winRate * 100),
          reportable: t.current.edgeReportable,
        },
        byLaneLeanCurrent: t.current.byLaneLean.map((c) => c.branch),
        byLaneLeanLegacy: t.legacy.byLaneLean.map((c) => c.branch),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
