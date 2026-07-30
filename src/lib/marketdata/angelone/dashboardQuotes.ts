import { DASHBOARD_INDICES, type DashboardIndex } from "./dashboardIndices";
import { isDemoMarketDataMode } from "./auth";
import { mockCandles, mockGiftNiftyLtp, mockLtp } from "./mock";
import { getLtp } from "./quotes";
import { getHistoricalCandles } from "./candles";
import type { OhlcvCandle, Underlying } from "./types";
import { fetchPublicDashboardQuotes } from "@/lib/marketdata/publicIndices";

export type DashboardQuoteCard = {
  id: DashboardIndex;
  label: string;
  ltp: number;
  change: number;
  changePct: number;
  candles: Array<{ open: number; high: number; low: number; close: number }>;
  demo: boolean;
  note: string | null;
  analysisUnderlying: Underlying | null;
  source?: string;
};

function dayChange(ltp: number, prevClose: number | undefined) {
  if (prevClose === undefined || prevClose === 0) {
    return { change: 0, changePct: 0 };
  }
  // change = LTP - prevClose; changePct = change / prevClose * 100
  const change = ltp - prevClose;
  const changePct = (change / prevClose) * 100;
  return { change, changePct };
}

async function loadAngelCandles(
  id: Underlying,
  exchange: string,
  symboltoken: string,
): Promise<OhlcvCandle[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 1 * 24 * 60 * 60 * 1000);
  try {
    return await getHistoricalCandles({
      exchange,
      symboltoken,
      interval: "FIVE_MINUTE",
      from,
      to,
      underlyingHint: id,
    });
  } catch {
    return mockCandles(id, "FIVE_MINUTE", 40);
  }
}

export async function getDashboardQuotes(): Promise<{
  cards: DashboardQuoteCard[];
  demoMode: boolean;
}> {
  const demoMode = isDemoMarketDataMode();
  const publicQuotes = await fetchPublicDashboardQuotes();
  const cards: DashboardQuoteCard[] = [];

  for (const meta of DASHBOARD_INDICES) {
    const pub = publicQuotes[meta.id];

    // Prefer live public LTP so Dashboard always shows market prices
    // (even when MARKETDATA_DEMO_MODE is on for Angel lanes).
    if (pub && Number.isFinite(pub.ltp)) {
      const { change, changePct } = dayChange(pub.ltp, pub.prevClose);
      cards.push({
        id: meta.id,
        label: meta.label,
        ltp: pub.ltp,
        change,
        changePct,
        candles: pub.candles,
        demo: Boolean(pub.note),
        note: pub.note,
        analysisUnderlying: meta.analysisUnderlying,
        source: pub.source,
      });
      continue;
    }

    // Fallbacks when public feed fails
    if (!meta.smartApiAvailable) {
      const q = mockGiftNiftyLtp();
      const candles = mockCandles("GIFTNIFTY", "FIVE_MINUTE", 40);
      const { change, changePct } = dayChange(q.ltp, q.close);
      cards.push({
        id: meta.id,
        label: meta.label,
        ltp: q.ltp,
        change,
        changePct,
        candles: candles.slice(-24).map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
        demo: true,
        note: "Gift Nifty unavailable — labeled demo quote.",
        analysisUnderlying: meta.analysisUnderlying,
        source: "Demo",
      });
      continue;
    }

    let quote;
    try {
      quote = demoMode
        ? mockLtp(meta.id as Underlying)
        : await getLtp({
            exchange: meta.exchange,
            tradingsymbol: meta.tradingsymbol,
            symboltoken: meta.symboltoken,
          });
    } catch {
      quote = mockLtp(meta.id as Underlying);
    }

    const candles = demoMode
      ? mockCandles(meta.id as Underlying, "FIVE_MINUTE", 40)
      : await loadAngelCandles(
          meta.id as Underlying,
          meta.exchange,
          meta.symboltoken,
        );
    const prev = quote.close ?? quote.open;
    const { change, changePct } = dayChange(quote.ltp, prev);

    cards.push({
      id: meta.id,
      label: meta.label,
      ltp: quote.ltp,
      change,
      changePct,
      candles: candles.slice(-24).map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
      demo: Boolean(quote.demo ?? demoMode),
      note: quote.demo || demoMode ? "Demo market data" : null,
      analysisUnderlying: meta.analysisUnderlying,
      source: quote.demo || demoMode ? "Demo" : "Angel One",
    });
  }

  return { cards, demoMode };
}
