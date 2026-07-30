export type Underlying = "NIFTY" | "BANKNIFTY" | "SENSEX";

export type CandleInterval =
  | "ONE_MINUTE"
  | "THREE_MINUTE"
  | "FIVE_MINUTE"
  | "FIFTEEN_MINUTE"
  | "ONE_HOUR"
  | "ONE_DAY";

export type OhlcvCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LtpQuote = {
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
};

export type OptionContractQuote = {
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

export type OptionChainResult = {
  underlying: Underlying;
  spot: number;
  expiry: string;
  contracts: OptionContractQuote[];
  demo?: boolean;
};

/** Well-known index tokens on Angel One (NSE/BSE indices) */
export const UNDERLYING_META: Record<
  Underlying,
  { exchange: "NSE" | "BSE"; tradingsymbol: string; symboltoken: string; lotSize: number; optionExchange: "NFO" | "BFO" }
> = {
  NIFTY: {
    exchange: "NSE",
    tradingsymbol: "Nifty 50",
    symboltoken: "99926000",
    lotSize: 75,
    optionExchange: "NFO",
  },
  BANKNIFTY: {
    exchange: "NSE",
    tradingsymbol: "Nifty Bank",
    symboltoken: "99926009",
    lotSize: 35,
    optionExchange: "NFO",
  },
  SENSEX: {
    exchange: "BSE",
    tradingsymbol: "SENSEX",
    symboltoken: "99919000",
    lotSize: 20,
    optionExchange: "BFO",
  },
};
