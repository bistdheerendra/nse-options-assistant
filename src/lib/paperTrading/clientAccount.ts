import { markPremiumFromMap } from "./positionMarkLookup";
import { unrealizedPnl } from "./pnl";

/** NSE options tick — treat this (or larger) as a real fill correction. */
export const PREMIUM_CORRECTION_TICK = 0.05;

export function premiumsDiffer(
  a: number,
  b: number,
  tick = PREMIUM_CORRECTION_TICK,
): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) >= tick;
}

export type ClientPosition = {
  id: string;
  accountId: string;
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
  symbolToken?: string | null;
  tradingSymbol?: string | null;
  openedAt?: string;
  closedAt?: string | null;
  entrySnapshot?: unknown;
  pending?: "opening" | "closing";
  fillCorrected?: boolean;
};

export type ClientAccount = {
  id: string;
  name: string;
  cashBalance: number;
  startingCash: number;
  createdAt: string;
  updatedAt: string;
  positions: ClientPosition[];
};

export type ClientSummary = {
  cashBalance: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPortfolioValue: number;
};

/** Merge a server (or optimistic) row into local account state. */
export function upsertPosition(
  account: ClientAccount,
  position: ClientPosition,
  cashBalance: number,
): ClientAccount {
  const idx = account.positions.findIndex((p) => p.id === position.id);
  const positions =
    idx >= 0
      ? account.positions.map((p) => (p.id === position.id ? position : p))
      : [...account.positions, position];
  return {
    ...account,
    cashBalance,
    updatedAt: new Date().toISOString(),
    positions,
  };
}

export function replacePositionId(
  account: ClientAccount,
  oldId: string,
  position: ClientPosition,
  cashBalance: number,
): ClientAccount {
  return {
    ...account,
    cashBalance,
    updatedAt: new Date().toISOString(),
    positions: account.positions.map((p) =>
      p.id === oldId ? position : p,
    ),
  };
}

export function removePosition(
  account: ClientAccount,
  positionId: string,
  cashBalance: number,
): ClientAccount {
  return {
    ...account,
    cashBalance,
    updatedAt: new Date().toISOString(),
    positions: account.positions.filter((p) => p.id !== positionId),
  };
}

/** Same math as server portfolioSummary — client-safe (no Prisma/fs). */
export function summaryFromAccount(
  account: ClientAccount,
  marks: Record<string, number>,
): ClientSummary {
  let unrealized = 0;
  let realized = 0;
  for (const p of account.positions) {
    if (p.status === "OPEN" || p.pending === "opening") {
      const mark = markPremiumFromMap(p, marks) ?? p.entryPremium;
      unrealized += unrealizedPnl({
        action: p.action === "SELL" ? "SELL" : "BUY",
        entryPremium: p.entryPremium,
        markPremium: mark,
        lotSize: p.lotSize,
        lots: p.lots,
      });
    } else {
      realized += p.realizedPnl ?? 0;
    }
  }
  return {
    cashBalance: account.cashBalance,
    unrealizedPnl: unrealized,
    realizedPnl: realized,
    totalPortfolioValue: account.cashBalance + unrealized,
  };
}
