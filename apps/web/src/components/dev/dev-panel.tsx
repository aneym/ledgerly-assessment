"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DEMO_PROFILES, profileUrl } from "@/lib/demo-profile-url";
import { actionsFor, type DevAction, type DevActionResult, runAction } from "@/lib/dev/actions";
import { currentScreen, pageCorrelationId } from "@/lib/dev/dom";
import { TEST_IDENTITIES } from "@/lib/dev/identities";
import "./dev-panel.css";

const KIND_LABEL: Record<DevAction["kind"], string> = {
  fill: "fill",
  submit: "submit",
  navigate: "go",
  click: "click",
};

type Last = { id: string; result: DevActionResult } | null;

/** Floating DEV pill bottom-right. Click expands the quick-action card for the mounted screen. */
export function DevPanel() {
  const pathname = usePathname();
  const router = useRouter();
  const panelId = useId();
  const pillRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [correlation, setCorrelation] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<Last>(null);

  const readPage = useCallback(() => {
    setScreen(currentScreen());
    setCorrelation(pageCorrelationId());
  }, []);

  // Re-read the screen whenever the card opens, and after every route change.
  useEffect(() => {
    if (open) readPage();
  }, [open, readPage]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, the DOM is the source
  useEffect(() => {
    setLast(null);
    const frame = requestAnimationFrame(readPage);
    return () => cancelAnimationFrame(frame);
  }, [pathname, readPage]);

  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      pillRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function run(action: DevAction) {
    if (busy) return;
    setBusy(action.id);
    const result = await runAction(action, (path) => router.push(path));
    setLast({ id: action.id, result });
    setBusy(null);
  }

  const actions = actionsFor(screen);

  return (
    <div className="dp-root" data-dev-panel>
      {open ? (
        <section
          ref={cardRef}
          id={panelId}
          className="card dp-card"
          aria-label="Dev panel"
          tabIndex={-1}
        >
          <header className="dp-head">
            <span className="dp-title">Dev panel</span>
            <span className="chip line dp-screen">{screen ?? "no data-screen"}</span>
            <button
              type="button"
              className="dp-close"
              onClick={() => {
                setOpen(false);
                pillRef.current?.focus();
              }}
              aria-label="Close dev panel"
            >
              Esc
            </button>
          </header>

          <div className="dp-section">
            <h2 className="dp-h">Actions</h2>
            {actions.length === 0 ? (
              <p className="dp-empty">No actions for this screen.</p>
            ) : (
              <ul className="dp-actions">
                {actions.map((action) => {
                  const result = last?.id === action.id ? last.result : null;
                  return (
                    <li key={action.id}>
                      <button
                        type="button"
                        className="dp-action"
                        onClick={() => void run(action)}
                        disabled={busy !== null}
                        aria-busy={busy === action.id ? "true" : undefined}
                        data-dev-action={action.id}
                      >
                        <span className="dp-label">{action.label}</span>
                        <span className="dp-kind">{KIND_LABEL[action.kind]}</span>
                      </button>
                      {result ? (
                        <p className={`dp-result ${result.ok ? "ok" : "bad"}`} aria-live="polite">
                          {result.note}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="dp-section">
            <h2 className="dp-h">Demo profiles</h2>
            <ul className="dp-ids">
              {DEMO_PROFILES.map((profile) => (
                <li key={profile} className="dp-id">
                  <span className="dp-role">{profile}</span>
                  <span className="dp-name">{TEST_IDENTITIES[profile].name}</span>
                  <a
                    className="dp-email"
                    href={profileUrl(profile, pathname)}
                    data-dev-switch={profile}
                    title={`Switch to the ${profile} profile; the server signs you in`}
                  >
                    switch
                  </a>
                </li>
              ))}
            </ul>
            <p className="dp-empty">
              A switch signs this browser in as one of the run's fictional accounts. No password is
              typed or shown.
            </p>
          </div>

          {correlation ? (
            <p className="dp-corr">
              <span>correlation</span>
              <code>{correlation}</code>
            </p>
          ) : null}

          <footer className="dp-foot">
            Dev panel. Actions fill real forms and call real routes. Nothing here fakes a result.
          </footer>
        </section>
      ) : null}

      <button
        ref={pillRef}
        type="button"
        className="pill ink sm dp-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? "Close dev panel" : "Open dev panel"}
      >
        DEV
      </button>
    </div>
  );
}
