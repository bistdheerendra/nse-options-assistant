"use client";

import { useEffect, useState } from "react";

const POLL_MS = 2_500;

/**
 * Live option LTPs for every OPEN paper row (all underlyings / expiries).
 * Pauses while the tab is hidden. Keeps last-good marks on a failed poll.
 */
export function useOpenPositionMarks(hasOpen: boolean) {
  const [marks, setMarks] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!hasOpen) {
      setMarks({});
      return;
    }

    let cancelled = false;

    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/paper/marks", { cache: "no-store" });
        const json = (await res.json()) as {
          marks?: Record<string, number>;
        };
        if (cancelled) return;
        if (json.marks && typeof json.marks === "object") {
          setMarks(json.marks);
        }
      } catch {
        // keep last-good marks
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hasOpen]);

  return marks;
}
