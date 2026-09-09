import { getOptionChain } from "@/lib/marketdata/angelone";
import { isDemoMarketDataMode } from "@/lib/marketdata/angelone/auth";
import { resolveAtmOptionTokens } from "@/lib/marketdata/angelone/optionTokens";
import type {
  OptionChainResult,
  OptionContractQuote,
  Underlying,
} from "@/lib/marketdata/angelone/types";
import {
  angelWebsocketFeed,
  type AngelFeedStatus,
  type AngelOptionTick,
} from "@/lib/marketdata/angelone/websocketFeed";
import {
  clearLargeOrderStore,
  formatLargeOrderAlertText,
  ingestSnapQuoteBook,
  pruneLargeOrderTokens,
  type LargeOrderEvent,
} from "@/lib/marketdata/largeOrder";

export type LiveOptionChainSnapshot = OptionChainResult & {
  ok: true;
  fetchedAt: string;
  feed: "angel-ws" | "rest" | "demo";
  wsStatus: AngelFeedStatus;
  /** Tokens currently subscribed on Angel WS (ATM band). */
  subscribedTokens: number;
};

export type LiveOptionChainError = {
  ok: false;
  fetchedAt: string;
  underlying: Underlying;
  error: string;
  uiHint?: string;
  wsStatus: AngelFeedStatus;
};

export type LiveOptionChainPayload =
  | LiveOptionChainSnapshot
  | LiveOptionChainError;

export type LargeOrderAlert = LargeOrderEvent & {
  underlying: Underlying;
};

type Listener = (payload: LiveOptionChainPayload) => void;
type LargeOrderListener = (event: LargeOrderAlert) => void;

/** Full REST refresh for structure / far strikes / IV. */
const SNAPSHOT_MS = 20_000;
/** When WS down / demo — poll REST near-live. */
const REST_FALLBACK_MS = 2_000;
/** Re-resolve ATM tokens when spot drifts. */
const TOKEN_REFRESH_MS = 60_000;

type UnderlyingState = {
  listeners: Set<Listener>;
  largeOrderListeners: Set<LargeOrderListener>;
  chain: OptionChainResult | null;
  /** Angel token → strike/type for patch matching (NSE OC uses non-Angel ids). */
  tokenMeta: Map<
    string,
    { strike: number; optionType: "CE" | "PE"; tradingsymbol: string }
  >;
  last: LiveOptionChainPayload | null;
  snapTimer: ReturnType<typeof setTimeout> | null;
  tokenTimer: ReturnType<typeof setTimeout> | null;
  snapInFlight: boolean;
  feed: LiveOptionChainSnapshot["feed"];
};

/**
 * In-process option-chain hub.
 * REST snapshot + Angel SmartAPI WS SnapQuote ticks for ATM ±10 CE/PE.
 */
class LiveOptionChainHub {
  private byUnderlying = new Map<Underlying, UnderlyingState>();
  private releaseAngel: (() => void) | null = null;
  private unsubOption: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;
  private wsStatus: AngelFeedStatus = "idle";
  private angelBound = false;
  /** Coalesce rapid option ticks before SSE broadcast (~10 Hz max). */
  private pendingTicks = new Map<string, AngelOptionTick>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(
    underlying: Underlying,
    listener: Listener,
  ): () => void {
    let state = this.byUnderlying.get(underlying);
    if (!state) {
      state = {
        listeners: new Set(),
        largeOrderListeners: new Set(),
        chain: null,
        tokenMeta: new Map(),
        last: null,
        snapTimer: null,
        tokenTimer: null,
        snapInFlight: false,
        feed: "rest",
      };
      this.byUnderlying.set(underlying, state);
    }
    state.listeners.add(listener);
    if (state.last) listener(state.last);

    this.ensureAngelBound();
    void this.bootstrap(underlying);

    return () => {
      const s = this.byUnderlying.get(underlying);
      if (!s) return;
      s.listeners.delete(listener);
      if (s.listeners.size === 0 && s.largeOrderListeners.size === 0) {
        this.teardownUnderlying(underlying);
      }
      if (this.totalListeners() === 0) {
        this.unbindAngel();
      }
    };
  }

  subscribeLargeOrder(
    underlying: Underlying,
    listener: LargeOrderListener,
  ): () => void {
    const state = this.byUnderlying.get(underlying);
    if (!state) {
      // Chain SSE always subscribe()s first; no-op if called alone.
      return () => undefined;
    }
    state.largeOrderListeners.add(listener);
    return () => {
      const s = this.byUnderlying.get(underlying);
      if (!s) return;
      s.largeOrderListeners.delete(listener);
      if (s.listeners.size === 0 && s.largeOrderListeners.size === 0) {
        this.teardownUnderlying(underlying);
      }
      if (this.totalListeners() === 0) {
        this.unbindAngel();
      }
    };
  }

  private totalListeners(): number {
    let n = 0;
    for (const s of this.byUnderlying.values()) {
      n += s.listeners.size + s.largeOrderListeners.size;
    }
    return n;
  }

  private ensureAngelBound() {
    if (this.angelBound || isDemoMarketDataMode()) {
      if (isDemoMarketDataMode()) this.wsStatus = "demo";
      return;
    }
    this.angelBound = true;
    this.releaseAngel = angelWebsocketFeed.acquire();
    this.unsubOption = angelWebsocketFeed.onOptionTick((tick) => {
      this.detectLargeOrders(tick);
      this.queueOptionTick(tick);
    });
    this.unsubStatus = angelWebsocketFeed.onStatus((s) => {
      this.wsStatus = s;
    });
  }

  private unbindAngel() {
    this.unsubOption?.();
    this.unsubOption = null;
    this.unsubStatus?.();
    this.unsubStatus = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingTicks.clear();
    clearLargeOrderStore();
    angelWebsocketFeed.setOptionSubscriptions([]);
    this.releaseAngel?.();
    this.releaseAngel = null;
    this.angelBound = false;
    this.wsStatus = "idle";
  }

  /**
   * Infer large rests on the raw SnapQuote tick (before 100ms coalesce)
   * so two book updates in one flush window are not merged/missed.
   */
  private detectLargeOrders(tick: AngelOptionTick) {
    if (isDemoMarketDataMode()) return;
    if (!tick.book || (!tick.book.bids.length && !tick.book.asks.length)) return;

    const events = ingestSnapQuoteBook(tick.token, tick.book, tick.receivedAt);
    if (!events.length) return;

    for (const [underlying, state] of this.byUnderlying) {
      if (state.listeners.size === 0 && state.largeOrderListeners.size === 0) {
        continue;
      }
      const meta = state.tokenMeta.get(tick.token);
      if (!meta) continue;
      for (const ev of events) {
        const alert: LargeOrderAlert = {
          ...ev,
          underlying,
          strike: meta.strike,
          optionType: meta.optionType,
          tradingsymbol: meta.tradingsymbol,
          alertText: "",
        };
        alert.alertText = formatLargeOrderAlertText(alert);
        for (const listener of state.largeOrderListeners) {
          try {
            listener(alert);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  private queueOptionTick(tick: AngelOptionTick) {
    this.pendingTicks.set(tick.token, tick);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pendingTicks.values()];
      this.pendingTicks.clear();
      this.flushOptionTicks(batch);
    }, 100);
  }

  private teardownUnderlying(underlying: Underlying) {
    const s = this.byUnderlying.get(underlying);
    if (!s) return;
    if (s.snapTimer) clearTimeout(s.snapTimer);
    if (s.tokenTimer) clearTimeout(s.tokenTimer);
    this.byUnderlying.delete(underlying);
    void this.resyncOptionSubscriptions();
  }

  private async bootstrap(underlying: Underlying) {
    await this.refreshTokens(underlying);
    await this.refreshSnapshot(underlying);
  }

  private async refreshTokens(underlying: Underlying) {
    const state = this.byUnderlying.get(underlying);
    if (!state || state.listeners.size === 0) return;

    if (isDemoMarketDataMode()) {
      this.scheduleTokenRefresh(underlying);
      return;
    }

    try {
      const set = await resolveAtmOptionTokens(underlying, { band: 10 });
      const meta = new Map<
        string,
        { strike: number; optionType: "CE" | "PE"; tradingsymbol: string }
      >();
      for (const row of set.rows) {
        meta.set(row.token, {
          strike: row.strike,
          optionType: row.optionType,
          tradingsymbol: row.tradingsymbol,
        });
      }
      state.tokenMeta = meta;
      const active = new Set<string>();
      for (const s of this.byUnderlying.values()) {
        for (const t of s.tokenMeta.keys()) active.add(t);
      }
      pruneLargeOrderTokens(active);
      await this.resyncOptionSubscriptions();
    } catch (err) {
      console.warn(
        "[liveOptionChainHub] token resolve failed:",
        err instanceof Error ? err.message : err,
      );
    }
    this.scheduleTokenRefresh(underlying);
  }

  private async resyncOptionSubscriptions() {
    if (isDemoMarketDataMode()) {
      angelWebsocketFeed.setOptionSubscriptions([]);
      return;
    }
    const byExchange = new Map<number, Set<string>>();
    for (const [underlying, state] of this.byUnderlying) {
      if (state.listeners.size === 0 || state.tokenMeta.size === 0) continue;
      const meta = UNDERLYING_EXCHANGE[underlying];
      let set = byExchange.get(meta);
      if (!set) {
        set = new Set();
        byExchange.set(meta, set);
      }
      for (const token of state.tokenMeta.keys()) set.add(token);
    }
    angelWebsocketFeed.setOptionSubscriptions(
      [...byExchange.entries()].map(([exchangeType, tokens]) => ({
        exchangeType,
        tokens: [...tokens],
      })),
    );
  }

  private scheduleTokenRefresh(underlying: Underlying) {
    const state = this.byUnderlying.get(underlying);
    if (!state || state.listeners.size === 0) return;
    if (state.tokenTimer) clearTimeout(state.tokenTimer);
    state.tokenTimer = setTimeout(() => {
      void this.refreshTokens(underlying);
    }, TOKEN_REFRESH_MS);
  }

  private scheduleSnapshot(underlying: Underlying) {
    const state = this.byUnderlying.get(underlying);
    if (!state || state.listeners.size === 0) return;
    if (state.snapTimer) clearTimeout(state.snapTimer);
    const ms =
      this.wsStatus === "live" && state.feed === "angel-ws"
        ? SNAPSHOT_MS
        : REST_FALLBACK_MS;
    state.snapTimer = setTimeout(() => {
      void this.refreshSnapshot(underlying);
    }, ms);
  }

  private async refreshSnapshot(underlying: Underlying) {
    const state = this.byUnderlying.get(underlying);
    if (!state || state.listeners.size === 0) return;
    if (state.snapInFlight) {
      this.scheduleSnapshot(underlying);
      return;
    }
    state.snapInFlight = true;
    try {
      const chain = await getOptionChain(underlying);
      // Re-apply freshest WS ticks over REST LTP/OI for ATM band.
      const patched = this.patchChainWithWs(chain, state);
      state.chain = patched;
      const feed: LiveOptionChainSnapshot["feed"] = isDemoMarketDataMode()
        ? "demo"
        : this.wsStatus === "live" && state.tokenMeta.size > 0
          ? "angel-ws"
          : "rest";
      state.feed = feed;
      this.broadcast(underlying, {
        ok: true,
        ...patched,
        fetchedAt: new Date().toISOString(),
        feed,
        wsStatus: this.wsStatus,
        subscribedTokens: state.tokenMeta.size,
      });
    } catch (err) {
      if (!state.chain) {
        this.broadcast(underlying, {
          ok: false,
          fetchedAt: new Date().toISOString(),
          underlying,
          error: err instanceof Error ? err.message : "Option chain unavailable",
          uiHint: "market data unavailable",
          wsStatus: this.wsStatus,
        });
      }
    } finally {
      state.snapInFlight = false;
      this.scheduleSnapshot(underlying);
    }
  }

  private patchChainWithWs(
    chain: OptionChainResult,
    state: UnderlyingState,
  ): OptionChainResult {
    const ticks = angelWebsocketFeed.getLatestOptionTicks();
    if (!ticks.size || !state.tokenMeta.size) return chain;

    const byKey = new Map<string, AngelOptionTick>();
    for (const [token, tick] of ticks) {
      const meta = state.tokenMeta.get(token);
      if (!meta) continue;
      byKey.set(`${meta.strike}:${meta.optionType}`, tick);
    }
    if (!byKey.size) return chain;

    const contracts = chain.contracts.map((c) => {
      const tick =
        byKey.get(`${c.strike}:${c.optionType}`) ??
        (state.tokenMeta.has(c.symboltoken)
          ? ticks.get(c.symboltoken)
          : undefined);
      if (!tick) return c;
      return applyTickToContract(c, tick);
    });
    return { ...chain, contracts };
  }

  private flushOptionTicks(batch: AngelOptionTick[]) {
    const touched = new Set<Underlying>();
    for (const tick of batch) {
      for (const [underlying, state] of this.byUnderlying) {
        if (state.listeners.size === 0 || !state.chain) continue;
        const meta = state.tokenMeta.get(tick.token);
        if (!meta) continue;

        const contracts = state.chain.contracts.map((c) => {
          const match =
            (c.strike === meta.strike && c.optionType === meta.optionType) ||
            c.symboltoken === tick.token ||
            c.tradingsymbol === meta.tradingsymbol;
          if (!match) return c;
          return applyTickToContract(c, tick);
        });
        state.chain = { ...state.chain, contracts };
        state.feed = "angel-ws";
        touched.add(underlying);
      }
    }
    const fetchedAt = new Date().toISOString();
    for (const underlying of touched) {
      const state = this.byUnderlying.get(underlying);
      if (!state?.chain) continue;
      this.broadcast(underlying, {
        ok: true,
        ...state.chain,
        fetchedAt,
        feed: "angel-ws",
        wsStatus: this.wsStatus,
        subscribedTokens: state.tokenMeta.size,
      });
    }
  }

  private broadcast(underlying: Underlying, payload: LiveOptionChainPayload) {
    const state = this.byUnderlying.get(underlying);
    if (!state) return;
    state.last = payload;
    for (const listener of state.listeners) {
      try {
        listener(payload);
      } catch {
        // ignore
      }
    }
  }
}

const UNDERLYING_EXCHANGE: Record<Underlying, number> = {
  NIFTY: 2, // NSE_FO
  BANKNIFTY: 2,
  SENSEX: 4, // BSE_FO
};

function applyTickToContract(
  c: OptionContractQuote,
  tick: AngelOptionTick,
): OptionContractQuote {
  // change = LTP - prevClose; changePct = change / prevClose * 100
  const change = tick.ltp - tick.prevClose;
  const changePct =
    tick.prevClose !== 0 ? (change / tick.prevClose) * 100 : undefined;
  return {
    ...c,
    ltp: tick.ltp,
    change: Number.isFinite(change) ? change : c.change,
    changePct:
      changePct !== undefined && Number.isFinite(changePct)
        ? changePct
        : c.changePct,
    volume: tick.volume ?? c.volume,
    oi: tick.oi ?? c.oi,
  };
}

const globalForHub = globalThis as typeof globalThis & {
  __nseLiveOptionChainHub?: LiveOptionChainHub;
};

export const liveOptionChainHub =
  globalForHub.__nseLiveOptionChainHub ?? new LiveOptionChainHub();

globalForHub.__nseLiveOptionChainHub = liveOptionChainHub;
