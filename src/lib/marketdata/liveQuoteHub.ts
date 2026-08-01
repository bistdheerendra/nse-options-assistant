import {
  getDashboardQuotes,
  isMarketDataUnavailable,
  type DashboardQuoteCard,
} from "@/lib/marketdata/angelone";
import {
  angelWebsocketFeed,
  type AngelFeedStatus,
  type AngelIndexTick,
} from "@/lib/marketdata/angelone/websocketFeed";
import { fetchLiveSpots } from "@/lib/marketdata/liveSpots";
import type { Underlying } from "@/lib/marketdata/angelone/types";

export type LiveDashboardSnapshot = {
  ok: true;
  fetchedAt: string;
  cards: DashboardQuoteCard[];
  demoMode: boolean;
  feed: "angel-ws" | "public-spot" | "snapshot";
};

export type LiveDashboardError = {
  ok: false;
  fetchedAt: string;
  error: string;
  uiHint?: string;
};

export type LiveDashboardPayload = LiveDashboardSnapshot | LiveDashboardError;

type Listener = (payload: LiveDashboardPayload) => void;

/**
 * Gift / public fallback poll — Angel WS pushes index ticks immediately.
 * Keep a light loop for Gift Nifty (not on SmartAPI) + Angel-down fallback.
 */
export const LIVE_HUB_SPOT_MS = 500;
/** Full card rebuild (candles / labels) — infrequent. */
export const LIVE_HUB_SNAPSHOT_MS = 30_000;
/** Prefer Angel tick if newer than this; else fall back to NSE public spot. */
const ANGEL_TICK_FRESH_MS = 5_000;

function dayChange(ltp: number, prevClose: number) {
  // change = LTP - prevClose; changePct = change / prevClose * 100
  const change = ltp - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  return { change, changePct };
}

function patchCardFromSpot(
  card: DashboardQuoteCard,
  spot: { ltp: number; prevClose: number; source: string },
): DashboardQuoteCard {
  const { change, changePct } = dayChange(spot.ltp, spot.prevClose);
  return {
    ...card,
    ltp: spot.ltp,
    change,
    changePct,
    source: spot.source,
    demo: card.id === "GIFTNIFTY" ? Boolean(card.note) : false,
    note:
      card.id === "GIFTNIFTY" && spot.source === "Nifty proxy"
        ? (card.note ??
          "Gift Nifty live feed unavailable — showing Nifty 50 as labeled proxy.")
        : card.id === "GIFTNIFTY"
          ? null
          : card.note,
  };
}

/**
 * In-process live quote hub.
 * Angel SmartAPI WebSocket ticks update NIFTY/BANKNIFTY/SENSEX immediately;
 * Gift + public NSE remain as fallback / complementary feed.
 */
class LiveQuoteHub {
  private listeners = new Set<Listener>();
  private spotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private spotInFlight = false;
  private snapInFlight = false;
  private cards: DashboardQuoteCard[] | null = null;
  private demoMode = false;
  private last: LiveDashboardPayload | null = null;
  private releaseAngel: (() => void) | null = null;
  private unsubAngelTick: (() => void) | null = null;
  private unsubAngelStatus: (() => void) | null = null;
  private angelStatus: AngelFeedStatus = "idle";

  getLatest(): LiveDashboardPayload | null {
    return this.last;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.last) listener(this.last);
    void this.ensureRunning();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private broadcast(payload: LiveDashboardPayload) {
    this.last = payload;
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // ignore bad subscriber
      }
    }
  }

  private async ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.bindAngelFeed();
    await this.tickSnapshot();
    void this.tickSpots();
  }

  private bindAngelFeed() {
    if (this.releaseAngel) return;
    this.releaseAngel = angelWebsocketFeed.acquire();
    this.unsubAngelTick = angelWebsocketFeed.onTick((tick) => {
      this.applyAngelTick(tick);
    });
    this.unsubAngelStatus = angelWebsocketFeed.onStatus((s) => {
      this.angelStatus = s;
    });
  }

  private unbindAngelFeed() {
    this.unsubAngelTick?.();
    this.unsubAngelTick = null;
    this.unsubAngelStatus?.();
    this.unsubAngelStatus = null;
    this.releaseAngel?.();
    this.releaseAngel = null;
    this.angelStatus = "idle";
  }

  private applyAngelTick(tick: AngelIndexTick) {
    if (!this.running || this.listeners.size === 0 || !this.cards) return;
    const id = tick.underlying;
    const nextCards = this.cards.map((card) => {
      if (card.id !== id) return card;
      return patchCardFromSpot(card, {
        ltp: tick.ltp,
        prevClose: tick.prevClose,
        source: "Angel One",
      });
    });
    this.cards = nextCards;
    this.broadcast({
      ok: true,
      fetchedAt: new Date().toISOString(),
      cards: nextCards,
      demoMode: this.demoMode,
      feed: "angel-ws",
    });
  }

  private stop() {
    this.running = false;
    this.unbindAngelFeed();
    if (this.spotTimer != null) {
      clearTimeout(this.spotTimer);
      this.spotTimer = null;
    }
    if (this.snapTimer != null) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
  }

  private scheduleSpots() {
    if (!this.running || this.listeners.size === 0) {
      this.stop();
      return;
    }
    this.spotTimer = setTimeout(() => {
      void this.tickSpots();
    }, LIVE_HUB_SPOT_MS);
  }

  private scheduleSnapshot() {
    if (!this.running || this.listeners.size === 0) return;
    this.snapTimer = setTimeout(() => {
      void this.tickSnapshot();
    }, LIVE_HUB_SNAPSHOT_MS);
  }

  private async tickSnapshot() {
    if (!this.running || this.listeners.size === 0) {
      this.stop();
      return;
    }
    if (this.snapInFlight) {
      this.scheduleSnapshot();
      return;
    }
    this.snapInFlight = true;
    try {
      const data = await getDashboardQuotes();
      // Prefer fresher Angel ticks over snapshot LTP for indices.
      const ticks = angelWebsocketFeed.getLatestTicks();
      const now = Date.now();
      const cards = data.cards.map((card) => {
        if (card.id === "GIFTNIFTY") return card;
        const tick = ticks[card.id as Underlying];
        if (!tick || now - tick.receivedAt > ANGEL_TICK_FRESH_MS) return card;
        return patchCardFromSpot(card, {
          ltp: tick.ltp,
          prevClose: tick.prevClose,
          source: "Angel One",
        });
      });
      this.cards = cards;
      this.demoMode = data.demoMode;
      this.broadcast({
        ok: true,
        fetchedAt: new Date().toISOString(),
        cards,
        demoMode: data.demoMode,
        feed:
          this.angelStatus === "live" &&
          Object.keys(ticks).length > 0
            ? "angel-ws"
            : "snapshot",
      });
    } catch (err) {
      if (!this.cards) {
        if (isMarketDataUnavailable(err)) {
          this.broadcast({
            ok: false,
            fetchedAt: new Date().toISOString(),
            error: err.message,
            uiHint: "market data unavailable",
          });
        } else {
          this.broadcast({
            ok: false,
            fetchedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    } finally {
      this.snapInFlight = false;
      this.scheduleSnapshot();
    }
  }

  private async tickSpots() {
    if (!this.running || this.listeners.size === 0) {
      this.stop();
      return;
    }
    if (this.spotInFlight) {
      this.scheduleSpots();
      return;
    }
    this.spotInFlight = true;
    try {
      if (!this.cards) return;

      const spots = await fetchLiveSpots();
      const ticks = angelWebsocketFeed.getLatestTicks();
      const now = Date.now();
      let usedAngel = false;

      const nextCards = this.cards.map((card) => {
        if (card.id !== "GIFTNIFTY") {
          const tick = ticks[card.id as Underlying];
          if (tick && now - tick.receivedAt <= ANGEL_TICK_FRESH_MS) {
            usedAngel = true;
            return patchCardFromSpot(card, {
              ltp: tick.ltp,
              prevClose: tick.prevClose,
              source: "Angel One",
            });
          }
        }
        const spot = spots[card.id];
        if (!spot || !Number.isFinite(spot.ltp)) return card;
        return patchCardFromSpot(card, spot);
      });

      this.cards = nextCards;
      this.broadcast({
        ok: true,
        fetchedAt: new Date().toISOString(),
        cards: nextCards,
        demoMode: this.demoMode,
        feed: usedAngel ? "angel-ws" : "public-spot",
      });
    } catch {
      // Keep last good snapshot; spots retry next tick
    } finally {
      this.spotInFlight = false;
      this.scheduleSpots();
    }
  }
}

const globalForHub = globalThis as typeof globalThis & {
  __nseLiveQuoteHub?: LiveQuoteHub;
};

export const liveQuoteHub =
  globalForHub.__nseLiveQuoteHub ?? new LiveQuoteHub();

globalForHub.__nseLiveQuoteHub = liveQuoteHub;
