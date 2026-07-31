"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live dashboard polling — silent background refresh, pauses when tab hidden.
 */
export function useLivePoll(
  load: (opts: { silent: boolean }) => Promise<void>,
  intervalMs: number,
) {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let timer: number | null = null;

    const tick = (silent: boolean) => {
      void loadRef.current({ silent });
    };

    const start = () => {
      if (timer != null) return;
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") tick(true);
      }, intervalMs);
    };

    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    tick(false);
    start();

    const onVis = () => {
      if (document.visibilityState === "visible") {
        tick(true);
        start();
      } else {
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
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

/** Index cards + macro quotes poll cadence (free APIs — keep polite). */
export const LIVE_QUOTE_POLL_MS = 15_000;
