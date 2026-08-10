/**
 * Pure helpers for paper → track-record bridge.
 * Run: npx tsx scripts/test-paper-outcome-bridge.ts
 */
import {
  alreadyRecordedOutcomeId,
  laneScoresFromFeatureSnapshot,
  tradeIdeaIdFromSnapshot,
  TRACK_RECORD_OUTCOME_ID_KEY,
} from "../src/lib/backtest/paperOutcomeBridge";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  tradeIdeaIdFromSnapshot({ tradeIdeaId: "abc" }) === "abc",
  "reads tradeIdeaId",
);
assert(tradeIdeaIdFromSnapshot({ risk: {} }) === null, "missing idea → null");
assert(tradeIdeaIdFromSnapshot(null) === null, "null snap → null");

assert(
  alreadyRecordedOutcomeId({
    [TRACK_RECORD_OUTCOME_ID_KEY]: "paper_x",
  }) === "paper_x",
  "reads outcome stamp",
);
assert(
  alreadyRecordedOutcomeId({ tradeIdeaId: "abc" }) === null,
  "no stamp → null",
);

const scores = laneScoresFromFeatureSnapshot({
  lanes: {
    technical: { score: 0.4 },
    optionsFlow: { score: -0.2 },
    macro: { score: 0.1 },
    sentiment: { score: 0 },
  },
});
assert(scores.technical === 0.4, "technical score");
assert(scores.optionsFlow === -0.2, "optionsFlow score");
assert(scores.macro === 0.1, "macro score");
assert(scores.sentiment === 0, "sentiment zero kept");

assert(
  Object.keys(laneScoresFromFeatureSnapshot({})).length === 0,
  "empty snapshot → empty scores",
);

console.log("paper-outcome-bridge assertions passed.");
