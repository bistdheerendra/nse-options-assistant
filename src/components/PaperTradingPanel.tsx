"use client";

import { ModeToggle } from "@/components/ModeToggle";
import { SpotPriceMarker } from "@/components/SpotPriceMarker";
import { unrealizedPnl } from "@/lib/paperTrading/pnl";
import { theme } from "@/lib/theme";
import { Loader2 } from "lucide-react";
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
  lotSize: number;
  expiry: string;
};

type Account = {
  cashBalance: number;
  startingCash: number;
  positions: Array<{
    id: string;
    underlying: string;
    strike: number;
    optionType: string;
    expiry: string;
    action: string;
    lotSize: number;
    lots: number;
    entryPremium: number;
    status: string;
    exitPremium?: number | null;
    realizedPnl?: number | null;
    mode: string;
    tradingSymbol?: string | null;
  }>;
};

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
        disabled={disabled || busy || !selected || lots < 1}
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
  const [mode, setMode] = useState<"SCALP" | "SWING">("SWING");
  const [account, setAccount] = useState<Account | null>(null);
  const [summary, setSummary] = useState<{
    cashBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    totalPortfolioValue: number;
  } | null>(null);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [expiry, setExpiry] = useState("");
  const [spot, setSpot] = useState<number | null>(null);
  const [spotChange, setSpotChange] = useState(0);
  const [spotChangePct, setSpotChangePct] = useState(0);
  const [selected, setSelected] = useState<ChainContract | null>(null);
  const [buyLots, setBuyLots] = useState(1);
  const [buyPct, setBuyPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [exitMsg, setExitMsg] = useState<string | null>(null);
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const spotMarkerRef = useRef<HTMLTableRowElement>(null);
  /** Only auto-center spot once per underlying+expiry (not on 20s refresh). */
  const centeredForKeyRef = useRef<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/paper");
    const json = await res.json();
    setAccount(json.account);
    setSummary(json.summary);
  }, []);

  const loadChain = useCallback(async () => {
    const res = await fetch(`/api/paper/chain?underlying=${underlying}`);
    const json = await res.json();
    const next: ChainContract[] = json.contracts ?? [];
    setContracts(next);
    setExpiry(json.expiry ?? "");
    setSpot(typeof json.spot === "number" ? json.spot : null);
    setSpotChange(Number(json.spotChange ?? 0));
    setSpotChangePct(Number(json.spotChangePct ?? 0));

    // Keep selection across refresh; clear only if contract vanished.
    const key = selectedKeyRef.current;
    if (!key) {
      setSelected(null);
      return;
    }
    const match = next.find(
      (c) => c.tradingsymbol === key || c.symboltoken === key,
    );
    setSelected(match ?? null);
    if (!match) selectedKeyRef.current = null;
  }, [underlying]);

  useEffect(() => {
    selectedKeyRef.current = null;
    setSelected(null);
    setMsg(null);
    setBuyLots(1);
    setBuyPct(0);
  }, [underlying]);

  useEffect(() => {
    void refresh();
    void loadChain();
    const id = window.setInterval(() => void loadChain(), 20_000);
    return () => window.clearInterval(id);
  }, [refresh, loadChain]);

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

  function selectContract(c: ChainContract) {
    selectedKeyRef.current = c.tradingsymbol || c.symboltoken;
    setSelected(c);
    setMsg(null);
    setBuyLots(1);
    setBuyPct(0);
  }

  function applyBuyPct(pct: number) {
    setBuyPct(pct);
    if (!selected || maxBuyLots <= 0) return;
    setBuyLots(Math.max(1, Math.floor((maxBuyLots * pct) / 100)) || 1);
  }

  async function submitBuy() {
    if (!selected) return;
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
          acknowledgeSellRisk: false,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Trade failed");
      setAccount(json.account);
      setSummary(json.summary);
      setMsg(json.note ?? "Paper trade placed.");
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
        body: JSON.stringify({ positionId: p.id, exitPremium }),
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
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold text-binance-gold">Paper Trading</h1>
        <p className="mt-1 text-sm text-binance-muted">
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
          onClick={() => void loadChain()}
          className="rounded border border-binance-border px-3 py-2 text-sm text-binance-muted hover:text-binance-text"
        >
          Refresh chain
        </button>
        <span className="text-xs text-binance-muted">
          Expiry {expiry || "—"} · live NSE refresh ~20s
        </span>
      </div>

      {/* Chain left + Binance-style order ticket right */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start">
        <div
          ref={chainScrollRef}
          className="max-h-[min(560px,65vh)] overflow-auto rounded-lg border border-binance-border bg-binance-surface"
        >
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
                <th className="px-3 py-2">Live P&L</th>
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
                  <td className="px-3 py-3 text-binance-muted" colSpan={9}>
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
        <ul className="space-y-1 text-xs text-binance-muted">
          {closed.map((p) => (
            <li key={p.id}>
              {p.underlying} {p.strike}
              {p.optionType} {p.action} → {p.status} · P&L{" "}
              <span
                className={
                  (p.realizedPnl ?? 0) >= 0 ? "text-binance-bull" : "text-binance-bear"
                }
              >
                ₹{(p.realizedPnl ?? 0).toFixed(0)}
              </span>
            </li>
          ))}
          {!closed.length && <li>No history yet</li>}
        </ul>
      </section>
    </div>
  );
}
