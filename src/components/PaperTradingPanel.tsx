"use client";

import { ModeToggle } from "@/components/ModeToggle";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type ChainContract = {
  strike: number;
  optionType: "CE" | "PE";
  tradingsymbol: string;
  symboltoken: string;
  ltp: number;
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
    setSelected(null);
  }, [underlying]);

  useEffect(() => {
    void refresh();
    void loadChain();
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
          <option>NIFTY</option>
          <option>BANKNIFTY</option>
          <option>SENSEX</option>
        </select>
        <ModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          onClick={() => void loadChain()}
          className="rounded border border-binance-border px-3 py-2 text-sm text-binance-muted hover:text-binance-text"
        >
          Refresh chain
        </button>
        <span className="text-xs text-binance-muted">Expiry {expiry || "—"}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-binance-border">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-binance-elevated text-binance-muted">
            <tr>
              <th className="px-3 py-2">Strike</th>
              <th className="px-3 py-2">CE LTP</th>
              <th className="px-3 py-2">CE OI</th>
              <th className="px-3 py-2">CE IV</th>
              <th className="px-3 py-2">PE LTP</th>
              <th className="px-3 py-2">PE OI</th>
              <th className="px-3 py-2">PE IV</th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((strike) => {
              const ce = contracts.find((c) => c.strike === strike && c.optionType === "CE");
              const pe = contracts.find((c) => c.strike === strike && c.optionType === "PE");
              return (
                <tr key={strike} className="border-t border-binance-border/60">
                  <td className="px-3 py-2 font-mono">{strike}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className={`underline-offset-2 hover:underline ${selected === ce ? "text-binance-gold" : ""}`}
                      onClick={() => ce && setSelected(ce)}
                    >
                      {ce?.ltp.toFixed(2) ?? "—"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-binance-muted">{ce?.oi ?? "—"}</td>
                  <td className="px-3 py-2 text-binance-muted">{ce?.iv?.toFixed(1) ?? "—"}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className={`underline-offset-2 hover:underline ${selected === pe ? "text-binance-gold" : ""}`}
                      onClick={() => pe && setSelected(pe)}
                    >
                      {pe?.ltp.toFixed(2) ?? "—"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-binance-muted">{pe?.oi ?? "—"}</td>
                  <td className="px-3 py-2 text-binance-muted">{pe?.iv?.toFixed(1) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="space-y-3 rounded-lg bg-binance-surface p-4">
          <p className="text-sm">
            Selected{" "}
            <span className="text-binance-gold">
              {selected.tradingsymbol}
            </span>{" "}
            @ ₹{selected.ltp}
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
            <span className="self-center text-xs text-binance-muted">lots × {selected.lotSize}</span>
          </div>
          {maxLossCopy && (
            <p
              className={`flex gap-2 text-sm ${
                maxLossCopy.tone === "bear" ? "text-binance-bear" : "text-binance-muted"
              }`}
            >
              {maxLossCopy.tone === "bear" && <AlertTriangle className="h-4 w-4 shrink-0" />}
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
