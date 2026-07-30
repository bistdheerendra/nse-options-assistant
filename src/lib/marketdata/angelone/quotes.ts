import { angelPost, isDemoMarketDataMode } from "./auth";
import { mockLtp } from "./mock";
import type { LtpQuote, Underlying } from "./types";
import { UNDERLYING_META } from "./types";

export async function getLtp(params: {
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
}): Promise<LtpQuote & { demo?: boolean }> {
  if (isDemoMarketDataMode()) {
    // Map known underlyings; otherwise fabricate from token
    const match = (Object.keys(UNDERLYING_META) as Underlying[]).find(
      (u) => UNDERLYING_META[u].symboltoken === params.symboltoken,
    );
    if (match) return mockLtp(match);
    return {
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      symboltoken: params.symboltoken,
      ltp: 100,
      demo: true,
    };
  }

  const data = await angelPost<{
    exchange: string;
    tradingsymbol: string;
    symboltoken: string;
    ltp: string | number;
    open?: string | number;
    high?: string | number;
    low?: string | number;
    close?: string | number;
  }>("/rest/secure/angelbroking/order/v1/getLtpData", {
    exchange: params.exchange,
    tradingsymbol: params.tradingsymbol,
    symboltoken: params.symboltoken,
  });

  return {
    exchange: data.exchange,
    tradingsymbol: data.tradingsymbol,
    symboltoken: String(data.symboltoken),
    ltp: Number(data.ltp),
    open: data.open !== undefined ? Number(data.open) : undefined,
    high: data.high !== undefined ? Number(data.high) : undefined,
    low: data.low !== undefined ? Number(data.low) : undefined,
    close: data.close !== undefined ? Number(data.close) : undefined,
  };
}

export async function getUnderlyingLtp(
  underlying: Underlying,
): Promise<LtpQuote & { demo?: boolean }> {
  const meta = UNDERLYING_META[underlying];
  return getLtp({
    exchange: meta.exchange,
    tradingsymbol: meta.tradingsymbol,
    symboltoken: meta.symboltoken,
  });
}

/** Convenience: NIFTY, BANKNIFTY, SENSEX + optional option contracts */
export async function getLiveQuotes(opts?: {
  underlyings?: Underlying[];
  options?: Array<{ exchange: string; tradingsymbol: string; symboltoken: string }>;
}) {
  const underlyings = opts?.underlyings ?? ["NIFTY", "BANKNIFTY", "SENSEX"];
  const indexQuotes = [];
  for (const u of underlyings) {
    indexQuotes.push({ underlying: u, ...(await getUnderlyingLtp(u)) });
  }
  const optionQuotes = [];
  for (const o of opts?.options ?? []) {
    optionQuotes.push(await getLtp(o));
  }
  return { indexQuotes, optionQuotes };
}
