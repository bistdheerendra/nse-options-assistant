/**
 * Cash-session hours in IST + open/closed check (Asia/Kolkata wall clock).
 * Heuristic regular sessions only — no holiday calendar.
 */

export type MarketHoursSpec = {
  /** Display string, e.g. "9:15 AM – 3:30 PM IST" */
  label: string;
  /** Minutes from midnight IST, or null if nearly 24h */
  openMin: number | null;
  closeMin: number | null;
  /** If true, treat as always open (futures / FX nearly continuous). */
  nearly24h?: boolean;
};

/** True when America/New_York is on daylight time (EDT). */
export function isUsEasternDaylightTime(date = new Date()): boolean {
  const tz =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "short",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return tz.includes("DT");
}

/** Parse "9:15 AM" / "1:30 PM" → minutes from midnight. */
export function parseIstClock(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]!.toUpperCase();
  if (ap === "AM") {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

/** Current weekday + minutes in Asia/Kolkata (0=Sun … 6=Sat). */
export function getIstClock(date = new Date()): {
  weekday: number;
  minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const wd =
    parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[wd] ?? 1,
    minutes: hour * 60 + minute,
  };
}

function session(
  openLabel: string,
  closeLabel: string,
): Pick<MarketHoursSpec, "openMin" | "closeMin" | "label"> {
  const openMin = parseIstClock(openLabel);
  const closeMin = parseIstClock(closeLabel);
  return {
    openMin,
    closeMin,
    label: `${openLabel} – ${closeLabel} IST`,
  };
}

/**
 * Regular cash-session hours in IST, keyed by quote / index id.
 * US equity: 9:30–16:00 ET → EDT 7:00 PM–1:30 AM · EST 8:00 PM–2:30 AM IST
 */
export function marketHoursForId(
  id: string,
  date = new Date(),
): MarketHoursSpec | null {
  if (id === "VIX" || id === "DJI" || id === "IXIC" || id === "GSPC") {
    return isUsEasternDaylightTime(date)
      ? { ...session("7:00 PM", "1:30 AM"), nearly24h: false }
      : { ...session("8:00 PM", "2:30 AM"), nearly24h: false };
  }

  if (id === "CL" || id === "BZ" || id === "DXY") {
    return {
      label:
        id === "CL"
          ? "Nearly 24h (CME)"
          : id === "BZ"
            ? "Nearly 24h (ICE)"
            : "Nearly 24h (ICE)",
      openMin: null,
      closeMin: null,
      nearly24h: true,
    };
  }

  const map: Record<string, MarketHoursSpec> = {
    NIFTY: { ...session("9:15 AM", "3:30 PM") },
    BANKNIFTY: { ...session("9:15 AM", "3:30 PM") },
    SENSEX: { ...session("9:15 AM", "3:30 PM") },
    GIFTNIFTY: { ...session("6:30 AM", "2:45 AM") },
    INDIAVIX: { ...session("9:15 AM", "3:30 PM") },
    N225: { ...session("5:30 AM", "11:30 AM") },
    HSI: { ...session("7:00 AM", "1:30 PM") },
    SSEC: { ...session("7:00 AM", "12:30 PM") },
    KS11: { ...session("5:30 AM", "12:00 PM") },
    STI: { ...session("6:30 AM", "2:30 PM") },
    USDINR: { ...session("9:00 AM", "5:00 PM") },
  };

  return map[id] ?? null;
}

/**
 * True if regular cash session is open now (IST).
 * Overnight sessions (openMin > closeMin) wrap past midnight.
 * Weekends closed except nearly-24h products (Sun eve–Fri for futures approximated as always open).
 */
export function isMarketOpenNow(id: string, date = new Date()): boolean {
  const spec = marketHoursForId(id, date);
  if (!spec) return false;
  if (spec.nearly24h) return true;

  const { weekday, minutes } = getIstClock(date);
  // Sat/Sun closed for cash equities / FX cash window
  if (weekday === 0 || weekday === 6) return false;

  const open = spec.openMin;
  const close = spec.closeMin;
  if (open == null || close == null) return false;

  if (open <= close) {
    // Same-day session, e.g. 9:15–15:30
    return minutes >= open && minutes < close;
  }
  // Overnight wrap, e.g. 19:00–01:30
  return minutes >= open || minutes < close;
}

/** Hours label string for UI (same as before for macro tiles). */
export function hoursIstForQuote(id: string, date = new Date()): string | null {
  return marketHoursForId(id, date)?.label ?? null;
}
