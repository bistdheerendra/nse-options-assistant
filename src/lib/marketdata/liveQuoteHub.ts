import {
  getDashboardQuotes,
  isMarketDataUnavailable,
  type DashboardQuoteCard,
} from "@/lib/marketdata/angelone";
import { fetchLiveSpots } from "@/lib/marketdata/liveSpots";

export type LiveDashboardSnapshot = {
  ok: true;
  fetchedAt: string;
  cards: DashboardQuoteCard[];
  demoMode: boolean;
  feed: "public-spot" | "snapshot";
};

export type LiveDashboardError = {
  ok: false;
  fetchedAt: string;
  error: string;
  uiHint?: string;
};

export type LiveDashboardPayload = LiveDashboardSnapshot | LiveDashboardError;

type Listener = (payload: LiveDashboardPayload) => void;

/** Fast LTP loop — public spots only (no Yahoo). */
export const LIVE_HUB_SPOT_MS = 350;
/** Full card rebuild (candles / labels) — infrequent. */
export const LIVE_HUB_SNAPSHOT_MS = 30_000;

function dayChange(ltp: number, prevClose: number) {
  // change = LTP - prevClose; changePct = change / prevClose * 100
  const change = ltp - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  return { change, changePct };
}

/**
 * In-process live quote hub.
 * Fast spot loop pushes LTP to SSE clients; slow snapshot keeps candles warm.
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
    await this.tickSnapshot();
    void this.tickSpots();
  }

  private stop() {
    this.running = false;
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
      this.cards = data.cards;
      this.demoMode = data.demoMode;
      this.broadcast({
        ok: true,
        fetchedAt: new Date().toISOString(),
        cards: data.cards,
        demoMode: data.demoMode,
        feed: "snapshot",
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
      const nextCards = this.cards.map((card) => {
        const spot = spots[card.id];
        if (!spot || !Number.isFinite(spot.ltp)) return card;
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
      });

      this.cards = nextCards;
      this.broadcast({
        ok: true,
        fetchedAt: new Date().toISOString(),
        cards: nextCards,
        demoMode: this.demoMode,
        feed: "public-spot",
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
