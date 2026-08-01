import WebSocket from "ws";
import { getSession, isDemoMarketDataMode } from "./auth";
import { UNDERLYING_META, type Underlying } from "./types";

const WS_URL = "wss://smartapisocket.angelone.in/smart-stream";
const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 30_000;
/** Quote mode — LTP + OHLC/close so we can compute day change. */
const MODE_QUOTE = 2;
const EXCHANGE_NSE_CM = 1;
const EXCHANGE_BSE_CM = 3;

export type AngelIndexTick = {
  underlying: Underlying;
  token: string;
  ltp: number;
  /** Previous close when present (Quote mode). */
  prevClose: number;
  exchangeTs: number;
  receivedAt: number;
};

type TickListener = (tick: AngelIndexTick) => void;
type StatusListener = (status: AngelFeedStatus) => void;

export type AngelFeedStatus = "idle" | "connecting" | "live" | "error" | "demo";

const TOKEN_TO_UNDERLYING: Record<string, Underlying> = {
  [UNDERLYING_META.NIFTY.symboltoken]: "NIFTY",
  [UNDERLYING_META.BANKNIFTY.symboltoken]: "BANKNIFTY",
  [UNDERLYING_META.SENSEX.symboltoken]: "SENSEX",
};

function readToken(buf: Buffer): string {
  const slice = buf.subarray(2, 27);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
}

/**
 * Angel SmartAPI WS binary packet (little-endian).
 * Prices are paise → divide by 100 for equity/index.
 * LTP packet ends at 51 bytes; Quote continues through close at offset 115.
 */
export function parseAngelQuotePacket(buf: Buffer): AngelIndexTick | null {
  if (buf.length < 51) return null;
  const mode = buf.readInt8(0);
  if (mode !== 1 && mode !== 2 && mode !== 3) return null;

  const token = readToken(buf);
  const underlying = TOKEN_TO_UNDERLYING[token];
  if (!underlying) return null;

  // Docs label LTP as int32 but allocate 8 bytes — read as int64 paise.
  const ltpPaise = Number(buf.readBigInt64LE(43));
  const ltp = ltpPaise / 100;
  if (!Number.isFinite(ltp) || ltp <= 0) return null;

  const exchangeTs = Number(buf.readBigInt64LE(35));
  let prevClose = ltp;
  if (buf.length >= 123) {
    const closePaise = Number(buf.readBigInt64LE(115));
    const close = closePaise / 100;
    if (Number.isFinite(close) && close > 0) prevClose = close;
  }

  return {
    underlying,
    token,
    ltp,
    prevClose,
    exchangeTs,
    receivedAt: Date.now(),
  };
}

/**
 * Server-side Angel One SmartAPI WebSocket 2.0 feed for index LTP.
 * One shared connection per process; Gift Nifty is not on SmartAPI.
 */
class AngelWebsocketFeed {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refCount = 0;
  private status: AngelFeedStatus = "idle";
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private latest = new Map<Underlying, AngelIndexTick>();
  private tickListeners = new Set<TickListener>();
  private statusListeners = new Set<StatusListener>();

  getStatus(): AngelFeedStatus {
    return this.status;
  }

  getLatestTicks(): Partial<Record<Underlying, AngelIndexTick>> {
    const out: Partial<Record<Underlying, AngelIndexTick>> = {};
    for (const [k, v] of this.latest) out[k] = v;
    return out;
  }

  /** Keep connection while ≥1 subscriber (dashboard hub). */
  acquire(): () => void {
    this.refCount += 1;
    void this.ensureConnected();
    return () => {
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) this.disconnect();
    };
  }

  onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: AngelFeedStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.statusListeners) {
      try {
        l(next);
      } catch {
        // ignore
      }
    }
  }

  private async ensureConnected() {
    if (isDemoMarketDataMode()) {
      this.setStatus("demo");
      return;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (this.refCount <= 0) return;

    this.intentionalClose = false;
    this.setStatus("connecting");

    try {
      const session = await getSession();
      const apiKey = process.env.ANGEL_ONE_API_KEY;
      if (!apiKey || !session.feedToken) {
        this.setStatus("error");
        this.scheduleReconnect();
        return;
      }

      // Official SmartAPI Python SDK sends the raw JWT (no "Bearer " prefix).
      const authToken = session.jwtToken.replace(/^Bearer\s+/i, "");
      const ws = new WebSocket(WS_URL, {
        headers: {
          Authorization: authToken,
          "x-api-key": apiKey,
          "x-client-code": session.clientCode,
          "x-feed-token": session.feedToken,
        },
      });
      this.ws = ws;

      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.setStatus("live");
        this.subscribeIndices(ws);
        this.startHeartbeat(ws);
      });

      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          // text pong / errors ignored for tick path
          return;
        }
        const buf = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        const tick = parseAngelQuotePacket(buf);
        if (!tick) return;
        this.latest.set(tick.underlying, tick);
        for (const l of this.tickListeners) {
          try {
            l(tick);
          } catch {
            // ignore
          }
        }
      });

      ws.on("close", () => {
        this.clearHeartbeat();
        this.ws = null;
        if (!this.intentionalClose && this.refCount > 0) {
          this.setStatus("error");
          this.scheduleReconnect();
        } else if (this.refCount <= 0) {
          this.setStatus("idle");
        }
      });

      ws.on("error", () => {
        // close handler schedules reconnect
      });
    } catch {
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  private subscribeIndices(ws: WebSocket) {
    const payload = {
      correlationID: "dash000001",
      action: 1,
      params: {
        mode: MODE_QUOTE,
        tokenList: [
          {
            exchangeType: EXCHANGE_NSE_CM,
            tokens: [
              UNDERLYING_META.NIFTY.symboltoken,
              UNDERLYING_META.BANKNIFTY.symboltoken,
            ],
          },
          {
            exchangeType: EXCHANGE_BSE_CM,
            tokens: [UNDERLYING_META.SENSEX.symboltoken],
          },
        ],
      },
    };
    ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(ws: WebSocket) {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.refCount <= 0 || this.intentionalClose) {
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, delay);
  }

  private disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setStatus("idle");
  }
}

const globalForFeed = globalThis as typeof globalThis & {
  __nseAngelWsFeed?: AngelWebsocketFeed;
};

export const angelWebsocketFeed =
  globalForFeed.__nseAngelWsFeed ?? new AngelWebsocketFeed();

globalForFeed.__nseAngelWsFeed = angelWebsocketFeed;
