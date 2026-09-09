"use client";

import type { LargeOrderAlert } from "@/lib/marketdata/liveOptionChainHub";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Cap is enforced by the hook; this only renders the live stack.
 * Copy is inferred-book language — never "order placed".
 */
export function LargeOrderToasts({ events }: { events: LargeOrderAlert[] }) {
  if (!events.length) return null;
  return (
    <div
      className="pointer-events-none fixed right-3 z-50 flex w-[min(100%-1.5rem,22rem)] flex-col gap-2 bottom-24 sm:bottom-6"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {events.map((e) => (
          <motion.div
            key={`${e.token}:${e.side}:${e.bookPrice}:${e.capturedAt}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="pointer-events-auto rounded-lg border border-binance-gold/40 bg-binance-elevated px-3 py-2 shadow-lg"
          >
            <p className="text-xs font-medium text-binance-gold">{e.alertText}</p>
            <p className="mt-1 text-[10px] leading-snug text-binance-muted">
              {e.disclaimer}
            </p>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Tiny inline flag on a chain CE/PE cell. */
export function LargeOrderStrikeFlag({
  events,
  strike,
  optionType,
}: {
  events: LargeOrderAlert[];
  strike: number;
  optionType: "CE" | "PE";
}) {
  const hit = events.find(
    (e) => e.strike === strike && e.optionType === optionType,
  );
  if (!hit) return null;
  return (
    <span
      className="mt-0.5 block text-[10px] font-medium text-binance-gold"
      title={hit.disclaimer}
    >
      {hit.side === "bid" ? "Inferred large bid qty" : "Inferred large ask qty"}
    </span>
  );
}
