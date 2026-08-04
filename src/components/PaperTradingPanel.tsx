"use client";

import { ChartAiLoader } from "@/components/ChartAiLoader";
import { LiveBadge } from "@/components/LiveBadge";
import { ModeToggle } from "@/components/ModeToggle";
import { SpotPriceMarker } from "@/components/SpotPriceMarker";
import { useDashboardLiveStream } from "@/hooks/useDashboardLiveStream";
import { useOptionChainLiveStream } from "@/hooks/useOptionChainLiveStream";
import {
  defaultPremiumTpSl,
  premiumExitHit,
  unrealizedPnl,
} from "@/lib/paperTrading/pnl";
import { theme } from "@/lib/theme";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ChainContract = {
  strike: number;
  optionType: "CE" | "PE";
  tradingsymbol: string;
  symboltoken: string;
  ltp: number;
  change?: number;
  changePct?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
  iv?: number;
  /** Angel Greeks delta when available. */
  delta?: number | null;
  lotSize: number;
  expiry: string;
};

type PositionRow = {
  id: string;
  underlying: string;
  strike: number;
  optionType: string;
  expiry: string;
  action: string;
  lotSize: number;
  lots: number;
  entryPremium: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  status: string;
  exitPremium?: number | null;
  realizedPnl?: number | null;
  closeReason?: string | null;
  mode: string;
  tradingSymbol?: string | null;
  openedAt?: string;
  closedAt?: string | null;
  entrySnapshot?: unknown;
};

function slTpLabel(snap: unknown): {
  text: string | null;
  title: string | null;
} {
  if (!snap || typeof snap !== "object") return { text: null, title: null };
  const s = snap as Record<string, unknown>;
  if (s.slTpSource === "delta") {
    return {
      text: "approx., delta-based",
      title:
        "Premium SL/TP projected from verdict-card spot levels via linear delta. Valid only for small spot moves — not a live reprice.",
    };
  }
  if (s.slTpSource === "multiplier_fallback") {
    // Spots persisted but no Greeks → static 0.6/1.8 (or manual) — not verdict-spot-derived
    const hasSpots =
      typeof s.entrySpotAtSignal === "number" &&
      typeof s.stopLossSpot === "number";
    return {
      text: "est. — no delta",
      title: hasSpots
        ? "Premium SL/TP uses the static 0.6×/1.8× multiplier (Angel Greeks unavailable for this strike). Verdict-card spot levels are stored on entrySnapshot for audit only."
        : "Premium SL/TP from static multiplier (or manual entry) — not derived from Analysis spot levels.",
    };
  }
  return { text: null, title: null };
}

type Account = {
  cashBalance: number;
  startingCash: number;
  positions: PositionRow[];
};

/** Format elapsed open time: 45s · 12m 5s · 2h 15m · 1d 3h */
function formatDuration(fromIso: string | undefined, toMs: number): string {
  if (!fromIso) return "—";
  const start = new Date(fromIso).getTime();
  if (!Number.isFinite(start)) return "—";
  const sec = Math.max(0, Math.floor((toMs - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

function levelsFor(p: PositionRow): { stopLoss: number; takeProfit: number } {
  if (p.stopLoss != null && p.takeProfit != null) {
    return { stopLoss: p.stopLoss, takeProfit: p.takeProfit };
  }
  return defaultPremiumTpSl(
    p.action === "SELL" ? "SELL" : "BUY",
    p.entryPremium,
  );
}

function closeReasonLabel(reason: string | null | undefined, status: string): string {
  if (status === "EXPIRED" || reason === "EXPIRED") return "Expired";
  if (reason === "TP") return "TP hit";
  if (reason === "SL") return "SL hit";
  if (reason === "MANUAL") return "Manual";
  return status === "CLOSED" ? "Closed" : status;
}

function formatStrike(n: number) {
  return n.toLocaleString("en-IN");
}

function sameContract(a: ChainContract | null, b: ChainContract | undefined) {
  if (!a || !b) return false;
  return (
    a.tradingsymbol === b.tradingsymbol ||
    (a.symboltoken === b.symboltoken && a.optionType === b.optionType)
  );
}

function PremiumCell({
  contract,
  selected,
  onSelect,
}: {
  contract: ChainContract | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!contract) {
    return <span className="text-binance-muted">—</span>;
  }
  const pct = contract.changePct;
  const up = (pct ?? 0) >= 0;
  const delta =
    contract.delta != null && Number.isFinite(contract.delta)
      ? contract.delta
      : null;
  return (
    <button
      type="button"
      className={`w-full rounded px-1 py-0.5 text-left underline-offset-2 hover:underline ${
        selected ? "bg-binance-gold/10 text-binance-gold" : ""
      }`}
      style={{ color: selected ? undefined : theme.colors.text }}
      onClick={onSelect}
    >
      <span className="block font-medium tabular-nums">
        ₹{contract.ltp.toFixed(2)}
      </span>
      {pct !== undefined && Number.isFinite(pct) && (
        <span
          className="block text-[10px] tabular-nums"
          style={{ color: up ? theme.colors.bull : theme.colors.bear }}
        >
          {up ? "+" : ""}
          {pct.toFixed(2)}%
        </span>
      )}
      {delta != null && (
        <span
          className="block text-[10px] tabular-nums text-binance-muted"
          title="Angel Greeks (approx.) — live contracts, market hours only"
        >
          Δ {delta.toFixed(2)}
        </span>
      )}
    </button>
  );
}

function PctSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (pct: number) => void;
  disabled?: boolean;
}) {
  const marks = [0, 25, 50, 75, 100];
  return (
    <div className={`space-y-2 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      <input
        type="range"
        min={0}
        max={100}
        step={25}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-binance-border accent-binance-gold"
      />
      <div className="flex justify-between text-[10px] text-binance-muted">
        {marks.map((m) => (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => onChange(m)}
            className={`hover:text-binance-text ${value === m ? "text-binance-gold" : ""}`}
          >
            {m}%
          </button>
        ))}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-binance-border bg-binance-elevated px-3 py-2">
      <span className="shrink-0 text-xs text-binance-muted">{label}</span>
      <div className="min-w-0 flex-1 text-right text-sm tabular-nums">{children}</div>
    </div>
  );
}

function BuyOrderPanel({
  selected,
  lots,
  onLotsChange,
  stopLoss,
  takeProfit,
  onStopLossChange,
  onTakeProfitChange,
  onResetLevels,
  pct,
  onPctChange,
  cashBalance,
  maxLots,
  notional,
  maxLossText,
  busy,
  onSubmit,
  disabled,
}: {
  selected: ChainContract | null;
  lots: number;
  onLotsChange: (n: number) => void;
  stopLoss: string;
  takeProfit: string;
  onStopLossChange: (v: string) => void;
  onTakeProfitChange: (v: string) => void;
  onResetLevels: () => void;
  pct: number;
  onPctChange: (n: number) => void;
  cashBalance: number;
  maxLots: number;
  notional: number | null;
  maxLossText: string | null;
  busy: boolean;
  onSubmit: () => void;
  disabled: boolean;
}) {
  const entry = selected?.ltp ?? null;
  const slNum = Number(stopLoss);
  const tpNum = Number(takeProfit);
  const levelsValid =
    entry != null &&
    Number.isFinite(slNum) &&
    Number.isFinite(tpNum) &&
    slNum > 0 &&
    tpNum > 0 &&
    slNum < entry &&
    tpNum > entry;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-binance-bull">
        Buy {selected ? selected.optionType : "option"}
      </p>

      <FieldRow label="Price">
        {selected ? (
          <span className="text-binance-muted">Market · ₹{selected.ltp.toFixed(2)}</span>
        ) : (
          <span className="text-binance-muted">—</span>
        )}
      </FieldRow>

      <FieldRow label="Lots">
        <input
          type="number"
          min={1}
          max={Math.max(1, maxLots || 1)}
          value={selected ? lots : ""}
          placeholder="—"
          disabled={disabled}
          onChange={(e) => onLotsChange(Math.max(1, Number(e.target.value) || 1))}
          className="w-full bg-transparent text-right outline-none disabled:cursor-not-allowed"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2 rounded border border-binance-border bg-binance-elevated px-3 py-2">
          <span className="shrink-0 text-xs text-binance-bear">SL</span>
          <input
            type="number"
            min={0}
            step="0.05"
            value={selected ? stopLoss : ""}
            placeholder="—"
            disabled={disabled}
            onChange={(e) => onStopLossChange(e.target.value)}
            className="min-w-0 w-full bg-transparent text-right text-sm tabular-nums text-binance-bear outline-none disabled:cursor-not-allowed"
            title="Premium stop-loss (must be below entry for buys)"
          />
        </div>
        <div className="flex items-center gap-2 rounded border border-binance-border bg-binance-elevated px-3 py-2">
          <span className="shrink-0 text-xs text-binance-bull">TP</span>
          <input
            type="number"
            min={0}
            step="0.05"
            value={selected ? takeProfit : ""}
            placeholder="—"
            disabled={disabled}
            onChange={(e) => onTakeProfitChange(e.target.value)}
            className="min-w-0 w-full bg-transparent text-right text-sm tabular-nums text-binance-bull outline-none disabled:cursor-not-allowed"
            title="Premium take-profit (must be above entry for buys)"
          />
        </div>
      </div>

      {selected && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span
            className={
              levelsValid ? "text-binance-muted" : "text-binance-bear"
            }
          >
            {levelsValid
              ? "Premium levels · SL below entry · TP above"
              : "SL must be < entry and TP > entry"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={onResetLevels}
            className="shrink-0 text-binance-gold hover:underline disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      )}

      <PctSlider
        value={selected ? pct : 0}
        onChange={onPctChange}
        disabled={disabled || maxLots <= 0}
      />

      <div className="space-y-1 text-xs text-binance-muted">
        <div className="flex justify-between gap-2">
          <span>Avbl</span>
          <span className="tabular-nums text-binance-text">
            ₹{cashBalance.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Max Buy</span>
          <span className="tabular-nums">
            {selected ? `${maxLots} lot${maxLots === 1 ? "" : "s"}` : "—"}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span>Total</span>
          <span className="tabular-nums text-binance-text">
            {notional != null
              ? `₹${notional.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
              : "—"}
          </span>
        </div>
        {selected && (
          <div className="flex justify-between gap-2">
            <span>Lot size</span>
            <span className="tabular-nums">{selected.lotSize}</span>
          </div>
        )}
      </div>

      {maxLossText && (
        <p className="text-[11px] leading-snug text-binance-muted">{maxLossText}</p>
      )}

      <button
        type="button"
        disabled={disabled || busy || !selected || lots < 1 || !levelsValid}
        onClick={onSubmit}
        className="mt-auto inline-flex w-full items-center justify-center gap-2 rounded bg-binance-bull px-4 py-2.5 text-sm font-semibold text-binance-bg hover:brightness-110 disabled:opacity-40"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Buy{" "}
        {selected
          ? `${selected.optionType} ${formatStrike(selected.strike)}`
          : "option"}
      </button>
    </div>
  );
}

export function PaperTradingPanel() {
  const [underlying, setUnderlying] = useState("NIFTY");
  const [mode, setMode] = useState<"SCALP" | "SWING">("SCALP");
  const [account, setAccount] = useState<Account | null>(null);
  const [summary, setSummary] = useState<{
    cashBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    totalPortfolioValue: number;
  } | null>(null);
  const [selected, setSelected] = useState<ChainContract | null>(null);
  const [buyLots, setBuyLots] = useState(1);
  const [buyPct, setBuyPct] = useState(0);
  const [buyStopLoss, setBuyStopLoss] = useState("");
  const [buyTakeProfit, setBuyTakeProfit] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [exitMsg, setExitMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const spotMarkerRef = useRef<HTMLTableRowElement>(null);
  /** Only auto-center spot once per underlying+expiry (not on live refresh). */
  const centeredForKeyRef = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const checkingExitsRef = useRef(false);

  const {
    contracts,
    expiry,
    spot: streamSpot,
    spotChange,
    spotChangePct,
    feed: chainFeed,
    subscribedTokens,
    greeksStatus,
    live: chainLive,
    loading: chainLoading,
    error: chainError,
    fetchedAt: chainUpdatedAt,
    reconnect: reconnectChain,
  } = useOptionChainLiveStream(underlying);

  const { cards: liveCards, live: indexLive } = useDashboardLiveStream();
  const liveSpot = useMemo(() => {
    const card = liveCards.find((c) => c.id === underlying);
    return card && Number.isFinite(card.ltp) ? card.ltp : null;
  }, [liveCards, underlying]);

  // Prefer index SSE spot when close to chain spot; else stream snapshot
  const spot = useMemo(() => {
    if (liveSpot == null) return streamSpot;
    if (streamSpot == null) return liveSpot;
    if (Math.abs(liveSpot - streamSpot) / Math.max(streamSpot, 1) > 0.005) {
      return streamSpot;
    }
    return liveSpot;
  }, [liveSpot, streamSpot]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/paper");
    const json = await res.json();
    setAccount(json.account);
    setSummary(json.summary);
  }, []);

  // Keep selection across tick patches; clear only if contract vanished.
  useEffect(() => {
    const key = selectedKeyRef.current;
    if (!key) {
      setSelected(null);
      return;
    }
    const match = contracts.find(
      (c) => c.tradingsymbol === key || c.symboltoken === key,
    );
    setSelected(match ?? null);
    if (!match) selectedKeyRef.current = null;
  }, [contracts]);

  useEffect(() => {
    selectedKeyRef.current = null;
    setSelected(null);
    setMsg(null);
    setBuyLots(1);
    setBuyPct(0);
    setBuyStopLoss("");
    setBuyTakeProfit("");
  }, [underlying]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live duration ticker (1s)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-close open positions when live mark hits premium TP or SL
  useEffect(() => {
    const openRows = account?.positions.filter((p) => p.status === "OPEN") ?? [];
    if (!openRows.length || !contracts.length || checkingExitsRef.current) return;

    const marks: Record<string, number> = {};
    let anyHit = false;
    for (const p of openRows) {
      const match = contracts.find(
        (c) =>
          c.strike === p.strike &&
          c.optionType === p.optionType &&
          (p.tradingSymbol
            ? c.tradingsymbol === p.tradingSymbol
            : p.underlying === underlying),
      );
      if (!match) continue;
      const key =
        p.tradingSymbol ?? `${p.underlying}-${p.strike}-${p.optionType}`;
      marks[key] = match.ltp;
      marks[`${p.underlying}-${p.strike}-${p.optionType}`] = match.ltp;
      const levels = levelsFor(p);
      const hit = premiumExitHit({
        action: p.action === "SELL" ? "SELL" : "BUY",
        markPremium: match.ltp,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
      });
      if (hit) anyHit = true;
    }
    if (!anyHit) return;

    checkingExitsRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/paper/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marks }),
        });
        const json = await res.json();
        if (!res.ok) return;
        if (Array.isArray(json.closed) && json.closed.length > 0) {
          setAccount(json.account);
          setSummary(json.summary);
          const parts = json.closed.map(
            (c: { reason: string; exitPremium: number }) =>
              `${c.reason} @ ₹${Number(c.exitPremium).toFixed(2)}`,
          );
          setExitMsg(`Auto-closed: ${parts.join(", ")}`);
        }
      } finally {
        checkingExitsRef.current = false;
      }
    })();
  }, [account, contracts, underlying]);

  const cashBalance = summary?.cashBalance ?? account?.cashBalance ?? 0;

  const maxBuyLots = useMemo(() => {
    if (!selected || selected.ltp <= 0) return 0;
    const costPerLot = selected.ltp * selected.lotSize;
    return Math.max(0, Math.floor(cashBalance / costPerLot));
  }, [selected, cashBalance]);

  const buyNotional = selected
    ? selected.ltp * selected.lotSize * buyLots
    : null;

  const buyMaxLoss = useMemo(() => {
    if (!selected) return null;
    return `Max loss (buy) = premium paid = ₹${(selected.ltp * selected.lotSize * buyLots).toFixed(2)}`;
  }, [selected, buyLots]);

  function applyDefaultLevels(ltp: number) {
    const { stopLoss, takeProfit } = defaultPremiumTpSl("BUY", ltp);
    setBuyStopLoss(stopLoss.toFixed(2));
    setBuyTakeProfit(takeProfit.toFixed(2));
  }

  function selectContract(c: ChainContract) {
    selectedKeyRef.current = c.tradingsymbol || c.symboltoken;
    setSelected(c);
    setMsg(null);
    setBuyLots(1);
    setBuyPct(0);
    applyDefaultLevels(c.ltp);
  }

  function applyBuyPct(pct: number) {
    setBuyPct(pct);
    if (!selected || maxBuyLots <= 0) return;
    setBuyLots(Math.max(1, Math.floor((maxBuyLots * pct) / 100)) || 1);
  }

  async function submitBuy() {
    if (!selected) return;
    const stopLoss = Number(buyStopLoss);
    const takeProfit = Number(buyTakeProfit);
    if (
      !Number.isFinite(stopLoss) ||
      !Number.isFinite(takeProfit) ||
      stopLoss <= 0 ||
      takeProfit <= 0 ||
      stopLoss >= selected.ltp ||
      takeProfit <= selected.ltp
    ) {
      setMsg("Set valid premium SL (< entry) and TP (> entry) before buying.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          underlying,
          strike: selected.strike,
          optionType: selected.optionType,
          expiry: selected.expiry,
          action: "BUY",
          lotSize: selected.lotSize,
          lots: buyLots,
          entryPremium: selected.ltp,
          mode,
          symbolToken: selected.symboltoken,
          tradingSymbol: selected.tradingsymbol,
          stopLoss,
          takeProfit,
          acknowledgeSellRisk: false,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Trade failed");
      setAccount(json.account);
      setSummary(json.summary);
      setMsg(
        json.note ??
          `Paper trade placed · SL ₹${stopLoss.toFixed(2)} · TP ₹${takeProfit.toFixed(2)}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  function liveMarkForPosition(p: Account["positions"][number]): number | null {
    const match = contracts.find(
      (c) =>
        c.strike === p.strike &&
        c.optionType === p.optionType &&
        (p.tradingSymbol
          ? c.tradingsymbol === p.tradingSymbol
          : p.underlying === underlying),
    );
    return match?.ltp ?? null;
  }

  function markPremiumForPosition(p: Account["positions"][number]): number {
    return liveMarkForPosition(p) ?? p.entryPremium;
  }

  async function exitPosition(p: Account["positions"][number]) {
    setExitingId(p.id);
    setExitMsg(null);
    try {
      const exitPremium = markPremiumForPosition(p);
      const res = await fetch("/api/paper/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionId: p.id,
          exitPremium,
          closeReason: "MANUAL",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Exit failed");
      setAccount(json.account);
      setSummary(json.summary);
      setExitMsg(
        `Exited ${p.underlying} ${p.strike} ${p.optionType} @ ₹${exitPremium.toFixed(2)} — ${json.note ?? "closed"}`,
      );
    } catch (e) {
      setExitMsg(e instanceof Error ? e.message : "Exit failed");
    } finally {
      setExitingId(null);
    }
  }

  const open = account?.positions.filter((p) => p.status === "OPEN") ?? [];
  const closed = account?.positions.filter((p) => p.status !== "OPEN") ?? [];

  const strikes = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);

  /** Index at which to insert the spot marker (before strikes[i], or length = after last). */
  const spotInsertIndex = useMemo(() => {
    if (spot == null || !strikes.length) return -1;
    const idx = strikes.findIndex((s) => s > spot);
    return idx === -1 ? strikes.length : idx;
  }, [spot, strikes]);

  const spotRow =
    spot != null ? (
      <tr key="spot-marker" ref={spotMarkerRef} className="relative">
        <td colSpan={5} className="relative h-0 border-0 p-0">
          <div className="absolute inset-x-0 top-0 z-20 -translate-y-1/2 px-2">
            <SpotPriceMarker
              spot={spot}
              change={spotChange}
              changePct={spotChangePct}
            />
          </div>
        </td>
      </tr>
    ) : null;

  // First paint (and when underlying/expiry changes): scroll so current price sits mid-viewport.
  useEffect(() => {
    if (spot == null || !strikes.length || spotInsertIndex < 0) return;
    const key = `${underlying}:${expiry}`;
    if (centeredForKeyRef.current === key) return;

    const frame = requestAnimationFrame(() => {
      const container = chainScrollRef.current;
      const marker = spotMarkerRef.current;
      if (!container || !marker) return;

      const containerRect = container.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const markerCenter =
        markerRect.top - containerRect.top + container.scrollTop + markerRect.height / 2;
      container.scrollTop = Math.max(0, markerCenter - container.clientHeight / 2);
      centeredForKeyRef.current = key;
    });

    return () => cancelAnimationFrame(frame);
  }, [underlying, expiry, spot, strikes.length, spotInsertIndex]);

  const formDisabled = !selected;

  return (
    <div className="space-y-4 sm:space-y-6">
      <section>
        <h1 className="text-xl font-semibold text-binance-gold sm:text-2xl">
          Paper Trading
        </h1>
        <p className="mt-1 text-xs text-binance-muted sm:text-sm">
          Simulated options only — this path never calls Angel One order APIs.
        </p>
      </section>

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["Cash Balance", summary.cashBalance],
            ["Portfolio Value", summary.totalPortfolioValue],
            ["Realized P&L", summary.realizedPnl],
            ["Unrealized P&L", summary.unrealizedPnl],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg bg-binance-surface p-3">
              <p className="text-xs text-binance-muted">{label}</p>
              <p
                className={`text-lg font-semibold tabular-nums tracking-tight ${
                  Number(value) > 0 && String(label).includes("P&L")
                    ? "text-binance-bull"
                    : Number(value) < 0
                      ? "text-binance-bear"
                      : ""
                }`}
              >
                ₹{Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value)}
          className="rounded border border-binance-border bg-binance-elevated px-3 py-2 text-sm"
        >
          <option value="NIFTY">Nifty 50</option>
          <option value="BANKNIFTY">BANKNIFTY</option>
          <option value="SENSEX">SENSEX</option>
        </select>
        <ModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          onClick={() => reconnectChain()}
          className="rounded border border-binance-border px-3 py-2 text-sm text-binance-muted hover:text-binance-text"
        >
          Refresh chain
        </button>
        <span className="inline-flex flex-wrap items-center gap-2 text-xs text-binance-muted">
          <span>Expiry {expiry || "—"}</span>
          <LiveBadge active={chainLive || indexLive} />
          <span>
            {chainFeed === "angel-ws"
              ? `Angel WS · ATM ${subscribedTokens || "—"} tok`
              : chainFeed === "demo"
                ? "demo chain"
                : "REST fallback"}
            {chainUpdatedAt
              ? ` · ${new Date(chainUpdatedAt).toLocaleTimeString("en-IN")}`
              : ""}
          </span>
        </span>
      </div>

      {/* Chain left + Binance-style order ticket right */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start">
        <div className="min-w-0 space-y-1.5">
          {greeksStatus === "unavailable" && (
            <p
              className="px-0.5 text-[11px] text-binance-muted"
              title="Angel Greeks (approx.) — live contracts, market hours only"
            >
              Greeks unavailable outside market hours
            </p>
          )}
        <div
          ref={chainScrollRef}
          className="relative max-h-[min(560px,65vh)] min-h-80 overflow-auto rounded-lg border border-binance-border bg-binance-surface"
        >
          {chainLoading && (
            <ChartAiLoader
              label={`${underlying} chain`}
              variant="chain"
            />
          )}
          {!chainLoading && chainError && contracts.length === 0 && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-binance-surface/90 p-4">
              <p className="inline-flex max-w-sm items-start gap-2 text-sm text-binance-bear">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {chainError}
                  <button
                    type="button"
                    onClick={() => reconnectChain()}
                    className="ml-2 text-binance-gold underline-offset-2 hover:underline"
                  >
                    Retry
                  </button>
                </span>
              </p>
            </div>
          )}
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 z-30 bg-binance-elevated text-binance-muted">
              <tr>
                <th className="px-3 py-2 text-right">Call LTP</th>
                <th className="px-3 py-2 text-right">OI</th>
                <th className="px-3 py-2 text-center">Strike</th>
                <th className="px-3 py-2">OI</th>
                <th className="px-3 py-2">Put LTP</th>
              </tr>
            </thead>
            <tbody>
              {strikes.flatMap((strike, i) => {
                const ce = contracts.find(
                  (c) => c.strike === strike && c.optionType === "CE",
                );
                const pe = contracts.find(
                  (c) => c.strike === strike && c.optionType === "PE",
                );
                const rows = [];
                if (spotInsertIndex === i && spotRow) rows.push(spotRow);
                rows.push(
                  <tr key={strike} className="border-t border-binance-border/60">
                    <td className="px-2 py-2 text-right">
                      <PremiumCell
                        contract={ce}
                        selected={sameContract(selected, ce)}
                        onSelect={() => ce && selectContract(ce)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right text-binance-muted tabular-nums">
                      {ce?.oi?.toLocaleString("en-IN") ?? "—"}
                    </td>
                    <td className="bg-binance-elevated/40 px-3 py-2.5 text-center font-mono font-semibold tabular-nums">
                      {formatStrike(strike)}
                    </td>
                    <td className="px-3 py-2.5 text-binance-muted tabular-nums">
                      {pe?.oi?.toLocaleString("en-IN") ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <PremiumCell
                        contract={pe}
                        selected={sameContract(selected, pe)}
                        onSelect={() => pe && selectContract(pe)}
                      />
                    </td>
                  </tr>,
                );
                return rows;
              })}
              {spotInsertIndex === strikes.length && spotRow}
            </tbody>
          </table>
        </div>
        </div>

        <aside className="sticky top-4 rounded-lg border border-binance-border bg-binance-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-2 border-b border-binance-border pb-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="border-b-2 border-binance-gold pb-2 font-medium text-binance-gold">
                Market
              </span>
              <span className="pb-2 text-binance-muted" title="Paper fills at live LTP">
                Limit
              </span>
            </div>
          </div>

          <div className="mb-4 min-h-10">
            {selected ? (
              <div>
                <p className="text-sm font-medium text-binance-text">
                  {selected.tradingsymbol}
                </p>
                <p className="text-xs text-binance-muted">
                  {selected.optionType} · Strike {formatStrike(selected.strike)} · Exp{" "}
                  {selected.expiry}
                </p>
              </div>
            ) : (
              <p className="text-sm text-binance-muted">
                Select a Call or Put LTP from the chain to trade.
              </p>
            )}
          </div>

          <BuyOrderPanel
            selected={selected}
            lots={buyLots}
            onLotsChange={(n) => {
              setBuyLots(n);
              setBuyPct(0);
            }}
            stopLoss={buyStopLoss}
            takeProfit={buyTakeProfit}
            onStopLossChange={setBuyStopLoss}
            onTakeProfitChange={setBuyTakeProfit}
            onResetLevels={() => {
              if (selected) applyDefaultLevels(selected.ltp);
            }}
            pct={buyPct}
            onPctChange={applyBuyPct}
            cashBalance={cashBalance}
            maxLots={maxBuyLots}
            notional={buyNotional}
            maxLossText={buyMaxLoss}
            busy={busy}
            onSubmit={() => void submitBuy()}
            disabled={formDisabled}
          />

          {msg && (
            <p className="mt-3 text-xs text-binance-muted">{msg}</p>
          )}
        </aside>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-binance-muted">Open positions</h2>
        <div className="overflow-x-auto rounded-lg border border-binance-border">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-binance-elevated text-binance-muted">
              <tr>
                <th className="px-3 py-2">Contract</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Mark</th>
                <th className="px-3 py-2">SL</th>
                <th className="px-3 py-2">TP</th>
                <th className="px-3 py-2">Live P&L</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Lots</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => {
                const dte =
                  (new Date(p.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
                const liveMark = liveMarkForPosition(p);
                const mark = liveMark ?? p.entryPremium;
                const { stopLoss, takeProfit } = levelsFor(p);
                const slTp = slTpLabel(p.entrySnapshot);
                // Live P&L: BUY (mark - entry) * lot * lots; SELL (entry - mark) * lot * lots
                const livePnl =
                  liveMark == null
                    ? null
                    : unrealizedPnl({
                        action: p.action === "SELL" ? "SELL" : "BUY",
                        entryPremium: p.entryPremium,
                        markPremium: liveMark,
                        lotSize: p.lotSize,
                        lots: p.lots,
                      });
                return (
                  <tr key={p.id} className="border-t border-binance-border/60">
                    <td className="px-3 py-2">
                      {p.underlying} {p.strike} {p.optionType}
                      {dte <= 3 && (
                        <span className="ml-2 text-binance-gold">Θ near expiry</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{p.action}</td>
                    <td className="px-3 py-2 tabular-nums">{p.entryPremium}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {liveMark != null ? (
                        liveMark.toFixed(2)
                      ) : (
                        <span className="text-binance-muted" title="Switch underlying to load live mark">
                          —
                        </span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 tabular-nums text-binance-bear"
                      title={slTp.title ?? undefined}
                    >
                      {stopLoss.toFixed(2)}
                      {slTp.text && (
                        <span className="mt-0.5 block text-[10px] font-normal text-binance-muted">
                          {slTp.text}
                        </span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 tabular-nums text-binance-bull"
                      title={slTp.title ?? undefined}
                    >
                      {takeProfit.toFixed(2)}
                      {slTp.text && (
                        <span className="mt-0.5 block text-[10px] font-normal text-binance-muted">
                          {slTp.text}
                        </span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 font-medium tabular-nums ${
                        livePnl == null
                          ? "text-binance-muted"
                          : livePnl >= 0
                            ? "text-binance-bull"
                            : "text-binance-bear"
                      }`}
                    >
                      {livePnl == null
                        ? "—"
                        : `${livePnl >= 0 ? "+" : ""}₹${livePnl.toLocaleString("en-IN", {
                            maximumFractionDigits: 0,
                          })}`}
                    </td>
                    <td
                      className="px-3 py-2 tabular-nums text-binance-text"
                      title={p.openedAt ? `Opened ${p.openedAt}` : undefined}
                    >
                      {formatDuration(p.openedAt, now)}
                    </td>
                    <td className="px-3 py-2">{p.lots}</td>
                    <td className="px-3 py-2">{p.mode}</td>
                    <td className="px-3 py-2">{p.expiry}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={exitingId === p.id}
                        onClick={() => void exitPosition(p)}
                        title={`Exit @ ₹${mark.toFixed(2)} (live mark or entry)`}
                        className="inline-flex items-center gap-1.5 rounded border border-binance-bear/50 px-2.5 py-1 text-binance-bear hover:bg-binance-bear/10 disabled:opacity-50"
                      >
                        {exitingId === p.id && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Exit
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!open.length && (
                <tr>
                  <td className="px-3 py-3 text-binance-muted" colSpan={12}>
                    No open positions
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {exitMsg && <p className="text-xs text-binance-muted">{exitMsg}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-binance-muted">Closed / expired</h2>
        <div className="overflow-x-auto rounded-lg border border-binance-border">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-binance-elevated text-binance-muted">
              <tr>
                <th className="px-3 py-2">Contract</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Exit</th>
                <th className="px-3 py-2">SL</th>
                <th className="px-3 py-2">TP</th>
                <th className="px-3 py-2">P&L</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...closed]
                .sort((a, b) => {
                  const ta = a.closedAt ? new Date(a.closedAt).getTime() : 0;
                  const tb = b.closedAt ? new Date(b.closedAt).getTime() : 0;
                  return tb - ta;
                })
                .map((p) => {
                  const { stopLoss, takeProfit } = levelsFor(p);
                  const slTp = slTpLabel(p.entrySnapshot);
                  const endMs = p.closedAt
                    ? new Date(p.closedAt).getTime()
                    : now;
                  const pnl = p.realizedPnl ?? 0;
                  return (
                    <tr key={p.id} className="border-t border-binance-border/60">
                      <td className="px-3 py-2">
                        {p.underlying} {p.strike} {p.optionType}
                      </td>
                      <td className="px-3 py-2">{p.action}</td>
                      <td className="px-3 py-2 tabular-nums">{p.entryPremium}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {p.exitPremium != null ? Number(p.exitPremium).toFixed(2) : "—"}
                      </td>
                      <td
                        className="px-3 py-2 tabular-nums text-binance-bear"
                        title={slTp.title ?? undefined}
                      >
                        {stopLoss.toFixed(2)}
                        {slTp.text && (
                          <span className="mt-0.5 block text-[10px] font-normal text-binance-muted">
                            {slTp.text}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-2 tabular-nums text-binance-bull"
                        title={slTp.title ?? undefined}
                      >
                        {takeProfit.toFixed(2)}
                        {slTp.text && (
                          <span className="mt-0.5 block text-[10px] font-normal text-binance-muted">
                            {slTp.text}
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 font-medium tabular-nums ${
                          pnl >= 0 ? "text-binance-bull" : "text-binance-bear"
                        }`}
                      >
                        {pnl >= 0 ? "+" : ""}₹
                        {pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatDuration(p.openedAt, endMs)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            p.closeReason === "TP"
                              ? "text-binance-bull"
                              : p.closeReason === "SL"
                                ? "text-binance-bear"
                                : "text-binance-muted"
                          }
                        >
                          {closeReasonLabel(p.closeReason, p.status)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              {!closed.length && (
                <tr>
                  <td className="px-3 py-3 text-binance-muted" colSpan={9}>
                    No history yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
