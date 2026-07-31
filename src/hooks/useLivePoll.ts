"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live dashboard polling — silent background refresh, pauses when tab hidden.
 * Uses chained timeouts (not overlapping intervals) so slow fetches don't stack.
 */
export function useLivePoll(
  load: (opts: { silent: boolean }) => Promise<void>,
  intervalMs: number,
) {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let timer: number | null = null;
    let cancelled = false;
    let inFlight = false;

    const clear = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delayMs: number) => {
      clear();
      timer = window.setTimeout(() => {
        void run(true);
      }, delayMs);
    };

    const run = async (silent: boolean) => {
      if (cancelled || inFlight) return;
      if (document.visibilityState !== "visible" && silent) {
        schedule(intervalMs);
        return;
      }
      inFlight = true;
      try {
        await loadRef.current({ silent });
      } finally {
        inFlight = false;
        if (!cancelled && document.visibilityState === "visible") {
          schedule(intervalMs);
        }
      }
    };

    void run(false);

    const onVis = () => {
      if (document.visibilityState === "visible") {
        void run(true);
      } else {
        clear();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
}

export function useRelativeClock(iso: string | null, tickMs = 1000) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const id = window.setInterval(() => setNow((n) => n + 1), tickMs);
    return () => window.clearInterval(id);
  }, [iso, tickMs]);

  if (!iso) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/** Index cards — near-real-time LTP (free APIs; not broker tick stream). */
export const LIVE_INDEX_POLL_MS = 2_000;

/** Macro quotes / news — keep polite on free upstreams. */
export const LIVE_MACRO_POLL_MS = 15_000;

/** @deprecated Prefer LIVE_INDEX_POLL_MS / LIVE_MACRO_POLL_MS */
export const LIVE_QUOTE_POLL_MS = LIVE_INDEX_POLL_MS;
