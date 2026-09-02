/**
 * Live mark lookup for open paper rows across underlyings.
 * Run: npx tsx scripts/test-position-marks.ts
 */
import {
  markPremiumFromMap,
  marksRecordForPositions,
  matchChainContract,
  positionMarkKeys,
  resolveLiveMark,
  type ChainContractRef,
  type PositionMarkRef,
} from "../src/lib/paperTrading/positionMarkLookup";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const nifty: PositionMarkRef = {
  underlying: "NIFTY",
  strike: 23900,
  optionType: "PE",
  symbolToken: "tok-n",
  tradingSymbol: "NIFTY08SEP2623900PE",
};

const bank: PositionMarkRef = {
  underlying: "BANKNIFTY",
  strike: 57200,
  optionType: "PE",
  symbolToken: "tok-b",
  tradingSymbol: "BANKNIFTY29SEP2657200PE",
};

const niftyChain: ChainContractRef[] = [
  {
    strike: 23900,
    optionType: "PE",
    tradingsymbol: "NIFTY08SEP2623900PE",
    symboltoken: "tok-n",
    ltp: 135.2,
  },
];

assert(
  positionMarkKeys(nifty).includes("NIFTY08SEP2623900PE"),
  "tradingSymbol key",
);
assert(positionMarkKeys(nifty).includes("token:tok-n"), "token key");
assert(
  positionMarkKeys(nifty).includes("NIFTY-23900-PE"),
  "fallback underlying-strike-type key",
);

const fromChain = resolveLiveMark(nifty, niftyChain, {}, "NIFTY");
assert(fromChain === 135.2, `NIFTY mark from selected chain, got ${fromChain}`);

const bankMissing = resolveLiveMark(bank, niftyChain, {}, "NIFTY");
assert(
  bankMissing === null,
  `BANKNIFTY must not pick a NIFTY chain LTP, got ${bankMissing}`,
);

const polled = { "BANKNIFTY29SEP2657200PE": 640.5, "token:tok-b": 640.5 };
const bankPolled = resolveLiveMark(bank, niftyChain, polled, "NIFTY");
assert(bankPolled === 640.5, `BANKNIFTY mark from poll, got ${bankPolled}`);

const combined = marksRecordForPositions(
  [nifty, bank],
  niftyChain,
  polled,
  "NIFTY",
);
assert(combined["NIFTY08SEP2623900PE"] === 135.2, "combined NIFTY prefers chain");
assert(
  combined["BANKNIFTY29SEP2657200PE"] === 640.5,
  "combined BANKNIFTY from poll",
);

const chainWins = resolveLiveMark(
  nifty,
  niftyChain,
  { "NIFTY08SEP2623900PE": 999 },
  "NIFTY",
);
assert(chainWins === 135.2, "SSE chain LTP wins over stale poll");

const legacy: PositionMarkRef = {
  underlying: "BANKNIFTY",
  strike: 57200,
  optionType: "PE",
};
assert(
  resolveLiveMark(legacy, niftyChain, {}, "NIFTY") === null,
  "legacy row without token must not match another underlying's strike",
);

assert(
  markPremiumFromMap(bank, polled) === 640.5,
  "map lookup by tradingSymbol",
);

const nseId = {
  ...bank,
  expiry: "2026-09-29",
};
const nseChain: ChainContractRef[] = [
  {
    strike: 57200,
    optionType: "PE",
    tradingsymbol: "OPTIDXBANKNIFTY29-09-2026PE57200.00",
    symboltoken: "OPTIDXBANKNIFTY29-09-2026PE57200.00",
    ltp: 641.1,
    expiry: "2026-09-29",
  },
];
assert(
  matchChainContract(nseId, nseChain)?.ltp === 641.1,
  "match NSE identifier / strike+expiry on that chain",
);

console.log("position-marks assertions passed.");
