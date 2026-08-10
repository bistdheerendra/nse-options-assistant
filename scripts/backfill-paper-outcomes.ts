/**
 * Backfill BacktestOutcome from closed paper positions with tradeIdeaId.
 * Run: npx tsx scripts/backfill-paper-outcomes.ts
 */
import { backfillPaperTrackOutcomes } from "../src/lib/paperTrading/account";

async function main() {
  const result = await backfillPaperTrackOutcomes();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
