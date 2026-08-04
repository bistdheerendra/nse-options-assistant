import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, prisma } from "@/lib/prisma";
import {
  defaultPremiumTpSl,
  premiumExitHit,
  resolvePremiumTpSl,
  settlePnl,
  unrealizedPnl,
  type CloseReason,
  type OptionSide,
  type SpotLevelsForPremiumSlTp,
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
  stopLoss?: number | null;
  takeProfit?: number | null;
  status: "OPEN" | "CLOSED" | "EXPIRED";
  exitPremium?: number | null;
  realizedPnl?: number | null;
  closeReason?: CloseReason | string | null;
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

/** Last successful DB read — survives brief pooler blips within the same process. */
let memoryCache: PaperAccount | null = null;

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

type DbPositionRow = {
  id: string;
  accountId: string;
  underlying: string;
  strike: number;
  optionType: OptionSide;
  expiry: Date;
  action: TradeAction;
  lotSize: number;
  lots: number;
  entryPremium: number;
  status: "OPEN" | "CLOSED" | "EXPIRED";
  exitPremium: number | null;
  realizedPnl: number | null;
  mode: "SCALP" | "SWING";
  symbolToken: string | null;
  tradingSymbol: string | null;
  openedAt: Date;
  closedAt: Date | null;
  entrySnapshot: unknown;
  stopLoss?: number | null;
  takeProfit?: number | null;
  closeReason?: string | null;
};

function snapshotMeta(snap: unknown): {
  stopLoss?: number;
  takeProfit?: number;
  closeReason?: string;
} {
  if (!snap || typeof snap !== "object") return {};
  const s = snap as Record<string, unknown>;
  return {
    stopLoss: typeof s.stopLoss === "number" ? s.stopLoss : undefined,
    takeProfit: typeof s.takeProfit === "number" ? s.takeProfit : undefined,
    closeReason: typeof s.closeReason === "string" ? s.closeReason : undefined,
  };
}

function mergeSnapshot(
  base: unknown,
  extra: Record<string, unknown>,
): Prisma.InputJsonValue {
  const prev =
    base && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  return { ...prev, ...extra } as Prisma.InputJsonValue;
}

function mapDbAccount(acc: {
  id: string;
  name: string;
  cashBalance: number;
  startingCash: number;
  createdAt: Date;
  updatedAt: Date;
  positions: DbPositionRow[];
}): PaperAccount {
  return {
    id: acc.id,
    name: acc.name,
    cashBalance: acc.cashBalance,
    startingCash: acc.startingCash,
    createdAt: acc.createdAt.toISOString(),
    updatedAt: acc.updatedAt.toISOString(),
    positions: acc.positions.map((p) => {
      const meta = snapshotMeta(p.entrySnapshot);
      return {
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
        stopLoss: p.stopLoss ?? meta.stopLoss ?? null,
        takeProfit: p.takeProfit ?? meta.takeProfit ?? null,
        status: p.status,
        exitPremium: p.exitPremium,
        realizedPnl: p.realizedPnl,
        closeReason: p.closeReason ?? meta.closeReason ?? null,
        mode: p.mode,
        symbolToken: p.symbolToken,
        tradingSymbol: p.tradingSymbol,
        openedAt: p.openedAt.toISOString(),
        closedAt: p.closedAt?.toISOString() ?? null,
        entrySnapshot: p.entrySnapshot,
      };
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mirrorToFile(account: PaperAccount): Promise<void> {
  try {
    await writeFileStore({ account });
  } catch {
    // non-fatal — mirror is best-effort
  }
}

/**
 * Load paper account. Prefers Postgres; on DB blips falls back to in-memory /
 * file mirror so the dashboard P&L card never hard-fails after a good read.
 */
export async function getOrCreateAccount(): Promise<PaperAccount> {
  if (hasDatabase() && prisma) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
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
        const mapped = mapDbAccount(acc as Parameters<typeof mapDbAccount>[0]);
        memoryCache = mapped;
        void mirrorToFile(mapped);
        return mapped;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[paper] DB attempt ${attempt + 1}/2 failed:`,
          err instanceof Error ? err.message : err,
        );
        if (attempt < 1) await sleep(400);
      }
    }

    if (memoryCache) {
      console.warn("[paper] serving in-memory cache after DB failure");
      return memoryCache;
    }

    try {
      const file = await readFileStore();
      // Prefer mirrored snapshot over throwing (empty default still better than 503)
      if (
        file.account.id !== "paper_default" ||
        file.account.positions.length > 0
      ) {
        memoryCache = file.account;
        console.warn("[paper] serving file mirror after DB failure");
        return file.account;
      }
    } catch {
      // fall through
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("Paper database unavailable");
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
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Verdict-card spot levels — preferred source for premium SL/TP when present. */
  spotLevels?: SpotLevelsForPremiumSlTp | null;
}): Promise<PaperAccount> {
  // Premium cash impact: BUY debits premium*mult; SELL credits it
  const notional = input.entryPremium * input.lotSize * input.lots;
  const cashDelta = input.action === "BUY" ? -notional : notional;

  const hasSpotLevels =
    input.spotLevels != null &&
    Number.isFinite(input.spotLevels.entrySpotAtSignal) &&
    Number.isFinite(input.spotLevels.stopLossSpot) &&
    Number.isFinite(input.spotLevels.tp1Spot);

  let stopLoss: number;
  let takeProfit: number;
  let takeProfit2: number | null = null;
  let slTpMeta: Record<string, unknown> = {};

  if (hasSpotLevels) {
    // Prefer delta projection from Analysis Entry/SL/TP1; else 0.6/1.8 fallback
    const resolved = resolvePremiumTpSl({
      action: input.action,
      entryPremium: input.entryPremium,
      spots: input.spotLevels,
    });
    stopLoss = resolved.stopLoss;
    takeProfit = resolved.takeProfit;
    takeProfit2 = resolved.takeProfit2;
    slTpMeta = {
      stopLoss,
      takeProfit,
      takeProfit2,
      slTpSource: resolved.source,
      entrySpotAtSignal: resolved.entrySpotAtSignal,
      stopLossSpot: resolved.stopLossSpot,
      tp1Spot: resolved.tp1Spot,
      tp2Spot: resolved.tp2Spot,
      delta: resolved.delta,
    };
  } else {
    const defaults = defaultPremiumTpSl(input.action, input.entryPremium);
    stopLoss =
      input.stopLoss != null && Number.isFinite(input.stopLoss)
        ? Number(input.stopLoss)
        : defaults.stopLoss;
    takeProfit =
      input.takeProfit != null && Number.isFinite(input.takeProfit)
        ? Number(input.takeProfit)
        : defaults.takeProfit;
    slTpMeta = {
      stopLoss,
      takeProfit,
      slTpSource: "multiplier_fallback" as const,
    };
  }

  if (hasDatabase() && prisma) {
    const acc = await getOrCreateAccount();
    const entrySnapshot = mergeSnapshot(input.entrySnapshot, slTpMeta);
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
          stopLoss,
          takeProfit,
          mode: input.mode,
          symbolToken: input.symbolToken,
          tradingSymbol: input.tradingSymbol,
          entrySnapshot,
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
    stopLoss,
    takeProfit,
    status: "OPEN",
    mode: input.mode,
    symbolToken: input.symbolToken,
    tradingSymbol: input.tradingSymbol,
    openedAt: new Date().toISOString(),
    entrySnapshot: mergeSnapshot(input.entrySnapshot, slTpMeta),
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
  closeReason?: CloseReason;
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
  const closeReason: CloseReason = params.closeReason ?? "MANUAL";
  const entrySnapshot = mergeSnapshot(pos.entrySnapshot, { closeReason });

  if (hasDatabase() && prisma) {
    await prisma.$transaction(async (tx) => {
      await tx.optionsPosition.update({
        where: { id: pos.id },
        data: {
          status: "CLOSED",
          exitPremium: params.exitPremium,
          realizedPnl: realized,
          closedAt: new Date(),
          entrySnapshot,
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
  p.closeReason = closeReason;
  p.entrySnapshot = entrySnapshot;
  p.closedAt = new Date().toISOString();
  store.account.cashBalance += closeCash;
  store.account.updatedAt = new Date().toISOString();
  await writeFileStore(store);
  return store.account;
}

/**
 * Auto-close OPEN positions whose live mark hit premium TP or SL.
 * marks: tradingSymbol → LTP (fallback key: underlying-strike-optionType)
 */
export async function closePositionsOnTpSl(
  marks: Record<string, number>,
): Promise<{ closed: Array<{ id: string; reason: "TP" | "SL"; exitPremium: number }> }> {
  const account = await getOrCreateAccount();
  const closed: Array<{ id: string; reason: "TP" | "SL"; exitPremium: number }> = [];

  for (const pos of account.positions) {
    if (pos.status !== "OPEN") continue;
    const key =
      pos.tradingSymbol ?? `${pos.underlying}-${pos.strike}-${pos.optionType}`;
    const mark = marks[key];
    if (mark == null || !Number.isFinite(mark)) continue;

    const levels =
      pos.stopLoss != null && pos.takeProfit != null
        ? { stopLoss: pos.stopLoss, takeProfit: pos.takeProfit }
        : defaultPremiumTpSl(pos.action, pos.entryPremium);

    const hit = premiumExitHit({
      action: pos.action,
      markPremium: mark,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
    });
    if (!hit) continue;

    await closePaperTrade({
      positionId: pos.id,
      exitPremium: mark,
      closeReason: hit,
    });
    closed.push({ id: pos.id, reason: hit, exitPremium: mark });
  }

  return { closed };
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
            entrySnapshot: mergeSnapshot(pos.entrySnapshot, {
              closeReason: "EXPIRED",
            }),
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
      p.closeReason = "EXPIRED";
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
