"use client";

import { ModeToggle } from "@/components/ModeToggle";
import { SpotPriceMarker } from "@/components/SpotPriceMarker";
import { theme } from "@/lib/theme";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
      className={`text-left underline-offset-2 hover:underline ${
        selected ? "text-binance-gold" : ""
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
  const [action, setAction] = useState<"BUY" | "SELL">("BUY");
  const [lots, setLots] = useState(1);
  const [ackSell, setAckSell] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/paper");
    const json = await res.json();
    setAccount(json.account);
    setSummary(json.summary);
  }, []);

  const loadChain = useCallback(async () => {
    const res = await fetch(`/api/paper/chain?underlying=${underlying}`);
    const json = await res.json();
    setContracts(json.contracts ?? []);
    setExpiry(json.expiry ?? "");
    setSpot(typeof json.spot === "number" ? json.spot : null);
    setSpotChange(Number(json.spotChange ?? 0));
    setSpotChangePct(Number(json.spotChangePct ?? 0));
    setSelected(null);
  }, [underlying]);

  useEffect(() => {
    void refresh();
    void loadChain();
    const id = window.setInterval(() => void loadChain(), 20_000);
    return () => window.clearInterval(id);
  }, [refresh, loadChain]);

  const maxLossCopy = useMemo(() => {
    if (!selected) return null;
    const mult = selected.lotSize * lots;
    if (action === "BUY") {
      return {
        tone: "muted" as const,
        text: `Max loss (buy) = premium paid = ₹${(selected.ltp * mult).toFixed(2)}`,
      };
    }
    if (selected.optionType === "CE") {
      return {
        tone: "bear" as const,
        text: "Sell CE — theoretically UNCAPPED loss if the underlying rallies.",
      };
    }
    const amt = (selected.strike - selected.ltp) * mult;
    return {
      tone: "bear" as const,
      text: `Sell PE — large loss bounded by strike (spot→0) ≈ ₹${amt.toFixed(2)}`,
    };
  }, [selected, action, lots]);

  async function submitTrade() {
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
          action,
          lotSize: selected.lotSize,
          lots,
          entryPremium: selected.ltp,
          mode,
          symbolToken: selected.symboltoken,
          tradingSymbol: selected.tradingsymbol,
          acknowledgeSellRisk: ackSell,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Trade failed");
      setAccount(json.account);
      setSummary(json.summary);
      setMsg(json.note);
      setAckSell(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
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
      <tr key="spot-marker" className="relative">
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
                className={`font-mono text-lg ${
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

      <div className="overflow-x-auto rounded-lg border border-binance-border">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-binance-elevated text-binance-muted">
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
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end">
                      <PremiumCell
                        contract={ce}
                        selected={selected === ce}
                        onSelect={() => ce && setSelected(ce)}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-binance-muted tabular-nums">
                    {ce?.oi?.toLocaleString("en-IN") ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-center font-mono font-semibold tabular-nums">
                    {formatStrike(strike)}
                  </td>
                  <td className="px-3 py-2.5 text-binance-muted tabular-nums">
                    {pe?.oi?.toLocaleString("en-IN") ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <PremiumCell
                      contract={pe}
                      selected={selected === pe}
                      onSelect={() => pe && setSelected(pe)}
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

      {selected && (
        <div className="space-y-3 rounded-lg bg-binance-surface p-4">
          <p className="text-sm">
            Selected{" "}
            <span className="text-binance-gold">{selected.tradingsymbol}</span> @ ₹
            {selected.ltp}
          </p>
          <div className="flex flex-wrap gap-3">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as "BUY" | "SELL")}
              className="rounded border border-binance-border bg-binance-elevated px-3 py-2 text-sm"
            >
              <option value="BUY">Buy</option>
              <option value="SELL">Sell / Write</option>
            </select>
            <input
              type="number"
              min={1}
              value={lots}
              onChange={(e) => setLots(Number(e.target.value) || 1)}
              className="w-24 rounded border border-binance-border bg-binance-elevated px-3 py-2 text-sm"
            />
            <span className="self-center text-xs text-binance-muted">
              lots × {selected.lotSize}
            </span>
          </div>
          {maxLossCopy && (
            <p
              className={`flex gap-2 text-sm ${
                maxLossCopy.tone === "bear" ? "text-binance-bear" : "text-binance-muted"
              }`}
            >
              {maxLossCopy.tone === "bear" && (
                <AlertTriangle className="h-4 w-4 shrink-0" />
              )}
              {maxLossCopy.text}
            </p>
          )}
          {action === "SELL" && (
            <label className="flex items-center gap-2 text-sm text-binance-bear">
              <input
                type="checkbox"
                checked={ackSell}
                onChange={(e) => setAckSell(e.target.checked)}
              />
              I acknowledge sell/write risk is uncapped or large
            </label>
          )}
          <button
            type="button"
            disabled={busy || (action === "SELL" && !ackSell)}
            onClick={() => void submitTrade()}
            className="inline-flex items-center gap-2 rounded bg-binance-gold px-4 py-2 text-sm font-semibold text-binance-bg disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm paper trade
          </button>
          {msg && <p className="text-xs text-binance-muted">{msg}</p>}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-binance-muted">Open positions</h2>
        <div className="overflow-x-auto rounded-lg border border-binance-border">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-binance-elevated text-binance-muted">
              <tr>
                <th className="px-3 py-2">Contract</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Lots</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Expiry</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => {
                const dte =
                  (new Date(p.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
                return (
                  <tr key={p.id} className="border-t border-binance-border/60">
                    <td className="px-3 py-2">
                      {p.underlying} {p.strike} {p.optionType}
                      {dte <= 3 && (
                        <span className="ml-2 text-binance-gold">Θ near expiry</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{p.action}</td>
                    <td className="px-3 py-2">{p.entryPremium}</td>
                    <td className="px-3 py-2">{p.lots}</td>
                    <td className="px-3 py-2">{p.mode}</td>
                    <td className="px-3 py-2">{p.expiry}</td>
                  </tr>
                );
              })}
              {!open.length && (
                <tr>
                  <td className="px-3 py-3 text-binance-muted" colSpan={6}>
                    No open positions
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
