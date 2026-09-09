"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { STATUS_LABEL, TYPE_LABEL } from "@/lib/operator/format";
import { CURRENCIES, isFiltered, type LedgerFilters, toQuery } from "@/lib/operator/ledger-filters";
import { LEDGER_STATUSES, LEDGER_TYPES } from "@/lib/operator/types";

/**
 * Search, filters and the currency tab. Every change is written to the URL query, so a
 * link reproduces the view. Search is debounced; the rest is immediate. The provenance,
 * from and to params still parse and apply from the URL; they have no control here.
 */
export function LedgerFilterBar({
  filters,
  sellers,
  onChange,
}: {
  filters: LedgerFilters;
  /** Business options in order: real sellers first, the fixture list only when no route is live. */
  sellers: Array<{ label: string; mock: boolean; sellers: Array<{ id: string; name: string }> }>;
  onChange: (next: LedgerFilters) => void;
}) {
  const [q, setQ] = useState(filters.q);
  const timer = useRef<number | null>(null);

  // Keep the box in step with back and forward navigation.
  useEffect(() => setQ(filters.q), [filters.q]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const set = <K extends keyof LedgerFilters>(key: K, value: LedgerFilters[K]) =>
    onChange({ ...filters, [key]: value });

  function search(value: string) {
    setQ(value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => set("q", value.trim()), 250);
  }

  return (
    <form
      className="op-filters"
      action="/admin/ledger"
      method="get"
      data-tour="admin.ledger.filters"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) window.clearTimeout(timer.current);
        set("q", q.trim());
      }}
    >
      <div className="op-search">
        <svg className="op-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10.5 10.5 14 14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="search"
          name="q"
          value={q}
          onChange={(event) => search(event.target.value)}
          placeholder="Business, order id, resource id"
          aria-label="Search the ledger by business, order id or resource id"
          data-tour="admin.ledger.search"
          autoComplete="off"
        />
      </div>

      <label className="op-filter">
        <span className="op-sr">Type</span>
        <select
          name="type"
          value={filters.type}
          onChange={(e) => set("type", e.target.value as LedgerFilters["type"])}
        >
          <option value="">All types</option>
          {LEDGER_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </label>

      <label className="op-filter">
        <span className="op-sr">Status</span>
        <select
          name="status"
          value={filters.status}
          onChange={(e) => set("status", e.target.value as LedgerFilters["status"])}
        >
          <option value="">All statuses</option>
          {LEDGER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>

      <label className="op-filter">
        <span className="op-sr">Business</span>
        <select
          name="seller_id"
          value={filters.seller_id}
          onChange={(e) => set("seller_id", e.target.value)}
        >
          <option value="">All businesses</option>
          {sellers
            .filter((group) => group.sellers.length > 0)
            .map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.name}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </label>

      <fieldset className="op-seg op-currency">
        <legend className="op-sr">Currency</legend>
        {(["", ...CURRENCIES] as const).map((currency) => (
          <label key={currency || "all"}>
            <input
              type="radio"
              name="currency"
              value={currency}
              checked={filters.currency === currency}
              onChange={() => set("currency", currency)}
            />
            <span>{currency || "All"}</span>
          </label>
        ))}
      </fieldset>

      {isFiltered(filters) && (
        <Link className="op-clear" href="/admin/ledger" replace>
          Clear
        </Link>
      )}
      <noscript>
        <button type="submit" className="pill ghost sm">
          Apply
        </button>
      </noscript>
      <span className="op-sr" aria-live="polite">
        {toQuery(filters) ? "Filters applied" : "No filters"}
      </span>
    </form>
  );
}
