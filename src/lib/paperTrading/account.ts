import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, prisma } from "@/lib/prisma";
import {
  settlePnl,
  unrealizedPnl,
  type OptionSide,
  type TradeAction,
} from "./pnl";
import type { Prisma } from "@prisma/client";

export type PaperPosition = {
  id: string;
  accountId: string;
  underlying: string;
  strike: number;
  optionType: OptionSide;
  expiry: string;
  action: TradeAction;
  lotSize: number;
  lots: number;
  entryPremium: number;
  status: "OPEN" | "CLOSED" | "EXPIRED";
  exitPremium?: number | null;
  realizedPnl?: number | null;
  mode: "SCALP" | "SWING";
  symbolToken?: string | null;
  tradingSymbol?: string | null;
  openedAt: string;
  closedAt?: string | null;
  entrySnapshot?: unknown;
};

export type PaperAccount = {
  id: string;
  name: string;
  cashBalance: number;
  startingCash: number;
  createdAt: string;
  updatedAt: string;
  positions: PaperPosition[];
};

type StoreFile = { account: PaperAccount };

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "paper-account.json");

function startingCash(): number {
  return Number(process.env.PAPER_STARTING_CASH ?? 100_000);
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

async function readFileStore(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(raw) as StoreFile;
  } catch {
    const now = new Date().toISOString();
    const account: PaperAccount = {
      id: "paper_default",
      name: "Default Paper Account",
      cashBalance: startingCash(),
      startingCash: startingCash(),
      createdAt: now,
      updatedAt: now,
      positions: [],
    };
    await writeFileStore({ account });
    return { account };
  }
}

async function writeFileStore(store: StoreFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function getOrCreateAccount(): Promise<PaperAccount> {
  if (hasDatabase() && prisma) {
    let acc = await prisma.paperOptionsAccount.findFirst({
      include: { positions: true },
      orderBy: { createdAt: "asc" },
    });
    if (!acc) {
      acc = await prisma.paperOptionsAccount.create({
        data: {
          name: "Default Paper Account",
          cashBalance: startingCash(),
          startingCash: startingCash(),
        },
        include: { positions: true },
      });
    }
    return {
      id: acc.id,
      name: acc.name,
      cashBalance: acc.cashBalance,
      startingCash: acc.startingCash,
      createdAt: acc.createdAt.toISOString(),
      updatedAt: acc.updatedAt.toISOString(),
      positions: acc.positions.map((p) => ({
        id: p.id,
        accountId: p.accountId,
        underlying: p.underlying,
        strike: p.strike,
        optionType: p.optionType,
        expiry: p.expiry.toISOString().slice(0, 10),
        action: p.action,
        lotSize: p.lotSize,
        lots: p.lots,
        entryPremium: p.entryPremium,
        status: p.status,
        exitPremium: p.exitPremium,
        realizedPnl: p.realizedPnl,
        mode: p.mode,
        symbolToken: p.symbolToken,
        tradingSymbol: p.tradingSymbol,
        openedAt: p.openedAt.toISOString(),
        closedAt: p.closedAt?.toISOString() ?? null,
        entrySnapshot: p.entrySnapshot,
      })),
    };
  }
  return (await readFileStore()).account;
}

export async function openPaperTrade(input: {
  underlying: string;
  strike: number;
  optionType: OptionSide;
  expiry: string;
  action: TradeAction;
  lotSize: number;
  lots: number;
  entryPremium: number;
  mode: "SCALP" | "SWING";
  symbolToken?: string;
  tradingSymbol?: string;
  entrySnapshot?: unknown;
}): Promise<PaperAccount> {
  // Premium cash impact: BUY debits premium*mult; SELL credits it
  const notional = input.entryPremium * input.lotSize * input.lots;
  const cashDelta = input.action === "BUY" ? -notional : notional;

  if (hasDatabase() && prisma) {
    const acc = await getOrCreateAccount();
    await prisma.$transaction(async (tx) => {
      await tx.paperOptionsAccount.update({
        where: { id: acc.id },
        data: { cashBalance: acc.cashBalance + cashDelta },
      });
      await tx.optionsPosition.create({
        data: {
          accountId: acc.id,
          underlying: input.underlying,
          strike: input.strike,
          optionType: input.optionType,
          expiry: new Date(input.expiry),
          action: input.action,
          lotSize: input.lotSize,
          lots: input.lots,
          entryPremium: input.entryPremium,
          mode: input.mode,
          symbolToken: input.symbolToken,
          tradingSymbol: input.tradingSymbol,
          entrySnapshot: input.entrySnapshot as Prisma.InputJsonValue | undefined,
        },
      });
    });
    return getOrCreateAccount();
  }

  const store = await readFileStore();
  if (input.action === "BUY" && store.account.cashBalance + cashDelta < 0) {
    throw new Error("Insufficient paper cash for this debit trade");
  }
  const pos: PaperPosition = {
    id: newId("pos"),
    accountId: store.account.id,
    underlying: input.underlying,
    strike: input.strike,
    optionType: input.optionType,
    expiry: input.expiry,
    action: input.action,
    lotSize: input.lotSize,
    lots: input.lots,
    entryPremium: input.entryPremium,
    status: "OPEN",
    mode: input.mode,
    symbolToken: input.symbolToken,
    tradingSymbol: input.tradingSymbol,
    openedAt: new Date().toISOString(),
    entrySnapshot: input.entrySnapshot,
  };
  store.account.cashBalance += cashDelta;
  store.account.positions.push(pos);
  store.account.updatedAt = new Date().toISOString();
  await writeFileStore(store);
  return store.account;
}

export async function closePaperTrade(params: {
  positionId: string;
  exitPremium: number;
}): Promise<PaperAccount> {
  const account = await getOrCreateAccount();
  const pos = account.positions.find((p) => p.id === params.positionId);
  if (!pos || pos.status !== "OPEN") throw new Error("Open position not found");

  const realized =
    pos.action === "BUY"
      ? (params.exitPremium - pos.entryPremium) * pos.lotSize * pos.lots
      : (pos.entryPremium - params.exitPremium) * pos.lotSize * pos.lots;

  // Closing: reverse premium mark into cash via realized path
  // Long close: receive exit premium; Short close: pay exit premium
  const closeCash =
    pos.action === "BUY"
      ? params.exitPremium * pos.lotSize * pos.lots
      : -params.exitPremium * pos.lotSize * pos.lots;

  if (hasDatabase() && prisma) {
    await prisma.$transaction(async (tx) => {
      await tx.optionsPosition.update({
        where: { id: pos.id },
        data: {
          status: "CLOSED",
          exitPremium: params.exitPremium,
          realizedPnl: realized,
          closedAt: new Date(),
        },
      });
      await tx.paperOptionsAccount.update({
        where: { id: account.id },
        data: { cashBalance: account.cashBalance + closeCash },
      });
    });
    return getOrCreateAccount();
  }

  const store = await readFileStore();
  const p = store.account.positions.find((x) => x.id === params.positionId)!;
  p.status = "CLOSED";
  p.exitPremium = params.exitPremium;
  p.realizedPnl = realized;
  p.closedAt = new Date().toISOString();
  store.account.cashBalance += closeCash;
  store.account.updatedAt = new Date().toISOString();
  await writeFileStore(store);
  return store.account;
}

export async function settleExpiredPositions(spotByUnderlying: Record<string, number>): Promise<{
  settled: number;
  ids: string[];
}> {
  const account = await getOrCreateAccount();
  const today = new Date().toISOString().slice(0, 10);
  const ids: string[] = [];

  for (const pos of account.positions) {
    if (pos.status !== "OPEN") continue;
    if (pos.expiry > today) continue;
    const spot = spotByUnderlying[pos.underlying];
    if (spot == null) continue;

    // Idempotent: only OPEN rows; status flips to EXPIRED once
    const { exitPremium, realizedPnl } = settlePnl({
      action: pos.action,
      optionType: pos.optionType,
      entryPremium: pos.entryPremium,
      spot,
      strike: pos.strike,
      lotSize: pos.lotSize,
      lots: pos.lots,
    });

    const closeCash =
      pos.action === "BUY"
        ? exitPremium * pos.lotSize * pos.lots
        : -exitPremium * pos.lotSize * pos.lots;

    if (hasDatabase() && prisma) {
      await prisma.$transaction(async (tx) => {
        const current = await tx.optionsPosition.findUnique({ where: { id: pos.id } });
        if (!current || current.status !== "OPEN") return;
        await tx.optionsPosition.update({
          where: { id: pos.id },
          data: {
            status: "EXPIRED",
            exitPremium,
            realizedPnl,
            closedAt: new Date(),
          },
        });
        await tx.paperOptionsAccount.update({
          where: { id: account.id },
          data: { cashBalance: { increment: closeCash } },
        });
      });
    } else {
      const store = await readFileStore();
      const p = store.account.positions.find((x) => x.id === pos.id);
      if (!p || p.status !== "OPEN") continue;
      p.status = "EXPIRED";
      p.exitPremium = exitPremium;
      p.realizedPnl = realizedPnl;
      p.closedAt = new Date().toISOString();
      store.account.cashBalance += closeCash;
      store.account.updatedAt = new Date().toISOString();
      await writeFileStore(store);
    }
    ids.push(pos.id);
  }

  return { settled: ids.length, ids };
}

export function portfolioSummary(
  account: PaperAccount,
  marks: Record<string, number>,
) {
  let unrealized = 0;
  let realized = 0;
  for (const p of account.positions) {
    if (p.status === "OPEN") {
      const key = p.tradingSymbol ?? `${p.underlying}-${p.strike}-${p.optionType}`;
      const mark = marks[key] ?? p.entryPremium;
      unrealized += unrealizedPnl({
        action: p.action,
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
