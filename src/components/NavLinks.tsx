import { NavLink } from "@/components/NavLink";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/paper", label: "Paper" },
  { href: "/backtest", label: "Track Record" },
] as const;

/** Server component: static labels come from SSR so HMR can't desync text. */
export function NavLinks() {
  return (
    <nav className="flex flex-wrap gap-4 text-sm">
      {LINKS.map(({ href, label }) => (
        <NavLink key={href} href={href} label={label} />
      ))}
    </nav>
  );
}
