"use client";

type LiveBadgeProps = {
  /** When false, shows muted OFFLINE instead of LIVE. */
  active?: boolean;
  className?: string;
  label?: string;
};

/**
 * Pulsing live indicator (Binance-style green dot + LIVE label).
 */
export function LiveBadge({
  active = true,
  className = "",
  label = "LIVE",
}: LiveBadgeProps) {
  if (!active) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded border border-binance-border bg-binance-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-binance-muted ${className}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-binance-muted" />
        Offline
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border border-binance-bull/35 bg-binance-bull/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-binance-bull ${className}`}
      title="Prices updating live"
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-binance-bull opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-binance-bull" />
      </span>
      {label}
    </span>
  );
}
