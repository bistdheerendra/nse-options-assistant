"use client";

import {
  biasFromEconomicEvent,
  biasFromHeadline,
  type MarketBias,
} from "@/lib/marketdata/marketBias";
import { theme } from "@/lib/theme";
import { LiveBadge } from "@/components/LiveBadge";
import {
  LIVE_MACRO_POLL_MS,
  useLivePoll,
  useRelativeClock,
} from "@/hooks/useLivePoll";
import {
  AlertTriangle,
  CalendarDays,
  Droplets,
  Globe2,
  Loader2,
  Newspaper,
  TrendingUp,
} from "lucide-react";
import { useCallback, useState } from "react";

type MacroQuote = {
  id: string;
  label: string;
  group: string;
  price: number;
  change: number;
  changePct: number;
  currency: string | null;
  source: string;
  note: string | null;
};

type EconomicEvent = {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  category: string;
};

type MacroResponse = {
  ok: boolean;
  fetchedAt?: string;
  quotes?: MacroQuote[];
  calendar?: {
    upcoming: EconomicEvent[];
    week: EconomicEvent[];
    highlights: {
      rbi: EconomicEvent | null;
      fed: EconomicEvent | null;
      cpi: EconomicEvent | null;
      gdp: EconomicEvent | null;
      nfp: EconomicEvent | null;
    };
    source: string;
    note: string | null;
  };
  news?: {
    items: Array<{
      title: string;
      link: string;
      publishedAt: string | null;
      source: string;
    }>;
    source: string;
    note: string | null;
  };
  error?: string;
  uiHint?: string;
};

function formatPrice(n: number, currency: string | null) {
  if (!Number.isFinite(n)) return "—";
  const maxFrac = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 10 ? 2 : 4;
  const formatted = n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFrac,
  });
  if (currency === "USD") return `$${formatted}`;
  return formatted;
}

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

/** Pill badge: BULL / BEAR / MIXED — heuristic market reaction cue. */
function MarketBiasBadge({ bias }: { bias: MarketBias }) {
  const styles: Record<
    MarketBias,
    { color: string; bg: string }
  > = {
    BULL: { color: theme.colors.bull, bg: `${theme.colors.bull}22` },
    BEAR: { color: theme.colors.bear, bg: `${theme.colors.bear}22` },
    MIXED: { color: theme.colors.gold, bg: `${theme.colors.gold}22` },
  };
  const s = styles[bias];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ color: s.color, backgroundColor: s.bg }}
      title="Heuristic market bias — rules-based, not a forecast"
    >
      {bias}
    </span>
  );
}

function countryLabel(code: string): string {
  const map: Record<string, string> = {
    USD: "US",
    INR: "India",
    EUR: "Eurozone",
    GBP: "UK",
    JPY: "Japan",
    CNY: "China",
    CAD: "Canada",
    AUD: "Australia",
  };
  return map[code] ?? code;
}

function QuoteTile({ q }: { q: MacroQuote }) {
  const up = q.change >= 0;
  const changeColor = up ? theme.colors.bull : theme.colors.bear;
  return (
    <div className="rounded-lg border border-binance-border bg-binance-elevated px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-binance-muted">{q.label}</p>
        {q.note && (
          <span className="text-[9px] uppercase tracking-wide text-binance-muted">
            Proxy
          </span>
        )}
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums text-binance-text">
        {formatPrice(q.price, q.currency)}
      </p>
      <p className="mt-0.5 text-xs tabular-nums" style={{ color: changeColor }}>
        {up ? "+" : ""}
        {q.change.toFixed(2)} ({up ? "+" : ""}
        {q.changePct.toFixed(2)}%)
      </p>
    </div>
  );
}

function EventHighlight({
  label,
  event,
}: {
  label: string;
  event: EconomicEvent | null;
}) {
  const bias = event ? biasFromEconomicEvent(event) : null;
  return (
    <div className="rounded-lg border border-binance-border bg-binance-elevated px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-binance-gold">
          {label}
        </p>
        {bias && <MarketBiasBadge bias={bias} />}
      </div>
      {event ? (
        <>
          <p className="mt-1 text-sm font-medium text-binance-text line-clamp-2">
            {event.title}
          </p>
          <p className="mt-1 text-[11px] text-binance-muted">
            {event.country} · {formatWhen(event.date)} · {event.impact}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-binance-muted">
            Act {event.actual ?? "—"} · Fcst {event.forecast ?? "—"} · Prev{" "}
            {event.previous ?? "—"}
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-binance-muted">
          No matching event this week
        </p>
      )}
    </div>
  );
}

function groupQuotes(quotes: MacroQuote[], group: string) {
  return quotes.filter((q) => q.group === group);
}

export function MacroDashboard() {
  const [data, setData] = useState<MacroResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ago = useRelativeClock(data?.fetchedAt ?? null);

  const load = useCallback(async ({ silent }: { silent: boolean }) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    if (!silent) setError(null);
    try {
      const res = await fetch(`/api/dashboard/macro?t=${Date.now()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as MacroResponse;
      if (!res.ok || !json.ok) {
        throw new Error(json.uiHint ?? json.error ?? "Failed to load macro data");
      }
      setData(json);
      setLive(true);
      setError(null);
    } catch (e) {
      if (!silent) {
        setLive(false);
        setError(e instanceof Error ? e.message : "Failed");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useLivePoll(load, LIVE_MACRO_POLL_MS);

  const quotes = data?.quotes ?? [];
  const giftVix = [
    ...groupQuotes(quotes, "gift"),
    ...groupQuotes(quotes, "vix"),
  ];
  const us = groupQuotes(quotes, "us");
  const asia = groupQuotes(quotes, "asia");
  const commodities = groupQuotes(quotes, "commodities");
  const fx = groupQuotes(quotes, "fx");

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-binance-text">
              Global Markets & Macro
            </h2>
            <LiveBadge active={live && !loading} />
          </div>
          <p className="mt-0.5 text-xs text-binance-muted">
            Live feeds · refresh ~{LIVE_MACRO_POLL_MS / 1000}s · Yahoo + NSE ·
            Forex Factory · News RSS
            {ago ? ` · Updated ${ago}` : ""}
            {refreshing ? " · syncing…" : ""}
          </p>
        </div>
        {loading && quotes.length === 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-binance-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </span>
        )}
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded border border-binance-bear/40 bg-binance-elevated px-3 py-2 text-sm text-binance-bear">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && quotes.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-binance-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading global markets…
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
              <TrendingUp className="h-4 w-4" />
              Gift Nifty · India VIX
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {giftVix.map((q) => (
                <QuoteTile key={q.id} q={q} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
              <Globe2 className="h-4 w-4" />
              US Markets
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {us.map((q) => (
                <QuoteTile key={q.id} q={q} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
              <Globe2 className="h-4 w-4" />
              Asian Markets
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {asia.map((q) => (
                <QuoteTile key={q.id} q={q} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
              <Droplets className="h-4 w-4" />
              Crude Oil · Dollar Index
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[...commodities, ...fx].map((q) => (
                <QuoteTile key={q.id} q={q} />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
              <CalendarDays className="h-4 w-4" />
              Key Economic Events
            </div>
            {data?.calendar?.note && (
              <p className="text-xs text-binance-muted">{data.calendar.note}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <EventHighlight
                label="RBI Policy"
                event={data?.calendar?.highlights.rbi ?? null}
              />
              <EventHighlight
                label="US Fed Meeting"
                event={data?.calendar?.highlights.fed ?? null}
              />
              <EventHighlight
                label="CPI Inflation"
                event={data?.calendar?.highlights.cpi ?? null}
              />
              <EventHighlight
                label="GDP Data"
                event={data?.calendar?.highlights.gdp ?? null}
              />
              <EventHighlight
                label="Non-Farm Payroll (NFP)"
                event={data?.calendar?.highlights.nfp ?? null}
              />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
                <CalendarDays className="h-4 w-4" />
                Upcoming Events
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-binance-border bg-binance-surface p-3">
                {(data?.calendar?.upcoming ?? []).length === 0 ? (
                  <p className="text-xs text-binance-muted">
                    No upcoming high/medium events left this week in the free
                    calendar feed.
                  </p>
                ) : (
                  (data?.calendar?.upcoming ?? []).map((e, i) => {
                    const bias = biasFromEconomicEvent(e);
                    return (
                      <div
                        key={`${e.title}-${e.date}-${i}`}
                        className="border-b border-binance-border/60 pb-2.5 last:border-0 last:pb-0"
                      >
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-binance-muted">
                          <span>{countryLabel(e.country)}</span>
                          <span>·</span>
                          <span>{formatWhen(e.date)}</span>
                          <MarketBiasBadge bias={bias} />
                          <span className="ml-auto text-[10px] uppercase tracking-wide text-binance-muted/80">
                            {e.impact}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-medium text-binance-text">
                          {e.title}
                        </p>
                        {(e.actual || e.forecast) && (
                          <p className="mt-0.5 text-[11px] tabular-nums text-binance-muted">
                            Act {e.actual ?? "—"} · Fcst {e.forecast ?? "—"}
                          </p>
                        )}
                      </div>
                    );
                  })
                )}
                <p className="pt-1 text-[10px] text-binance-muted">
                  Source: {data?.calendar?.source ?? "—"}
                </p>
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-binance-gold">
                <Newspaper className="h-4 w-4" />
                Today's News
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-binance-border bg-binance-surface p-3">
                {(data?.news?.items ?? []).length === 0 ? (
                  <p className="text-xs text-binance-muted">
                    {data?.news?.note ?? "No headlines right now."}
                  </p>
                ) : (
                  (data?.news?.items ?? []).map((n) => {
                    const bias = biasFromHeadline(n.title);
                    const ago = formatAgo(n.publishedAt);
                    return (
                      <a
                        key={n.link + n.title}
                        href={n.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border-b border-binance-border/60 pb-2.5 last:border-0 last:pb-0"
                      >
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-binance-muted">
                          {ago ? <span>{ago}</span> : null}
                          {ago ? <span>·</span> : null}
                          <MarketBiasBadge bias={bias} />
                          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-binance-muted">
                            {n.source}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-medium text-binance-text hover:text-binance-gold">
                          {n.title}
                        </p>
                      </a>
                    );
                  })
                )}
                <p className="pt-1 text-[10px] text-binance-muted">
                  Source: {data?.news?.source ?? "—"}
                </p>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
