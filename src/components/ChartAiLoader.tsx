"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

type Variant = "chart" | "chain" | "synthesis" | "track";

type Props = {
  /** Shown under the main status line, e.g. BANKNIFTY */
  label?: string;
  compact?: boolean;
  /** chart = candles; chain = option-grid; synthesis = lane run; track = track record */
  variant?: Variant;
  /** Fill a sized parent (absolute inset-0). Default true. */
  overlay?: boolean;
};

const STATUS_BY_VARIANT: Record<Variant, string[]> = {
  chart: [
    "Syncing live OHLC…",
    "Mapping price structure…",
    "Aligning with spot feed…",
  ],
  chain: [
    "Fetching option chain…",
    "Hydrating CE / PE premiums…",
    "Linking ATM to live spot…",
  ],
  synthesis: [
    "Running lane analysis…",
    "Scoring technical + flow…",
    "Synthesizing IV-aware structure…",
  ],
  track: [
    "Loading outcomes…",
    "Computing win rates…",
    "Building cohort stats…",
  ],
};

/**
 * Binance-gold “AI scan” overlay for slow market-data loads.
 * Theme tokens only — no hardcoded palette hex.
 */
export function ChartAiLoader({
  label,
  compact = false,
  variant = "chart",
  overlay = true,
}: Props) {
  const statusLines = STATUS_BY_VARIANT[variant];
  const [statusIdx, setStatusIdx] = useState(0);

  useEffect(() => {
    setStatusIdx(0);
    const id = setInterval(() => {
      setStatusIdx((i) => (i + 1) % statusLines.length);
    }, 1800);
    return () => clearInterval(id);
  }, [statusLines.length, variant]);

  const defaultLabel =
    variant === "chain"
      ? "Option chain"
      : variant === "synthesis"
        ? "Synthesis"
        : variant === "track"
          ? "Track record"
          : "Chart";

  return (
    <div
      className={
        overlay
          ? "absolute inset-0 z-40 flex flex-col items-center justify-center overflow-hidden bg-binance-surface/85 backdrop-blur-[2px]"
          : "relative z-10 flex min-h-52 flex-col items-center justify-center overflow-hidden rounded-lg border border-binance-border bg-binance-surface/85 py-8 backdrop-blur-[2px]"
      }
      role="status"
      aria-live="polite"
      aria-label={label ? `Loading ${label}` : `Loading ${defaultLabel}`}
    >
      {/* Soft gold aurora */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            "radial-gradient(ellipse 60% 45% at 50% 42%, color-mix(in oklab, var(--color-binance-gold) 28%, transparent), transparent 70%)",
        }}
      />

      {/* Horizontal scan beam */}
      <motion.div
        className="pointer-events-none absolute inset-x-0 h-px bg-linear-to-r from-transparent via-binance-gold/70 to-transparent"
        initial={{ top: "18%" }}
        animate={{ top: ["18%", "82%", "18%"] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      />

      <div
        className={`relative flex flex-col items-center ${compact ? "scale-90 gap-3" : "gap-4"}`}
      >
        {/* Orbit rings + core */}
        <div className="relative flex h-20 w-20 items-center justify-center sm:h-24 sm:w-24">
          <motion.span
            className="absolute inset-0 rounded-full border border-binance-gold/25"
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          />
          <motion.span
            className="absolute inset-2 rounded-full border border-dashed border-binance-gold/40"
            animate={{ rotate: -360 }}
            transition={{ duration: 5.5, repeat: Infinity, ease: "linear" }}
          />
          <motion.span
            className="absolute inset-5 rounded-full border border-binance-gold/50"
            animate={{ scale: [1, 1.08, 1], opacity: [0.55, 1, 0.55] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "linear" }}
          >
            <span className="absolute top-0 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-binance-gold" />
          </motion.div>
          <motion.div
            className="absolute inset-1"
            animate={{ rotate: -360 }}
            transition={{ duration: 3.4, repeat: Infinity, ease: "linear" }}
          >
            <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-binance-gold/80" />
          </motion.div>
          <motion.span
            className="relative h-3.5 w-3.5 rounded-full bg-binance-gold"
            style={{
              boxShadow:
                "0 0 18px color-mix(in oklab, var(--color-binance-gold) 70%, transparent)",
            }}
            animate={{ scale: [1, 1.25, 1] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>

        {variant === "chart" ? (
          <div className="flex h-10 items-end gap-1.5" aria-hidden>
            {[0.45, 0.7, 0.55, 0.9, 0.6, 0.8, 0.5, 0.75].map((h, i) => (
              <motion.span
                key={i}
                className={`w-1.5 rounded-sm ${
                  i % 3 === 1 ? "bg-binance-bear/70" : "bg-binance-bull/70"
                }`}
                animate={{ scaleY: [0.35, 1, 0.45, 0.85, 0.35] }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.08,
                }}
                style={{ originY: 1, height: `${h * 100}%` }}
              />
            ))}
          </div>
        ) : variant === "chain" ? (
          <div className="flex w-52 flex-col gap-1.5" aria-hidden>
            {[0, 1, 2, 3].map((row) => (
              <motion.div
                key={row}
                className="flex items-center gap-2"
                animate={{ opacity: [0.35, 1, 0.35] }}
                transition={{
                  duration: 1.4,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: row * 0.12,
                }}
              >
                <span className="h-2 flex-1 rounded-sm bg-binance-bull/50" />
                <span className="h-2 w-10 rounded-sm bg-binance-elevated" />
                <span className="h-2 flex-1 rounded-sm bg-binance-bear/50" />
              </motion.div>
            ))}
          </div>
        ) : variant === "synthesis" ? (
          /* Synthesis — pulsing lane score bars */
          <div className="flex w-48 flex-col gap-2" aria-hidden>
            {["Technical", "Flow", "Sentiment", "Macro"].map((lane, i) => (
              <div key={lane} className="flex items-center gap-2">
                <span className="w-16 text-[10px] text-binance-muted">{lane}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-binance-elevated">
                  <motion.span
                    className="block h-full rounded-full bg-binance-gold"
                    animate={{ width: ["18%", "88%", "40%", "72%", "18%"] }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: i * 0.15,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Track record — cohort cards shimmer */
          <div className="grid w-56 grid-cols-2 gap-2" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <motion.div
                key={i}
                className="h-12 rounded-md border border-binance-border bg-binance-elevated"
                animate={{ opacity: [0.35, 0.9, 0.35] }}
                transition={{
                  duration: 1.5,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.12,
                }}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col items-center gap-1.5 px-4 text-center">
          <p className="text-sm font-medium tracking-wide text-binance-text">
            {label ?? defaultLabel}
            <span className="text-binance-muted"> · AI feed</span>
          </p>
          <div className="relative h-4 min-w-48">
            <AnimatePresence mode="wait">
              <motion.p
                key={statusLines[statusIdx]}
                className="absolute inset-x-0 text-center text-xs text-binance-gold"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
              >
                {statusLines[statusIdx]}
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
