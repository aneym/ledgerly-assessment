"use client";

import { useAnnounce } from "./Announcer";

/**
 * A mono id that copies itself. The name is "Copy {value}" through hidden text
 * and never changes; the page announcer says "Copied". The icon shows on row
 * hover, focus and the selected row (table.css). With `short`, a long id shows
 * only its last 8 characters; the full value stays in the title and the copy.
 */
export function CopyId({
  value,
  className,
  short,
}: {
  value: string;
  className?: string;
  /** Show the tail of a long id in the cell. The copy and the name keep the whole id. */
  short?: boolean;
}) {
  const announce = useAnnounce();
  const shown = short && value.length > 12 ? `…${value.slice(-8)}` : value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      announce("Copied");
    } catch {
      announce("Copy failed. Select the id by hand.");
    }
  }

  return (
    <button
      type="button"
      className={["tbl-copy", className].filter(Boolean).join(" ")}
      onClick={copy}
      title={value}
    >
      <span className="tbl-sr">Copy </span>
      <span className="tbl-copy-text" aria-hidden={shown !== value ? true : undefined}>
        {shown}
      </span>
      {shown !== value && <span className="tbl-sr">{value}</span>}
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
        <path d="M8 4V2.75A1.25 1.25 0 0 0 6.75 1.5H2.75A1.25 1.25 0 0 0 1.5 2.75v4A1.25 1.25 0 0 0 2.75 8H4" />
      </svg>
    </button>
  );
}
