/**
 * Large-order *inference* from SnapQuote best-5 book snapshots.
 *
 * Angel does not expose individual orders. We only see aggregated qty +
 * order-count at a price. A "large order" here is a size jump vs a rolling
 * baseline — never label this as a confirmed placed order or trade.
 */

import type { Underlying } from "@/lib/marketdata/angelone/types";

export type BookLevel = {
  price: number;
  qty: number;
  orders: number;
};

export type BookSnapshot = {
  bids: BookLevel[];
  asks: BookLevel[];
  totalBuyQty?: number;
  totalSellQty?: number;
};

/**
 * Relative spike vs rolling mean of qty at the same price.
 * Live NIFTY ATM±10 (2026-09-10, market hours): ordinary existing +Δqty often
 * already exceeds 3× prev; 5× is closer to the rare tail.
 */
export const LARGE_ORDER_MULT = 5;

/**
 * Absolute floor in Angel-reported depth quantity (F&O SnapQuote lots).
 * Live NIFTY ATM±10 30–45s windows (2026-09-10): existing +Δqty p50≈650–715,
 * p95≈4485–4745, p99≈7670–8580. Floor = p95 band rounded to 5000 (same
 * percentile method as the SWING price-slope threshold). 250 shipped as a
 * placeholder and matched ~75% of ordinary +Δqty.
 */
export const LARGE_ORDER_ABS_MIN = 5000;

/** Per token+side+price — resting icebergs would otherwise spam. */
export const LARGE_ORDER_COOLDOWN_SEC = 30;

/**
 * Cap toast/SSE rate across the whole ATM band. Token+price cooldown does not
 * help when L1 prices rotate and each new key looks like a fresh event.
 */
export const LARGE_ORDER_UNDERLYING_COOLDOWN_SEC = 12;

/** Prior qty samples kept per price for the rolling mean. */
export const LARGE_ORDER_ROLLING_WINDOW = 8;

/** Max inferred events emitted from one SnapQuote tick (anti-spam). */
export const LARGE_ORDER_MAX_PER_TICK = 2;

export type BookSide = "bid" | "ask";

export type OrderCountHint =
  | "likely_one_large_rest"
  | "many_smaller_orders"
  | "unclear";

export type LargeOrderEvent = {
  token: string;
  underlying?: Underlying;
  strike?: number;
  optionType?: "CE" | "PE";
  tradingsymbol?: string;
  side: BookSide;
  /** Book price where qty jumped (premium), not the index strike. */
  bookPrice: number;
  qtyNow: number;
  qtyPrev: number;
  /** Δqty = qtyNow − qtyPrev (positive rest added at this price). */
  deltaQty: number;
  rollingMean: number;
  /** qtyNow / rollingMean when mean > 0; else null (new at this price). */
  sizeMultiple: number | null;
  ordersNow: number;
  ordersPrev: number;
  deltaOrders: number;
  orderCountHint: OrderCountHint;
  inferred: true;
  disclaimer: string;
  alertText: string;
  capturedAt: number;
};

type LevelState = {
  qty: number;
  orders: number;
  recent: number[];
};

type TokenBookState = {
  seen: boolean;
  levels: Map<string, LevelState>;
  lastFiredAt: Map<string, number>;
};

const DISCLAIMER =
  "Inferred from a book size jump — not a confirmed individual order or trade.";

/** In-process prior books (single-instance, like oiVelocity). */
const byToken = new Map<string, TokenBookState>();
const lastUnderlyingFireAt = new Map<string, number>();

/** Escape hatch — SnapQuote parsing stays on; only inference/SSE emit stops. */
export function isLargeOrderDetectorEnabled(): boolean {
  return process.env.LARGE_ORDER_DETECTOR_ENABLED !== "false";
}

function priceKey(side: BookSide, price: number): string {
  return `${side}:${price.toFixed(2)}`;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function hintFor(deltaOrders: number, ordersNow: number): OrderCountHint {
  // Qty up with ~0–1 extra resting orders → more consistent with one large rest
  // (or an iceberg adding size). Many new orders → stack of smaller rests.
  if (deltaOrders <= 1) return "likely_one_large_rest";
  if (deltaOrders >= 5 || ordersNow >= 8) return "many_smaller_orders";
  return "unclear";
}

/**
 * Headline: "Large bid qty appeared at 24500 CE (~3.2× recent size, 1 order)"
 * Must stay inferred-language — never "order placed".
 */
export function formatLargeOrderAlertText(e: {
  side: BookSide;
  strike?: number;
  optionType?: "CE" | "PE";
  sizeMultiple: number | null;
  ordersNow: number;
  deltaOrders: number;
  orderCountHint: OrderCountHint;
}): string {
  const loc =
    e.strike != null && e.optionType
      ? `${e.strike} ${e.optionType}`
      : "watched contract";
  const sizeBit =
    e.sizeMultiple != null && Number.isFinite(e.sizeMultiple)
      ? `~${e.sizeMultiple.toFixed(1)}× recent size`
      : "new at this price";
  let orderBit: string;
  if (e.orderCountHint === "many_smaller_orders") {
    orderBit = `${e.ordersNow} orders (many smaller rests)`;
  } else if (e.deltaOrders <= 1 && e.ordersNow <= 1) {
    orderBit = "1 order";
  } else if (e.orderCountHint === "likely_one_large_rest") {
    orderBit =
      e.deltaOrders <= 0
        ? "same order count (size added)"
        : `${e.ordersNow} order${e.ordersNow === 1 ? "" : "s"}`;
  } else {
    orderBit = `${e.ordersNow} orders`;
  }
  return `Large ${e.side} qty appeared at ${loc} (${sizeBit}, ${orderBit})`;
}

function considerLevel(
  token: string,
  side: BookSide,
  level: BookLevel,
  state: TokenBookState,
  now: number,
): LargeOrderEvent | null {
  const key = priceKey(side, level.price);
  const prev = state.levels.get(key);
  const qtyPrev = prev?.qty ?? 0;
  const ordersPrev = prev?.orders ?? 0;
  // Baseline is prior samples only — the current spike is not in rollingMean.
  const rollingMean = mean(prev?.recent ?? []);
  // Δqty = qtyNow − qtyPrev at this price (0 if the price was absent last tick)
  const deltaQty = level.qty - qtyPrev;
  const deltaOrders = level.orders - ordersPrev;
  const cooldownUntil =
    (state.lastFiredAt.get(key) ?? 0) + LARGE_ORDER_COOLDOWN_SEC * 1000;

  const relativeGate = rollingMean > 0 ? LARGE_ORDER_MULT * rollingMean : 0;
  // New / re-entered top-5 prices have qtyPrev=0 and relativeGate=0. Live
  // sample: that path was ~84% of fires (1612/1912 in 30s) — seed, don't fire.
  const fires =
    qtyPrev > 0 &&
    rollingMean > 0 &&
    deltaQty > 0 &&
    deltaQty >= LARGE_ORDER_ABS_MIN &&
    deltaQty >= relativeGate &&
    now >= cooldownUntil;

  const recent = [...(prev?.recent ?? [])];
  recent.push(level.qty);
  if (recent.length > LARGE_ORDER_ROLLING_WINDOW) recent.shift();
  state.levels.set(key, {
    qty: level.qty,
    orders: level.orders,
    recent,
  });

  if (!fires) return null;

  state.lastFiredAt.set(key, now);
  const sizeMultiple =
    rollingMean > 0 ? Math.round((level.qty / rollingMean) * 10) / 10 : null;
  const orderCountHint = hintFor(deltaOrders, level.orders);
  const draft: LargeOrderEvent = {
    token,
    side,
    bookPrice: level.price,
    qtyNow: level.qty,
    qtyPrev,
    deltaQty,
    rollingMean: Math.round(rollingMean * 10) / 10,
    sizeMultiple,
    ordersNow: level.orders,
    ordersPrev,
    deltaOrders,
    orderCountHint,
    inferred: true,
    disclaimer: DISCLAIMER,
    alertText: "",
    capturedAt: now,
  };
  draft.alertText = formatLargeOrderAlertText(draft);
  return draft;
}

function seedLevels(state: TokenBookState, book: BookSnapshot) {
  const seed = (side: BookSide, levels: BookLevel[]) => {
    for (const lv of levels) {
      if (lv.qty <= 0 || lv.price <= 0) continue;
      state.levels.set(priceKey(side, lv.price), {
        qty: lv.qty,
        orders: lv.orders,
        recent: [lv.qty],
      });
    }
  };
  seed("bid", book.bids);
  seed("ask", book.asks);
}

/**
 * Ingest one parsed SnapQuote book (per token). First snapshot for a token
 * establishes the baseline and never fires. Empty/missing books → no events
 * (status equivalent to unavailable — never fabricated).
 */
export function ingestSnapQuoteBook(
  token: string,
  book: BookSnapshot | undefined | null,
  now = Date.now(),
): LargeOrderEvent[] {
  if (!isLargeOrderDetectorEnabled()) return [];
  if (!token || !book) return [];
  const hasLevels = book.bids.length > 0 || book.asks.length > 0;
  if (!hasLevels) return [];

  let state = byToken.get(token);
  if (!state) {
    state = {
      seen: false,
      levels: new Map(),
      lastFiredAt: new Map(),
    };
    byToken.set(token, state);
  }

  if (!state.seen) {
    seedLevels(state, book);
    state.seen = true;
    return [];
  }

  const candidates: LargeOrderEvent[] = [];
  for (const lv of book.bids) {
    if (lv.qty <= 0 || lv.price <= 0) continue;
    const ev = considerLevel(token, "bid", lv, state, now);
    if (ev) candidates.push(ev);
  }
  for (const lv of book.asks) {
    if (lv.qty <= 0 || lv.price <= 0) continue;
    const ev = considerLevel(token, "ask", lv, state, now);
    if (ev) candidates.push(ev);
  }

  // Prices that dropped off the book: keep history so a re-entry isn't a
  // false "new at this price" after one missing tick, but cap map growth.
  if (state.levels.size > 40) {
    const live = new Set([
      ...book.bids.map((l) => priceKey("bid", l.price)),
      ...book.asks.map((l) => priceKey("ask", l.price)),
    ]);
    for (const key of [...state.levels.keys()]) {
      if (!live.has(key)) state.levels.delete(key);
    }
  }

  candidates.sort((a, b) => b.deltaQty - a.deltaQty);
  return candidates.slice(0, LARGE_ORDER_MAX_PER_TICK);
}

export function pruneLargeOrderTokens(activeTokens: Set<string>) {
  for (const token of [...byToken.keys()]) {
    if (!activeTokens.has(token)) byToken.delete(token);
  }
}

/**
 * At most one SSE/toast per underlying per window. Detector may still produce
 * 1–2 candidates per tick; the hub calls this before emit.
 */
export function takeUnderlyingRateLimited<T extends LargeOrderEvent>(
  underlying: string,
  events: T[],
  now = Date.now(),
): T[] {
  if (!events.length) return [];
  const last = lastUnderlyingFireAt.get(underlying) ?? 0;
  // last=0 means never fired (do not treat epoch-0 as "fired 12s ago").
  if (last > 0 && now - last < LARGE_ORDER_UNDERLYING_COOLDOWN_SEC * 1000) {
    return [];
  }
  lastUnderlyingFireAt.set(underlying, now);
  return events.slice(0, 1);
}

export function clearLargeOrderStore() {
  byToken.clear();
  lastUnderlyingFireAt.clear();
}
