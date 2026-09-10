/**
 * SnapQuote best-5 unpack + large-order inference (no fabrication).
 * Usage: npx tsx scripts/test-large-order.ts
 */
import {
  parseAngelBinaryPacket,
  parseSnapQuoteBook,
} from "../src/lib/marketdata/angelone/websocketFeed";
import {
  LARGE_ORDER_ABS_MIN,
  LARGE_ORDER_MULT,
  LARGE_ORDER_UNDERLYING_COOLDOWN_SEC,
  clearLargeOrderStore,
  formatLargeOrderAlertText,
  ingestSnapQuoteBook,
  takeUnderlyingRateLimited,
  type LargeOrderEvent,
} from "../src/lib/marketdata/largeOrder";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function writeLevel(
  buf: Buffer,
  index: number,
  level: { flag: 0 | 1; qty: number; price: number; orders: number },
) {
  const off = 147 + index * 20;
  buf.writeUInt16LE(level.flag, off);
  buf.writeBigInt64LE(BigInt(level.qty), off + 2);
  buf.writeBigInt64LE(BigInt(Math.round(level.price * 100)), off + 10);
  buf.writeUInt16LE(level.orders, off + 18);
}

function snapQuotePacket(opts: {
  token: string;
  ltp: number;
  totalBuy: number;
  totalSell: number;
  oi: number;
  levels: Array<{ flag: 0 | 1; qty: number; price: number; orders: number }>;
}): Buffer {
  const buf = Buffer.alloc(379);
  buf.writeInt8(3, 0);
  buf.writeUInt8(2, 1);
  Buffer.from(opts.token).copy(buf, 2);
  buf.writeBigInt64LE(BigInt(1), 27);
  buf.writeBigInt64LE(BigInt(Date.now()), 35);
  const paise = BigInt(Math.round(opts.ltp * 100));
  buf.writeBigInt64LE(paise, 43);
  buf.writeBigInt64LE(BigInt(10), 51);
  buf.writeBigInt64LE(paise, 59);
  buf.writeBigInt64LE(BigInt(5_000), 67);
  buf.writeDoubleLE(opts.totalBuy, 75);
  buf.writeDoubleLE(opts.totalSell, 83);
  buf.writeBigInt64LE(paise, 91);
  buf.writeBigInt64LE(paise, 99);
  buf.writeBigInt64LE(paise, 107);
  buf.writeBigInt64LE(paise, 115);
  buf.writeBigInt64LE(BigInt(0), 123);
  buf.writeBigInt64LE(BigInt(opts.oi), 131);
  buf.writeBigInt64LE(BigInt(0), 139);
  opts.levels.forEach((lv, i) => writeLevel(buf, i, lv));
  return buf;
}

// ── Parser: LTP/OI unchanged + book unpacked ──────────────────────────────
const pkt = snapQuotePacket({
  token: "55555",
  ltp: 120.5,
  totalBuy: 1_200,
  totalSell: 800,
  oi: 42_000,
  levels: [
    { flag: 1, qty: 100, price: 120.0, orders: 2 },
    { flag: 1, qty: 80, price: 119.5, orders: 1 },
    { flag: 0, qty: 90, price: 121.0, orders: 3 },
  ],
});
const parsed = parseAngelBinaryPacket(pkt);
assert(parsed != null, "SnapQuote packet must parse");
assert(parsed!.ltp === 120.5, `ltp ${parsed!.ltp}`);
assert(parsed!.oi === 42_000, `oi ${parsed!.oi}`);
assert(parsed!.book?.totalBuyQty === 1_200, `totBuy ${parsed!.book?.totalBuyQty}`);
assert(parsed!.book?.totalSellQty === 800, `totSell ${parsed!.book?.totalSellQty}`);
assert(parsed!.book?.bids[0]?.price === 120, `bid px ${parsed!.book?.bids[0]?.price}`);
assert(parsed!.book?.bids[0]?.qty === 100, `bid qty ${parsed!.book?.bids[0]?.qty}`);
assert(parsed!.book?.asks[0]?.price === 121, `ask px ${parsed!.book?.asks[0]?.price}`);
const bookOnly = parseSnapQuoteBook(pkt);
assert(bookOnly?.bids.length === 2, "two bid levels");

const quoteOnly = Buffer.alloc(123);
quoteOnly.writeInt8(2, 0);
quoteOnly.writeInt8(1, 1);
Buffer.from("99926000").copy(quoteOnly, 2);
quoteOnly.writeBigInt64LE(BigInt(0), 27);
quoteOnly.writeBigInt64LE(BigInt(Date.now()), 35);
quoteOnly.writeBigInt64LE(BigInt(2438360), 43);
quoteOnly.writeBigInt64LE(BigInt(2431715), 115);
const q = parseAngelBinaryPacket(quoteOnly);
assert(q?.ltp === 24383.6, `quote ltp ${q?.ltp}`);
assert(q?.book === undefined, "Quote mode must not invent a SnapQuote book");

// ── Detector ──────────────────────────────────────────────────────────────
clearLargeOrderStore();
assert(
  ingestSnapQuoteBook("t1", { bids: [], asks: [] }).length === 0,
  "empty book → no event",
);

const baseline = {
  bids: [{ price: 12.5, qty: 100, orders: 2 }],
  asks: [{ price: 12.7, qty: 90, orders: 2 }],
};
assert(ingestSnapQuoteBook("t1", baseline).length === 0, "first snapshot warms up");

assert(
  ingestSnapQuoteBook("t1", baseline).length === 0,
  "unchanged book must not fire",
);

const spiked = {
  bids: [{ price: 12.5, qty: 100 + LARGE_ORDER_ABS_MIN + 50, orders: 3 }],
  asks: baseline.asks,
};
const fired = ingestSnapQuoteBook("t1", spiked);
assert(fired.length === 1, `expected 1 event, got ${fired.length}`);
assert(fired[0]!.inferred === true, "must be labeled inferred");
assert(fired[0]!.side === "bid", fired[0]!.side);
assert(fired[0]!.deltaQty === LARGE_ORDER_ABS_MIN + 50, `Δ ${fired[0]!.deltaQty}`);
assert(fired[0]!.rollingMean === 100, `mean ${fired[0]!.rollingMean}`);
assert(
  fired[0]!.deltaQty >= LARGE_ORDER_MULT * fired[0]!.rollingMean,
  "relative gate",
);
assert(fired[0]!.disclaimer.toLowerCase().includes("not a confirmed"), "disclaimer");

const cooled = ingestSnapQuoteBook("t1", {
  bids: [
    {
      price: 12.5,
      qty: 100 + LARGE_ORDER_ABS_MIN + 50 + LARGE_ORDER_ABS_MIN,
      orders: 3,
    },
  ],
  asks: baseline.asks,
});
assert(cooled.length === 0, "cooldown must suppress");

clearLargeOrderStore();
ingestSnapQuoteBook("t2", baseline);
const tooSmall = ingestSnapQuoteBook("t2", {
  bids: [{ price: 12.5, qty: 150, orders: 2 }],
  asks: baseline.asks,
});
assert(tooSmall.length === 0, "Δ below ABS_MIN must not fire");

clearLargeOrderStore();
ingestSnapQuoteBook("t3", baseline);
const newPrice = ingestSnapQuoteBook("t3", {
  bids: [
    ...baseline.bids,
    { price: 13.5, qty: 200, orders: 1 },
  ],
  asks: baseline.asks,
});
assert(newPrice.length === 0, "new book price must seed, not fire");
const jumpedNew = ingestSnapQuoteBook("t3", {
  bids: [
    ...baseline.bids,
    { price: 13.5, qty: 200 + LARGE_ORDER_ABS_MIN, orders: 1 },
  ],
  asks: baseline.asks,
});
assert(jumpedNew.length === 1, `seeded price jump should fire, got ${jumpedNew.length}`);
assert(jumpedNew[0]!.qtyPrev === 200, "prev is seed qty");
assert(jumpedNew[0]!.rollingMean === 200, "mean excludes spike");

const stub = [{ deltaQty: 9000 } as LargeOrderEvent];
clearLargeOrderStore();
assert(takeUnderlyingRateLimited("NIFTY", stub, 1_000).length === 1, "first emit");
assert(
  takeUnderlyingRateLimited("NIFTY", stub, 2_000).length === 0,
  "underlying cooldown",
);
assert(
  takeUnderlyingRateLimited(
    "NIFTY",
    stub,
    1_000 + LARGE_ORDER_UNDERLYING_COOLDOWN_SEC * 1000,
  ).length === 1,
  "underlying cooldown elapsed",
);
assert(
  takeUnderlyingRateLimited("BANKNIFTY", stub, 2_000).length === 1,
  "other underlying independent",
);

const prevFlag = process.env.LARGE_ORDER_DETECTOR_ENABLED;
process.env.LARGE_ORDER_DETECTOR_ENABLED = "false";
clearLargeOrderStore();
assert(
  ingestSnapQuoteBook("t-off", spiked).length === 0,
  "feature flag disables detector",
);
if (prevFlag === undefined) delete process.env.LARGE_ORDER_DETECTOR_ENABLED;
else process.env.LARGE_ORDER_DETECTOR_ENABLED = prevFlag;

const headline = formatLargeOrderAlertText({
  side: "bid",
  strike: 24500,
  optionType: "CE",
  sizeMultiple: 3.2,
  ordersNow: 1,
  deltaOrders: 1,
  orderCountHint: "likely_one_large_rest",
});
assert(
  headline === "Large bid qty appeared at 24500 CE (~3.2× recent size, 1 order)",
  headline,
);

console.log("test-large-order: all passed", {
  parsedLtp: parsed!.ltp,
  parsedOi: parsed!.oi,
  sampleAlert: fired[0]!.alertText,
  sampleDelta: fired[0]!.deltaQty,
  sampleMean: fired[0]!.rollingMean,
  headline,
});
