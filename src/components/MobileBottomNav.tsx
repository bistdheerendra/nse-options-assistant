"use client";

import {
  BarChart3,
  CandlestickChart,
  LayoutDashboard,
  LineChart,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/analysis", label: "Analysis", icon: CandlestickChart },
  { href: "/chart", label: "Chart", icon: LineChart },
  { href: "/paper", label: "Paper", icon: Wallet },
  { href: "/backtest", label: "Record", icon: BarChart3 },
] as const;

/** Keep placeholder height ≈ tab row so layout does not jump after mount. */
const NAV_ROW_CLASS = "mx-auto h-[3.25rem] max-w-lg";

/**
 * App-style bottom tab bar — mobile / narrow viewports only.
 * Desktop keeps the top header nav.
 *
 * Renders a height-stable shell until mount so SSR HTML cannot diverge from a
 * stale client chunk (e.g. 4-tab vs 5-tab after Chart was added).
 */
export function MobileBottomNav() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-binance-border bg-binance-surface/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Primary"
    >
      {!mounted ? (
        <div className={NAV_ROW_CLASS} aria-hidden />
      ) : (
        <ul
          className="mx-auto grid max-w-lg px-1 pt-1.5 pb-1"
          style={{
            // Tied to TABS.length — avoids hardcoding grid-cols-4 vs grid-cols-5
            gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))`,
          }}
        >
          {TABS.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={`flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium transition ${
                    active
                      ? "text-binance-gold"
                      : "text-binance-muted active:text-binance-text"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-full ${
                      active ? "bg-binance-gold/15" : ""
                    }`}
                  >
                    <Icon
                      className="h-[1.35rem] w-[1.35rem]"
                      strokeWidth={active ? 2.25 : 1.75}
                      aria-hidden
                    />
                  </span>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
