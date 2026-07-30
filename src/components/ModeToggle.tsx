"use client";

import { motion } from "framer-motion";

type Props = {
  mode: "SCALP" | "SWING";
  onChange: (mode: "SCALP" | "SWING") => void;
};

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="inline-flex rounded-md bg-binance-elevated p-1">
      {(["SCALP", "SWING"] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className="relative px-4 py-1.5 text-sm font-medium"
          >
            {active && (
              <motion.span
                layoutId="mode-pill"
                className="absolute inset-0 rounded bg-binance-gold"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span
              className={`relative z-10 ${active ? "text-binance-bg" : "text-binance-muted"}`}
            >
              {m === "SCALP" ? "Scalp" : "Swing"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
