"use client";

import { type RefObject, useEffect } from "react";

/**
 * The tour anchors the shared DataTable does not know about. Rows render in the
 * order of `keys`, so the nth body row gets the nth key as data-tour-item.
 */
export function useRowTour(ref: RefObject<HTMLElement | null>, tour: string, keys: string[]): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLTableRowElement>("table.tbl-table > tbody > tr");
    rows.forEach((row, index) => {
      const key = keys[index];
      if (key === undefined || row.classList.contains("is-message")) {
        delete row.dataset.tour;
        delete row.dataset.tourItem;
        return;
      }
      row.dataset.tour = tour;
      row.dataset.tourItem = key;
    });
  }, [ref, tour, keys]);
}

/** data-tour on an element the page does not render itself, found by id (the Inspector). */
export function useTourAttr(id: string, tour: string, mounted: boolean): void {
  useEffect(() => {
    if (!mounted) return;
    const el = document.getElementById(id);
    if (el) el.dataset.tour = tour;
  }, [id, tour, mounted]);
}
