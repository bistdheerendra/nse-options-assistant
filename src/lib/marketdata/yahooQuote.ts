/**
 * Shared Yahoo Finance chart quote helper (unofficial free endpoint).
 * Prefer chart API over /v7/finance/quote — quote batch often returns Unauthorized.
 */

export type YahooSimpleQuote = {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string | null;
  shortName: string | null;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        currency?: string;
        shortName?: string;
        longName?: string;
      };
    }> | null;
    error?: { description?: string };
  };
};

const UA = "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)";

export async function fetchYahooSimpleQuote(
  symbol: string,
): Promise<YahooSimpleQuote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartResponse;
    const meta = json.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price)) return null;
    const prevClose = Number(
      meta?.chartPreviousClose ?? meta?.previousClose ?? price,
    );
    // change = price - prevClose; changePct = change / prevClose * 100
    const change = price - prevClose;
    const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
    return {
      symbol: meta?.symbol ?? symbol,
      price,
      prevClose,
      change,
      changePct,
      currency: meta?.currency ?? null,
      shortName: meta?.shortName ?? meta?.longName ?? null,
    };
  } catch {
    return null;
  }
}

/** Bounded concurrency — avoid unthrottled parallel Yahoo hammering. */
export async function fetchYahooQuotesBatched(
  symbols: string[],
  concurrency = 4,
): Promise<Map<string, YahooSimpleQuote>> {
  const out = new Map<string, YahooSimpleQuote>();
  for (let i = 0; i < symbols.length; i += concurrency) {
    const chunk = symbols.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (s) => {
        const q = await fetchYahooSimpleQuote(s);
        return [s, q] as const;
      }),
    );
    for (const [s, q] of results) {
      if (q) out.set(s, q);
    }
  }
  return out;
}
