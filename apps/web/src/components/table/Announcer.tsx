"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from "react";

type Announce = (text: string) => void;

const AnnounceContext = createContext<Announce>(() => {});

/**
 * One role="status" per page, mounted before the content. Cleared, then written
 * after 400ms so repeated text re-announces. "Reading the ledger", "24 rows match",
 * "Copied", "Filters cleared". Never per keystroke.
 */
export function Announcer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);

  const announce = useCallback<Announce>((text) => {
    const el = ref.current;
    if (!el) return;
    el.textContent = "";
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      el.textContent = text;
    }, 400);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <AnnounceContext.Provider value={announce}>
      <div ref={ref} role="status" aria-live="polite" aria-atomic="true" className="tbl-sr" />
      {children}
    </AnnounceContext.Provider>
  );
}

/** Without an Announcer above, the returned function does nothing. */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}
