import { NavLink } from "@/components/NavLink";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/paper", label: "Paper" },
  { href: "/backtest", label: "Track Record" },
] as const;

/** Desktop / tablet top nav. Mobile uses MobileBottomNav instead. */
export function NavLinks() {
  return (
    <nav className="hidden flex-wrap gap-4 text-sm md:flex" aria-label="Primary">
      {LINKS.map(({ href, label }) => (
        <NavLink key={href} href={href} label={label} />
      ))}
    </nav>
  );
}
