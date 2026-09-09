"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { DemoEvent } from "../contract";

const STATE_TONE: Record<DemoEvent["state"], string> = {
  pending: "var(--muted, #6b675e)",
  running: "var(--ink-2, #55524a)",
  passed: "var(--ok, #3f6b4f)",
  failed: "var(--bad, #8f2f2f)",
  blocked: "var(--warn, #8a6116)",
  verified: "var(--ok, #3f6b4f)",
};

const KIND_LABEL: Partial<Record<DemoEvent["kind"], string>> = {
  "request.started": "request",
  "request.finished": "response",
  "db.written": "db write",
  "operation.requested": "whop call",
  "operation.responded": "whop reply",
  "step.started": "step",
  "step.finished": "step",
  "run.started": "run",
  "run.reset": "reset",
  "role.switched": "view",
};

/**
 * The live side panel: one row per sanitized event, identifiers and numbers only. New rows
 * arrive with a short fade and slide; nothing here reorders or invents an event.
 */
export function TracePanel({
  events,
  title = "Backend log",
}: {
  events: DemoEvent[];
  title?: string;
}) {
  const reduced = useReducedMotion() ?? false;
  const listRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const count = events.length;

  // Follow the newest row unless the presenter scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stick.current || count === 0) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [count, reduced]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <section
      data-tour-panel=""
      aria-label={title}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "var(--font-mono, ui-monospace, Menlo, monospace)",
        fontSize: 12,
        color: "var(--ink, #26251f)",
        background: "var(--paper, #fff)",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--line, #e3e0d9)",
          fontFamily: "var(--font-sans, system-ui, sans-serif)",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ color: "var(--muted, #6b675e)" }}>{count} events</span>
      </div>
      <div ref={listRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <AnimatePresence initial={false}>
          {events.map((e) => {
            const ids = [...(e.db?.ids ?? []), ...(e.provider?.resource_ids ?? [])];
            const status = e.request?.http_status ?? e.provider?.http_status ?? null;
            const ms = e.request?.duration_ms ?? e.provider?.duration_ms ?? null;
            const meta = [
              status !== null ? String(status) : null,
              ms !== null ? `${ms} ms` : null,
            ].filter(Boolean);
            const requestId = e.request?.request_id ?? e.provider?.request_id ?? null;
            const title = [
              requestId ? `request_id: ${requestId}` : null,
              `correlation: ${e.correlation_id}`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <motion.div
                key={e.event_id}
                title={title}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                style={{
                  padding: "6px 14px",
                  borderBottom: "1px solid var(--plate, #efede8)",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ color: STATE_TONE[e.state], fontWeight: 600 }}>
                    {KIND_LABEL[e.kind] ?? e.kind}
                  </span>{" "}
                  <span style={{ color: "var(--ink-2, #55524a)" }}>{e.summary}</span>
                  {meta.length ? (
                    <span style={{ display: "block", color: "var(--muted, #6b675e)" }}>
                      {meta.join(" · ")}
                    </span>
                  ) : null}
                  {ids.length ? (
                    <span style={{ display: "block", wordBreak: "break-all" }}>
                      {e.db ? `${e.db.table}: ` : ""}
                      {ids.join(", ")}
                    </span>
                  ) : null}
                  {e.gate ? (
                    <span style={{ display: "block", color: "var(--warn, #8a6116)" }}>
                      {e.gate.id}: {e.gate.reason}
                    </span>
                  ) : null}
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
