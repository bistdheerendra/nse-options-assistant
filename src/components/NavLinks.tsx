"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/paper", label: "Paper" },
  { href: "/backtest", label: "Track Record" },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-4 text-sm">
      {LINKS.map(({ href, label }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={
              active
                ? "font-medium text-binance-gold"
                : "text-binance-muted hover:text-binance-text"
            }
            aria-current={active ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
