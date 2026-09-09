"use client";

import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { CopyId } from "./CopyId";
import { useInspectorMode } from "./use-inspector-mode";
import "./table.css";

function pressedRowButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.tbl-rowbtn[aria-pressed="true"]');
}

/**
 * The one detail pattern. A sticky pane beside the card at 1024 and up: its head
 * stays, its body scrolls, focus stays in the table. Below 1024 a <dialog> opened
 * with showModal(): a right drawer to 768, a bottom sheet under it. Escape and the
 * backdrop close it; focus returns to the row button. Not rendered when nothing is
 * selected; mount it only while there is a selection.
 */
export function Inspector({
  id,
  open,
  onClose,
  returnFocusTo,
  label,
  idValue,
  title,
  amount,
  status,
  media,
  children,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** "Ledger entry" */
  label: string;
  /** Copyable id in the label row. Also the key for the body's scroll reset. */
  idValue?: string;
  /** "Transfer" */
  title: ReactNode;
  amount?: { text: string; negative?: boolean; struck?: boolean };
  /** A chip plus one line. */
  status?: ReactNode;
  /** The product cover on earnings, 64px. */
  media?: ReactNode;
  /** InspectorBlock sections, then InspectorLinks. */
  children: ReactNode;
}) {
  const mode = useInspectorMode();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = `${id}-title`;

  const close = useCallback(() => {
    const target = returnFocusTo?.current ?? pressedRowButton();
    onClose();
    if (target?.isConnected) target.focus();
  }, [onClose, returnFocusTo]);

  // A new selection starts at the top of the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: idValue is the reset key on purpose
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [idValue, open]);

  // Pane: Escape clears the selection unless a field has focus.
  useEffect(() => {
    if (!open || mode !== "pane") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const el = event.target as HTMLElement | null;
      if (el?.closest("input, select, textarea, [contenteditable]")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, mode, close]);

  // Dialog: open and close follow the prop. Focus lands on the title, not the first control.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || mode === "pane") return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("h2")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, mode]);

  function onDialogClose() {
    // Escape or backdrop closed the native dialog while the selection is still set.
    if (open) close();
  }

  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) dialogRef.current?.close();
  }

  const head = (
    <div className="insp-head">
      <div className="insp-label">
        <span>{label}</span>
        <span className="id">
          {idValue !== undefined && <CopyId value={idValue} />}
          <button type="button" className="insp-close" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
      {/* tabIndex -1: a focus target for an "Open detail" affordance, never in the tab order */}
      <h2 id={titleId} tabIndex={-1}>
        <span>{title}</span>
        {amount && (
          <span
            className={["amt", amount.negative ? "is-neg" : "", amount.struck ? "is-struck" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            {amount.negative ? "−" : ""}
            {amount.text}
          </span>
        )}
      </h2>
      {status !== undefined && <div className="insp-status">{status}</div>}
    </div>
  );

  const body = (
    <div className="insp-body" ref={bodyRef}>
      {media !== undefined && <div className="insp-media">{media}</div>}
      {children}
    </div>
  );

  if (mode === "pane") {
    if (!open) return null;
    return (
      <aside className="insp" id={id} aria-labelledby={titleId}>
        {head}
        {body}
      </aside>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click closes on the backdrop only; Escape is native to the dialog
    <dialog
      ref={dialogRef}
      className="tbl-sheet"
      id={id}
      aria-labelledby={titleId}
      onClose={onDialogClose}
      onClick={onBackdrop}
    >
      <div className="grab" aria-hidden="true" />
      {head}
      {body}
    </dialog>
  );
}

export function InspectorBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp-block">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** One ledger line: label, dotted leader, value. `quiet` for absent values, `num` for money. */
export function InspectorLine({
  k,
  v,
  quiet = false,
  num = false,
}: {
  k: ReactNode;
  v: ReactNode;
  quiet?: boolean;
  num?: boolean;
}) {
  const cls = ["v", quiet ? "q" : "", num ? "num" : ""].filter(Boolean).join(" ");
  return (
    <div className="ll">
      <span className="k">{k}</span>
      <i className="lead" aria-hidden="true" />
      <span className={cls}>{v}</span>
    </div>
  );
}

/** Mark plus name and a muted line, at the top of a Business block. */
export function InspectorWho({
  mark,
  name,
  sub,
}: {
  mark: ReactNode;
  name: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="insp-who">
      {mark}
      <div>
        <b>{name}</b>
        {sub !== undefined && <span>{sub}</span>}
      </div>
    </div>
  );
}

export function InspectorTimeline({
  items,
}: {
  items: Array<{ label: string; when: string; open?: boolean }>;
}) {
  return (
    <ol className="insp-timeline">
      {items.map((item) => (
        <li key={`${item.label}-${item.when}`} className={item.open ? "is-open" : undefined}>
          <span>{item.label}</span>
          <span className="when">{item.when}</span>
        </li>
      ))}
    </ol>
  );
}

export function InspectorNote({ children }: { children: ReactNode }) {
  return <p className="insp-note">{children}</p>;
}

export function InspectorLinks({ children }: { children: ReactNode }) {
  return <div className="insp-links">{children}</div>;
}
