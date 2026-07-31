/**
 * This-week economic calendar via free Forex Factory JSON mirror
 * (https://nfs.faireconomy.media/ff_calendar_thisweek.json) — no API key.
 */

export type CalendarImpact = "High" | "Medium" | "Low" | "Holiday";

export type EconomicEvent = {
  title: string;
  country: string;
  date: string; // ISO
  impact: CalendarImpact | string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  category:
    | "rbi"
    | "fed"
    | "cpi"
    | "gdp"
    | "nfp"
    | "other";
};

export type MacroEventBuckets = {
  /** Future (and just-started) relevant events this week, soonest first. */
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

type FfRow = {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
};

function categorize(title: string, country: string): EconomicEvent["category"] {
  const t = title.toLowerCase();
  const c = country.toUpperCase();
  // RBI: require INR country or explicit RBI wording (avoid generic "monetary policy")
  if (
    c === "INR" ||
    /\brbi\b|reserve bank of india|india.*repo rate|repo rate.*india/.test(t)
  ) {
    return "rbi";
  }
  if (
    c === "USD" &&
    (/fomc|federal funds|fed chair|powell/.test(t) ||
      /interest rate decision/.test(t))
  ) {
    return "fed";
  }
  if (/\bcpi\b|consumer price/.test(t)) return "cpi";
  if (/\bgdp\b|gross domestic/.test(t)) return "gdp";
  // NFP: official US Non-Farm Payrolls only
  if (
    c === "USD" &&
    /non-farm|nonfarm|\bnfp\b|non farm payrolls|nonfarm payrolls/.test(t)
  ) {
    return "nfp";
  }
  return "other";
}

function isRelevant(e: EconomicEvent): boolean {
  if (e.category !== "other") return true;
  // High-impact anywhere + USD/INR medium — enough signal for upcoming list
  if (e.impact === "High") return true;
  if (e.country === "USD" || e.country === "INR") {
    return e.impact === "Medium";
  }
  return false;
}

function pickNext(
  events: EconomicEvent[],
  category: EconomicEvent["category"],
  preferCountry?: string,
): EconomicEvent | null {
  const now = Date.now();
  const pool = events.filter((e) => {
    if (e.category !== category) return false;
    if (preferCountry && e.country !== preferCountry) return false;
    return true;
  });
  const impactRank = (e: EconomicEvent) =>
    e.impact === "High" ? 0 : e.impact === "Medium" ? 1 : 2;
  const bySoonest = (a: EconomicEvent, b: EconomicEvent) => {
    const ir = impactRank(a) - impactRank(b);
    if (ir !== 0) return ir;
    return +new Date(a.date) - +new Date(b.date);
  };
  const byLatest = (a: EconomicEvent, b: EconomicEvent) => {
    const ir = impactRank(a) - impactRank(b);
    if (ir !== 0) return ir;
    return +new Date(b.date) - +new Date(a.date);
  };
  // Prefer upcoming; else most recent past (High impact first)
  const upcoming = pool
    .filter((e) => new Date(e.date).getTime() >= now - 6 * 60 * 60 * 1000)
    .sort(bySoonest);
  if (upcoming[0]) return upcoming[0];
  const past = pool
    .filter((e) => new Date(e.date).getTime() < now)
    .sort(byLatest);
  return past[0] ?? null;
}

function emptyBuckets(note: string): MacroEventBuckets {
  return {
    upcoming: [],
    week: [],
    highlights: { rbi: null, fed: null, cpi: null, gdp: null, nfp: null },
    source: "Forex Factory (faireconomy mirror)",
    note,
  };
}

/** Last successful week snapshot — reused when FF mirror rate-limits. */
let lastGoodCalendar: MacroEventBuckets | null = null;

export async function fetchEconomicCalendar(): Promise<MacroEventBuckets> {
  try {
    const res = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NSEOptionsAssistant/1.0)",
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      if (lastGoodCalendar) {
        return {
          ...lastGoodCalendar,
          note: `Using cached calendar (upstream HTTP ${res.status})`,
        };
      }
      return emptyBuckets(
        `Economic calendar unavailable (HTTP ${res.status}) — retry shortly`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      if (lastGoodCalendar) {
        return {
          ...lastGoodCalendar,
          note: "Using cached calendar (upstream rate limited)",
        };
      }
      return emptyBuckets(
        "Economic calendar returned non-JSON (rate limited?) — retry shortly",
      );
    }
    const rows = (await res.json()) as FfRow[];
    const events: EconomicEvent[] = rows
      .filter((r) => r.title && r.date && r.country)
      .map((r) => ({
        title: String(r.title),
        country: String(r.country),
        date: String(r.date),
        impact: (r.impact as CalendarImpact) ?? "Low",
        forecast: r.forecast ? String(r.forecast) : null,
        previous: r.previous ? String(r.previous) : null,
        actual: r.actual ? String(r.actual) : null,
        category: categorize(String(r.title), String(r.country)),
      }))
      .filter(isRelevant)
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));

    const now = Date.now();
    // Include events from ~30m ago (just released) through rest of week
    const upcomingCutoff = now - 30 * 60 * 1000;
    const upcoming = events.filter(
      (e) => new Date(e.date).getTime() >= upcomingCutoff,
    );

    const buckets: MacroEventBuckets = {
      upcoming,
      week: events,
      highlights: {
        rbi: pickNext(events, "rbi"),
        fed: pickNext(events, "fed", "USD") ?? pickNext(events, "fed"),
        cpi:
          pickNext(events, "cpi", "USD") ??
          pickNext(events, "cpi", "INR") ??
          pickNext(events, "cpi"),
        gdp:
          pickNext(events, "gdp", "USD") ??
          pickNext(events, "gdp", "INR") ??
          pickNext(events, "gdp"),
        nfp: pickNext(events, "nfp", "USD") ?? pickNext(events, "nfp"),
      },
      source: "Forex Factory (faireconomy mirror)",
      note: null,
    };
    lastGoodCalendar = buckets;
    return buckets;
  } catch (err) {
    if (lastGoodCalendar) {
      return {
        ...lastGoodCalendar,
        note: "Using cached calendar (fetch error)",
      };
    }
    return emptyBuckets(
      err instanceof Error ? err.message : "Economic calendar fetch failed",
    );
  }
}
