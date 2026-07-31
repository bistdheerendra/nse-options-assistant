import {
  MACRO_COMPONENT_WEIGHTS,
  scoreMacroQuotes,
  type MacroQuote,
} from "../src/lib/lanes/macro";
import {
  SENTIMENT_COMPONENT_WEIGHTS,
  scoreSentiment,
} from "../src/lib/lanes/sentiment";
import { runOptionsFlowLane } from "../src/lib/lanes/optionsFlow";
import { runTechnicalLane } from "../src/lib/lanes/technical";
import type { FiiDiiSnapshot } from "../src/lib/marketdata/fiiDii";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function q(
  id: string,
  changePct: number,
  price = 100,
  group: MacroQuote["group"] = "fx",
): MacroQuote {
  return {
    id,
    label: id,
    group,
    country: null,
    price,
    change: (changePct / 100) * price,
    changePct,
    currency: "INR",
    source: "test",
    note: null,
  };
}

function flow(fiiNet: number, diiNet: number): FiiDiiSnapshot {
  return {
    date: "test",
    fiiBuy: Math.max(fiiNet, 0) + 1000,
    fiiSell: Math.max(-fiiNet, 0) + 1000,
    fiiNet,
    diiBuy: Math.max(diiNet, 0) + 1000,
    diiSell: Math.max(-diiNet, 0) + 1000,
    diiNet,
    source: "test",
    note: null,
  };
}

function testMacroScoring() {
  console.log("=== Macro lane scoring (pure, no network) ===");

  const weightSum = Object.values(MACRO_COMPONENT_WEIGHTS).reduce(
    (a, b) => a + b,
    0,
  );
  assert(Math.abs(weightSum - 1) < 1e-9, `weights must sum to 1, got ${weightSum}`);

  const bearish = scoreMacroQuotes({
    quotes: [
      q("INDIAVIX", 8, 18, "vix"),
      q("USDINR", 0.5, 84, "fx"),
      q("GIFTNIFTY", -0.4, 25000, "gift"),
      q("DJI", -0.8, 39000, "us"),
      q("IXIC", -1.0, 17000, "us"),
      q("GSPC", -0.7, 5200, "us"),
      q("CL", 2.5, 80, "commodities"),
      q("BZ", 2.2, 85, "commodities"),
      q("DXY", 0.6, 104, "fx"),
    ],
    mode: "SWING",
  });
  console.log(
    "bearish scenario:",
    JSON.stringify(
      { score: bearish.score, signals: bearish.signals, breakdown: bearish.breakdown },
      null,
      2,
    ),
  );
  assert(bearish.score < -0.15, `expected bearish lean, got ${bearish.score}`);
  assert(
    bearish.signals.some((s) => /VIX.*risk-off/i.test(s)),
    "expected India VIX risk-off signal",
  );
  assert(
    bearish.signals.some((s) => /INR weak/i.test(s)),
    "expected USD/INR weakness signal",
  );

  const bullish = scoreMacroQuotes({
    quotes: [
      q("INDIAVIX", -6, 12, "vix"),
      q("USDINR", -0.3, 83.5, "fx"),
      q("GIFTNIFTY", 0.8, 25200, "gift"),
      q("DJI", 0.9, 40000, "us"),
      q("IXIC", 1.2, 17500, "us"),
      q("GSPC", 0.8, 5300, "us"),
      q("CL", -1.5, 78, "commodities"),
      q("BZ", -1.4, 82, "commodities"),
      q("DXY", -0.4, 103, "fx"),
    ],
    mode: "SWING",
  });
  console.log(
    "bullish scenario:",
    JSON.stringify(
      { score: bullish.score, signals: bullish.signals, breakdown: bullish.breakdown },
      null,
      2,
    ),
  );
  assert(bullish.score > 0.15, `expected bullish lean, got ${bullish.score}`);
  assert(
    bullish.signals.some((s) => /VIX.*risk-on/i.test(s)),
    "expected India VIX risk-on signal",
  );
  assert(
    bullish.signals.some((s) => /Gift Nifty premium/i.test(s)),
    "expected Gift Nifty premium signal",
  );

  const empty = scoreMacroQuotes({ quotes: [] });
  assert(empty.score === 0, "empty quotes score must be 0");
  assert(
    empty.signals.includes("macro data unavailable"),
    "empty quotes must signal unavailable",
  );

  console.log("Macro scoring assertions passed.\n");
}

function testSentimentScoring() {
  console.log("=== Sentiment lane scoring (pure, no network) ===");

  const weightSum = Object.values(SENTIMENT_COMPONENT_WEIGHTS).reduce(
    (a, b) => a + b,
    0,
  );
  assert(
    Math.abs(weightSum - 1) < 1e-9,
    `sentiment weights must sum to 1, got ${weightSum}`,
  );

  const bullish = scoreSentiment({
    fiiDii: flow(2500, 800),
    newsTitles: [
      "Nifty surges to record high on strong FII buying",
      "Sensex rallies as RBI signals rate cut optimism",
      "India markets gain on growth beat",
      "IT stocks jump on upgrade",
    ],
    mode: "SWING",
  });
  console.log(
    "sentiment bullish:",
    JSON.stringify(
      { score: bullish.score, signals: bullish.signals, breakdown: bullish.breakdown },
      null,
      2,
    ),
  );
  assert(bullish.score > 0.15, `expected bullish sentiment, got ${bullish.score}`);
  assert(
    bullish.signals.some((s) => /FII net bought/i.test(s)),
    "expected FII buy signal",
  );
  assert(
    bullish.signals.some((s) => /News flow:.*bullish/i.test(s)),
    "expected news flow signal",
  );

  const bearish = scoreSentiment({
    fiiDii: flow(-2200, -400),
    newsTitles: [
      "Nifty plunges as FII sell-off deepens",
      "Sensex crashes on hawkish RBI tone",
      "India markets tumble amid tariff fears",
      "Bank stocks fall on downgrade",
    ],
    mode: "SWING",
  });
  console.log(
    "sentiment bearish:",
    JSON.stringify(
      { score: bearish.score, signals: bearish.signals, breakdown: bearish.breakdown },
      null,
      2,
    ),
  );
  assert(bearish.score < -0.15, `expected bearish sentiment, got ${bearish.score}`);
  assert(
    bearish.signals.some((s) => /FII net sold/i.test(s)),
    "expected FII sell signal",
  );

  const newsOnly = scoreSentiment({
    fiiDii: null,
    newsTitles: [
      "Nifty surges on stimulus hopes",
      "Sensex rallies after RBI dovish remarks",
    ],
    mode: "SWING",
  });
  assert(
    newsOnly.score !== 0,
    `partial news-only score should be non-zero, got ${newsOnly.score}`,
  );
  assert(
    newsOnly.signals.some((s) => /FII\/DII flow unavailable/i.test(s)),
    "expected FII/DII gap flag",
  );
  assert(!newsOnly.rawIndicators.unavailable, "partial run must not mark unavailable");

  const flowOnly = scoreSentiment({
    fiiDii: flow(-1800, 500),
    newsTitles: null,
    mode: "SWING",
  });
  assert(
    flowOnly.score !== 0,
    `partial FII-only score should be non-zero, got ${flowOnly.score}`,
  );
  assert(
    flowOnly.signals.some((s) => /News headlines unavailable/i.test(s)),
    "expected news gap flag",
  );

  const empty = scoreSentiment({ fiiDii: null, newsTitles: null });
  assert(empty.score === 0, "empty sentiment score must be 0");
  assert(
    empty.signals.includes("sentiment data unavailable"),
    "empty must signal unavailable",
  );

  console.log("Sentiment scoring assertions passed.\n");
}

async function main() {
  testMacroScoring();
  testSentimentScoring();

  const underlying = "NIFTY" as const;
  console.log("=== Technical lane (SWING) ===");
  const tech = await runTechnicalLane({ underlying, mode: "SWING" });
  console.log(JSON.stringify(tech, null, 2));

  console.log("\n=== Options Flow lane (SWING) ===");
  const flowLane = await runOptionsFlowLane({ underlying, mode: "SWING" });
  console.log(JSON.stringify(flowLane, null, 2));

  console.log("\n=== Technical lane (SCALP) ===");
  const techScalp = await runTechnicalLane({ underlying, mode: "SCALP" });
  console.log(
    JSON.stringify(
      { score: techScalp.score, signals: techScalp.signals },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
