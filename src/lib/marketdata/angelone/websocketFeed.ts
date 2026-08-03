import WebSocket from "ws";
import { getSession, isDemoMarketDataMode } from "./auth";
import { UNDERLYING_META, type Underlying } from "./types";

const WS_URL = "wss://smartapisocket.angelone.in/smart-stream";
const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 30_000;

/** Quote mode — LTP + OHLC/close so we can compute day change. */
const MODE_QUOTE = 2;
/** Snap quote — includes open interest (needed for option chain OI). */
const MODE_SNAP_QUOTE = 3;

export const EXCHANGE_NSE_CM = 1;
export const EXCHANGE_NSE_FO = 2;
export const EXCHANGE_BSE_CM = 3;
export const EXCHANGE_BSE_FO = 4;

export type AngelIndexTick = {
  underlying: Underlying;
  token: string;
  ltp: number;
  /** Previous close when present (Quote mode). */
  prevClose: number;
  exchangeTs: number;
  receivedAt: number;
};

export type AngelOptionTick = {
  token: string;
  ltp: number;
  prevClose: number;
  volume?: number;
  oi?: number;
  exchangeTs: number;
  receivedAt: number;
};

export type AngelTokenGroup = {
  exchangeType: number;
  tokens: string[];
};

type TickListener = (tick: AngelIndexTick) => void;
type OptionTickListener = (tick: AngelOptionTick) => void;
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

type AngelBinaryTick = {
  mode: number;
  exchangeType: number;
  token: string;
  ltp: number;
  prevClose: number;
  volume?: number;
  oi?: number;
  exchangeTs: number;
  receivedAt: number;
};

/**
 * Angel SmartAPI WS binary packet (little-endian).
 * Prices are paise → divide by 100 for equity/index/options premium.
 * LTP @43; Quote close @115; SnapQuote OI @131 (contract count, not paise).
 */
export function parseAngelBinaryPacket(buf: Buffer): AngelBinaryTick | null {
  if (buf.length < 51) return null;
  const mode = buf.readInt8(0);
  if (mode !== 1 && mode !== 2 && mode !== 3) return null;

  const exchangeType = buf.readUInt8(1);
  const token = readToken(buf);
  if (!token) return null;

  // Docs label LTP as int32 but allocate 8 bytes — read as int64 paise.
  const ltpPaise = Number(buf.readBigInt64LE(43));
  const ltp = ltpPaise / 100;
  if (!Number.isFinite(ltp) || ltp <= 0) return null;

  const exchangeTs = Number(buf.readBigInt64LE(35));
  let prevClose = ltp;
  let volume: number | undefined;
  let oi: number | undefined;

  if (buf.length >= 75) {
    const vol = Number(buf.readBigInt64LE(67));
    if (Number.isFinite(vol) && vol >= 0) volume = vol;
  }
  if (buf.length >= 123) {
    const closePaise = Number(buf.readBigInt64LE(115));
    const close = closePaise / 100;
    if (Number.isFinite(close) && close > 0) prevClose = close;
  }
  // Snap quote open_interest (int64 contracts)
  if (buf.length >= 139) {
    const rawOi = Number(buf.readBigInt64LE(131));
    if (Number.isFinite(rawOi) && rawOi >= 0) oi = rawOi;
  }

  return {
    mode,
    exchangeType,
    token,
    ltp,
    prevClose,
    volume,
    oi,
    exchangeTs,
    receivedAt: Date.now(),
  };
}

/** Index-only parse (keeps scripts/tests that expect AngelIndexTick). */
export function parseAngelQuotePacket(buf: Buffer): AngelIndexTick | null {
  const raw = parseAngelBinaryPacket(buf);
  if (!raw) return null;
  const underlying = TOKEN_TO_UNDERLYING[raw.token];
  if (!underlying) return null;
  return {
    underlying,
    token: raw.token,
    ltp: raw.ltp,
    prevClose: raw.prevClose,
    exchangeTs: raw.exchangeTs,
    receivedAt: raw.receivedAt,
  };
}

/**
 * Server-side Angel One SmartAPI WebSocket 2.0 feed.
 * One shared connection: index LTP (Quote) + optional NFO/BFO option tokens (SnapQuote).
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
  private latestOptions = new Map<string, AngelOptionTick>();
  private tickListeners = new Set<TickListener>();
  private optionTickListeners = new Set<OptionTickListener>();
  private statusListeners = new Set<StatusListener>();
  /** Active option token subscriptions (ATM band). */
  private optionGroups: AngelTokenGroup[] = [];
  private optionTokenSet = new Set<string>();

  getStatus(): AngelFeedStatus {
    return this.status;
  }

  getLatestTicks(): Partial<Record<Underlying, AngelIndexTick>> {
    const out: Partial<Record<Underlying, AngelIndexTick>> = {};
    for (const [k, v] of this.latest) out[k] = v;
    return out;
  }

  getLatestOptionTicks(): Map<string, AngelOptionTick> {
    return new Map(this.latestOptions);
  }

  /** Keep connection while ≥1 subscriber (dashboard / option-chain hubs). */
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

  onOptionTick(listener: OptionTickListener): () => void {
    this.optionTickListeners.add(listener);
    return () => this.optionTickListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Subscribe / replace NFO–BFO option tokens on the shared WS.
   * Pass [] to clear. Uses SnapQuote (mode 3) for LTP + OI.
   */
  setOptionSubscriptions(groups: AngelTokenGroup[]) {
    const normalized = groups
      .map((g) => ({
        exchangeType: g.exchangeType,
        tokens: [...new Set(g.tokens.filter(Boolean))],
      }))
      .filter((g) => g.tokens.length > 0);

    const prev = this.optionGroups;
    this.optionGroups = normalized;
    this.optionTokenSet = new Set(normalized.flatMap((g) => g.tokens));

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (prev.length) {
      this.sendSubscribe(ws, {
        correlationID: "optunsub01",
        action: 0,
        mode: MODE_SNAP_QUOTE,
        tokenList: prev,
      });
    }
    if (normalized.length) {
      this.sendSubscribe(ws, {
        correlationID: "optsub0001",
        action: 1,
        mode: MODE_SNAP_QUOTE,
        tokenList: normalized,
      });
    }
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
        if (this.optionGroups.length) {
          this.sendSubscribe(ws, {
            correlationID: "optsub0001",
            action: 1,
            mode: MODE_SNAP_QUOTE,
            tokenList: this.optionGroups,
          });
        }
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
        const raw = parseAngelBinaryPacket(buf);
        if (!raw) return;

        const underlying = TOKEN_TO_UNDERLYING[raw.token];
        if (underlying) {
          const tick: AngelIndexTick = {
            underlying,
            token: raw.token,
            ltp: raw.ltp,
            prevClose: raw.prevClose,
            exchangeTs: raw.exchangeTs,
            receivedAt: raw.receivedAt,
          };
          this.latest.set(underlying, tick);
          for (const l of this.tickListeners) {
            try {
              l(tick);
            } catch {
              // ignore
            }
          }
          return;
        }

        if (!this.optionTokenSet.has(raw.token)) return;

        const opt: AngelOptionTick = {
          token: raw.token,
          ltp: raw.ltp,
          prevClose: raw.prevClose,
          volume: raw.volume,
          oi: raw.oi,
          exchangeTs: raw.exchangeTs,
          receivedAt: raw.receivedAt,
        };
        this.latestOptions.set(raw.token, opt);
        for (const l of this.optionTickListeners) {
          try {
            l(opt);
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

  private sendSubscribe(
    ws: WebSocket,
    args: {
      correlationID: string;
      action: 0 | 1;
      mode: number;
      tokenList: AngelTokenGroup[];
    },
  ) {
    if (!args.tokenList.length) return;
    ws.send(
      JSON.stringify({
        correlationID: args.correlationID,
        action: args.action,
        params: {
          mode: args.mode,
          tokenList: args.tokenList,
        },
      }),
    );
  }

  private subscribeIndices(ws: WebSocket) {
    this.sendSubscribe(ws, {
      correlationID: "dash000001",
      action: 1,
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
    });
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
    this.optionGroups = [];
    this.optionTokenSet.clear();
    this.latestOptions.clear();
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
