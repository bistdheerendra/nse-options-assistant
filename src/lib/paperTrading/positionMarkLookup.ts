/** Client-safe mark keys / lookups — no Angel / Prisma imports. */

export type PositionMarkRef = {
  underlying: string;
  strike: number;
  optionType: string;
  symbolToken?: string | null;
  tradingSymbol?: string | null;
  expiry?: string;
};

export type ChainContractRef = {
  strike: number;
  optionType: string;
  tradingsymbol: string;
  symboltoken: string;
  ltp: number;
  expiry?: string;
};

export function positionMarkKeys(p: PositionMarkRef): string[] {
  const keys: string[] = [];
  if (p.tradingSymbol) keys.push(p.tradingSymbol);
  if (p.symbolToken) keys.push(`token:${p.symbolToken}`);
  keys.push(`${p.underlying}-${p.strike}-${p.optionType}`);
  return keys;
}

export function markPremiumFromMap(
  p: PositionMarkRef,
  marks: Record<string, number>,
): number | null {
  for (const key of positionMarkKeys(p)) {
    const m = marks[key];
    if (m != null && Number.isFinite(m) && m > 0) return m;
  }
  return null;
}

/** Match a paper row to a chain contract (NSE id, Angel token, or strike+type+expiry). */
export function matchChainContract<T extends ChainContractRef>(
  p: PositionMarkRef,
  contracts: T[],
): T | undefined {
  return contracts.find((c) => {
    if (p.tradingSymbol && c.tradingsymbol === p.tradingSymbol) return true;
    if (p.symbolToken && c.symboltoken === p.symbolToken) return true;
    return (
      c.strike === p.strike &&
      c.optionType === p.optionType &&
      (!p.expiry || !c.expiry || c.expiry === p.expiry)
    );
  });
}

/**
 * Prefer the selected chain's live LTP (SSE) when the contract is on that chain.
 * Otherwise use polled marks so NIFTY + BANKNIFTY (or other-expiry) rows all show P&L.
 */
export function resolveLiveMark(
  p: PositionMarkRef,
  contracts: ChainContractRef[],
  polledMarks: Record<string, number>,
  chainUnderlying?: string,
): number | null {
  const bySymbol = p.tradingSymbol
    ? contracts.find((c) => c.tradingsymbol === p.tradingSymbol)
    : undefined;
  if (bySymbol && Number.isFinite(bySymbol.ltp) && bySymbol.ltp > 0) {
    return bySymbol.ltp;
  }

  const byToken = p.symbolToken
    ? contracts.find((c) => c.symboltoken === p.symbolToken)
    : undefined;
  if (byToken && Number.isFinite(byToken.ltp) && byToken.ltp > 0) {
    return byToken.ltp;
  }

  // Legacy rows with no token/symbol: only match the chain for that underlying.
  if (!p.tradingSymbol && !p.symbolToken && chainUnderlying === p.underlying) {
    const loose = contracts.find(
      (c) => c.strike === p.strike && c.optionType === p.optionType,
    );
    if (loose && Number.isFinite(loose.ltp) && loose.ltp > 0) return loose.ltp;
  }

  return markPremiumFromMap(p, polledMarks);
}

/** Keys used by portfolioSummary / closePositionsOnTpSl. Chain LTP wins over poll. */
export function marksRecordForPositions(
  positions: PositionMarkRef[],
  contracts: ChainContractRef[],
  polledMarks: Record<string, number>,
  chainUnderlying?: string,
): Record<string, number> {
  const marks: Record<string, number> = { ...polledMarks };
  for (const p of positions) {
    const live = resolveLiveMark(p, contracts, polledMarks, chainUnderlying);
    if (live == null) continue;
    for (const key of positionMarkKeys(p)) marks[key] = live;
  }
  return marks;
}
