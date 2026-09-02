import { promises as fs } from "fs";
import path from "path";
import { hasDatabase, prisma } from "@/lib/prisma";
import { recordOutcomeFromClosedPosition } from "@/lib/backtest/paperOutcomeBridge";
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
import { markPremiumFromMap } from "./positionMarkLookup";
import { paperTiming } from "./timing";
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

/** Hot-path open/close result — never includes full position history. */
export type PaperMutationResult = {
  position: PaperPosition;
  cashBalance: number;
  accountId: string;
};

type StoreFile = { account: PaperAccount };

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "paper-account.json");

/** Last successful DB read — survives brief pooler blips within the same process. */
let memoryCache: PaperAccount | null = null;
/** Short TTL so dashboard + paper + TP/SL paths don't re-pull full positions every call. */
let memoryCacheAt = 0;
const PAPER_MEMORY_TTL_MS = 3_000;

function invalidatePaperMemoryCache(): void {
  memoryCache = null;
  memoryCacheAt = 0;
}

/** Account id never changes for the default paper book — skip a round-trip after first resolve. */
let stickyAccountId: string | null = null;

function setPaperMemoryCache(account: PaperAccount): void {
  memoryCache = account;
  memoryCacheAt = Date.now();
  stickyAccountId = account.id;
}

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

/** Merge keys into OptionsPosition.entrySnapshot (DB or file). */
export async function patchPositionEntrySnapshot(
  positionId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const t0 = Date.now();
  if (hasDatabase() && prisma) {
    const current = await prisma.optionsPosition.findUnique({
      where: { id: positionId },
      select: { entrySnapshot: true },
    });
    paperTiming("patchPositionEntrySnapshot.findUnique", t0);
    if (!current) return;
    const tUpd = Date.now();
    await prisma.optionsPosition.update({
      where: { id: positionId },
      data: {
        entrySnapshot: mergeSnapshot(current.entrySnapshot, extra),
      },
      select: { id: true },
    });
    paperTiming("patchPositionEntrySnapshot.update", tUpd);
    invalidatePaperMemoryCache();
    return;
  }
  const store = await readFileStore();
  const p = store.account.positions.find((x) => x.id === positionId);
  if (!p) return;
  p.entrySnapshot = mergeSnapshot(p.entrySnapshot, extra);
  store.account.updatedAt = new Date().toISOString();
  await writeFileStore(store);
}

async function maybeRecordTrackOutcome(pos: PaperPosition): Promise<void> {
  try {
    const result = await recordOutcomeFromClosedPosition(
      pos,
      patchPositionEntrySnapshot,
    );
    if (result.recorded) {
      console.info(
        `[paper→track] recorded outcome ${result.outcomeId} for position ${pos.id} (idea ${result.tradeIdeaId})`,
      );
    } else if (result.reason === "error") {
      console.warn(
        `[paper→track] skip position ${pos.id}: ${result.detail ?? result.reason}`,
      );
    }
  } catch (err) {
    console.warn(
      `[paper→track] failed for position ${pos.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function isoDay(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return d.toISOString().slice(0, 10);
}

function isoTs(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapDbPosition(p: DbPositionRow): PaperPosition {
  const meta = snapshotMeta(p.entrySnapshot);
  return {
    id: p.id,
    accountId: p.accountId,
    underlying: p.underlying,
    strike: p.strike,
    optionType: p.optionType,
    expiry: isoDay(p.expiry),
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
    openedAt: isoTs(p.openedAt) ?? new Date().toISOString(),
    closedAt: isoTs(p.closedAt),
    entrySnapshot: p.entrySnapshot,
  };
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
    positions: acc.positions.map(mapDbPosition),
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
  const t0 = Date.now();
  if (
    memoryCache &&
    Date.now() - memoryCacheAt < PAPER_MEMORY_TTL_MS
  ) {
    paperTiming("getOrCreateAccount.memoryCache", t0, `positions=${memoryCache.positions.length}`);
    return memoryCache;
  }

  if (hasDatabase() && prisma) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tQuery = Date.now();
        let acc = await prisma.paperOptionsAccount.findFirst({
          include: { positions: true },
          orderBy: { createdAt: "asc" },
        });
        paperTiming(
          `getOrCreateAccount.findFirst.attempt${attempt + 1}`,
          tQuery,
          `positions=${acc?.positions.length ?? 0}`,
        );
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
        setPaperMemoryCache(mapped);
        void mirrorToFile(mapped);
        paperTiming("getOrCreateAccount.dbTotal", t0, `positions=${mapped.positions.length}`);
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
        setPaperMemoryCache(file.account);
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
  const fileAccount = (await readFileStore()).account;
  setPaperMemoryCache(fileAccount);
  return fileAccount;
}

async function resolveAccountId(): Promise<string> {
  if (stickyAccountId) return stickyAccountId;
  if (memoryCache) {
    stickyAccountId = memoryCache.id;
    return stickyAccountId;
  }
  if (!hasDatabase() || !prisma) {
    const file = await readFileStore();
    stickyAccountId = file.account.id;
    return stickyAccountId;
  }
  const t0 = Date.now();
  let acc = await prisma.paperOptionsAccount.findFirst({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!acc) {
    acc = await prisma.paperOptionsAccount.create({
      data: {
        name: "Default Paper Account",
        cashBalance: startingCash(),
        startingCash: startingCash(),
      },
      select: { id: true },
    });
  }
  stickyAccountId = acc.id;
  paperTiming("resolveAccountId", t0, acc.id);
  return acc.id;
}

function patchCacheOpen(position: PaperPosition, cashBalance: number): void {
  stickyAccountId = position.accountId;
  if (!memoryCache) return;
  const positions = memoryCache.positions.some((p) => p.id === position.id)
    ? memoryCache.positions.map((p) => (p.id === position.id ? position : p))
    : [...memoryCache.positions, position];
  setPaperMemoryCache({
    ...memoryCache,
    cashBalance,
    updatedAt: new Date().toISOString(),
    positions,
  });
  void mirrorToFile(memoryCache);
}

function patchCacheClose(position: PaperPosition, cashBalance: number): void {
  stickyAccountId = position.accountId;
  if (!memoryCache) return;
  setPaperMemoryCache({
    ...memoryCache,
    cashBalance,
    updatedAt: new Date().toISOString(),
    positions: memoryCache.positions.map((p) =>
      p.id === position.id ? position : p,
    ),
  });
  void mirrorToFile(memoryCache);
}

async function resolveOpenPosition(positionId: string): Promise<PaperPosition> {
  if (memoryCache) {
    const cached = memoryCache.positions.find((p) => p.id === positionId);
    if (cached && cached.status === "OPEN") return cached;
  }
  if (hasDatabase() && prisma) {
    const t0 = Date.now();
    const row = await prisma.optionsPosition.findUnique({
      where: { id: positionId },
    });
    paperTiming("resolveOpenPosition.findUnique", t0);
    if (!row || row.status !== "OPEN") {
      throw new Error("Open position not found");
    }
    return mapDbPosition(row as DbPositionRow);
  }
  const store = await readFileStore();
  const p = store.account.positions.find((x) => x.id === positionId);
  if (!p || p.status !== "OPEN") throw new Error("Open position not found");
  return p;
}

async function openPositionDb(params: {
  accountId: string;
  cashDelta: number;
  underlying: string;
  strike: number;
  optionType: OptionSide;
  expiry: Date;
  action: TradeAction;
  lotSize: number;
  lots: number;
  entryPremium: number;
  stopLoss: number;
  takeProfit: number;
  mode: "SCALP" | "SWING";
  symbolToken: string | null;
  tradingSymbol: string | null;
  entrySnapshot: Prisma.InputJsonValue;
}): Promise<{ position: PaperPosition; cashBalance: number }> {
  if (!prisma) throw new Error("Paper database unavailable");
  const t0 = Date.now();
  // Two statements, no interactive $transaction (PgBouncer BEGIN/COMMIT was ~500ms).
  // Debit/credit first (returns new cash), then insert. If create fails, reverse cash.
  // BUY: if cash went negative, revert and reject. Concurrent paper buys are rare.
  const tCash = Date.now();
  const accAfter = await prisma.paperOptionsAccount.update({
    where: { id: params.accountId },
    data: { cashBalance: { increment: params.cashDelta } },
    select: { cashBalance: true },
  });
  paperTiming("openPositionDb.cashIncrement", tCash);
  if (params.action === "BUY" && accAfter.cashBalance < 0) {
    await prisma.paperOptionsAccount.update({
      where: { id: params.accountId },
      data: { cashBalance: { increment: -params.cashDelta } },
      select: { id: true },
    });
    throw new Error("Insufficient paper cash for this debit trade");
  }

  try {
    const tCreate = Date.now();
    const row = await prisma.optionsPosition.create({
      data: {
        accountId: params.accountId,
        underlying: params.underlying,
        strike: params.strike,
        optionType: params.optionType,
        expiry: params.expiry,
        action: params.action,
        lotSize: params.lotSize,
        lots: params.lots,
        entryPremium: params.entryPremium,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        mode: params.mode,
        symbolToken: params.symbolToken,
        tradingSymbol: params.tradingSymbol,
        entrySnapshot: params.entrySnapshot,
      },
    });
    paperTiming("openPositionDb.create", tCreate);
    paperTiming("openPositionDb.total", t0);
    return {
      position: mapDbPosition(row as DbPositionRow),
      cashBalance: accAfter.cashBalance,
    };
  } catch (err) {
    try {
      await prisma.paperOptionsAccount.update({
        where: { id: params.accountId },
        data: { cashBalance: { increment: -params.cashDelta } },
        select: { id: true },
      });
    } catch (revertErr) {
      console.error(
        "[paper] cash revert after failed position create:",
        revertErr,
      );
    }
    throw err;
  }
}

async function closePositionDb(params: {
  positionId: string;
  accountId: string;
  exitPremium: number;
  realized: number;
  closeCash: number;
  entrySnapshot: Prisma.InputJsonValue;
  closeReason: string;
}): Promise<{ position: PaperPosition; cashBalance: number }> {
  if (!prisma) throw new Error("Paper database unavailable");
  const t0 = Date.now();
  const tUpd = Date.now();
  const row = await prisma.optionsPosition.update({
    where: { id: params.positionId },
    data: {
      status: "CLOSED",
      exitPremium: params.exitPremium,
      realizedPnl: params.realized,
      closedAt: new Date(),
      closeReason: params.closeReason,
      entrySnapshot: params.entrySnapshot,
    },
  });
  paperTiming("closePositionDb.positionUpdate", tUpd);
  const tCash = Date.now();
  const acc = await prisma.paperOptionsAccount.update({
    where: { id: params.accountId },
    data: { cashBalance: { increment: params.closeCash } },
    select: { cashBalance: true },
  });
  paperTiming("closePositionDb.cashIncrement", tCash);
  paperTiming("closePositionDb.total", t0);
  return {
    position: mapDbPosition(row as DbPositionRow),
    cashBalance: acc.cashBalance,
  };
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
}): Promise<PaperMutationResult> {
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
    const tOpen = Date.now();
    const accountId = await resolveAccountId();
    paperTiming("openPaperTrade.resolveAccountId", tOpen);
    const entrySnapshot = mergeSnapshot(input.entrySnapshot, slTpMeta);
    const written = await openPositionDb({
      accountId,
      cashDelta,
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
      symbolToken: input.symbolToken ?? null,
      tradingSymbol: input.tradingSymbol ?? null,
      entrySnapshot,
    });
    patchCacheOpen(written.position, written.cashBalance);
    paperTiming("openPaperTrade.total", tOpen, `id=${written.position.id}`);
    return {
      position: written.position,
      cashBalance: written.cashBalance,
      accountId,
    };
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
  setPaperMemoryCache(store.account);
  return {
    position: pos,
    cashBalance: store.account.cashBalance,
    accountId: store.account.id,
  };
}

export async function closePaperTrade(params: {
  positionId: string;
  exitPremium: number;
  closeReason?: CloseReason;
}): Promise<PaperMutationResult> {
  const tClose = Date.now();
  const pos = await resolveOpenPosition(params.positionId);
  paperTiming("closePaperTrade.resolveOpenPosition", tClose);

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
    const written = await closePositionDb({
      positionId: pos.id,
      accountId: pos.accountId,
      exitPremium: params.exitPremium,
      realized,
      closeCash,
      entrySnapshot,
      closeReason,
    });
    patchCacheClose(written.position, written.cashBalance);
    // Track-record bookkeeping must not block the user-facing close.
    void maybeRecordTrackOutcome(written.position);
    paperTiming("closePaperTrade.total", tClose, `id=${written.position.id}`);
    return {
      position: written.position,
      cashBalance: written.cashBalance,
      accountId: written.position.accountId,
    };
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
  setPaperMemoryCache(store.account);
  void maybeRecordTrackOutcome(p);
  paperTiming("closePaperTrade.total", tClose);
  return {
    position: p,
    cashBalance: store.account.cashBalance,
    accountId: store.account.id,
  };
}

/**
 * Auto-close OPEN positions whose live mark hit premium TP or SL.
 * marks: tradingSymbol → LTP (fallback key: underlying-strike-optionType)
 */
export async function closePositionsOnTpSl(
  marks: Record<string, number>,
): Promise<{
  closed: Array<{
    id: string;
    reason: "TP" | "SL";
    exitPremium: number;
    position: PaperPosition;
  }>;
  cashBalance: number | null;
}> {
  const account = await getOrCreateAccount();
  const closed: Array<{
    id: string;
    reason: "TP" | "SL";
    exitPremium: number;
    position: PaperPosition;
  }> = [];
  let cashBalance: number | null = account.cashBalance;

  for (const pos of account.positions) {
    if (pos.status !== "OPEN") continue;
    const mark = markPremiumFromMap(pos, marks);
    if (mark == null) continue;

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

    const result = await closePaperTrade({
      positionId: pos.id,
      exitPremium: mark,
      closeReason: hit,
    });
    cashBalance = result.cashBalance;
    closed.push({
      id: pos.id,
      reason: hit,
      exitPremium: mark,
      position: result.position,
    });
  }

  return { closed, cashBalance };
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
        const current = await tx.optionsPosition.findUnique({
          where: { id: pos.id },
          select: { id: true, status: true },
        });
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
          select: { id: true },
        });
        await tx.paperOptionsAccount.update({
          where: { id: account.id },
          data: { cashBalance: { increment: closeCash } },
          select: { id: true },
        });
      });
      invalidatePaperMemoryCache();
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
    void maybeRecordTrackOutcome({
      ...pos,
      status: "EXPIRED",
      exitPremium,
      realizedPnl,
      closeReason: "EXPIRED",
      closedAt: new Date().toISOString(),
      entrySnapshot: mergeSnapshot(pos.entrySnapshot, {
        closeReason: "EXPIRED",
      }),
    });
  }

  return { settled: ids.length, ids };
}

/**
 * One-shot: write BacktestOutcome for already CLOSED/EXPIRED paper rows that
 * have tradeIdeaId but no trackRecordOutcomeId yet.
 */
export async function backfillPaperTrackOutcomes(): Promise<{
  scanned: number;
  recorded: number;
  skipped: Record<string, number>;
  outcomeIds: string[];
}> {
  const account = await getOrCreateAccount();
  const skipped: Record<string, number> = {};
  const outcomeIds: string[] = [];
  let recorded = 0;
  let scanned = 0;

  for (const pos of account.positions) {
    if (pos.status !== "CLOSED" && pos.status !== "EXPIRED") continue;
    scanned += 1;
    const result = await recordOutcomeFromClosedPosition(
      pos,
      patchPositionEntrySnapshot,
    );
    if (result.recorded) {
      recorded += 1;
      outcomeIds.push(result.outcomeId);
    } else {
      skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
    }
  }

  return { scanned, recorded, skipped, outcomeIds };
}

export function portfolioSummary(
  account: PaperAccount,
  marks: Record<string, number>,
) {
  let unrealized = 0;
  let realized = 0;
  for (const p of account.positions) {
    if (p.status === "OPEN") {
      const mark = markPremiumFromMap(p, marks) ?? p.entryPremium;
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
