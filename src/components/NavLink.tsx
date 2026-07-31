"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  const pathname = usePathname();
  const active =
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
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
}
