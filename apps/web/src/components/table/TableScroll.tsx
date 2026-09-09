"use client";

import { type ReactNode, useCallback, useEffect, useRef } from "react";
import "./table.css";

/**
 * The one nested scroller a table may own. Renders .tbl-clip by default, or the
 * bounded region when `bounded` (rows over 20 on a page with an inspector column;
 * the media query keeps it off on small or short viewports). Owns data-stuck on
 * the card, and data-at-start and data-at-end for the wide case.
 */
export function TableScroll({
  bounded = false,
  wide = false,
  labelledBy,
  children,
}: {
  bounded?: boolean;
  wide?: boolean;
  /** The caption id. */
  labelledBy: string;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // One ref for both the div and the section; a callback keeps the element types apart.
  const setBox = useCallback((el: HTMLElement | null) => {
    boxRef.current = el;
  }, []);

  // Stuck cue: a 1px sentinel above the table. When it is above the shell line, or
  // clipped away inside the region, the head is stuck and gains its shadow step.
  useEffect(() => {
    const box = boxRef.current;
    const sentinel = sentinelRef.current;
    if (!box || !sentinel) return;
    const card = box.closest<HTMLElement>(".tbl");
    if (!card || typeof IntersectionObserver === "undefined") return;

    const shellTop = Number.parseFloat(getComputedStyle(card).getPropertyValue("--shell-top")) || 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const rootBottom = entry.rootBounds?.bottom ?? window.innerHeight;
        const above = !entry.isIntersecting && entry.boundingClientRect.top < rootBottom;
        if (above) card.dataset.stuck = "true";
        else delete card.dataset.stuck;
      },
      { root: null, rootMargin: `-${shellTop}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      delete card.dataset.stuck;
    };
  }, []);

  // Edge flags for the wide case only.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !wide) return;
    const update = () => {
      const max = box.scrollWidth - box.clientWidth;
      box.dataset.atStart = box.scrollLeft <= 1 ? "true" : "false";
      box.dataset.atEnd = box.scrollLeft >= max - 1 ? "true" : "false";
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(box);
    return () => {
      box.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [wide]);

  if (bounded) {
    // A named section is a region landmark. It is one tab stop so the arrow keys scroll it;
    // Safari does not make scrollers focusable on its own.
    return (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must be reachable by keyboard
      <section ref={setBox} className="tbl-region" tabIndex={0} aria-labelledby={labelledBy}>
        <div ref={sentinelRef} className="tbl-sentinel" aria-hidden="true" />
        {children}
      </section>
    );
  }
  return (
    <div ref={setBox} className={wide ? "tbl-clip is-wide" : "tbl-clip"}>
      <div ref={sentinelRef} className="tbl-sentinel" aria-hidden="true" />
      {children}
    </div>
  );
}
